# 0.6 语音服务

“语音与通话”提供两个模式：本地模式、MiMo API。面板试听、识别和 QQ 收发共享 `VoiceService`；聊天、记忆和会话仍由原链路处理。

## 使用

1. 在语音与通话选择服务模式。旧配置升级后默认本地模式，Windows TTS 和 faster-whisper 环境路径不变。
2. 选择 MiMo API 后填写自己的 API Key。留空保存会保留已有密钥；“清除 MiMo 密钥并切回本地”会移除当前配置中的密钥。面板和状态接口只显示是否已配置，不回显密钥。
3. 选择预置音色，或选择“使用参考录音”，填写音色名称并上传 WAV/MP3（最多 7 MiB）。录音保存在本机，可以预览、重新选择；上传本身不调用云端。最多保存 20 份，第一版不含删除界面。
4. 可填写语气提示，选择自动、中文或英语识别，点击“保存语音配置”。保存前需要停止 QQ 连接并等待当前语音和消息任务完成。
5. 用下方合成与识别测试验证实际 API 访问。显示“已配置”仅代表密钥和参考文件齐全，不代表密钥有效、余额充足或真实音质已经验证。
6. QQ 语音开关和回复偏好在“会话与聊天”。启动 QQ 后使用已保存的语音服务；群聊暂不自动合成语音，安静时段、内容策略、准备失败文字回退和发送结果不确定不重试的规则不变。

本地识别上传支持 PCM WAV；MiMo 识别支持 WAV/MP3（最多 8 MiB）。其他 QQ 语音格式继续通过 ffmpeg 转换。合成测试最多 300 字，返回完整 WAV。

## 数据及接口

- 官方固定地址：`https://api.xiaomimimo.com/v1/chat/completions`，使用 `api-key` 请求头，不支持用户改任意远程地址。
- 预置合成：`mimo-v2.5-tts`；参考音色：`mimo-v2.5-tts-voiceclone`；识别：`mimo-v2.5-asr`。
- 参考音色随每次合成请求发送 `audio.voice` 音频 data URL。并不是在云端创建一个永久音色 ID。
- `GET/POST /api/voice/references` 列出元信息/上传；`GET /api/voice/reference/:id` 提供受登录保护的预览。
- `POST /api/voice/config` 仅修改语音字段，避免覆盖连接页其他设置；`POST /api/voice/synthesize`、`/api/voice/transcribe` 使用已保存模式。
- 密钥保存在 `.runtime/config.private.json`；参考音频在 `.runtime/voice-references/`；生成音频在 `.runtime/audio/`。这些目录全部排除 Git。备份私有运行目录也包含这些数据；清除当前密钥不会删除旧备份。
- MiMo 模式会发送合成文字、待识别音频和选中的参考录音，并使用账户额度。失败不会自动切换服务或重试 API。请求限时 120 秒、响应上限 12 MiB，远端错误正文和密钥不进入面板错误。
- 第一版没有实时电话、流式通话，也没有真实 MiMo 音质或 QQ 云语音实测结论。

文档依据：[语音合成与音色复刻](https://mimo.mi.com/docs/zh-CN/quick-start/usage-guide/audio/speech-synthesis-v2.5)、[TTS API](https://mimo.mi.com/docs/zh-CN/api/audio/tts)、[ASR API](https://mimo.mi.com/docs/zh-CN/api/audio/Speech-Recognition)。
