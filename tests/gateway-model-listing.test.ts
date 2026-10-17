/**
 * The OpenAI-compatible endpoint must list what the user selected, and must say
 * WHICH CHANNEL each row belongs to (regression).
 *
 * Two live-install failures, one surface.
 *
 * 1. The gateway ignored the model selection. The XD Pool card read
 *    `已启用 3 / 18` — `hy3`, `space-bunny`, `deepseek-v4.1-flash` — while
 *    `GET /v1/models` answered with **17** WorkBuddy models, fourteen of them
 *    switched off. The two faces of one plugin read the catalog through
 *    different doors:
 *
 *      host picker  → registerModelDiscovery → catalog.visible()   (filtered)
 *      LAN gateway  → /v1/models             → catalog.current()   (everything)
 *
 *    So a client pointed at the gateway could pick a model the picker never
 *    offered, and "enabled" silently meant "hidden from DSH" rather than
 *    "not usable". `current()` is not wrong in general — it is what the card
 *    renders the full roster from — which is exactly why this needs a test on the
 *    HTTP surface rather than a unit test of the catalog.
 *
 * 2. Only the pool lane was listed bare. A chain is `combo:<slug>`, the keyless
 *    lane is `free:<model>`, every aggregate row is a composite
 *    `providerId/modelId` — and the pool's own models were `hy3`. A client
 *    therefore could tell three lanes apart and could not tell the fourth from
 *    anything else. Pool rows now carry `workbuddy:`.
 *
 *    Bare ids must KEEP working: a client configured before the prefix existed
 *    is not misconfigured, and a listing change that breaks it is a regression
 *    dressed as a clarification.
 *
 * The case that is easy to get wrong and is therefore asserted directly: the
 * pooled upstream speaks the BARE model id, because `prepareChatBody` passes
 * `model` through untouched. Routing on the prefix without rewriting the body
 * sends WorkBuddy a model it has never heard of — the request looks routed and
 * fails upstream.
 */

import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WorkBuddyAccountPool } from '../src/accounts.ts'
import { WorkBuddyCatalog } from '../src/catalog.ts'
import { POOL_MODEL_PREFIX, createWorkBuddyShim } from '../src/shim.ts'
import { WorkBuddyUpstreamClient } from '../src/upstream.ts'

const shims: { close(): Promise<void> }[] = []

afterEach(async () => {
  while (shims.length > 0) await shims.pop()?.close()
})

/** A minimal signed-in auth directory so the pool has one account to serve. */
async function fakeAuthDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'wbgw-'))
  const auth = join(dir, 'auth')
  await mkdir(auth, { recursive: true })
  await writeFile(
    join(auth, 'workbuddy-desktop.info'),
    JSON.stringify({
      auth: {
        accessToken: 'token-0',
        refreshToken: 'refresh-0',
        expiresAt: Date.now() + 3_600_000,
        refreshExpiresAt: Date.now() + 30 * 24 * 3_600_000,
        domain: '',
      },
      account: { uid: `uid-0-${'0'.repeat(24)}`, uin: '1000000000000', nickname: 'Gateway' },
    }),
    'utf8',
  )
  return auth
}

interface Bound {
  catalog: WorkBuddyCatalog
  baseUrl: () => string
  token: () => string
  /** `model` field of every body the shim forwarded upstream. */
  upstreamModels: () => string[]
}

/** A CN shim over the static fallback roster, bound and ready to answer. */
async function boundShim(): Promise<Bound> {
  const catalog = new WorkBuddyCatalog('cn')
  const pool = new WorkBuddyAccountPool({ authDirs: [await fakeAuthDir()] })
  await pool.scan()
  const bodies: string[] = []
  const shim = createWorkBuddyShim({
    pool,
    client: new WorkBuddyUpstreamClient({
      fetchImpl: async (_url: unknown, init: RequestInit) => {
        // Only the chat request is captured: the pool also fires background
        // balance refreshes through this same fetch, and recording those would
        // make the assertion below measure the wrong request.
        if (typeof init.body === 'string' && init.body.includes('"messages"')) bodies.push(init.body)
        return new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n', {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        })
      },
    }),
    catalog,
    region: 'cn',
  })
  shims.push(shim)
  await shim.ready
  return {
    catalog,
    baseUrl: () => shim.baseUrl(),
    token: () => shim.token(),
    upstreamModels: () => bodies.map(b => String((JSON.parse(b) as { model?: unknown }).model)),
  }
}

/** The gateway's own answer, as a client sees it. */
async function listed(shim: Bound): Promise<{ id: string; owned_by: string }[]> {
  const response = await fetch(`${shim.baseUrl()}/v1/models`, {
    headers: { Authorization: `Bearer ${shim.token()}` },
  })
  expect(response.status).toBe(200)
  const body = await response.json() as { data: { id: string; owned_by: string }[] }
  return body.data
}

/** One chat turn through the gateway, as any OpenAI client would send it. */
async function ask(shim: Bound, model: string): Promise<number> {
  const response = await fetch(`${shim.baseUrl()}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${shim.token()}` },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }] }),
  })
  await response.text()
  return response.status
}

describe('the gateway model listing', () => {
  it('serves the full roster while nothing has been selected', async () => {
    // An absent selection means "everything" — a fresh install must not be
    // handed an empty picker. Pinned first so the next case cannot pass by
    // filtering everything away.
    const shim = await boundShim()
    const rows = await listed(shim)
    expect(rows.length).toBeGreaterThan(3)
    expect(rows.every(row => row.owned_by === 'workbuddy')).toBe(true)
  })

  it('drops the models the user switched OFF', async () => {
    const shim = await boundShim()
    const before = (await listed(shim)).map(row => row.id)
    expect(before).toContain(`${POOL_MODEL_PREFIX}glm-5.2`)

    shim.catalog.applySelection({ enabledModelIds: ['hy3', 'space-bunny'] })

    const after = (await listed(shim)).map(row => row.id)
    expect(after).toEqual([`${POOL_MODEL_PREFIX}hy3`, `${POOL_MODEL_PREFIX}space-bunny`])
    expect(after.length).toBeLessThan(before.length)
  })

  it('agrees with visible(), which is what the host picker reads', async () => {
    // The invariant that was actually broken: two doors into one catalog.
    const shim = await boundShim()
    shim.catalog.applySelection({ enabledModelIds: ['deepseek-v4.1-flash'] })
    expect((await listed(shim)).map(row => row.id)).toEqual(
      shim.catalog.visible().map(model => `${POOL_MODEL_PREFIX}${model.id}`),
    )
  })

  it('names every pool row with its channel', async () => {
    const shim = await boundShim()
    for (const row of await listed(shim)) {
      expect(row.id.startsWith(POOL_MODEL_PREFIX)).toBe(true)
    }
  })
})

describe('the gateway accepts both spellings and forwards the bare one', () => {
  it('routes a workbuddy-prefixed id and sends upstream the BARE model id', async () => {
    const shim = await boundShim()
    expect(await ask(shim, `${POOL_MODEL_PREFIX}hy3`)).toBe(200)
    // Not `workbuddy:hy3`: the pooled upstream only knows its own ids, and
    // `prepareChatBody` does not rewrite `model`.
    expect(shim.upstreamModels()).toEqual(['hy3'])
  })

  it('still serves a bare id, so existing client configs keep working', async () => {
    const shim = await boundShim()
    expect(await ask(shim, 'hy3')).toBe(200)
    expect(shim.upstreamModels()).toEqual(['hy3'])
  })

  it('refuses a prefixed id whose remainder names another lane', async () => {
    // `workbuddy:free:x` / `workbuddy:combo:x` / `workbuddy:prov/x` must not be
    // quietly re-routed into the lane the remainder spells.
    const shim = await boundShim()
    for (const model of [
      `${POOL_MODEL_PREFIX}`,
      `${POOL_MODEL_PREFIX}free:some-model`,
      `${POOL_MODEL_PREFIX}combo:some-chain`,
      `${POOL_MODEL_PREFIX}someprov/some-model`,
    ]) {
      expect(await ask(shim, model), model).not.toBe(200)
    }
    expect(shim.upstreamModels()).toEqual([])
  })
})
