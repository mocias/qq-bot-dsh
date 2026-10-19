import assert from 'node:assert/strict'
import test from 'node:test'
import { desktopReady } from '../lib/desktop-availability.js'
import { buildRecallNudgeMessage } from '../lib/recall-nudge.js'

test('autonomous UI wakeups require an accessible idle desktop', () => {
  assert.equal(desktopReady(undefined, {}), false)
  assert.equal(desktopReady({ interactive: false, idleSeconds: 999 }, {}), false)
  assert.equal(desktopReady({ interactive: true, idleSeconds: 119 }, {}), false)
  assert.equal(desktopReady({ interactive: true, idleSeconds: 120 }, {}), true)
  assert.equal(desktopReady({ interactive: true, idleSeconds: 60 }, { desktopIdleSeconds: 30 }), true)
})

test('autonomous prompt requires task selection, UI verification and stopping on interruption', () => {
  const text = buildRecallNudgeMessage(['真实经历'], { autonomousActions: true }).content[0].text
  assert.match(text, /DESKTOP.md/)
  assert.match(text, /重新观察核验/)
  assert.match(text, /立即结束/)
  assert.match(text, /安静结束/)
  assert.doesNotMatch(text, /小蓝|阿周/)
  assert.doesNotMatch(buildRecallNudgeMessage([]).content[0].text, /自主行动唤醒/)
})
