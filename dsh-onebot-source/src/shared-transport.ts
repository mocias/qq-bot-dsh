/** One DSH-owned OneBot connection, with isolated private and group consumers. */
export const QQ_TRANSPORT_KEY = Symbol.for('dsh.qq.shared-transport.v1')
type Event = Record<string, unknown>
interface Provider { connected: boolean; call(action: string, params?: Record<string, unknown>): Promise<unknown> }
export interface SharedQQTransport {
  connected(): boolean
  call(action: string, params?: Record<string, unknown>): Promise<unknown>
  whenConnected(timeoutMs?: number): Promise<void>
  subscribe(message: (event: Event) => void, status?: (connected: boolean) => void): () => void
  attach(provider: Provider): () => void
  dispatch(provider: Provider, event: Event): void
  notify(provider: Provider, connected: boolean): void
  snapshot(): { connected: boolean; connectionCount: number; subscribers: number }
}
export function sharedQQTransport(): SharedQQTransport {
  const globals = globalThis as unknown as Record<symbol, SharedQQTransport | undefined>
  if (globals[QQ_TRANSPORT_KEY]) return globals[QQ_TRANSPORT_KEY]!
  let current: Provider | undefined
  const listeners = new Set<{ message: (event: Event) => void; status?: (connected: boolean) => void }>()
  const deliver = (fn: (() => void)) => { try { fn() } catch { console.warn('[qq-bridge] isolated subscriber failure') } }
  const hub: SharedQQTransport = {
    connected: () => current?.connected === true,
    async call(action, params = {}) {
      const provider = current
      if (!provider?.connected) throw Error('QQ shared connection is not ready')
      return provider.call(action, params)
    },
    whenConnected(timeoutMs = 15000) {
      if (hub.connected()) return Promise.resolve()
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { stop(); reject(Error('QQ shared connection timed out')) }, timeoutMs)
        const stop = hub.subscribe(() => {}, connected => { if (connected) { clearTimeout(timer); stop(); resolve() } })
      })
    },
    subscribe(message, status) {
      const listener = { message, status }; listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    attach(provider) {
      if (current && current !== provider) throw Error('Another QQ transport is already mounted')
      current = provider
      for (const listener of listeners) deliver(() => listener.status?.(provider.connected))
      return () => {
        if (current !== provider) return
        current = undefined
        for (const listener of listeners) deliver(() => listener.status?.(false))
      }
    },
    dispatch(provider, event) { if (current === provider) for (const listener of listeners) deliver(() => listener.message(event)) },
    notify(provider, connected) { if (current === provider) for (const listener of listeners) deliver(() => listener.status?.(connected)) },
    snapshot: () => ({ connected: hub.connected(), connectionCount: current ? 1 : 0, subscribers: listeners.size }),
  }
  globals[QQ_TRANSPORT_KEY] = hub
  return hub
}
