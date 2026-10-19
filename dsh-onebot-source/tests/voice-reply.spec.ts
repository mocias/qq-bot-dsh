import { afterEach, describe, expect, it, vi } from 'vitest'
import { OutboundPipeline, type OutboundContext } from '../src/outbound.js'
import { VOICE_REPLY_HOOK, voiceRequest } from '../src/voice-reply.js'
const globalHooks = globalThis as unknown as Record<symbol, unknown>
afterEach(() => { delete globalHooks[VOICE_REPLY_HOOK] })
function fixture() {
  const writes: Array<Record<string, unknown>> = []
  const call = vi.fn(async (_action: string, params: Record<string, unknown>) => { writes.push(params); return { message_id: 17 } })
  const context = { connected: () => true, selfId: () => '100000002', isStopping: () => false,
    getChat: () => undefined, log: vi.fn(), call,
    config: { botQQ: '100000002', sensitivePatterns: [], textImageThreshold: 0, maxImageBytes: 1000000, cardFooter: '', fontFiles: [], fontFamilies: [] },
  } satisfies OutboundContext
  return { pipeline: new OutboundPipeline(context), writes, call }
}
describe('model-selected QQ voice final replies', () => {
  it('recognizes only a complete voice block, not a marker quoted inside normal text', () => {
    expect(voiceRequest('[[qq_voice]]你好[[/qq_voice]]')).toBe('你好')
    expect(voiceRequest('示例：[[qq_voice]]你好[[/qq_voice]]')).toBeUndefined()
  })
  it('sends exactly one record, preserving the original target and FIFO', async () => {
    const { pipeline, writes } = fixture()
    globalHooks[VOICE_REPLY_HOOK] = { prepare: vi.fn(async () => ({ segments: [{ type: 'record', data: { file: 'base64://audio' } }] })) }
    const ids = await pipeline.sendToChat('private:100000001', '[[qq_voice]]你好[[/qq_voice]]', { queuable: true })
    expect(ids).toEqual(['17']); expect(writes).toHaveLength(1)
    expect(writes[0]).toMatchObject({ user_id: 100000001, message: [{ type: 'record' }] })
  })
  it('normal typing and progress messages do not invoke synthesis', async () => {
    const { pipeline, writes } = fixture(); const prepare = vi.fn()
    globalHooks[VOICE_REPLY_HOOK] = { prepare }
    await pipeline.sendToChat('private:100000001', '普通文字', { queuable: true })
    await pipeline.sendToChat('private:100000001', '[[qq_voice]]进度[[/qq_voice]]')
    expect(prepare).not.toHaveBeenCalled();expect(writes).toHaveLength(2)
  })
  it('synthesis failure falls back to one text reply with no control markers', async () => {
    const { pipeline, writes } = fixture()
    globalHooks[VOICE_REPLY_HOOK] = { prepare: async () => { throw Error('mock synthesis failure') } }
    await pipeline.sendToChat('private:100000001', '[[qq_voice]]你好[[/qq_voice]]', { queuable: true })
    expect(writes).toHaveLength(1);expect(JSON.stringify(writes)).toContain('你好');expect(JSON.stringify(writes)).not.toContain('qq_voice')
  })
  it('text preference uses one text reply', async () => {
    const { pipeline, writes } = fixture()
    globalHooks[VOICE_REPLY_HOOK] = { prepare: async (_chat: string, text: string) => ({ text, reason: 'text_preference' }) }
    await pipeline.sendToChat('private:100000001', '[[qq_voice]]你好[[/qq_voice]]', { queuable: true })
    expect(writes).toHaveLength(1);expect(writes[0].message).toEqual([{ type: 'text', data: { text: '你好' } }])
  })
  it('uncertain voice send failure does not retry or send an additional text', async () => {
    const { pipeline, call } = fixture()
    globalHooks[VOICE_REPLY_HOOK] = { prepare: async () => ({ segments: [{ type: 'record', data: { file: 'base64://audio' } }] }) }
    call.mockRejectedValueOnce(Error('timeout'))
    await expect(pipeline.sendToChat('private:100000001', '[[qq_voice]]你好[[/qq_voice]]', { queuable: true })).rejects.toThrow('timeout')
    expect(call).toHaveBeenCalledTimes(1)
  })
})
