import { afterEach, describe, expect, it, vi } from 'vitest'
import { OutboundPipeline, type OutboundContext } from '../src/outbound.js'
import { makeCmdHarness, sentTexts } from './helpers/bridge-harness.js'

afterEach(() => vi.useRealTimers())

function fixture(splitShortTextBubbles = true) {
  const writes: Array<{ text: string; at: number }> = []
  const call = vi.fn(async (_action: string, params: Record<string, unknown>) => {
    const message = params.message as Array<{ type: string; data: { text: string } }>
    writes.push({ text: message.map(s => s.data.text).join(''), at: Date.now() })
    return { message_id: writes.length }
  })
  const context = { connected: () => true, selfId: () => '100000002', isStopping: () => false,
    getChat: () => undefined, log: vi.fn(), call,
    config: { botQQ: '100000002', sensitivePatterns: [], textImageThreshold: 0,
      maxImageBytes: 1000000, cardFooter: '', fontFiles: [], fontFamilies: [], splitShortTextBubbles },
  }
  return { pipeline: new OutboundPipeline(context as OutboundContext), writes, call }
}

describe('companion text bubbles', () => {
  it('splits short lines into distinct sends, trims blanks, and spaces sends by 300ms', async () => {
    vi.useFakeTimers()
    const { pipeline, writes } = fixture()
    const result = pipeline.sendToChat('private:100000001', '第一句\r\n\r\n 第二句 \n第三句', { queuable: true })
    await vi.runAllTimersAsync()
    expect(await result).toEqual(['1', '2', '3'])
    expect(writes.map(w => w.text)).toEqual(['第一句', '第二句', '第三句'])
    expect(writes[1].at - writes[0].at).toBe(300)
    expect(writes[2].at - writes[1].at).toBe(300)
  })

  it.each([
    ['a\nb\nc\nd\ne\nf', 6],
    ['a\nb\nc\nd\ne\nf\ng', 1],
    ['短句\n' + '长'.repeat(120), 2],
    ['短句\n' + '长'.repeat(121), 1],
    ['一句', 1],
  ])('preserves the six-line and 120-character limits: %s', async (text, count) => {
    vi.useFakeTimers()
    const { pipeline, writes } = fixture()
    const result = pipeline.sendToChat('private:100000001', text)
    await vi.runAllTimersAsync()
    await result
    expect(writes).toHaveLength(count)
    if (count === 1) expect(writes[0].text).toBe(text)
  })

  it('retains one bubble when disabled', async () => {
    const { pipeline, writes } = fixture(false)
    await pipeline.sendToChat('private:100000001', '第一句\n第二句')
    expect(writes.map(w => w.text)).toEqual(['第一句\n第二句'])
  })

  it('keeps all chunks ahead of the next reply in the same chat', async () => {
    vi.useFakeTimers()
    const { pipeline, writes } = fixture()
    const first = pipeline.sendToChat('private:100000001', '第一句\n第二句')
    const second = pipeline.sendToChat('private:100000001', '下一轮')
    await vi.runAllTimersAsync()
    await Promise.all([first, second])
    expect(writes.map(w => w.text)).toEqual(['第一句', '第二句', '下一轮'])
  })

  it('stops on an uncertain chunk failure without retrying or sending the remaining chunks', async () => {
    vi.useFakeTimers()
    const { pipeline, call, writes } = fixture()
    call.mockImplementationOnce(async () => ({ message_id: 1 }))
      .mockRejectedValueOnce(new Error('uncertain delivery'))
    const result = pipeline.sendToChat('private:100000001', '第一句\n第二句\n第三句')
      .then(() => undefined, error => error)
    await vi.runAllTimersAsync()
    expect(await result).toEqual(new Error('uncertain delivery'))
    expect(call).toHaveBeenCalledTimes(2)
    expect(writes).toHaveLength(0)
  })

  it('queues busy messages in order without a queue notice when disabled', async () => {
    const h = await makeCmdHarness({ newMessagePolicy: 'queue' })
    try {
      const config = (h.bridge as unknown as { deps: { config: { queueNoticeEnabled?: boolean } } }).deps.config
      config.queueNoticeEnabled = false
      h.sendText('启动任务')
      await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
      h.chats().get('private:10001')!.agent.status = 'running'
      h.sendText('排队一')
      await vi.waitFor(() => expect(h.captured.followups).toHaveLength(2))
      h.sendText('排队二')
      await vi.waitFor(() => expect(h.captured.followups).toHaveLength(3))
      expect(h.captured.followups[1].text).toContain('排队一')
      expect(h.captured.followups[2].text).toContain('排队二')
      expect(h.captured.steers).toHaveLength(0)
      expect(sentTexts(h.outbound)).toHaveLength(0)
    } finally {
      h.client.close()
      await h.bridge.stop()
      await h.connection.stop()
    }
  })
})
