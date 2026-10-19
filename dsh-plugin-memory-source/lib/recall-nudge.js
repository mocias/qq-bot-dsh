/**
 * Recall nudge: the "persona" half of dsh-plugin-memory.
 *
 * DigestGuard makes sure the agent WRITES memory back; this module makes it
 * USE memory like a long-term companion would — when a conversation lulls,
 * it invites the agent to surface one real, remembered fact about the user
 * in a first-person voice ("I remember / last time we…"), instead of a dry
 * status line. The delivery mechanics mirror DigestGuard (watch every ROOT
 * agent's `agent/turn-stopping` boundary, inject a synthetic followup only
 * while the agent is idle and no next-turn step is queued), but the trigger
 * is a *cadence*, not store staleness: at most `maxPerSession` recalls per
 * session, spaced by at least `intervalMinutes`.
 *
 * The nudge never invents material — it only hands the agent a few real
 * `log.md` headlines as a seed and tells it to pick one it actually
 * remembers. No store write happens here, so the recall is conversational
 * only and never mutates the memory library.
 *
 * Independent of dsh-plugin-heartbeat: lives inside dsh-plugin-memory,
 * depends on no other plugin, and queues behind the same per-agent inbox.
 *
 * @module dsh-plugin-memory/recall-nudge
 */

import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseLogEntries } from './boot.js'
import { readRecallPolicy, RecallSchedule } from './recall-policy.js'
import { desktopReady, readDesktopAvailability } from './desktop-availability.js'

/** Poll cadence while the agent sits idle (ms). Short enough to feel prompt, long enough to stay cheap. */
const POLL_INTERVAL_MS = 30000

/**
 * Draw a random interval in [minMinutes, maxMinutes] minutes (ms).
 * The spread makes recalls feel human rather than metronomic.
 * @param {number} minMinutes lower bound in minutes
 * @param {number} maxMinutes upper bound in minutes
 * @returns {number} milliseconds
 */
export function randomIntervalMs(minMinutes, maxMinutes) {
  const min = Math.max(0, Number(minMinutes ?? 30))
  const max = Math.max(min, Number(maxMinutes ?? min))
  return (min + Math.random() * (max - min)) * 60000
}

/**
 * Seed candidates for a recall: the most recent log.md headlines, which are
 * the closest thing to "what we've been through lately". Empty when the
 * store has no log yet — in that case there is nothing to recall and the
 * nudge stays quiet.
 * @param {string} memoryDir absolute path of the memory store
 * @param {number} count max candidates to surface (default 3)
 * @returns {string[]}
 */
export function listRecallCandidates(memoryDir, count = 3) {
  const logPath = join(memoryDir, 'log.md')
  if (!existsSync(logPath)) return []
  try {
    const text = readFileSync(logPath, 'utf8')
    return parseLogEntries(text, count)
  } catch {
    return []
  }
}

/**
 * Build the recall message in the same followup shape DigestGuard uses
 * (role 'user', content array, plugin source). The text is an invitation,
 * not a command: first-person, Small-Blue voice, explicitly bounded by
 * "only what's really in memory, never invent, don't repeat yourself".
 * @param {string[]} candidates optional seed headlines
 * @returns {{ id: string, role: 'user', content: [{type:'text', text:string}], source: {kind:'plugin:memory'} }}
 */
export function buildRecallNudgeMessage(candidates, options = {}) {
  const list = Array.isArray(candidates)
    ? candidates.filter((c) => typeof c === 'string' && c.trim().length > 0)
    : []
  const seed = list.length > 0
    ? `\n可作引子（挑一条顺眼的就行，不用核对是否提过）：\n${list.map((c) => `- ${c}`).join('\n')}`
    : ''
  return {
    id: `memory-recall-${randomUUID()}`,
    role: 'user',
    content: [{
      type: 'text',
      text: (options.autonomousActions ? [
        '【自主行动唤醒】现在处于你获准自主活动的时段，电脑已通过空闲检查。先读取记忆库中的 DESKTOP.md，结合 SOUL.md、近期对话和真实记忆，判断这轮有没有值得主动处理的小事。',
        '- 优先处理用户已经约定的待办；也可以依据真实兴趣，在许可范围内阅读公开资料、整理自己的笔记或完成一个短小的桌面任务。不要编造待办，不为证明能力而随意操作。',
        '- 需要电脑界面时使用 windows_computer_use 工具：观察唯一目标、操作、重新观察核验；用户停止或目标不明确时立即结束，不重试绕过。',
        '- 一轮最多处理一件小事。保存、删除、发送等动作仅在已授权范围内进行；不得自主扩大账号权限或操作对象。',
        '- 将有价值的实际经历写回记忆，完成的待办标记完成。没有合适行动时，可以自然聊一句；如果也没有值得说的内容，安静结束，不输出巡检或占位汇报。',
        '- 最终回复只说已经核验的结果，或自然延续一个真实话题；不要输出内部调度、记忆维护和工具清单。',
        seed,
      ] : [
        '【主动搭话】对话空了下来。请遵循 SOUL.md 的人格和当前联系人的称呼，自然提起一件记忆里真实存在的事，或顺着你们最近的话题轻轻聊一句。偏好、共同经历、未了的决定、最近的进展都可以；别写成系统通知。',
        '- 只提记忆里真实存在的，绝不编造；',
        '- 用第一人称（我记得 / 上次我们…），别用「据记忆库记录」这种机器腔；',
        '- 一句到三句即可，别写成任务汇报；',
        '- 若话题正不合适，就只回一句日常状态带过，不硬聊。',
        // 2026-10-08 修 bug 的关键一句。旧文案是「换着说，别重复最近提过的」，
        // 见 test/recall-nudge.test.mjs 的 prompt-shape 三条断言。
        '- 想到哪件就直接开口说，不要先在思考里打草稿、不要排练措辞，也不要列举「已经提过哪些」来自查。',
        seed,
      ]).filter(Boolean).join('\n'),
    }],
    // Session format v4 admits only a producer-owned kind. The retired
    // {kind:'plugin', plugin:'memory'} wrapper is rejected at adoption
    // ("format v4 message requires a producer-owned source kind").
    source: { kind: 'plugin:memory' },
  }
}

/**
 * @typedef {object} RecallNudgeOptions
 * @property {() => { enabled: boolean, minMinutes: number, maxMinutes: number, maxPerSession: number, deferUntilUserSpeaks?: boolean, activeSessionOnly?: boolean }} readConfig
 * @property {() => string} getMemoryDir resolve the current store dir on every check
 * @property {unknown} [agents] optional live-agent registry for liveness checks
 * @property {import('./activity-tracker.js').ActivityTracker} [tracker] gate source: has-user-spoken + active-session
 * @property {{ info?: Function, warn?: Function }} [logger]
 */

/**
 * One recall-nudge per live ROOT agent, lifecycle-hooked to the agent's
 * context — same pattern as DigestGuard so the two never share state but
 * both fire only on a real idle boundary.
 */
export class RecallNudge {
  /**
   * @param {object} agent live root agent (ReactLoopAgent shape: ctx, status, inbox, followup)
   * @param {RecallNudgeOptions} options
   */
  constructor(agent, options) {
    this.agent = agent
    this.readConfig = options.readConfig
    this.getMemoryDir = options.getMemoryDir
    this.agents = options.agents
    this.tracker = options.tracker
    this.logger = options.logger
    this.pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS
    this.disposed = false
    this.stopTurnStopping = undefined
    this.timer = undefined
    this.recalls = 0
    // 0 = "not armed yet": the first eligible idle moment arms the interval so
    // the first recall never fires instantly after the user's first turn.
    this.nextRecallAt = 0
    this.schedule = undefined
    this.readDesktopState = options.readDesktopState ?? readDesktopAvailability
    this.desktopState = undefined
    this.desktopCheckedAt = 0
    this.desktopProbe = undefined
  }

  /** Subscribe to the turn boundary AND poll while the agent sits idle. */
  start() {
    if (this.disposed) return
    this.stopTurnStopping = this.agent.ctx.on?.('agent/turn-stopping', () => {
      this.safeCheck()
    })
    // A turn boundary only fires when a turn ends; a fully idle agent never
    // produces one, so we also poll on a short interval. This is what makes
    // recall proactive (heartbeat-style) rather than turn-reactive.
    this.timer = setInterval(() => {
      this.safeCheck()
    }, this.pollIntervalMs)
    if (typeof this.timer.unref === 'function') this.timer.unref()
  }

  /** Shared guard wrapper so both triggers stay exception-safe. */
  safeCheck() {
    if (this.disposed) return
    try {
      this.onTurnStopped()
    } catch (error) {
      this.logger?.warn?.(`memory: recall check failed for agent "${this.agent.id}": ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** Cancel subscriptions and the poll timer; the nudge stops observing. */
  dispose() {
    this.disposed = true
    this.stopTurnStopping?.()
    this.stopTurnStopping = undefined
    if (this.timer !== undefined) {
      clearInterval(this.timer)
      this.timer = undefined
    }
  }

  /** Evaluate whether a recall is due right now. */
  onTurnStopped() {
    if (this.disposed) return
    // A scheduled alarm may resume an old QQ session after rotation. Only the
    // current private conversation may consume proactive-contact allowance.
    const sessionId = String(this.agent.session?.id ?? '')
    if (sessionId.startsWith('onebot-')
      && globalThis[Symbol.for('dsh.onebot.session-rotation.v1')]?.isCurrent(sessionId) === false) return
    if (this.agents && this.agents.get(this.agent.id) !== this.agent) {
      this.dispose()
      return
    }
    const config = this.readConfig()
    if (!config.enabled) return
    // Both gates: don't recall before the user has spoken, and only for the
    // currently active session (most recent user message).
    if (this.tracker && !this.tracker.shouldInject(this.agent.id, config)) return
    // A persistent daily policy replaces the old process-local session cap.
    if (!config.policyFile && this.recalls >= Math.max(1, Number(config.maxPerSession ?? 3))) return
    if (this.agent.status !== 'idle') return
    const inbox = this.agent.inbox
    if (inbox && Array.isArray(inbox.nextStep) && inbox.nextStep.length > 0) return

    const now = Date.now()
    let policy
    if (config.policyFile) {
      policy = readRecallPolicy(config.policyFile)
      this.schedule ??= new RecallSchedule(config.stateFile,
        config.stateKey || String(this.agent.session?.id ?? this.agent.id))
      if (!this.schedule.due(now, policy, this.tracker?.lastUserAt(this.agent.id) ?? 0)) return
      if (policy.autonomousActions) {
        // Probe only when due, cache briefly, and never block the host event loop.
        if (!this.desktopCheckedAt || now - this.desktopCheckedAt > 30000) {
          if (!this.desktopProbe) {
            this.desktopProbe = this.readDesktopState().then(state => {
              this.desktopState = state
              this.desktopCheckedAt = Date.now()
            }).catch(error => {
              this.desktopState = { interactive: false, idleSeconds: 0 }
              this.desktopCheckedAt = Date.now()
              this.logger?.warn?.(`memory: desktop availability check failed: ${error.message}`)
            }).finally(() => {
              this.desktopProbe = undefined
              if (!this.disposed) this.safeCheck()
            })
          }
          return
        }
        if (!desktopReady(this.desktopState, policy)) return
      }
    }
    if (!policy && this.nextRecallAt === 0) {
      // First eligible idle moment: arm the interval from here instead of
      // firing instantly (the pre-gate bug). Returns so the next check honors it.
      this.nextRecallAt = now + randomIntervalMs(config.minMinutes, config.maxMinutes)
      return
    }
    if (!policy && now < this.nextRecallAt) return

    const candidates = listRecallCandidates(this.getMemoryDir(), 3)
    if (candidates.length === 0 && !policy?.autonomousActions) return

    if (policy) this.schedule.reserve(now, policy)
    this.agent.followup(buildRecallNudgeMessage(candidates, { autonomousActions: policy?.autonomousActions }))
    this.nextRecallAt = now + randomIntervalMs(config.minMinutes, config.maxMinutes)
    this.recalls += 1
    this.logger?.info?.(`memory: recall nudge #${this.recalls} for agent "${this.agent.id}"`)
  }
}
