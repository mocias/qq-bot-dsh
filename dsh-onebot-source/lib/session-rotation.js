import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
export const SESSION_ROTATION_HOOK = Symbol.for('dsh.onebot.session-rotation.v1');
/** A journal retains the old record and routes its scheduled reminders. */
export class SessionRotation {
    path;
    deps;
    locks = new Map();
    records = {};
    blocked = false;
    constructor(path, deps) {
        this.path = path;
        this.deps = deps;
        try {
            if (existsSync(path)) {
                const data = JSON.parse(readFileSync(path, 'utf8'));
                if (data.version !== 1 || typeof data.records !== 'object' || !data.records)
                    throw Error('invalid rotation journal');
                this.records = data.records;
            }
        }
        catch (error) {
            this.blocked = true;
            deps.log('automatic rotation disabled: ' + String(error));
        }
    }
    save() {
        mkdirSync(dirname(this.path), { recursive: true });
        writeFileSync(this.path + '.tmp', JSON.stringify({ version: 1, records: this.records }, null, 2) + '\n');
        renameSync(this.path + '.tmp', this.path);
    }
    route(sessionId) {
        const entry = this.records[sessionId];
        return entry?.status === 'complete' || entry?.status === 'pending' ? entry.chatId : undefined;
    }
    async wait(chatId) { await this.locks.get(chatId); }
    request(request) {
        if (this.blocked)
            return Promise.resolve({ rotated: false, reason: 'rotation journal unavailable' });
        const prior = this.records[request.sessionId];
        if (prior?.status === 'complete')
            return Promise.resolve({ rotated: true, sessionId: prior.newSessionId, createdAt: prior.createdAt });
        const chat = this.deps.current(request.sessionId);
        if (!chat)
            return Promise.resolve({ rotated: false, reason: 'session is no longer current' });
        const existing = this.locks.get(chat.chatId);
        if (existing)
            return existing;
        const operation = Promise.resolve().then(() => this.perform(chat, request))
            .finally(() => this.locks.delete(chat.chatId));
        this.locks.set(chat.chatId, operation);
        return operation;
    }
    async perform(chat, request) {
        let swapped = false;
        try {
            if (!this.deps.safe(chat.chatId, chat.sessionId))
                return { rotated: false, reason: 'conversation is active' };
            if (!request.receipt.startsWith('<!-- memory-idle-digest-')
                || !readFileSync(request.receiptFile, 'utf8').includes(request.receipt))
                return { rotated: false, reason: 'memory receipt missing' };
            await this.deps.flush(chat.sessionId);
            if (!this.deps.safe(chat.chatId, chat.sessionId))
                return { rotated: false, reason: 'new input arrived' };
            const createdAt = new Date().toISOString();
            const local = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', dateStyle: 'short', timeStyle: 'medium' }).format(new Date(createdAt));
            const entry = { chatId: chat.chatId, oldSessionId: chat.sessionId,
                cwd: chat.cwd, nickname: chat.nickname, status: 'pending', createdAt,
                title: `QQ 私聊｜${local}（北京时间）`, request };
            this.records[chat.sessionId] = entry;
            this.save();
            // Inbound delivery waits on this operation after the final idle check.
            swapped = true;
            await this.deps.reset(chat.chatId, chat.cwd);
            const next = await this.deps.create(chat.chatId, chat.nickname);
            if (next.cwd !== chat.cwd)
                throw Error('successor workspace differs from original');
            entry.newSessionId = next.sessionId;
            this.save();
            await this.deps.finish(next, entry.title);
            entry.status = 'complete';
            this.save();
            this.deps.log(`rotated ${chat.sessionId} -> ${next.sessionId}; cwd=${next.cwd}; ${request.compactions} compactions`);
            return { rotated: true, sessionId: next.sessionId, createdAt };
        }
        catch (error) {
            if (swapped) {
                try {
                    await this.deps.restore(chat.chatId, chat.sessionId);
                    this.records[chat.sessionId].status = 'failed';
                    this.save();
                }
                catch (restoreError) {
                    this.deps.log('rotation rollback deferred: ' + String(restoreError));
                }
            }
            this.deps.log('rotation deferred: ' + String(error));
            return { rotated: false, reason: String(error) };
        }
    }
    /** Finish a committed swap after a crash; never rotate the same old session twice. */
    async recover() {
        if (this.blocked)
            return;
        for (const entry of Object.values(this.records)) {
            if (entry.status !== 'pending')
                continue;
            const current = this.deps.byChat(entry.chatId);
            if (!current || current.sessionId === entry.oldSessionId)
                continue;
            if (current.cwd !== entry.cwd) {
                this.deps.log('rotation recovery skipped: workspace changed');
                continue;
            }
            try {
                await this.deps.finish(current, entry.title);
                entry.newSessionId = current.sessionId;
                entry.status = 'complete';
                this.save();
            }
            catch (error) {
                this.deps.log('rotation recovery deferred: ' + String(error));
            }
        }
    }
}
