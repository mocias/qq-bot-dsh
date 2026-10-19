import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { apply } from '../lib/index.js'

test('memory boot is confined to the approved QQ session and its continuations', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qq-memory-scope-'))
  const contexts = []
  const ctx = {
    systemPrompt: { context(value) { contexts.push(value); return () => {} } },
    skills: { register() { return () => {} } },
    agents: { roots() { return [] } },
    logger: { info() {}, warn() {} },
    on() { return () => {} }, inject() {}, effect(fn) { return fn() },
  }
  try {
    const dispose = apply(ctx, { memoryDir: dir, configFile: join(dir, 'config.json'),
      sessionPrefixes: ['onebot-private-12345'], deferUntilUserSpeaks: false,
      activeSessionOnly: false, recallEnabled: false, digestNudgeEnabled: false, autoCommit: false })
    const boot = contexts.find(c => c.name === 'memory-boot')
    const textFor = id => boot.text({ agent: { id, session: { id } } })
    assert.match(textFor('onebot-private-12345'), /SOUL/)
    assert.match(textFor('onebot-private-12345-new'), /SOUL/)
    assert.equal(textFor('onebot-private-123456'), '')
    assert.equal(textFor('unrelated-desktop-session'), '')
    assert.equal(boot.text({}), '')
    dispose()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
