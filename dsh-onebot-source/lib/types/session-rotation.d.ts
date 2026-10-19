export declare const SESSION_ROTATION_HOOK: unique symbol;
export interface RotationRequest {
    sessionId: string;
    receiptFile: string;
    receipt: string;
    compactions: number;
}
export interface RotationResult {
    rotated: boolean;
    sessionId?: string;
    reason?: string;
    createdAt?: string;
}
export interface RotationHook {
    isCurrent(sessionId: string): boolean;
    rotate(request: RotationRequest): Promise<RotationResult>;
}
export interface RotationChat {
    chatId: string;
    sessionId: string;
    cwd: string;
    nickname: string;
}
export interface RotationDeps {
    current(sessionId: string): RotationChat | undefined;
    byChat(chatId: string): RotationChat | undefined;
    safe(chatId: string, sessionId: string): boolean;
    flush(sessionId: string): Promise<void>;
    reset(chatId: string, cwd: string): Promise<void>;
    create(chatId: string, nickname: string): Promise<RotationChat>;
    restore(chatId: string, sessionId: string): Promise<void>;
    finish(chat: RotationChat, title: string): Promise<void>;
    log(message: string): void;
}
/** A journal retains the old record and routes its scheduled reminders. */
export declare class SessionRotation {
    private path;
    private deps;
    readonly locks: Map<string, Promise<RotationResult>>;
    private records;
    private blocked;
    constructor(path: string, deps: RotationDeps);
    private save;
    route(sessionId: string): string | undefined;
    wait(chatId: string): Promise<void>;
    request(request: RotationRequest): Promise<RotationResult>;
    private perform;
    /** Finish a committed swap after a crash; never rotate the same old session twice. */
    recover(): Promise<void>;
}
