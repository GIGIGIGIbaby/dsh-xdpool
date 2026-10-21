/**
 * The vendored channel pack's model catalogue, and how long it stays trusted.
 *
 * Each adapter used to fetch its catalogue once per process and never again
 * (`if (this.remoteModels !== void 0) return;`), so a vendor renaming a model or
 * changing its multiplier only reached the card after a DSH restart. The
 * multiplier is part of the display name (`Qwen3.8-Max · x0.5→x0.2`), which makes
 * that a price a user reads off a screen that can be hours stale — exactly the
 * report that prompted this: qoder's `deepseek-v4.1-flash` had been renamed to
 * `DeepSeek-Flash` and made free, and the card still showed the old row.
 *
 * `pack.js` is a vendor build artifact, so these are source assertions: they
 * cannot drive the adapter, but they fail loudly when a vendor refresh drops the
 * patch — the failure mode that matters, since a silent revert would restore
 * restart-only catalogs with no symptom until the next rename.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const pack = readFileSync(new URL('../vendor/channel-pack/pack.js', import.meta.url), 'utf8')

describe('the vendored catalogue cache expires', () => {
  it('defines the TTL and the stale check', () => {
    expect(pack).toContain('var REMOTE_CATALOG_TTL_MS = ')
    expect(pack).toContain('function remoteModelsStale(owner)')
    // Ten minutes by default, overridable so a test host can prove a refetch
    // without waiting one out.
    expect(pack).toContain('process.env.DSH_XDPOOL_CATALOG_TTL_MS')
  })

  it('routes every lazy loader through it', () => {
    // Nine adapters: four fetch-guard adapters, one short-guard adapter and four
    // getter-style loaders. A count, because the failure this guards against is a
    // vendor refresh reverting ONE of them and the others still looking fine.
    expect((pack.match(/!remoteModelsStale\(this\)/gu) ?? []).length).toBe(9)
    expect(pack).not.toContain('if (this.remoteModels !== void 0 || fetchRemote === void 0) return;')
  })

  it('keeps the post-fetch recheck that returns whatever it has', () => {
    // Four of the eight `return this.remoteModels` sites were entry guards and are
    // now stale checks; the four after the fetch must stay untouched, or a failed
    // refresh would loop instead of serving the last good catalogue.
    expect((pack.match(/if \(this\.remoteModels !== void 0\) return this\.remoteModels;/gu) ?? []).length).toBe(4)
    // And each of those still follows a stale-guarded entry in the same loader.
    expect((pack.match(/!remoteModelsStale\(this\)\) return this\.remoteModels;/gu) ?? []).length).toBe(4)
  })

  it('does not clear the cache on expiry', () => {
    // Last known good, not "fall back to bare ids": a failed refresh must leave
    // the previous catalogue in place.
    const at = pack.indexOf('function remoteModelsStale(owner)')
    const body = pack.slice(at, at + 900)
    expect(body).not.toContain('owner.remoteModels = void 0')
  })
})

/**
 * qoder's prices come from a table baked into the bundle, not from the network.
 *
 * `QoderAdapter.listModels` maps `product.fallbackModels` through
 * `qoderDisplayName()`, which renders `priceFactor` plus an optional static
 * `promotion`. So a refresh cannot change a qoder price, and the promo schema only
 * knew daily HH:MM windows — which cannot express "free until 10-25 00:00". Both
 * were added here, bounded by a date so the row reverts on its own instead of
 * needing a second edit when the promo ends.
 */
describe('qoder promotions can end on a date', () => {
  it('the window check honours from/until', () => {
    const at = pack.indexOf('function promotionActiveNow2(promotion, now)')
    expect(at).toBeGreaterThan(-1)
    const body = pack.slice(at, at + 700)
    expect(body).toContain('Date.parse(promotion.until ?? "")')
    expect(body).toContain('Date.parse(promotion.from ?? "")')
    expect(body).toContain('now.getTime() >= until')
  })

  it('both qoder tables carry the running DeepSeek promo with its end date', () => {
    // International and CN each have their own table; a fix in only one leaves the
    // other channel showing the old price.
    const promos = pack.match(/id: "dfmodel"[^\n]*until: "([^"]+)"/gu) ?? []
    expect(promos).toHaveLength(2)
    for (const line of promos) {
      expect(line).toContain('discountFactor: 0')
      expect(line).toContain('beforePromotionPriceFactor: 0.1')
      expect(line).toContain('until: "2026-10-24T16:00:00.000Z"')
    }
  })

  it('a zero factor renders as an arrow to zero, not as free forever', () => {
    // `priceFactor === 0` prints 免费 (a permanent fact); a promo must keep the old
    // price visible and show where it lands, because it will come back.
    const at = pack.indexOf('function qoderDisplayName(model, now =')
    const body = pack.slice(at, at + 700)
    expect(body).toContain('x${before}\\u2192x${effective}')
  })
})
