import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
const execute = promisify(execFile)

export async function readDesktopAvailability() {
  if (process.platform !== 'win32') return { interactive: false, idleSeconds: 0 }
  const script = fileURLToPath(new URL('../scripts/desktop-idle.ps1', import.meta.url))
  const { stdout } = await execute('powershell.exe', ['-NoProfile', '-NonInteractive',
    '-ExecutionPolicy', 'Bypass', '-File', script], {
    windowsHide: true, timeout: 8000, maxBuffer: 16384, encoding: 'utf8',
  })
  const result = JSON.parse(stdout.replace(/^\uFEFF/, '').trim())
  if (typeof result.interactive !== 'boolean' || !Number.isFinite(result.idleSeconds)) {
    throw new Error('Invalid desktop availability response')
  }
  return result
}

export function desktopReady(state, policy) {
  return state?.interactive === true && Number.isFinite(state.idleSeconds)
    && state.idleSeconds >= (policy.desktopIdleSeconds ?? 120)
}
