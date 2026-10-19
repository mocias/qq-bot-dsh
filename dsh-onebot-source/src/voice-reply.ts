import type { OutboundSegment } from './outbound.js'
export const VOICE_REPLY_HOOK = Symbol.for('dsh.companion.voice.reply.v1')
export interface VoicePreparation { text?: string; segments?: OutboundSegment[]; reason?: string }
export interface VoiceReplyHook { prepare(chatId: string, text: string): Promise<VoicePreparation> }
export function voiceRequest(text: string): string | undefined {
  const match = /^\s*\[\[qq_voice\]\]([\s\S]*?)\[\[\/qq_voice\]\]\s*$/.exec(text)
  return match?.[1]?.trim() || undefined
}
export function stripVoiceMarkers(text: string): string { return text.replace(/\[\[\/?qq_voice\]\]/g, '').trim() }
export function voiceHook(): VoiceReplyHook | undefined {
  return (globalThis as unknown as Record<symbol, VoiceReplyHook | undefined>)[VOICE_REPLY_HOOK]
}
