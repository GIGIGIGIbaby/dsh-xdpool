/**
 * The gateway allowlist: what the card's checkboxes actually do.
 *
 * The feature is a security boundary with two ways to fail, and both are silent:
 *
 *   - enforcing on the shim unconditionally would narrow the HOST's picker too.
 *     This one process answers the host's own pool adapter and, through the
 *     relay, whatever device holds the LAN key — so a list meant for other
 *     machines would start refusing the user's own chat. The relay stamps
 *     `x-xdpool-relay-hop` on what it forwards and strips a client-supplied copy,
 *     so the two callers are distinguishable and only one is gated.
 *   - filtering only `/v1/models` would be cosmetic. The relay key is one secret
 *     shared by every device on the network, so a model merely left off a listing
 *     would still be reachable by anything that guessed its id — including the
 *     login channels, whose quota is the account owner's. The refusal below is
 *     what makes hiding it mean anything.
 *
 * `undefined` and `[]` are different answers and are tested apart: collapsing an
 * empty selection into "no selection" would silently re-open a gateway the user
 * just closed.
 */

import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WorkBuddyAccountPool } from '../src/accounts.ts'
import { WorkBuddyCatalog } from '../src/catalog.ts'
import { RELAY_HOP_HEADER, createWorkBuddyShim } from '../src/shim.ts'
import { WorkBuddyUpstreamClient } from '../src/upstream.ts'
import { normalizeStore } from '../src/store.ts'

const shims: { close(): Promise<void> }[] = []

afterEach(async () => {
  while (shims.length > 0) await shims.pop()?.close()
})

async function authDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'wballow-'))
  const auth = join(dir, 'auth')
  await mkdir(auth, { recursive: true })
  await writeFile(join(auth, 'workbuddy-desktop.info'), JSON.stringify({
    auth: {
      accessToken: 't', refreshToken: 'r',
      expiresAt: Date.now() + 3_600_000, refreshExpiresAt: Date.now() + 30 * 864e5, domain: '',
    },
    account: { uid: `u-${'0'.repeat(24)}`, uin: '1', nickname: 'N' },
  }), 'utf8')
  return auth
}

/** A pool shim whose listing is a fixed roster, gated by `allow`. */
async function gateway(allow: readonly string[] | undefined) {
  const catalog = new WorkBuddyCatalog('cn')
  catalog.applySelection({ enabledModelIds: ['hy3', 'space-bunny'] })
  const pool = new WorkBuddyAccountPool({ authDirs: [await authDir()] })
  await pool.scan()
  const upstream: string[] = []
  const shim = createWorkBuddyShim({
    pool,
    client: new WorkBuddyUpstreamClient({
      fetchImpl: async (_url: unknown, init: RequestInit) => {
        if (typeof init.body === 'string' && init.body.includes('"messages"')) {
          upstream.push(String((JSON.parse(init.body) as { model?: unknown }).model))
        }
        return new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n', {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        })
      },
    }),
    catalog,
    region: 'cn',
    lanModels: () => allow,
  })
  shims.push(shim)
  await shim.ready
  const via = async (path: string, init: RequestInit, lan: boolean) => {
    const headers = new Headers(init.headers)
    headers.set('Authorization', `Bearer ${shim.token()}`)
    // The relay's own marker. A LAN request carries it; the host's adapter does
    // not, and that single difference is what this file is about.
    if (lan) headers.set(RELAY_HOP_HEADER, '1')
    const response = await fetch(`${shim.baseUrl()}${path}`, { ...init, headers })
    return { status: response.status, text: await response.text() }
  }
  const listModels = (lan: boolean) => via('/v1/models', { method: 'GET' }, lan)
  const ask = (model: string, lan: boolean) => via('/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }] }),
  }, lan)
  /** A body the caller controls, for the cases where `model` is the variable. */
  const askRaw = (body: string, lan: boolean) => via('/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  }, lan)
  return { listModels, ask, askRaw, upstream }
}

const idsOf = (body: string): string[] =>
  ((JSON.parse(body) as { data: { id: string }[] }).data).map(row => row.id)

describe('the LAN listing', () => {
  it('shows only the shared models to a LAN client', async () => {
    const gatewaySubject = await gateway(['buddy:hy3'])
    expect(idsOf(await (await gatewaySubject.listModels(true)).text)).toEqual(['buddy:hy3'])
  })

  it('shows everything when the user never made a selection', async () => {
    const gatewaySubject = await gateway(undefined)
    expect(idsOf(await (await gatewaySubject.listModels(true)).text)).toEqual([
      'buddy:hy3', 'buddy:space-bunny',
    ])
  })

  it('shows nothing once everything has been unticked', async () => {
    const gatewaySubject = await gateway([])
    expect(idsOf(await (await gatewaySubject.listModels(true)).text)).toEqual([])
  })

  it("never narrows the host's own view of the same shim", async () => {
    // The regression this whole file exists to prevent: a list meant for other
    // machines must not shrink what DSH offers in chat.
    const gatewaySubject = await gateway(['buddy:hy3'])
    expect(idsOf(await (await gatewaySubject.listModels(false)).text)).toEqual([
      'buddy:hy3', 'buddy:space-bunny',
    ])
  })
})

describe('the LAN completion', () => {
  it('refuses a model that is not shared, and never reaches upstream', async () => {
    const gatewaySubject = await gateway(['buddy:hy3'])
    const result = await gatewaySubject.ask('buddy:space-bunny', true)
    expect(result.status).toBe(403)
    expect(result.text).toContain('not shared on this gateway')
    expect(gatewaySubject.upstream).toEqual([])
  })

  it('refuses a hidden model spelled without its prefix too', async () => {
    // Bare ids are still accepted by the pool lane, so gating only the prefixed
    // spelling would leave `space-bunny` reachable while `buddy:space-bunny` was
    // refused. The check runs on what the caller sent, before any lane rewrites.
    const gatewaySubject = await gateway(['buddy:hy3'])
    expect((await gatewaySubject.ask('space-bunny', true)).status).toBe(403)
    expect(gatewaySubject.upstream).toEqual([])
  })

  it('serves a shared model', async () => {
    const gatewaySubject = await gateway(['buddy:hy3'])
    expect((await gatewaySubject.ask('buddy:hy3', true)).status).toBe(200)
    expect(gatewaySubject.upstream).toEqual(['hy3'])
  })

  it.each([
    ['no model field at all', '{"messages":[]}'],
    ['an empty model', '{"model":"","messages":[]}'],
    ['a body that is not JSON', 'not json'],
  ])('refuses a LAN request with %s', async (_label, body) => {
    // "Not listed" is not a licence to serve everything: a caller that omits the
    // model has named nothing that the allowlist could have approved.
    const gatewaySubject = await gateway(['buddy:hy3'])
    expect((await gatewaySubject.askRaw(body, true)).status).toBe(403)
    expect(gatewaySubject.upstream).toEqual([])
  })

  it("leaves the host's own turns completely alone", async () => {
    const gatewaySubject = await gateway(['buddy:hy3'])
    expect((await gatewaySubject.ask('buddy:space-bunny', false)).status).toBe(200)
    expect(gatewaySubject.upstream).toEqual(['space-bunny'])
  })
})

describe('the stored allowlist keeps absent and empty apart', () => {
  it('reads a missing section as no selection', () => {
    expect(normalizeStore({ version: 1 }).relay?.models).toBeUndefined()
  })

  it('reads an empty selection as empty, not as "no selection"', () => {
    // Collapsing this into undefined would silently re-open a gateway the user
    // just closed, and they would have no way to see that they had.
    expect(normalizeStore({ version: 1, relay: { models: [] } }).relay?.models).toEqual([])
  })

  it('deduplicates, trims, and drops non-string entries without losing the list', () => {
    // This file also holds the API keys, so one malformed entry must not cost the
    // user both.
    const stored = normalizeStore({
      version: 1,
      relay: { models: ['buddy:hy3', 'buddy:hy3', 7, null, ' qoder:qfmodel '] },
    })
    expect(stored.relay?.models).toEqual(['buddy:hy3', 'qoder:qfmodel'])
  })
})
