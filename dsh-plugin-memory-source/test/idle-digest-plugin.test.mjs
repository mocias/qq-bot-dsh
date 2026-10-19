import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { apply } from '../lib/index.js'

for (const mode of ['conversation-idle', 'compaction-idle']) test(`${mode} attaches to an existing QQ agent, updates prompts, guards sends, and cleans up`, t => {
  const dir = mkdtempSync(join(tmpdir(), 'idle-digest-plugin-'))
  writeFileSync(join(dir, 'SOUL.md'), '# 已定义的人设\n这是有实际内容的测试人格。\n')
  writeFileSync(join(dir, 'BOOTSTRAP.md'), 'status: complete\n')
  writeFileSync(join(dir, 'index.md'), '# index\n')
  writeFileSync(join(dir, 'MEMORY.md'), '# Memory\n')
  let now = 1_000_000, seq = 0, cancelled = 0
  t.mock.method(Date, 'now', () => now)
  const polls = [], cleared = [], guards = [], contexts = [], skills = [], effects = [], listeners = new Map()
  t.mock.method(globalThis, 'setInterval', fn => { const timer = { fn, unref() {} }; polls.push(timer); return timer })
  t.mock.method(globalThis, 'clearInterval', timer => cleared.push(timer))
  const on = (event, fn) => { const set = listeners.get(event) ?? new Set(); set.add(fn); listeners.set(event, set); return () => set.delete(fn) }
  const emit = (name, ...args) => { for (const fn of [...(listeners.get(name) ?? [])]) fn(...args) }
  const agentCtx = { on, effect(fn) { const stop = fn(); effects.push(stop); return stop } }
  const agent = { id: 'owner', status: 'idle', ctx: agentCtx,
    session: { id: 'onebot-private-123', ownEvents() { return [] } },
    inbox: { nextStep: [], nextTurn: [], remove(id) { const i = this.nextTurn.findIndex(m => m.id === id); if (i < 0) return false; this.nextTurn.splice(i, 1); return true } },
    followup(message) { this.inbox.nextTurn.push(message) }, cancel() { cancelled++ },
  }
  const ctx = { ...agentCtx, logger: { info() {}, warn() {} },
    systemPrompt: { context(value) { contexts.push(value); return () => {} } },
    skills: { register(value) { skills.push(value); return () => {} } },
    agents: { roots() { return [agent] }, get(id) { return id === agent.id ? agent : undefined } },
    inject(names, callback) { if (names.length === 1 && names[0] === 'tools') callback({ tools: { guard(fn) { guards.push(fn) } } }) },
  }
  const dispose = apply(ctx, { memoryDir: dir, configFile: join(dir, 'config.json'),
    sessionPrefixes: ['onebot-private-123'], userMessageSourceKinds: ['plugin:dsh-onebot'],
    deferUntilUserSpeaks: false, activeSessionOnly: false, scaffold: false, trackPageAccess: false,
    recallEnabled: false, autoCommit: false, digestNudgeEnabled: true,
    digestNudgeMode: mode, digestMinTurns: 3, digestIdleMinutes: mode === 'compaction-idle' ? 30 : 15 })
  try {
    const boot = contexts.find(c => c.name === 'memory-boot').text({ agent })
    assert.match(boot, /日常后台整理只在收到【空闲记忆整理】/)
    assert.doesNotMatch(boot, /每次会话收尾前必须/)
    assert.match(skills[0].content, /后台整理时机/)
    assert.doesNotMatch(skills[0].content, /digest 是强制义务/)
    const event = (type, data) => emit('session/event', agent.session, { seq: seq++, time: now, type, data })
    for (let turn = 1; turn <= 3; turn++) {
      event('turn/start', { turn }); event('user/message', { source: { kind: 'plugin:dsh-onebot' } })
      event('assistant/message', { message: {} }); event('turn/end', { turn, reason: { kind: 'completed' } })
    }
    if (mode === 'compaction-idle') {
      const log = []
      agent.session.ownEvents = () => log
      const summary = { seq: seq++, time: now, type: 'compaction/summary', data: { compactionId: 'c1', summary: [{ type: 'text', text: '摘要' }] } }
      const end = { seq: seq++, time: now, type: 'compaction/end', data: { compactionId: 'c1', turn: null } }
      log.push(summary, end); emit('session/event', agent.session, summary); emit('session/event', agent.session, end)
    }
    assert.equal(polls.length, 1); polls[0].fn(); assert.equal(agent.inbox.nextTurn.length, 0)
    now += (mode === 'compaction-idle' ? 30 : 15) * 60_000; polls[0].fn(); assert.equal(agent.inbox.nextTurn.length, 1)
    const digest = agent.inbox.nextTurn.shift(); agent.status = 'running'
    event('turn/start', { turn: 4 }); event('user/message', digest)
    assert.match(guards[0]({ name: 'qq_send_text', agent }), /内部记忆整理/)
    assert.equal(guards[0]({ name: 'read_file', agent }), undefined)
    const input = { source: { kind: 'plugin:dsh-onebot' } }; agent.inbox.nextStep.push(input)
    emit('agent/inbox/inserted', { agent, message: input })
    assert.equal(cancelled, 1); assert.equal(agent.inbox.nextStep[0], input)
  } finally { dispose(); for (const cleanup of effects) cleanup?.() }
  assert.ok(cleared.includes(polls[0]))
})
