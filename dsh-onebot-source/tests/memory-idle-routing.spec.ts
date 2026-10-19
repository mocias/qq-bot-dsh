import { describe, expect, it, vi } from 'vitest'
import { makeCmdHarness, makeEvent, sentTexts } from './helpers/bridge-harness.js'

describe('idle memory maintenance and owner steering', () => {
  it('does not return owner messages to the ordinary follow-up queue', async () => {
    const h = await makeCmdHarness()
    try {
      const config = (h.bridge as unknown as { deps: { config: { directSteerPrivateUsers?: string[] } } }).deps.config
      config.directSteerPrivateUsers = ['10001']
      h.sendText('开始任务')
      await vi.waitFor(() => expect(h.captured.steers).toHaveLength(1))
      h.chats().get('private:10001')!.agent.status = 'running'
      h.sendText('刚才的要求改成这一条')
      await vi.waitFor(() => expect(h.captured.steers).toHaveLength(2))
      expect(h.captured.followups).toHaveLength(0)
      expect(h.captured.steers[1].text).toContain('刚才的要求改成这一条')
      expect(sentTexts(h.outbound)).toHaveLength(0)
    } finally { h.client.close(); await h.bridge.stop(); await h.connection.stop() }
  })

  it.each(['completed', 'error'])('keeps %s maintenance silent, then delivers the next real user reply', async reason => {
    const h = await makeCmdHarness({ interimMessages: false })
    try {
      h.sendText('创建会话')
      await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
      const session = { id: h.sessionIds[0] }
      const emit = (type: string, data: unknown) => h.ctx.emit('session/event', session as never, makeEvent(type, data))
      emit('turn/start', { turn: 1 })
      emit('user/message', { id: 'memory-idle-digest-test', source: { kind: 'plugin:memory' } })
      emit('assistant/message', { message: { role: 'assistant', content: [{ type: 'text', text: '内部整理报告' }] } })
      emit('turn/end', { turn: 1, reason: reason === 'error' ? { kind: 'error', error: { message: 'digest failed' } } : { kind: 'completed' } })
      await new Promise(resolve => setTimeout(resolve, 50))
      expect(sentTexts(h.outbound)).toHaveLength(0)
      emit('turn/start', { turn: 2 })
      emit('user/message', { id: 'real-user', source: { kind: 'plugin:dsh-onebot' } })
      emit('assistant/message', { message: { role: 'assistant', content: [{ type: 'text', text: '正常回复' }] } })
      emit('turn/end', { turn: 2, reason: { kind: 'completed' } })
      await vi.waitFor(() => expect(sentTexts(h.outbound).some(text => text.includes('正常回复'))).toBe(true))
      expect(sentTexts(h.outbound).some(text => text.includes('内部整理'))).toBe(false)
    } finally { h.client.close(); await h.bridge.stop(); await h.connection.stop() }
  })
})
