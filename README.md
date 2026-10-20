# qq-bot-dsh

QQ 机器人开发工作区：当前主线是 `standalone/` 独立 Node.js 服务，包含配置面板、QQ 多媒体桥接、长期记忆、插话、会话轮换和本地语音测试；0.5 新增群聊受限工具、人设/知识管理与常用控制命令。

**独立进程仍依赖 DSH 提供模型推理、Agent 工具循环和权限审批。** 本仓库不是完全脱离 DSH 的 Agent harness。

## 开始开发

需要 Node.js 22+；本地语音合成需要 Windows 中文语音组件。

```powershell
npm --prefix standalone ci --ignore-scripts
npm run test:standalone
npm run start:standalone
```

打开终端打印的本机登录链接。默认端口为 `3199`，QQ 连接默认停止。在面板填写另行启动的 DSH 与 OneBot 服务地址、机器人账号和允许名单，验证后手动连接。账号、令牌和聊天资料只保存在本机 `standalone/.runtime/`。

## 目录

| 路径 | 用途 |
| --- | --- |
| `standalone/` | 当前独立服务和 Web 配置面板；优先在这里开发 |
| `dsh-onebot-source/` | 原 OneBot 插件 TypeScript 源码、已编译 lib 和测试 |
| `dsh-group-social/` | 原独立群聊插件，作为迁移参考 |
| `dsh-plugin-memory-source/` | 原长期记忆插件完整核心源码与测试 |
| `dsh-companion-voice/` | 本地 TTS / ASR、MiMo API 适配源码 |
| `dsh-qq-unified/` | 原 DSH 统一插件打包工具与设置界面 |
| `scripts/` | 工作区检查、测试和打包入口 |
| `docs/` | 开发、验证、迁移说明 |

原插件内的固定账号与路径已改为示例，不能直接当作本机部署配置。当前独立服务的账号默认值为空，允许名单默认为空。不要同时让旧插件和独立服务消费同一 QQ 聊天。

## 新机器需要单独配置

DSH、QQ/NapCat、Python 环境、语音模型、API 密钥、私人记忆均不在仓库中。语音模型和部署目录的准备方式见 [开发说明](docs/DEVELOPMENT.md)。桌面 QQ 与机器人共用一个登录实例的方式见 [迁移说明](docs/MIGRATION.md)。

交接从 [HANDOFF.md](HANDOFF.md) 开始，开发约定见 [AGENTS.md](AGENTS.md)，验证范围见 [docs/VALIDATION.md](docs/VALIDATION.md)。

## 来源与许可

保留各来源模块的独立许可，详见 `dsh-onebot-source/LICENSE`、`dsh-plugin-memory-source/LICENSE` 和 [第三方说明](standalone/THIRD-PARTY-NOTICES.md)。本仓库没有把不同来源代码重新统一授权。QQ 协议接入参考 [Derpyu520/qq-bridge](https://github.com/Derpyu520/qq-bridge)，NapCat 与 DSH 需另行安装。
