import type { OutboundSegment } from './outbound.js';
export declare const VOICE_REPLY_HOOK: unique symbol;
export interface VoicePreparation {
    text?: string;
    segments?: OutboundSegment[];
    reason?: string;
}
export interface VoiceReplyHook {
    prepare(chatId: string, text: string): Promise<VoicePreparation>;
}
export declare function voiceRequest(text: string): string | undefined;
export declare function stripVoiceMarkers(text: string): string;
export declare function voiceHook(): VoiceReplyHook | undefined;
