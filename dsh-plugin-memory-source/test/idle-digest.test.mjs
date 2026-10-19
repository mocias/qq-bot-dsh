import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { IdleDigestGuard } from '../lib/idle-digest.js'

function fixture(options = {}) {
  const dir = options.dir ?? mkdtempSync(join(tmpdir(), 'idle-digest-test-'))
  let now = 1_000_000, seq = 0, turn = 0
  const events = options.events ?? []
  if (events.length) seq = events.at(-1).seq + 1
  const listeners = new Map(), requests = [], cancelled = []
  const ctx = { on(name, fn) {
    const set = listeners.get(name) ?? new Set(); set.add(fn); listeners.set(name, set)
    return () => set.delete(fn)
  } }
  const emit = (name, ...args) => { for (const fn of [...(listeners.get(name) ?? [])]) fn(...args) }
  const config = { enabled: true, minTurns: 3, idleMinutes: 15, ...options.config }
  const agent = { id: options.id ?? 'private-agent', status: 'idle', ctx,
    session: { id: options.sessionId ?? 'onebot-private-123', ownEvents: () => events },
    inbox: { nextStep: [], nextTurn: [], remove(id) {
      for (const lane of [this.nextStep, this.nextTurn]) {
        const i = lane.findIndex(m => m.id === id)
        if (i >= 0) { lane.splice(i, 1); return true }
      }
      return false
    } },
    followup(m) { requests.push(m); this.inbox.nextTurn.push(m) },
    cancel(cause, opts) { cancelled.push({ cause, opts }) },
  }
  const guard = new IdleDigestGuard(agent, { getMemoryDir: () => dir, events: ctx,
    readConfig: () => config, now: () => now, pollIntervalMs: options.pollIntervalMs ?? 30000,
    rotationHook: options.rotationHook })
  guard.start()
  function event(type, data) {
    const item = { seq: seq++, time: now, type, data }; events.push(item)
    emit('session/event', agent.session, item)
    return item
  }
  function user() {
    const message = { id: 'user-' + seq + '-' + now, source: { kind: 'plugin:dsh-onebot' } }
    agent.inbox.nextStep.push(message)
    emit('agent/inbox/inserted', { agent, message })
    return message
  }
  function round(kind = 'plugin:dsh-onebot', reason = 'completed') {
    const message = kind === 'plugin:dsh-onebot' ? user() : { source: { kind } }
    agent.inbox.nextStep = []
    agent.status = 'running'; event('turn/start', { turn: ++turn })
    event('user/message', message)
    event('assistant/message', { message: { role: 'assistant', content: [{ type: 'text', text: 'reply' }] } })
    event('turn/end', { turn, reason: { kind: reason } }); agent.status = 'idle'
  }
  function claim() {
    const message = agent.inbox.nextTurn.shift()
    agent.status = 'running'; event('turn/start', { turn: ++turn })
    emit('agent/inbox/claimed', { agent, message, turn })
    event('user/message', message)
  }
  function compact({ error, withSummary = true, id = 'compact-' + seq } = {}) {
    if (withSummary) event('compaction/summary', { compactionId: id, summary: [{ type: 'text', text: '有来源的历史摘要' }], shadowedRange: { start: 1, end: 5 } })
    return event('compaction/end', { compactionId: id, turn, ...(error ? { error } : {}) })
  }
  function finish(receipt = true, reason = 'completed') {
    if (receipt && guard.state.pending) appendFileSync(join(dir, 'log.md'), guard.state.pending.receipt + '\n')
    event('assistant/message', { message: { role: 'assistant', content: [{ type: 'text', text: 'internal' }] } })
    event('turn/end', { turn, reason: { kind: reason } }); agent.status = 'idle'
  }
  return { dir, agent, guard, requests, cancelled, config, events, emit, event, round, user, claim, finish, compact,
    advance(ms) { now += ms }, dispose() { guard.dispose() } }
}

const idle = 15 * 60_000
test('no new human turns means no digest, even after long inactivity', () => {
  const h = fixture(); try { h.advance(24 * 3600_000); h.guard.check(); assert.equal(h.requests.length, 0) } finally { h.dispose() }
})
test('requires both three completed turns and a full 15-minute conversation gap', () => {
  const h = fixture(); try {
    h.round(); h.round(); h.advance(idle); h.guard.check(); assert.equal(h.requests.length, 0)
    h.round(); h.advance(idle - 1); h.guard.check(); assert.equal(h.requests.length, 0)
    h.advance(1); h.guard.check(); assert.equal(h.requests.length, 1)
  } finally { h.dispose() }
})
test('fresh user input resets idle even before a response or a turn has started', () => {
  const h = fixture(); try {
    for (let n = 0; n < 3; n++) h.round()
    h.advance(idle); h.user(); h.agent.inbox.nextStep = []; h.guard.check()
    assert.equal(h.requests.length, 0)
  } finally { h.dispose() }
})
test('busy agent and both inbox lanes prevent maintenance', () => {
  const h = fixture(); try {
    for (let n = 0; n < 3; n++) h.round(); h.advance(idle)
    h.agent.status = 'running'; h.guard.check(); assert.equal(h.requests.length, 0)
    h.agent.status = 'idle'; h.agent.inbox.nextTurn.push({ id: 'scheduled-work' })
    h.guard.check(); assert.equal(h.requests.length, 0)
    h.agent.inbox.nextTurn = []; h.agent.inbox.nextStep.push({ id: 'steer' })
    h.guard.check(); assert.equal(h.requests.length, 0)
  } finally { h.dispose() }
})
test('proactive messages do not count as human rounds and postpone the quiet window', () => {
  const h = fixture(); try {
    for (let n = 0; n < 6; n++) h.round('plugin:memory')
    h.advance(idle); h.guard.check(); assert.equal(h.requests.length, 0)
    for (let n = 0; n < 3; n++) h.round()
    h.advance(idle); h.round('plugin:memory'); h.guard.check(); assert.equal(h.requests.length, 0)
    h.advance(idle); h.guard.check(); assert.equal(h.requests.length, 1)
  } finally { h.dispose() }
})
test('only completed human turns count; multiple steers in one turn count once', () => {
  const h = fixture(); try {
    h.round('plugin:dsh-onebot', 'error'); h.round('plugin:dsh-onebot', 'aborted')
    assert.equal(h.guard.pendingTurns(), 0)
    h.event('turn/start', { turn: 50 }); h.event('user/message', h.user()); h.event('user/message', h.user())
    h.event('assistant/message', { message: {} }); h.event('turn/end', { turn: 50, reason: { kind: 'completed' } })
    assert.equal(h.guard.pendingTurns(), 1)
  } finally { h.dispose() }
})
test('successful receipt clears only pending work and never repeatedly digests an unchanged chat', () => {
  const h = fixture(); try {
    for (let n = 0; n < 3; n++) h.round(); h.advance(idle); h.guard.check(); h.guard.check()
    assert.equal(h.requests.length, 1)
    h.claim(); h.finish(); assert.equal(h.guard.pendingTurns(), 0)
    h.advance(7 * 24 * 3600_000); h.guard.check(); assert.equal(h.requests.length, 1)
    for (let n = 0; n < 3; n++) h.round(); h.advance(idle); h.guard.check(); assert.equal(h.requests.length, 2)
    h.claim(); h.finish()
    for (let n = 0; n < 3; n++) h.round(); h.advance(idle); h.guard.check(); assert.equal(h.requests.length, 3)
  } finally { h.dispose() }
})
test('a normal memory write is not a digest receipt; missing receipt retains pending turns', () => {
  const h = fixture(); try {
    for (let n = 0; n < 3; n++) h.round(); h.advance(idle); h.guard.check(); h.claim()
    writeFileSync(join(h.dir, 'log.md'), 'unrelated update\n'); h.finish(false)
    assert.equal(h.guard.pendingTurns(), 3); h.guard.check(); assert.equal(h.requests.length, 1)
    h.advance(idle); h.guard.check(); assert.equal(h.requests.length, 2)
  } finally { h.dispose() }
})
test('returning user removes only the pending digest and preserves user input', () => {
  const h = fixture(); try {
    for (let n = 0; n < 3; n++) h.round(); h.advance(idle); h.guard.check()
    const user = h.user()
    assert.equal(h.agent.inbox.nextTurn.length, 0); assert.equal(h.agent.inbox.nextStep[0], user)
    assert.equal(h.cancelled.length, 0); assert.equal(h.guard.pendingTurns(), 3)
  } finally { h.dispose() }
})
test('returning user interrupts active digest, preserving the native steer inbox and dirty rounds', () => {
  const h = fixture(); try {
    for (let n = 0; n < 3; n++) h.round(); h.advance(idle); h.guard.check(); h.claim()
    const user = h.user(); assert.equal(h.cancelled.length, 1)
    assert.deepEqual(h.cancelled[0].opts, { keepInbox: true })
    assert.equal(h.agent.inbox.nextStep[0], user); h.finish(false, 'aborted')
    assert.equal(h.guard.pendingTurns(), 3); h.guard.check(); assert.equal(h.requests.length, 1)
  } finally { h.dispose() }
})
test('checkpoints survive restart and replayed session events are not double counted', () => {
  const h = fixture(); h.round(); h.round(); h.dispose()
  const restored = fixture({ dir: h.dir, events: h.events })
  try {
    assert.equal(restored.guard.pendingTurns(), 2)
    restored.round(); restored.advance(idle); restored.guard.check(); assert.equal(restored.requests.length, 1)
  } finally { restored.dispose() }
})
test('installation does not re-digest already existing historical conversation', () => {
  const h = fixture(); for (let n = 0; n < 5; n++) h.round(); h.dispose()
  const restored = fixture({ events: h.events })
  try { restored.advance(idle); restored.guard.check(); assert.equal(restored.requests.length, 0) } finally { restored.dispose() }
})
test('polling fires while fully idle without another user message and dispose clears it', async () => {
  const h = fixture({ pollIntervalMs: 5 })
  for (let n = 0; n < 3; n++) h.round(); h.advance(idle)
  await new Promise(resolve => setTimeout(resolve, 25))
  assert.equal(h.requests.length, 1); h.dispose(); assert.equal(h.guard.timer, undefined)
})
test('corrupt checkpoint is preserved and disables maintenance instead of losing state', () => {
  const h = fixture(); h.dispose()
  const path = join(h.dir, '.runtime', 'idle-digest.json'); writeFileSync(path, 'corrupt')
  const restored = fixture({ dir: h.dir })
  try { restored.guard.check(); assert.equal(restored.requests.length, 0); assert.equal(readFileSync(path, 'utf8'), 'corrupt') } finally { restored.dispose() }
})

const compactConfig = { mode: 'compaction-idle', idleMinutes: 30, rotateAfterCompactions: 15 }
test('compaction mode ignores conversation count and needs successful compression plus 30 quiet minutes', () => {
  const h = fixture({ config: compactConfig }); try {
    for (let n = 0; n < 10; n++) h.round(); h.advance(60 * 60000); h.guard.check(); assert.equal(h.requests.length, 0)
    h.compact({ error: 'failed' }); h.compact({ withSummary: false }); h.guard.check(); assert.equal(h.requests.length, 0)
    h.compact(); h.advance(30 * 60000 - 1); h.guard.check(); assert.equal(h.requests.length, 0)
    h.advance(1); h.guard.check(); assert.equal(h.requests.length, 1)
    const text = h.requests[0].content[0].text; assert.match(text, /压缩摘要资料文件/); assert.match(text, /30 分钟/)
    assert.equal(h.guard.state.compactions.length, 1)
  } finally { h.dispose() }
})
test('compression checkpoint is acknowledged once; later compression requires another quiet window', () => {
  const h = fixture({ config: compactConfig }); try {
    h.compact(); h.advance(30 * 60000); h.guard.check(); h.claim(); h.finish()
    h.advance(2 * 86400_000); h.guard.check(); assert.equal(h.requests.length, 1)
    h.compact(); h.advance(30 * 60000); h.guard.check(); assert.equal(h.requests.length, 2)
  } finally { h.dispose() }
})
test('maintenance compression is included in its receipt, preventing digest recursion', () => {
  const h = fixture({ config: compactConfig }); try {
    h.compact(); h.advance(30 * 60000); h.guard.check(); h.claim(); h.compact(); h.finish()
    h.advance(30 * 60000); h.guard.check(); assert.equal(h.requests.length, 1)
    assert.equal(h.guard.pendingCompactions().length, 0)
  } finally { h.dispose() }
})
test('fifteen compressions rotate only after a successful saved digest and do not double rotate', async () => {
  const rotations = []
  const h = fixture({ config: compactConfig, rotationHook: () => ({ isCurrent: () => true,
    rotate: async request => { rotations.push(request); return { rotated: true, sessionId: 'successor' } } }) })
  try {
    for (let n = 0; n < 15; n++) h.compact()
    h.advance(30 * 60000); h.guard.check(); assert.equal(rotations.length, 0)
    h.claim(); h.finish(false); h.guard.check(); assert.equal(rotations.length, 0)
    h.advance(30 * 60000); h.guard.check(); h.claim(); h.finish(); h.guard.check()
    await h.guard.rotationInFlight
    assert.equal(rotations.length, 1); assert.equal(rotations[0].compactions, 15)
    h.guard.check(); assert.equal(rotations.length, 1)
  } finally { h.dispose() }
})
test('returning user prevents rotation until its newer conversation is also captured', async () => {
  let rotations = 0
  const h = fixture({ config: compactConfig, rotationHook: () => ({ isCurrent: () => true,
    rotate: async () => { rotations++; return { rotated: true, sessionId: 'successor' } } }) })
  try {
    for (let n = 0; n < 15; n++) h.compact()
    h.advance(30 * 60000); h.guard.check(); h.claim(); h.finish()
    h.advance(1); h.round(); h.advance(30 * 60000); h.guard.check(); assert.equal(rotations, 0)
    h.compact(); h.advance(30 * 60000); h.guard.check(); h.claim(); h.finish(); h.guard.check()
    await h.guard.rotationInFlight; assert.equal(rotations, 1)
  } finally { h.dispose() }
})
test('successful compression counts survive restart without duplicate end events', () => {
  const h = fixture({ config: compactConfig }); const ended = h.compact()
  h.emit('session/event', h.agent.session, ended); h.dispose()
  const restored = fixture({ config: compactConfig, dir: h.dir, events: h.events })
  try { assert.equal(restored.guard.state.compactions.length, 1); restored.advance(30 * 60000); restored.guard.check(); assert.equal(restored.requests.length, 1) } finally { restored.dispose() }
})
test('qq.4 checkpoints migrate historical successful compression without recounting conversation turns', () => {
  const h = fixture(); h.round(); h.compact(); h.dispose()
  const path = join(h.dir, '.runtime', 'idle-digest.json'), all = JSON.parse(readFileSync(path, 'utf8'))
  const record = all.sessions[h.agent.session.id]
  delete record.compactions; delete record.openCompactions; delete record.digestedCompactionSeq
  writeFileSync(path, JSON.stringify(all))
  const restored = fixture({ config: compactConfig, dir: h.dir, events: h.events })
  try { assert.equal(restored.guard.state.totalTurns, 1); assert.equal(restored.guard.state.compactions.length, 1) } finally { restored.dispose() }
})
