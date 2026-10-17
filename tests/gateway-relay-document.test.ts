/**
 * The Gateway card's document, composed.
 *
 * This file exists because of a regression that shipped past the whole suite and
 * would have shipped to users: adding the model picker turned the relay document
 * into
 *
 *   return { ...relay.status(), candidates, shared }
 *
 * and `relay.status()` is ASYNC. Spreading a pending promise contributes no own
 * properties, so the document came back as `{ candidates, shared }` and every
 * field the card needs — `enabled`, `listening`, `host`, `port`, `key`, `error` —
 * was simply gone. HTTP 200, valid JSON, a Gateway page with no switch, no key
 * and no endpoint, and nothing anywhere in the response saying it had broken.
 *
 * It was caught by curling the live route, not by a test, which is the point of
 * this file. The existing relay assertions scan `index.ts` for source text; a
 * text scan cannot see a missing `await`, because the text was all still there.
 * These assertions run the composition and check the FIELDS.
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { relayDocumentOf, type PoolRelayStatus } from '../src/relay.ts'
import type { GatewayModelEntry } from '../src/shim.ts'

/** A relay that is on, bound, and holding a key. */
const BASE: PoolRelayStatus = {
  enabled: true,
  listening: true,
  host: '127.0.0.1',
  port: 8326,
  endpoint: 'http://127.0.0.1:8326/v1',
  key: 'relay-key-value',
  error: '',
}

const ROSTER: readonly GatewayModelEntry[] = [
  { id: 'buddy:hy3', name: 'Hy3', source: 'workbuddy' },
  { id: 'qoder:qfmodel', name: 'Qwen3.8-Flash · 免费', source: 'qoder' },
]

function document(input: Partial<Parameters<typeof relayDocumentOf>[0]> = {}) {
  return relayDocumentOf({
    status: async () => BASE,
    shared: () => undefined,
    roster: async () => ROSTER,
    ...input,
  })
}

describe('the gateway relay document', () => {
  it('carries every relay field alongside the new picker fields', async () => {
    // The regression, stated as the thing that must always be true: the card
    // reads all of these, and a missing one is silent.
    const doc = await document()
    expect(doc.enabled).toBe(true)
    expect(doc.listening).toBe(true)
    expect(doc.host).toBe('127.0.0.1')
    expect(doc.port).toBe(8326)
    expect(doc.endpoint).toBe('http://127.0.0.1:8326/v1')
    expect(doc.key).toBe('relay-key-value')
    expect(doc.error).toBe('')
    expect(doc.candidates).toHaveLength(2)
  })

  it('reports the field names the card actually reads, exactly', async () => {
    // A whitelist on the shape, so a future field that arrives by accident — or a
    // required one that goes missing — fails here rather than in the browser.
    const doc = await document()
    expect(Object.keys(doc).sort()).toEqual([
      'candidates', 'enabled', 'endpoint', 'error', 'host', 'key', 'listening', 'port',
    ])
  })

  it('omits `shared` until the user has chosen, so the card can mean "everything"', async () => {
    const doc = await document()
    expect('shared' in doc).toBe(false)
  })

  it('keeps an explicit empty selection empty', async () => {
    // `[]` is "share nothing", a decision. Collapsing it into the absent case
    // would silently re-open a gateway the user just closed.
    const doc = await document({ shared: () => [] })
    expect(doc.shared).toEqual([])
  })

  it('round-trips a non-empty selection', async () => {
    const doc = await document({ shared: () => ['buddy:hy3'] })
    expect(doc.shared).toEqual(['buddy:hy3'])
  })

  it('still serves the relay fields when the roster fails', async () => {
    const warned: unknown[] = []
    const doc = await document({
      roster: async () => {
        throw new Error('listing unavailable')
      },
      warn: error => { warned.push(error) },
    })
    expect(doc.candidates).toEqual([])
    expect(warned).toHaveLength(1)
    expect(doc.enabled).toBe(true)
    expect(doc.key).toBe('relay-key-value')
  })

  it('does not report a stopped relay as listening', async () => {
    const doc = await relayDocumentOf({
      status: async () => ({ ...BASE, listening: false, endpoint: '', error: 'port in use' }),
      shared: () => undefined,
      roster: async () => ROSTER,
    })
    expect(doc.listening).toBe(false)
    expect(doc.endpoint).toBe('')
    expect(doc.error).toBe('port in use')
  })
})

/**
 * The POST answer has to be the same document as the GET answer.
 *
 * Found on the live host, one step after the regression above: the write path
 * ended with `return relay.status()`, which is the listener's own state and
 * carries no roster. The card treats the write response as the new state, so
 * every save — the switch, the address, the key, the share list — answered with
 * a document that had `candidates` absent, and the picker emptied until the next
 * poll. Same family as the missing `await`: a valid response, shaped for a
 * different route.
 */
describe('the write path answers with the whole document', () => {
  it('returns the shared loader rather than the bare listener status', () => {
    const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
    const at = source.indexOf('saveRelay: async')
    expect(at).toBeGreaterThan(-1)
    const end = source.indexOf('  }))', at)
    expect(end).toBeGreaterThan(at)
    const body = source.slice(at, end)
    expect(body).toContain('return relayDocument()')
    expect(body).not.toContain('return relay.status()')
  })

  it('shares one loader between the two routes instead of assembling twice', () => {
    // Two assemblies of the same document is how the two routes drifted apart in
    // the first place, so the guard is that only one exists.
    const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
    expect((source.match(/relayDocumentOf\(/gu) ?? []).length).toBe(1)
    expect(source).toContain('const relayDocument = () => relayDocumentOf({')
    expect(source).toContain('    relayDocument,')
  })

  it('declares `candidates` as required so a producer cannot omit it quietly', () => {
    // Optional was what let `return relay.status()` typecheck. With the field
    // required, the shortcut is a compile error instead of a card with no rows.
    const source = readFileSync(new URL('../src/status-paths.ts', import.meta.url), 'utf8')
    const at = source.indexOf('export interface PoolWebRelayStatus')
    expect(at).toBeGreaterThan(-1)
    const body = source.slice(at, source.indexOf('\n}', at))
    expect(body).toContain('candidates: readonly PoolWebGatewayModel[]')
    expect(body).not.toContain('candidates?:')
  })
})
