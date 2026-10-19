# 原 DSH 语音插件

保留本地 Windows TTS、faster-whisper 转写与 MiMo API 适配，以及原 OneBot 语音输出策略。此目录仍是原插件形态，standalone 只复用本地语音测试能力。实时双向通话和电话线路尚未实现。

lib/tts.ps1 生成 WAV；lib/transcribe.py 使用离线模型，依赖见 requirements-asr.lock.txt；lib/mimo-api.mjs 和 transcribe-mimo.mjs 为 API 适配代码。不要把密钥写入源码。

原插件的固定私聊对象与路径已替换为示例，需要参数化后才能部署。代码测试和本地音频生成不代表真实 QQ 语音送达或对方听到。当前准备步骤见 ../docs/DEVELOPMENT.md，整体状态见 ../HANDOFF.md。
