import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

// The policy is intentionally editable by the companion. The recipient/session
// allowlist lives separately in the host's composition, not in this file.
export function readRecallPolicy(path) {
  const policy = JSON.parse(readFileSync(path, 'utf8'))
  if (typeof policy.enabled !== 'boolean') throw new Error('recall policy needs enabled')
  if (policy.autonomousActions !== undefined && typeof policy.autonomousActions !== 'boolean') {
    throw new Error('invalid autonomousActions')
  }
  if (policy.desktopIdleSeconds !== undefined
    && (!Number.isFinite(policy.desktopIdleSeconds) || policy.desktopIdleSeconds < 0)) {
    throw new Error('invalid desktopIdleSeconds')
  }
  if (typeof policy.timeZone !== 'string' || !policy.timeZone) throw new Error('invalid timeZone')
  new Intl.DateTimeFormat('en', { timeZone: policy.timeZone }).format()
  for (const key of ['intervalMinMinutes', 'intervalMaxMinutes', 'maxPerDay']) {
    if (!Number.isFinite(policy[key]) || policy[key] < 0) throw new Error(`invalid ${key}`)
  }
  if (policy.intervalMinMinutes < 1 || policy.intervalMaxMinutes < policy.intervalMinMinutes
    || !Number.isInteger(policy.maxPerDay)) throw new Error('invalid recall interval or daily limit')
  for (const key of ['start', 'end']) {
    if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(policy.activeHours?.[key] ?? '')) {
      throw new Error(`invalid activeHours.${key}`)
    }
  }
  return policy
}

export function policyClock(now, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(now)).map(p => [p.type, p.value]))
  return { day: `${parts.year}-${parts.month}-${parts.day}`,
    minute: Number(parts.hour) * 60 + Number(parts.minute) }
}

export function withinActiveHours(now, policy) {
  const minute = policyClock(now, policy.timeZone).minute
  const parse = value => { const [h, m] = value.split(':').map(Number); return h * 60 + m }
  const start = parse(policy.activeHours.start), end = parse(policy.activeHours.end)
  return start === end || (start < end ? minute >= start && minute < end : minute >= start || minute < end)
}

export class RecallSchedule {
  constructor(path, sessionId, random = Math.random) {
    this.path = path
    this.sessionId = sessionId
    this.random = random
  }
  load() {
    const all = existsSync(this.path) ? JSON.parse(readFileSync(this.path, 'utf8')) : {}
    return { all, state: all[this.sessionId] ?? { count: 0, day: '', nextAt: 0, lastUserAt: 0 } }
  }
  save(all, state) {
    all[this.sessionId] = state
    mkdirSync(dirname(this.path), { recursive: true })
    const temp = this.path + '.tmp'
    writeFileSync(temp, JSON.stringify(all, null, 2) + '\n')
    renameSync(temp, this.path)
  }
  interval(policy) {
    return (policy.intervalMinMinutes
      + this.random() * (policy.intervalMaxMinutes - policy.intervalMinMinutes)) * 60000
  }
  due(now, policy, lastUserAt) {
    if (!policy.enabled || policy.maxPerDay === 0) return false
    const { all, state } = this.load()
    const day = policyClock(now, policy.timeZone).day
    if (state.day !== day) { state.day = day; state.count = 0 }
    const signature = JSON.stringify([policy.intervalMinMinutes, policy.intervalMaxMinutes])
    if (!state.nextAt || lastUserAt > state.lastUserAt || state.intervalSignature !== signature) {
      state.lastUserAt = lastUserAt
      state.intervalSignature = signature
      state.nextAt = now + this.interval(policy)
      this.save(all, state)
      return false
    }
    this.save(all, state)
    return state.count < policy.maxPerDay && now >= state.nextAt && withinActiveHours(now, policy)
  }
  reserve(now, policy) {
    // Reserve before queuing the model turn. A crash or uncertain delivery must
    // not cause an automatic replay of an unsolicited message.
    const { all, state } = this.load()
    const day = policyClock(now, policy.timeZone).day
    if (state.day !== day) { state.day = day; state.count = 0 }
    state.count += 1
    state.lastAttemptAt = now
    state.nextAt = now + this.interval(policy)
    this.save(all, state)
  }
}
