/** One DSH-owned OneBot connection, with isolated private and group consumers. */
export declare const QQ_TRANSPORT_KEY: unique symbol;
type Event = Record<string, unknown>;
interface Provider {
    connected: boolean;
    call(action: string, params?: Record<string, unknown>): Promise<unknown>;
}
export interface SharedQQTransport {
    connected(): boolean;
    call(action: string, params?: Record<string, unknown>): Promise<unknown>;
    whenConnected(timeoutMs?: number): Promise<void>;
    subscribe(message: (event: Event) => void, status?: (connected: boolean) => void): () => void;
    attach(provider: Provider): () => void;
    dispatch(provider: Provider, event: Event): void;
    notify(provider: Provider, connected: boolean): void;
    snapshot(): {
        connected: boolean;
        connectionCount: number;
        subscribers: number;
    };
}
export declare function sharedQQTransport(): SharedQQTransport;
export {};
