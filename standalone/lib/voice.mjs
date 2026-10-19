import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
const run = promisify(execFile);
export class LocalVoice {
  constructor(root, runtime) {
    this.root = root; this.dir = path.join(runtime, 'audio'); this.busy = false;
    fs.mkdirSync(this.dir, { recursive: true });
  }
  paths(model) {
    const deploy = path.join(this.root, 'dsh-qq-deploy');
    return {
      python: path.join(deploy, 'voice-asr-venv/Scripts/python.exe'),
      script: path.join(deploy, 'voice-runtime/voice/lib/transcribe.py'),
      model: path.join(deploy, model === 'small' ? 'voice-asr-model-small' : 'voice-asr-model'),
      tts: path.join(this.root, 'dsh-companion-voice/lib/tts.ps1'),
    };
  }
  status(config) {
    const p = this.paths(config.model);
    return { busy: this.busy, engine: 'faster-whisper CPU int8', model: config.model,
      asrReady: [p.python, p.script, path.join(p.model, 'model.bin')].every(f => fs.existsSync(f)),
      ttsReady: process.platform === 'win32' && fs.existsSync(p.tts) };
  }
  async exclusive(task) {
    if (this.busy) throw Error('语音任务正在运行，请等待完成');
    this.busy = true;
    try { this.prune(); return await task(); } finally { this.busy = false; }
  }
  prune() {
    const files = fs.readdirSync(this.dir).map(name => ({ name, time: fs.statSync(path.join(this.dir, name)).mtimeMs })).sort((a,b) => b.time-a.time);
    for (let i=0; i<files.length; i++) if (i >= 100 || files[i].time < Date.now()-86400000) fs.unlinkSync(path.join(this.dir, files[i].name));
  }
  async synthesize(text, config) {
    if (typeof text !== 'string' || !text.trim() || text.length > 300) throw Error('请输入 1–300 字的测试文字');
    return this.exclusive(async () => {
      const id = randomUUID(), file = path.join(this.dir, id+'.wav'), request = path.join(this.dir, id+'.json');
      fs.writeFileSync(request, JSON.stringify({ text, file, voice: config.voice }));
      try {
        await run(path.join(process.env.SystemRoot || 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'),
          ['-NoProfile', '-NonInteractive', '-File', this.paths(config.model).tts, '-RequestFile', request],
          { windowsHide: true, timeout: 60000, maxBuffer: 1024*1024 });
        if (!fs.existsSync(file)) throw Error();
        return { id, audioUrl: '/api/audio/'+id, provider: 'Windows System.Speech' };
      } catch { throw Error('本地语音合成失败，请检查 Windows 中文语音组件'); }
      finally { fs.rmSync(request, { force: true }); }
    });
  }
  async transcribe(data, config) {
    if (!Buffer.isBuffer(data) || data.length < 44 || data.length > 8*1024*1024 || data.toString('ascii', 0, 4) !== 'RIFF' || data.toString('ascii', 8, 12) !== 'WAVE') throw Error('请上传 8 MiB 以内的 WAV 音频');
    return this.exclusive(async () => {
      const id = randomUUID(), prefix = path.join(this.dir, id), file = prefix+'.wav';
      fs.writeFileSync(file, data);
      const p = this.paths(config.model);
      try {
        await run(p.python, [p.script, '--file', file, '--out', prefix, '--model', p.model],
          { windowsHide: true, timeout: 180000, maxBuffer: 1024*1024, env: { ...process.env, HF_HUB_OFFLINE: '1' } });
        const result = JSON.parse(fs.readFileSync(prefix+'.json', 'utf8'));
        return { id, text: result.text, duration: result.duration, model: config.model, provider: 'faster-whisper-local' };
      } catch { throw Error('本地识别失败或超时，请检查 Python 环境和模型文件'); }
    });
  }
  audio(id) {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw Error('音频不存在');
    return fs.readFileSync(path.join(this.dir, id+'.wav'));
  }
}
