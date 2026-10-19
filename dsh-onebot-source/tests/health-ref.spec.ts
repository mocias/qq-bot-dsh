/**
 * W3/T4 (P3) 诊断参考号体系回归测试：一次故障一个参考号，凭号查日志。
 *
 * 断言面（对齐任务书验收）：
 * - 连接/桥类故障 → QQ-CONN-<ts><rand>：真实 EADDRINUSE 路径触发，日志行 /
 *   trace jsonl（stage=connection、reason 齐全、data.ref 同号）/ healthcheck
 *   报告三处同号逐字相等。
 * - 消息回合故障 → MF-<ts><rand>：⚠️ 运行出错文案尾部附号，trace jsonl 同号
 *   事件 stage/reason 齐全，结构化日志行与 /healthcheck 报告同号；同一故障
 *   QQ 文案 / trace 行 / 报告三处同号逐字相等。
 * - T3 deferred 错误终态：补发终态通知带同号（不再重复 ⚠️）。
 * - /retry 失败：⚠️ 重试失败 + MF- 号（trace stage=command 同号）。
 * - 正常回复路径零发号（无 MF-/QQ-CONN- 命中、报告「最近故障参考号：无」、
 *   export 文件名保持无号基线形态）。
 * - export 文件名模式：省略参考号自动用最近故障号；显式传号逐字入名；非法
 *   参考号回 usage 不落盘。
 * 时序纪律：vi.waitFor 文本确定性等待；deferred 单元用构造器注入假调度器。
 * @module dsh-onebot/tests/health-ref
 */
import { describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'
import { WebSocketServer } from 'ws'

import { OneBotConnection } from '../src/connection.js'
import { TraceSink, TRACE_FILE } from '../src/trace.js'
import { DEFERRED_REGISTRY_FILE } from '../src/deferred.js'
import { FAILURE_REF_DETAIL_MAX, FailureRefRegistry, isFailureRef, newFailureRef } from '../src/ref.js'

import { makeCmdHarness, makeEvent, makeHarness, sentTexts } from './helpers/bridge-harness.js'

/** Trace jsonl 读取助手：逐行解析为事件数组（坏行跳过）。 */
function readTrace(mediaDir: string): Array<Record<string, unknown>> {
  const file = join(mediaDir, TRACE_FILE)
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8').split('\n').filter(l => l.trim() !== '')
    .map(l => JSON.parse(l) as Record<string, unknown>)
}

const stopAll = async (h: { client: WebSocket; bridge: { stop(): Promise<void> }; connection: { stop(): Promise<void> } }): Promise<void> => {
  h.client.close()
  await h.bridge.stop()
  await h.connection.stop()
}

const flush = async (): Promise<void> => { await new Promise(resolve => setTimeout(resolve, 0)) }

describe('参考号生成与注册表（src/ref.ts）', () => {
  it('格式：QQ-CONN-/MF- 前缀 + base36 时间戳 + 随机尾；不含用户内容；可注入确定性', () => {
    const ref1 = newFailureRef('conn', { now: 1_700_000_000_000, random: () => 0.5 })
    const ref2 = newFailureRef('msg', { now: 1_700_000_000_000, random: () => 0 })
    expect(ref1).toMatch(/^QQ-CONN-[a-z0-9]+$/)
    expect(ref2).toMatch(/^MF-[a-z0-9]+$/)
    expect(ref1.startsWith('QQ-CONN-' + (1_700_000_000_000).toString(36))).toBe(true)
    expect(isFailureRef(ref1)).toBe(true)
    expect(isFailureRef(ref2)).toBe(true)
    expect(isFailureRef('bogus')).toBe(false)
    expect(isFailureRef('MF-;rm -rf')).toBe(false)
    expect(newFailureRef('msg', { now: 1, random: () => 0 })).not.toBe(newFailureRef('conn', { now: 1, random: () => 0 }))
  })

  it('注册表有界：超出容量丢最旧；detail 截断到上限', () => {
    const registry = new FailureRefRegistry(3)
    for (let i = 0; i < 5; i++) {
      registry.record({ ref: 'MF-' + i, kind: 'msg', ts: i, stage: 'agent', detail: 'x'.repeat(300) })
    }
    const recent = registry.recent()
    expect(recent.map(r => r.ref)).toEqual(['MF-2', 'MF-3', 'MF-4'])
    expect(recent[0]!.detail.length).toBe(FAILURE_REF_DETAIL_MAX)
    expect(registry.recent(1)[0]!.ref).toBe('MF-4')
  })
})

describe('连接故障 → QQ-CONN- 号贯穿（真实 EADDRINUSE 路径）', () => {
  it('绑定失败：日志行/trace jsonl（stage=connection）/healthcheck 报告三处同号逐字相等', async () => {
    const mediaDir = mkdtempSync(join(tmpdir(), 'onebot-ref-conn-'))
    const sink = new TraceSink({ dir: mediaDir })
    const h = await makeHarness({ mediaDir, trace: sink })
    const connLog: string[] = []
    // 第二个反向连接绑到已被 harness 占用的端口 → EADDRINUSE（attempt 1 立即记错并发号）
    const conn2 = new OneBotConnection({
      mode: 'reverse', host: '127.0.0.1', port: h.connection.address()!.port, url: '', accessToken: 'test-token', callTimeoutMs: 1_000,
      log: (_level, message) => connLog.push(message),
    })
    conn2.onFailure = (stage, detail) => h.bridge.registerConnectionFailure(stage, detail)
    conn2.start()
    let ref = ''
    await vi.waitFor(() => {
      const hit = /QQ-CONN-[a-z0-9]+/.exec(connLog.join('\n'))
      expect(hit).not.toBeNull()
      ref = hit![0]
    })
    expect(connLog.join('\n')).toContain('（参考号 ' + ref + '）')
    expect(connLog.join('\n')).toContain('EADDRINUSE')

    // trace jsonl：同号事件 ≥1 行，stage/reason/data.ref 齐全
    await sink.flush()
    const events = readTrace(mediaDir).filter(e => e.data !== undefined && (e.data as { ref?: string }).ref === ref)
    expect(events.length).toBeGreaterThanOrEqual(1)
    expect(events[0]!.stage).toBe('connection')
    expect(events[0]!.ok).toBe(false)
    expect(String(events[0]!.reason)).toContain('EADDRINUSE')

    // /healthcheck 报告：最近故障参考号节含同号（与日志/trace 逐字相等）
    h.sendText('/healthcheck')
    await vi.waitFor(() => expect(sentTexts(h.outbound).some(t => t.includes('最近故障参考号'))).toBe(true))
    const report = sentTexts(h.outbound).find(t => t.includes('最近故障参考号'))!
    expect(report).toContain('grep 任一参考号')
    expect(report).toContain(ref)

    await conn2.stop()
    await stopAll(h)
  }, 30_000)
})

describe('消息回合故障 → MF- 号贯穿', () => {
  it('turn/end error：⚠️ 文案尾号 / trace stage=agent / 结构化日志 / 报告三处同号逐字相等', async () => {
    const mediaDir = mkdtempSync(join(tmpdir(), 'onebot-ref-msg-'))
    const sink = new TraceSink({ dir: mediaDir })
    const logs: string[] = []
    const h = await makeHarness({ mediaDir, trace: sink, log: (level, message) => logs.push(level + ' ' + message) })
    h.sendText('你好')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    h.ctx.emit('session/event', { id: h.sessionIds[0] } as never, makeEvent('turn/end', { turn: 1, reason: { kind: 'error', error: { message: '模型额度不足' } } }))

    await vi.waitFor(() => expect(sentTexts(h.outbound).some(t => t.includes('⚠️ 运行出错'))).toBe(true))
    const notice = sentTexts(h.outbound).find(t => t.includes('⚠️ 运行出错'))!
    const ref = /MF-[a-z0-9]+/.exec(notice)![0]
    expect(notice).toContain('模型额度不足')
    expect(notice).toContain('（参考号 ' + ref + '，可凭此号在 qq-trace.jsonl 中检索本次故障全过程）')

    // trace jsonl：同号事件 stage=agent、ok=false、reason 齐全
    await sink.flush()
    const events = readTrace(mediaDir).filter(e => e.data !== undefined && (e.data as { ref?: string }).ref === ref)
    expect(events.length).toBeGreaterThanOrEqual(1)
    expect(events[0]!.stage).toBe('agent')
    expect(events[0]!.ok).toBe(false)
    expect(String(events[0]!.reason)).toContain('模型回合出错')
    expect(String(events[0]!.reason)).toContain('模型额度不足')

    // 结构化日志行同号
    expect(logs.some(l => l.includes('故障参考号 ' + ref) && l.includes('模型回合出错'))).toBe(true)

    // /healthcheck 报告同号（三处逐字相等的第三处）
    h.sendText('/healthcheck')
    await vi.waitFor(() => expect(sentTexts(h.outbound).some(t => t.includes('最近故障参考号（'))).toBe(true))
    const report = sentTexts(h.outbound).find(t => t.includes('最近故障参考号（'))!
    // 同号一致性（逐字）：QQ 文案 ref === trace 行 ref === 报告 ref
    expect(report).toContain(ref)

    // export：省略参考号 → 文件名自动携带该故障号
    h.sendText('/healthcheck export')
    await vi.waitFor(() => expect(sentTexts(h.outbound).some(t => t.includes('诊断包已导出'))).toBe(true))
    const archiveLine = sentTexts(h.outbound).find(t => t.includes('诊断包已导出'))!
    const archivePath = /\/\S*qq-diagnostics-\S*\.zip/.exec(archiveLine)![0]
    expect(archivePath).toMatch(new RegExp('-' + ref + '\\.zip$'))
    expect(existsSync(archivePath)).toBe(true)

    await stopAll(h)
  }, 30_000)

  it('T3 deferred 错误终态：补发通知带同号、不再重复 ⚠️；trace queue 事件携带 ref', async () => {
    const mediaDir = mkdtempSync(join(tmpdir(), 'onebot-ref-deferred-'))
    const sink = new TraceSink({ dir: mediaDir })
    const h = await makeHarness({ mediaDir, trace: sink, deferredTimeoutMs: 30 })
    h.sendText('启动任务')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    ;(h.bridge as unknown as { chats: Map<string, { agent: { status: string } }> }).chats.get('private:10001')!.agent.status = 'running'
    h.ctx.emit('session/event', { id: h.sessionIds[0] } as never, makeEvent('turn/start', { turn: 1 }))
    await vi.waitFor(() => expect(sentTexts(h.outbound).some(t => t.includes('等待模型回复超时'))).toBe(true))

    h.ctx.emit('session/event', { id: h.sessionIds[0] } as never, makeEvent('turn/end', { turn: 1, reason: { kind: 'error', error: { message: '额度耗尽' } } }))
    await vi.waitFor(() => expect(sentTexts(h.outbound).some(t => t.includes('任务已结束：运行出错'))).toBe(true))
    const deferredNotice = sentTexts(h.outbound).find(t => t.includes('任务已结束：运行出错'))!
    const ref = /MF-[a-z0-9]+/.exec(deferredNotice)![0]
    expect(deferredNotice).toContain('（超时补发）')
    expect(deferredNotice).toContain('（参考号 ' + ref)
    // 同一次故障不双发：补发终态已带号，基线 ⚠️ 被抑制
    expect(sentTexts(h.outbound).some(t => t.includes('⚠️ 运行出错'))).toBe(false)
    // 条目持久化同号
    const entryLine = readFileSync(join(mediaDir, DEFERRED_REGISTRY_FILE), 'utf8').split('\n').filter(l => l.trim() !== '')[0]!
    expect(JSON.parse(entryLine).ref).toBe(ref)
    // trace queue 事件携带 ref（deferredRetryable/uncertain/delivered 至少一条含号）
    await sink.flush()
    expect(readTrace(mediaDir).some(e => (e.data as { ref?: string } | undefined)?.ref === ref)).toBe(true)

    await stopAll(h)
  }, 30_000)

  it('/retry 失败：⚠️ 重试失败 + MF- 号，trace stage=command 同号', async () => {
    const mediaDir = mkdtempSync(join(tmpdir(), 'onebot-ref-retry-'))
    const sink = new TraceSink({ dir: mediaDir })
    const h = await makeCmdHarness({ mediaDir, trace: sink })
    h.sendText('第一问')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    ;(h.bridge as unknown as { dispatchFollowup: () => Promise<void> }).dispatchFollowup = async () => {
      throw new Error('inject dispatch exploded')
    }
    h.sendText('/retry')
    await vi.waitFor(() => expect(sentTexts(h.outbound).some(t => t.includes('⚠️ 重试失败'))).toBe(true))
    const notice = sentTexts(h.outbound).find(t => t.includes('⚠️ 重试失败'))!
    const ref = /MF-[a-z0-9]+/.exec(notice)![0]
    expect(notice).toContain('inject dispatch exploded')
    expect(notice).toContain('（参考号 ' + ref)
    await sink.flush()
    const events = readTrace(mediaDir).filter(e => e.data !== undefined && (e.data as { ref?: string }).ref === ref)
    expect(events.length).toBeGreaterThanOrEqual(1)
    expect(events[0]!.stage).toBe('command')
    expect(String(events[0]!.reason)).toContain('/retry 重试失败')
    await stopAll(h)
  }, 30_000)
})

describe('正常路径零发号 + export 文件名模式', () => {
  it('正常回合零参考号；报告「无」；export 文件名保持无号基线；显式传号逐字入名', async () => {
    const mediaDir = mkdtempSync(join(tmpdir(), 'onebot-ref-clean-'))
    const sink = new TraceSink({ dir: mediaDir })
    const h = await makeHarness({ mediaDir, trace: sink })
    h.sendText('正常一问')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    h.ctx.emit('session/event', { id: h.sessionIds[0] } as never, makeEvent('turn/start', { turn: 1 }))
    h.ctx.emit('session/event', { id: h.sessionIds[0] } as never, makeEvent('assistant/message', { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '正常答案' }] } }))
    h.ctx.emit('session/event', { id: h.sessionIds[0] } as never, makeEvent('turn/end', { turn: 1, reason: { kind: 'completed' } }))
    await flush()
    await sink.flush()
    // trace 与出站文案零 MF-/QQ-CONN- 命中
    expect(readTrace(mediaDir).some(e => JSON.stringify(e).match(/MF-[a-z0-9]{4,}|QQ-CONN-[a-z0-9]{4,}/) !== null)).toBe(false)
    expect(sentTexts(h.outbound).some(t => /MF-[a-z0-9]{4,}|QQ-CONN-[a-z0-9]{4,}/.test(t))).toBe(false)

    // 报告「最近故障参考号：无」；export 文件名无号（0.8.1 基线形态）
    h.sendText('/healthcheck')
    await vi.waitFor(() => expect(sentTexts(h.outbound).some(t => t.includes('最近故障参考号：无'))).toBe(true))
    h.sendText('/healthcheck export')
    await vi.waitFor(() => expect(sentTexts(h.outbound).some(t => t.includes('诊断包已导出'))).toBe(true))
    const archiveLine = sentTexts(h.outbound).find(t => t.includes('诊断包已导出'))!
    const archivePath = /\/\S*qq-diagnostics-\S*\.zip/.exec(archiveLine)![0]
    expect(archivePath).toMatch(/qq-diagnostics-\d{4,}-\d+\.zip$/)

    // 显式传号：合法号逐字入名；报告带「本次导出参考号」
    const explicit = newFailureRef('msg', { now: Date.now() })
    h.sendText('/healthcheck export ' + explicit)
    await vi.waitFor(() => expect(sentTexts(h.outbound).filter(t => t.includes('诊断包已导出')).length).toBe(2))
    const explicitLine = sentTexts(h.outbound).filter(t => t.includes('诊断包已导出'))[1]!
    const explicitPath = /\/\S*qq-diagnostics-\S*\.zip/.exec(explicitLine)![0]
    expect(explicitPath.endsWith('-' + explicit + '.zip')).toBe(true)
    expect(existsSync(explicitPath)).toBe(true)

    // 非法参考号：usage 提示、不落盘
    const before = readdirSync(mediaDir).filter(n => n.endsWith('.zip')).length
    h.sendText('/healthcheck export bogus-ref')
    await vi.waitFor(() => expect(sentTexts(h.outbound).some(t => t.includes('参考号格式不正确'))).toBe(true))
    expect(readdirSync(mediaDir).filter(n => n.endsWith('.zip')).length).toBe(before)

    await stopAll(h)
  }, 30_000)
})
