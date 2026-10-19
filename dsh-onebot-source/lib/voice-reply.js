export const VOICE_REPLY_HOOK = Symbol.for('dsh.companion.voice.reply.v1');
export function voiceRequest(text) {
    const match = /^\s*\[\[qq_voice\]\]([\s\S]*?)\[\[\/qq_voice\]\]\s*$/.exec(text);
    return match?.[1]?.trim() || undefined;
}
export function stripVoiceMarkers(text) { return text.replace(/\[\[\/?qq_voice\]\]/g, '').trim(); }
export function voiceHook() {
    return globalThis[VOICE_REPLY_HOOK];
}
