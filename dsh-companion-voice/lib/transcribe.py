"""Local QQ voice recognition. Audio never leaves this machine."""
import argparse
import json
import pathlib
from faster_whisper import WhisperModel

parser = argparse.ArgumentParser()
parser.add_argument('--file', required=True)
parser.add_argument('--out', required=True)
parser.add_argument('--model', default='D:/qq-bot-dsh/dsh-qq-deploy/voice-asr-model')
args = parser.parse_args()
model = WhisperModel(args.model, device='cpu', compute_type='int8', cpu_threads=4,
                     local_files_only=True)
segments, info = model.transcribe(args.file, language='zh', beam_size=5,
                                  vad_filter=False, condition_on_previous_text=False)
details = [{'text': s.text.strip(), 'start': s.start, 'end': s.end,
            'avg_logprob': s.avg_logprob, 'no_speech_prob': s.no_speech_prob}
           for s in segments]
text = ''.join(s['text'] for s in details).strip()
pathlib.Path(args.out + '.txt').write_text(text, encoding='utf-8')
pathlib.Path(args.out + '.json').write_text(json.dumps({
    'text': text, 'segments': details, 'language': info.language,
    'duration': info.duration, 'engine': 'faster-whisper-base-local',
    'untrusted_content': True}, ensure_ascii=False), encoding='utf-8')
print(json.dumps({'ok': True, 'characters': len(text), 'duration': info.duration}))
