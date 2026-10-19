# 开发环境

## 独立服务

Node.js 22+，在根目录运行：

```powershell
npm --prefix standalone ci --ignore-scripts
npm run test:standalone
npm run start:standalone
```

配置面板默认只监听 `127.0.0.1:3199`。可以设置 `QQ_RSI_PORT`。启动时输出的登录链接包含临时令牌，不要分享。设置数据在 `standalone/.runtime/`，重启后 QQ 连接仍默认停止。

另外启动兼容 DSH 和 OneBot v11 正向 WebSocket 服务（消息格式 array）。DSH 端口可能变动，以本机实际地址为准。面板可显式启用当前用户 DSH 登录授权，或填入当前 DSH 启动令牌。新安装不自带模型服务认证。

## 本地语音

TTS 复用 `dsh-companion-voice/lib/tts.ps1`，需要 Windows 对应的 System.Speech 声音组件。

ASR 目前按如下相对目录寻找已有环境，均由使用者单独准备且不提交：

```text
dsh-qq-deploy/
  voice-asr-venv/Scripts/python.exe
  voice-runtime/voice/lib/transcribe.py
  voice-asr-model/                 # base 模型目录，包含 model.bin
  voice-asr-model-small/           # small 模型目录，包含 model.bin
```

Python 依赖版本见 `dsh-companion-voice/requirements-asr.lock.txt`；转写脚本源文件为 `dsh-companion-voice/lib/transcribe.py`，准备环境时复制到上述位置。模型需单独下载对应 faster-whisper 格式；程序以离线模式读取，缺少模型时不会自动下载。

`npm run test:voice-local` 会生成和识别本地测试语音，要求已有环境；不向 QQ 发送。MiMo 代码见 `dsh-companion-voice/lib/mimo-api.mjs` 和 `transcribe-mimo.mjs`，当前独立面板尚未接入。

## 原插件

`npm run test:portable` 运行群聊、语音和统一设置模块的便携测试。记忆 CLI 自测：`node standalone/scripts/original-memory.mjs --self-test`。

原 OneBot 编译需要 TypeScript 与匹配的 DSH peer dependencies。`npm run typecheck` / `npm run build` 会检查关键入口；缺失时停止，不会伪造构建成功。`npm run build:bundle` 只打包已有 lib，不能替代编译。旧插件示例固定账号与机器路径需先适配。
