import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { readRecallPolicy, RecallSchedule, withinActiveHours } from '../lib/recall-policy.js'

const policy = { enabled: true, timeZone: 'Asia/Shanghai', activeHours: { start: '09:00', end: '23:00' },
  intervalMinMinutes: 120, intervalMaxMinutes: 360, maxPerDay: 2 }
const at = value => Date.parse(value + '+08:00')

test('quiet hours use Shanghai time including boundaries and overnight windows', () => {
  assert.equal(withinActiveHours(at('2026-10-19T08:59:00'), policy), false)
  assert.equal(withinActiveHours(at('2026-10-19T09:00:00'), policy), true)
  assert.equal(withinActiveHours(at('2026-10-19T22:59:00'), policy), true)
  assert.equal(withinActiveHours(at('2026-10-19T23:00:00'), policy), false)
  const overnight = { ...policy, activeHours: { start: '22:00', end: '02:00' } }
  assert.equal(withinActiveHours(at('2026-10-20T01:00:00'), overnight), true)
  assert.equal(withinActiveHours(at('2026-10-20T12:00:00'), overnight), false)
})

test('daily cap and next trigger survive restart; new conversation postpones recall', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qq-memory-policy-'))
  try {
    const path = join(dir, 'state.json')
    let schedule = new RecallSchedule(path, 'onebot-private-12345', () => 0)
    const start = at('2026-10-19T09:00:00')
    assert.equal(schedule.due(start, policy, start), false)
    schedule = new RecallSchedule(path, 'onebot-private-12345', () => 0)
    assert.equal(schedule.due(start + 119 * 60000, policy, start), false)
    assert.equal(schedule.due(start + 120 * 60000, policy, start), true)
    schedule.reserve(start + 120 * 60000, policy)
    schedule = new RecallSchedule(path, 'onebot-private-12345', () => 0)
    assert.equal(schedule.due(start + 240 * 60000, policy, start), true)
    schedule.reserve(start + 240 * 60000, policy)
    assert.equal(schedule.due(start + 360 * 60000, policy, start), false)
    const tomorrow = at('2026-10-20T09:00:00')
    assert.equal(schedule.due(tomorrow, policy, start), true)
    assert.equal(schedule.due(tomorrow, policy, tomorrow), false)
    assert.equal(schedule.due(tomorrow + 120 * 60000, policy, tomorrow), true)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('persona may change policy live; invalid config prevents scheduling', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qq-memory-edit-'))
  try {
    const path = join(dir, 'proactive.json')
    writeFileSync(path, JSON.stringify(policy))
    assert.equal(readRecallPolicy(path).maxPerDay, 2)
    writeFileSync(path, JSON.stringify({ ...policy, maxPerDay: 3, intervalMinMinutes: 180 }))
    assert.equal(readRecallPolicy(path).maxPerDay, 3)
    writeFileSync(path, JSON.stringify({ ...policy, intervalMinMinutes: 500 }))
    assert.throws(() => readRecallPolicy(path), /invalid recall/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
