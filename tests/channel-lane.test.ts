/**
 * The channel lane: login channels bridged onto the OpenAI wire.
 *
 * This lane is the one place in the gateway where a wrong FIELD NAME, rather than
 * a wrong value, produces a failure nobody can see: a delta written under a key
 * the client does not read arrives as HTTP 200 and an empty answer, which is
 * indistinguishable from a model that said nothing. Every assertion below is
 * therefore about the shape a client actually parses.
 *
 * The host vocabulary it translates FROM is pinned against the real type
 * (`dsh-llm` `types.d.ts`: block-start | text-delta | reasoning-delta |
 * tool-call-delta | block-end | usage | finish), and the translation is tested
 * chunk by chunk rather than only end to end, so a dropped tool call fails here
 * instead of surfacing as "this channel refuses to use tools".
 *
 * Two behaviours that look like omissions and are not:
 *
 *   - a channel whose listing throws contributes NOTHING rather than an error,
 *     because "not signed in" is the card's answer too, and a gateway that 500s
 *     on one dead channel would hide every healthy one;
 *   - the response echoes the BARE model id, not the composite the client sent,
 *     because a client that keys its cache off `response.model` would otherwise
 *     mint a new entry per turn.
 */

import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WorkBuddyAccountPool } from '../src/accounts.ts'
import { WorkBuddyCatalog } from '../src/catalog.ts'
import {
  createChannelLane,
  interpretImagePart,
  mapFinishReason,
  toChannelEvent,
  type ChannelLaneAttachments,
  type ChannelLaneLlm,
} from '../src/channel-lane.ts'
import { POOL_MODEL_PREFIX, channelListableAsRows, createWorkBuddyShim } from '../src/shim.ts'
import { POOL_OWNED_CHANNELS } from '../src/channels.ts'
import { WorkBuddyUpstreamClient } from '../src/upstream.ts'

const shims: { close(): Promise<void> }[] = []

afterEach(async () => {
  while (shims.length > 0) await shims.pop()?.close()
})

const toId = (channel: string, modelId: string): string => `${channel}:${modelId}`

/** A host `llm` stand-in: fixed listings, and a scripted chunk stream. */
function fakeLlm(input: {
  models?: Record<string, { id: string; name?: string }[]>
  chunks?: Record<string, Record<string, unknown>[]>
} = {}): ChannelLaneLlm & { streamed: { provider: string; model: string; options: Record<string, unknown> }[] } {
  const streamed: { provider: string; model: string; options: Record<string, unknown> }[] = []
  return {
    streamed,
    async listModels(provider: string) {
      const rows = input.models?.[provider]
      if (rows === undefined) throw new Error(`no adapter for ${provider}`)
      return rows
    },
    stream(options: Record<string, unknown>) {
      const provider = String(options.provider)
      const model = String(options.model)
      streamed.push({ provider, model, options })
      const chunks = input.chunks?.[`${provider}/${model}`] ?? input.chunks?.['*'] ?? []
      return (async function* () {
        for (const chunk of chunks) yield chunk
      })()
    },
  }
}

/** The lane over a fixed set of configured channels. */
function lane(
  llm: ChannelLaneLlm,
  providers: readonly string[] = ['qoder', 'trae'],
  attachments?: () => ChannelLaneAttachments | undefined,
) {
  return createChannelLane({ llm, providers: () => providers, toId, ...(attachments === undefined ? {} : { attachments }) })
}

describe('channel listing', () => {
  it('names every row with its channel', async () => {
    const llm = fakeLlm({ models: { qoder: [{ id: 'Qwen3.8-Flash' }], trae: [{ id: 'dsv-pro', name: 'DS Pro' }] } })
    const rows = await lane(llm).rows()
    expect(rows.map(row => row.id)).toEqual(['qoder:Qwen3.8-Flash', 'trae:dsv-pro'])
    expect(rows[1]!.name).toBe('DS Pro')
  })

  it('contributes nothing for an unsigned channel instead of failing the listing', async () => {
    // `fakeLlm` throws for any provider it has no models for, so `codearts` here
    // stands in for "no adapter / not signed in".
    const llm = fakeLlm({ models: { qoder: [{ id: 'M' }] } })
    const rows = await lane(llm, ['qoder', 'codearts']).rows()
    expect(rows.map(row => row.id)).toEqual(['qoder:M'])
  })

  it('excludes the pool-owned channels, which are not channels', () => {
    // `buddy` is the pool lane's own prefix; `workbuddy` is the other account
    // pool. Listing either as a channel would show one model twice.
    expect(channelListableAsRows('buddy', POOL_OWNED_CHANNELS)).toBe(false)
    expect(channelListableAsRows('workbuddy', POOL_OWNED_CHANNELS)).toBe(false)
    expect(channelListableAsRows('qoder', POOL_OWNED_CHANNELS)).toBe(true)
    expect(channelListableAsRows('free', POOL_OWNED_CHANNELS)).toBe(false)
    expect(channelListableAsRows('combo', POOL_OWNED_CHANNELS)).toBe(false)
  })
})

describe('composite id resolution', () => {
  const subject = lane(fakeLlm())
  it('accepts a configured channel', () => {
    expect(subject.resolve('qoder:Qwen3.8-Flash')).toEqual({ channel: 'qoder', modelId: 'Qwen3.8-Flash' })
  })
  it('rejects an unknown channel, a missing part, and a slash id', () => {
    expect(subject.resolve('nosuch:M')).toBeUndefined()
    expect(subject.resolve('qoder:')).toBeUndefined()
    expect(subject.resolve(':M')).toBeUndefined()
    expect(subject.resolve('qoder/M')).toBeUndefined()
    expect(subject.resolve('hy3')).toBeUndefined()
  })
})

describe('host chunk translation', () => {
  it('maps text and reasoning deltas onto the keys a client reads', () => {
    expect(toChannelEvent({ type: 'text-delta', index: 0, text: 'hi' }))
      .toEqual({ kind: 'delta', delta: { content: 'hi' } })
    expect(toChannelEvent({ type: 'reasoning-delta', index: 0, text: 'think' }))
      .toEqual({ kind: 'delta', delta: { reasoning_content: 'think' } })
  })

  it('carries a tool call name only on the fragment that has one', () => {
    const first = toChannelEvent({ type: 'tool-call-delta', index: 0, id: 'call_1', name: 'read', argumentsDelta: '{"a"' })
    const later = toChannelEvent({ type: 'tool-call-delta', index: 0, id: 'call_1', argumentsDelta: ':1}' })
    expect((first!.delta.tool_calls as Record<string, unknown>[])![0]!.function).toEqual({ name: 'read', arguments: '{"a"' })
    // No `name` key at all on a continuation: an empty string here would overwrite
    // the name a client already recorded.
    expect((later!.delta.tool_calls as Record<string, unknown>[])![0]!.function).toEqual({ arguments: ':1}' })
  })

  it('folds usage and finish, and ignores the block markers', () => {
    expect(toChannelEvent({ type: 'usage', usage: { input: 12, output: 5, total: 17 } }))
      .toEqual({ kind: 'usage', usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 } })
    // The host reports input/output only. Defaulting the total to 0 would make a
    // client that meters spend off `total_tokens` read every channel turn as free.
    expect(toChannelEvent({ type: 'usage', usage: { input: 14, output: 2 } }))
      .toEqual({ kind: 'usage', usage: { prompt_tokens: 14, completion_tokens: 2, total_tokens: 16 } })
    expect(toChannelEvent({ type: 'finish', reason: { kind: 'stop' } }))
      .toEqual({ kind: 'done', finishReason: 'stop' })
    expect(toChannelEvent({ type: 'block-start', index: 0, blockType: 'text' })).toBeUndefined()
    expect(toChannelEvent({ type: 'block-end', index: 0, block: {} })).toBeUndefined()
  })

  it('names the finish reasons a client branches on', () => {
    expect(mapFinishReason({ kind: 'toolUse' })).toBe('tool_calls')
    expect(mapFinishReason({ kind: 'length' })).toBe('length')
    expect(mapFinishReason({ kind: 'aborted' })).toBe('abort')
    expect(mapFinishReason({ kind: 'stop' })).toBe('stop')
    expect(mapFinishReason(undefined)).toBe('stop')
  })
})

async function authDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'wbchan-'))
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

/** A gateway with a channel lane wired in, over a fake host seam. */
async function gatewayWithChannel(llm: ChannelLaneLlm, attachments?: () => ChannelLaneAttachments | undefined) {
  const pool = new WorkBuddyAccountPool({ authDirs: [await authDir()] })
  await pool.scan()
  const shim = createWorkBuddyShim({
    pool,
    client: new WorkBuddyUpstreamClient({ fetchImpl: async () => new Response('{}') as never }),
    catalog: new WorkBuddyCatalog('cn'),
    region: 'cn',
    channels: lane(llm, ['qoder', 'trae'], attachments),
  })
  shims.push(shim)
  await shim.ready
  const call = async (body: Record<string, unknown>) => {
    const response = await fetch(`${shim.baseUrl()}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${shim.token()}` },
      body: JSON.stringify(body),
    })
    return { status: response.status, text: await response.text() }
  }
  const models = async () => {
    const response = await fetch(`${shim.baseUrl()}/v1/models`, {
      headers: { Authorization: `Bearer ${shim.token()}` },
    })
    const payload = await response.json() as { data: { id: string; owned_by: string }[] }
    return payload.data
  }
  return { call, models }
}

describe('the gateway serving a channel', () => {
  it('lists channel rows alongside pool and free rows', async () => {
    const llm = fakeLlm({ models: { qoder: [{ id: 'Qwen3.8-Flash' }] } })
    const gateway = await gatewayWithChannel(llm)
    const ids = (await gateway.models()).map(row => row.id)
    expect(ids).toContain(`${POOL_MODEL_PREFIX}hy3`)
    expect(ids).toContain('qoder:Qwen3.8-Flash')
  })

  it('streams deltas and terminates the way an OpenAI client expects', async () => {
    const llm = fakeLlm({
      models: { qoder: [{ id: 'Qwen3.8-Flash' }] },
      chunks: { 'qoder/Qwen3.8-Flash': [
        { type: 'text-delta', index: 0, text: 'early' },
        { type: 'text-delta', index: 0, text: ' answer' },
        { type: 'finish', reason: { kind: 'stop' } },
      ] },
    })
    const gateway = await gatewayWithChannel(llm)
    const result = await gateway.call({
      model: 'qoder:Qwen3.8-Flash',
      messages: [{ role: 'user', content: 'hi' }],
    })
    expect(result.status).toBe(200)
    const lines = result.text.split('\n\n').filter(Boolean)
    // The terminator is a sentinel, not a frame: parse everything before it and
    // assert the sentinel separately, so a missing [DONE] fails on the sentinel
    // rather than as a JSON error three lines away.
    expect(lines.at(-1)).toBe('data: [DONE]')
    const frames = lines.slice(0, -1).map(line => JSON.parse(line.replace(/^data: /u, '')) as Record<string, any>)
    expect(frames[0].choices[0].delta.content).toBe('early')
    expect(frames[1].choices[0].delta.content).toBe(' answer')
    expect(frames[2].choices[0].finish_reason).toBe('stop')
    // The bare id, not the composite: a client caching by response.model must not
    // mint a new entry every turn.
    expect(frames[0].model).toBe('Qwen3.8-Flash')
  })

  it('forwards the host contract: array content, provider and model split out', async () => {
    const llm = fakeLlm({
      models: { qoder: [{ id: 'M' }] },
      chunks: { '*': [{ type: 'finish', reason: { kind: 'stop' } }] },
    })
    const gateway = await gatewayWithChannel(llm)
    await gateway.call({
      model: 'qoder:M',
      messages: [
        { role: 'system', content: 'be brief' },
        { role: 'user', content: 'hi' },
      ],
    })
    const sent = llm as unknown as { streamed: { provider: string; model: string; options: Record<string, any> }[] }
    expect(sent.streamed).toHaveLength(1)
    const call = sent.streamed[0]!
    expect(call.provider).toBe('qoder')
    expect(call.model).toBe('M')
    // A bare string here is the exact shape the host rejects with
    // `content.some is not a function` — the bug fixed in model-probe.ts.
    for (const message of call.options.messages) {
      expect(Array.isArray(message.content)).toBe(true)
    }
    expect(call.options.system).toEqual([{ type: 'text', text: 'be brief' }])
  })

  it('honours stream:false, unlike the pool lane which always streams', async () => {
    const llm = fakeLlm({
      models: { qoder: [{ id: 'M' }] },
      chunks: { '*': [
        { type: 'text-delta', index: 0, text: 'one' },
        { type: 'reasoning-delta', index: 0, text: 'hm' },
        { type: 'usage', usage: { input: 3, output: 1, total: 4 } },
        { type: 'finish', reason: { kind: 'stop' } },
      ] },
    })
    const gateway = await gatewayWithChannel(llm)
    const result = await gateway.call({ model: 'qoder:M', stream: false, messages: [{ role: 'user', content: 'hi' }] })
    expect(result.status).toBe(200)
    const body = JSON.parse(result.text) as Record<string, any>
    expect(body.object).toBe('chat.completion')
    expect(body.choices[0].message.content).toBe('one')
    expect(body.choices[0].message.reasoning_content).toBe('hm')
    expect(body.usage).toEqual({ prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 })
    // Not SSE: the whole point of honouring the flag.
    expect(result.text).not.toMatch(/^data: /mu)
  })

  it('reassembles a streamed tool call into one complete call', async () => {
    const llm = fakeLlm({
      models: { qoder: [{ id: 'M' }] },
      chunks: { '*': [
        { type: 'tool-call-delta', index: 0, id: 'call_9', name: 'read_file', argumentsDelta: '{"path"' },
        { type: 'tool-call-delta', index: 0, id: 'call_9', argumentsDelta: ': "a.ts"}' },
        { type: 'finish', reason: { kind: 'toolUse' } },
      ] },
    })
    const gateway = await gatewayWithChannel(llm)
    const result = await gateway.call({ model: 'qoder:M', stream: false, messages: [{ role: 'user', content: 'read it' }] })
    const body = JSON.parse(result.text) as Record<string, any>
    expect(body.choices[0].finish_reason).toBe('tool_calls')
    expect(body.choices[0].message.content).toBeNull()
    expect(body.choices[0].message.tool_calls).toHaveLength(1)
    expect(body.choices[0].message.tool_calls[0]).toMatchObject({
      id: 'call_9',
      function: { name: 'read_file', arguments: '{"path": "a.ts"}' },
    })
  })

  it('surfaces an upstream failure as a status, not an empty 200', async () => {
    const failing: ChannelLaneLlm = {
      listModels: async () => [{ id: 'M' }],
      stream() {
        return (async function* () {
          throw new Error('channel says no')
        })()
      },
    }
    const gateway = await gatewayWithChannel(failing)
    const result = await gateway.call({ model: 'qoder:M', messages: [{ role: 'user', content: 'hi' }] })
    expect(result.status).toBe(502)
    expect(result.text).toContain('channel says no')
  })
})

/** A real 1x1 PNG, so the byte path is exercised rather than stubbed away. */
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const PNG_URL = `data:image/png;base64,${PNG}`

/**
 * The image path.
 *
 * The lane used to emit `{ type: 'image', url }`. That is not a block the host
 * recognises — its `ImageBlock` names a durable `attachment` — so the picture was
 * dropped, the turn succeeded, and the model described an image it had never
 * received. Every assertion below is about the picture either ARRIVING as a
 * reference or the request FAILING LOUDLY; the third state is the bug.
 */
describe('image parts reach the host as durable attachments', () => {
  /** A store stand-in that records what was saved and returns a distinguishable ref. */
  function fakeStore(): ChannelLaneAttachments & { saved: { data: Uint8Array; mediaType: string }[] } {
    const saved: { data: Uint8Array; mediaType: string }[] = []
    return {
      saved,
      async saveImage(input: { data: Uint8Array; mediaType: string }) {
        saved.push({ data: input.data, mediaType: input.mediaType })
        return { id: `att-${saved.length}`, version: 1 }
      },
    }
  }

  /** The messages the fake host actually received. */
  function sentMessages(llm: ChannelLaneLlm): Record<string, any>[] {
    const streamed = (llm as unknown as { streamed: { options: Record<string, any> }[] }).streamed
    return streamed.at(-1)?.options.messages ?? []
  }

  it('carries a base64 image as an attachment reference, never as a url', async () => {
    const llm = fakeLlm({ models: { qoder: [{ id: 'M' }] }, chunks: { '*': [{ type: 'finish', reason: { kind: 'stop' } }] } })
    const store = fakeStore()
    const gateway = await gatewayWithChannel(llm, () => store)
    const result = await gateway.call({
      model: 'qoder:M',
      stream: false,
      messages: [{ role: 'user', content: [
        { type: 'text', text: '什么颜色' },
        { type: 'image_url', image_url: { url: PNG_URL } },
      ] }],
    })
    expect(result.status).toBe(200)
    // The bytes reached the store, under the media type the client declared.
    expect(store.saved).toHaveLength(1)
    expect(store.saved[0]!.mediaType).toBe('image/png')
    expect(Buffer.from(store.saved[0]!.data).equals(Buffer.from(PNG, 'base64'))).toBe(true)
    const blocks = sentMessages(llm).at(-1)!.content as Record<string, any>[]
    expect(blocks[0]).toEqual({ type: 'text', text: '什么颜色' })
    // The regression itself: an `image` block with a `url` reads as no image at
    // all downstream, and nothing along the path says so.
    expect(blocks[1]).toEqual({ type: 'image', attachment: { id: 'att-1', version: 1 } })
    for (const block of blocks) expect(block).not.toHaveProperty('url')
  })

  it('refuses a remote image URL with a 400 instead of fetching it', async () => {
    const llm = fakeLlm({ models: { qoder: [{ id: 'M' }] }, chunks: { '*': [] } })
    const store = fakeStore()
    const gateway = await gatewayWithChannel(llm, () => store)
    const result = await gateway.call({
      model: 'qoder:M',
      messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.test/a.png' } }] }],
    })
    expect(result.status).toBe(400)
    expect(result.text).toContain('not fetched')
    // Nothing was saved, and the upstream was never asked.
    expect(store.saved).toHaveLength(0)
    expect((llm as unknown as { streamed: unknown[] }).streamed).toHaveLength(0)
  })

  it('refuses a type the store will not hold, naming what it does accept', async () => {
    const llm = fakeLlm({ models: { qoder: [{ id: 'M' }] }, chunks: { '*': [] } })
    const gateway = await gatewayWithChannel(llm, () => fakeStore())
    const result = await gateway.call({
      model: 'qoder:M',
      messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/tiff;base64,AA==' } }] }],
    })
    expect(result.status).toBe(400)
    expect(result.text).toMatch(/png.*jpeg.*webp.*gif/u)
  })

  it('refuses an image when no attachment store is wired, rather than answering blind', async () => {
    // The build without `ctx.get('attachments')` is the dangerous one: dropping
    // the part here is what produced "the model says white" on a red square.
    const llm = fakeLlm({ models: { qoder: [{ id: 'M' }] }, chunks: { '*': [] } })
    const gateway = await gatewayWithChannel(llm)
    const result = await gateway.call({
      model: 'qoder:M',
      messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: PNG_URL } }] }],
    })
    expect(result.status).toBe(400)
    expect(result.text).toContain('attachment store')
  })

  it('leaves the store alone when no message carries an image', async () => {
    const llm = fakeLlm({ models: { qoder: [{ id: 'M' }] }, chunks: { '*': [{ type: 'finish', reason: { kind: 'stop' } }] } })
    const store = fakeStore()
    const gateway = await gatewayWithChannel(llm, () => store)
    expect((await gateway.call({ model: 'qoder:M', messages: [{ role: 'user', content: 'hi' }] })).status).toBe(200)
    expect(store.saved).toHaveLength(0)
  })

  it('reads the data URL forms the store can accept', () => {
    expect(interpretImagePart(PNG_URL)).toMatchObject({ ok: true, mediaType: 'image/png' })
    // `image/jpg` is the spelling clients actually send; the store knows jpeg.
    expect(interpretImagePart(`data:image/jpg;base64,${PNG}`)).toMatchObject({ ok: true, mediaType: 'image/jpeg' })
    expect(interpretImagePart('https://example.test/a.png').ok).toBe(false)
    expect(interpretImagePart('data:image/png,notbase64')).toMatchObject({ ok: false })
    expect(interpretImagePart('data:image/png;base64,')).toMatchObject({ ok: false })
    expect(interpretImagePart('data:text/plain;base64,aGk=')).toMatchObject({ ok: false })
    expect(interpretImagePart('some raw bytes').ok).toBe(false)
  })
})
