import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it, vi } from 'vitest'
import { SessionRotation, SESSION_ROTATION_HOOK, type RotationHook, type RotationDeps } from '../src/session-rotation.js'
import { makeCmdHarness, makeEvent, sentTexts } from './helpers/bridge-harness.js'

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'qq-session-rotation-'))
  const request = { sessionId: 'old', receiptFile: join(dir, 'log.md'), receipt: '<!-- memory-idle-digest-test -->', compactions: 15 }
  writeFileSync(request.receiptFile, request.receipt)
  let chat = { chatId: 'private:123', sessionId: 'old', cwd: dir, nickname: 'owner' }, safe = true
  const titles: string[] = []
  const deps: RotationDeps = {
    current: id => chat.sessionId === id ? chat : undefined, byChat: () => chat, safe: () => safe,
    flush: vi.fn(async () => {}), reset: vi.fn(async () => {}),
    create: vi.fn(async () => { chat = { ...chat, sessionId: 'new' }; return chat }),
    restore: vi.fn(async () => { chat = { ...chat, sessionId: 'old' } }),
    finish: vi.fn(async (_next, title) => { titles.push(title) }), log: vi.fn(),
  }
  const path = join(dir, 'rotations.json'), rotation = new SessionRotation(path, deps)
  return { rotation, deps, request, dir, titles, path, setSafe(value: boolean) { safe = value } }
}

describe('automatic session rotation', () => {
  it('requires a saved receipt and an idle conversation', async () => {
    const h = fixture(); h.setSafe(false)
    expect((await h.rotation.request(h.request)).rotated).toBe(false)
    h.setSafe(true); writeFileSync(h.request.receiptFile, 'not saved')
    expect((await h.rotation.request(h.request)).rotated).toBe(false)
    expect(h.deps.reset).not.toHaveBeenCalled()
  })
  it('preserves the workspace, timestamps the successor, and journals the reminder route', async () => {
    const h = fixture(); const result = await h.rotation.request(h.request)
    expect(result).toMatchObject({ rotated: true, sessionId: 'new' })
    expect(h.deps.reset).toHaveBeenCalledWith('private:123', h.dir)
    expect(h.titles[0]).toMatch(/QQ 私聊｜\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}（北京时间）/)
    expect(h.rotation.route('old')).toBe('private:123')
    expect(JSON.parse(readFileSync(h.path, 'utf8')).records.old.status).toBe('complete')
    const restarted = new SessionRotation(h.path, h.deps)
    expect((await restarted.request(h.request)).sessionId).toBe('new')
    expect(h.deps.create).toHaveBeenCalledTimes(1)
  })
  it('rechecks user activity after flushing and before replacing the session', async () => {
    const h = fixture(); vi.mocked(h.deps.flush).mockImplementation(async () => { h.setSafe(false) })
    expect((await h.rotation.request(h.request)).rotated).toBe(false)
    expect(h.deps.reset).not.toHaveBeenCalled()
  })
  it('restores the old session if creating the successor fails', async () => {
    const h = fixture(); vi.mocked(h.deps.create).mockRejectedValue(Error('create failed'))
    expect((await h.rotation.request(h.request)).rotated).toBe(false)
    expect(h.deps.restore).toHaveBeenCalledWith('private:123', 'old')
    expect(JSON.parse(readFileSync(h.path, 'utf8')).records.old.status).toBe('failed')
  })
  it('coalesces concurrent requests for one session', async () => {
    const h = fixture(); const [a, b] = await Promise.all([h.rotation.request(h.request), h.rotation.request(h.request)])
    expect(a).toEqual(b); expect(h.deps.create).toHaveBeenCalledTimes(1)
  })
  it('recovers a committed new mapping after a crash without creating another session', async () => {
    const h = fixture(); await h.rotation.request(h.request)
    const journal = JSON.parse(readFileSync(h.path, 'utf8')); journal.records.old.status = 'pending'
    writeFileSync(h.path, JSON.stringify(journal))
    const restarted = new SessionRotation(h.path, h.deps); await restarted.recover()
    expect((await restarted.request(h.request)).sessionId).toBe('new')
    expect(h.deps.create).toHaveBeenCalledTimes(1)
  })
  it('new input during the final flush defers rotation and still steers into the old session', async () => {
    const h = await makeCmdHarness()
    let release: (() => void) | undefined
    try {
      const deps = (h.bridge as unknown as { deps: { config: { directSteerPrivateUsers?: string[]; compactionRotationEnabled?: boolean }; sessions: { flush: (session: unknown) => Promise<unknown> } } }).deps
      deps.config.directSteerPrivateUsers = ['10001']; deps.config.compactionRotationEnabled = true
      h.sendText('hello'); await vi.waitFor(() => expect(h.captured.steers).toHaveLength(1))
      const old = h.chats().get('private:10001')!
      const originalFlush = deps.sessions.flush.bind(deps.sessions)
      deps.sessions.flush = async session => {
        if (session === old.agent.session && !release) await new Promise<void>(resolve => { release = resolve })
        return originalFlush(session)
      }
      const receiptFile = join(h.mediaDir, 'receipt.md'), receipt = '<!-- memory-idle-digest-race -->'; writeFileSync(receiptFile, receipt)
      const hook = (globalThis as unknown as Record<symbol, RotationHook>)[SESSION_ROTATION_HOOK]
      const operation = hook.rotate({ sessionId: old.sessionId, receiptFile, receipt, compactions: 15 })
      await vi.waitFor(() => expect(release).toBeDefined())
      h.sendText('继续使用')
      await vi.waitFor(() => expect((h.bridge as unknown as { inboundInFlight: Map<string, number> }).inboundInFlight.get('private:10001')).toBe(1))
      release!(); expect((await operation).rotated).toBe(false)
      await vi.waitFor(() => expect(h.captured.steers).toHaveLength(2))
      expect(h.captured.steers[1].sessionId).toBe(old.sessionId)
    } finally { release?.(); h.client.close(); await h.bridge.stop(); await h.connection.stop() }
  })
  it('integrates with the actual registry, retaining workspace and forwarding only old scheduled turns', async () => {
    const h = await makeCmdHarness()
    try {
      const config = (h.bridge as unknown as { deps: { config: { directSteerPrivateUsers?: string[]; compactionRotationEnabled?: boolean } } }).deps.config
      config.directSteerPrivateUsers = ['10001']; config.compactionRotationEnabled = true
      h.sendText('hello'); await vi.waitFor(() => expect(h.captured.steers).toHaveLength(1))
      const old = h.chats().get('private:10001')!
      const receiptFile = join(h.mediaDir, 'receipt.md'), receipt = '<!-- memory-idle-digest-live-seam -->'
      writeFileSync(receiptFile, receipt)
      const hook = (globalThis as unknown as Record<symbol, RotationHook>)[SESSION_ROTATION_HOOK]
      const result = await hook.rotate({ sessionId: old.sessionId, receiptFile, receipt, compactions: 15 })
      expect(result.rotated).toBe(true)
      const next = h.chats().get('private:10001')!
      expect(next.sessionId).not.toBe(old.sessionId)
      expect(next.agent.session.header.cwd).toBe(old.agent.session.header.cwd)
      const emit = (type: string, data: unknown) => h.ctx.emit('session/event', { id: old.sessionId } as never, makeEvent(type, data))
      emit('turn/start', { turn: 2 }); emit('user/message', { source: { kind: 'user' } })
      emit('assistant/message', { message: { content: [{ type: 'text', text: '旧会话普通内容' }] } })
      emit('turn/end', { turn: 2, reason: { kind: 'completed' } })
      emit('turn/start', { turn: 3 }); emit('user/message', { source: { kind: 'schedule' } })
      emit('assistant/message', { message: { content: [{ type: 'text', text: '到点提醒' }] } })
      emit('turn/end', { turn: 3, reason: { kind: 'completed' } })
      await vi.waitFor(() => expect(sentTexts(h.outbound).some(t => t.includes('到点提醒'))).toBe(true))
      expect(sentTexts(h.outbound).some(t => t.includes('旧会话普通内容'))).toBe(false)
      h.sendText('new input'); await vi.waitFor(() => expect(h.captured.steers).toHaveLength(2))
      expect(h.captured.steers[1].sessionId).toBe(next.sessionId)
    } finally { h.client.close(); await h.bridge.stop(); await h.connection.stop() }
  })
})
