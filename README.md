# qq-bot-dsh

开发入口：[当前逻辑地图](docs/ARCHITECTURE.md) · [结构整理与后续优先级](docs/REFACTOR-2026-10.md)。

当前发布版本 **0.25.0**。本版统一会话生命周期、记忆查询和发送计划准备，修复轮换/手动新建的原生会话被再次替换的问题，并更新 Web 面板、导航、表单与手机布局。见 [0.25.0 发布说明](docs/RELEASE-0.25.0.md)。

主线是 `standalone/` 独立 Node.js 服务，配套 `native-dsh-plugin/` 轻量 DSH 插件；两者随同一便携安装包更新，不能混装版本。0.23～0.24 建立的真实世界模拟（real-world simulation）与循环思考继续保留：角色状态、经历、等待、交接和再次醒来形成连续过程，并支持编辑行为规则。

## 角色模拟与循环思考的功能基础

| 版本 | 真实世界模拟与循环思考的改进 | 配套功能 |
| --- | --- | --- |
| **0.24.0** | 真人离开后交接、整合记忆并休眠；DSH 定时预约可恢复原会话及 QQ 工具，让角色醒来后主动发送。模拟规则明确允许自然主动发言，并可使用当前实际开放的其他 DSH 工具。 | 默认 30 分钟离开阈值可修改；98 项提示词；逐条语音情绪说明；人格与聊天记忆一键 ZIP 导出。 |
| **0.23.0** | 将真实世界模拟、等待、状态保存、发送续接和交接规则集中到独立提示词页面，支持全局默认＋每个人格单独覆盖，使循环行为可以按角色调整。 | 当时提供 90 项提示词及工具说明；修订冲突检查与备份；新工作区名称包含群聊/私聊、对象号码和人格名。 |

真实世界模拟与持续循环的基础在 0.19～0.22 系列建立，0.23～0.24 进一步完善其配置与生命周期，0.25 继续保留。详见 [0.23 提示词配置](docs/PROMPT-PROFILES-0.23.md)和 [0.24 休眠与唤醒](docs/ABSENCE-WAKE-0.24.md)。

## 当前聊天与角色行为

- **角色模拟与长期经历**：按上次消息或模拟提示投递时间计算 60 秒模拟间隔，经 `qq_wait_for_messages` 返回推演事件。每次推演通过 `qq_role_state_update` 保存角色状态与正式角色经历，再继续等待；角色经历与真实群成员事实分开，不将模拟当作现实世界已执行的动作。
- **循环思考与即时发送**：私聊和群聊共用“读取消息／推演 → 更新状态 → 按需发送 → 再等待”的循环，不再有旧的 15 分钟总时长上限。每次等待 1～300 秒，消息和子任务通知可提前唤醒；QQ 回复必须通过发送工具取得回执，DSH 普通正文不会自动发往 QQ。等待阻塞时并不持续调用模型，也不保证模型永不退出；停止、离线和执行异常仍需处理。见[持续对话](docs/CONTINUOUS-CHAT.md)。
- **离开、交接、原会话恢复**：默认 30 分钟没有真人来信就停止普通等待，由 `qq_handoff` 保存交接，再在同一 DSH 会话整合记忆，取得回执后休眠。机器人发言、模拟和预约不会重置来信计时。用户回来时仍在原会话恢复人设、交接和记忆，不发送上线招呼。
- **定时醒来并主动发消息**：启用对应聊天的 DSH 定时唤醒权限后，预约由 QQ 服务先恢复原生工具再提交模型；每次预约独立去重。DSH 与 QQ 服务必须运行，手动停止接收优先；此功能不能启动已关闭的应用或电脑。
- **同一聊天多个人格**：人格卡先预览、点击确定配置才切换；每个人格独立保存人设、长期记忆、语音和会话。支持全局提示词继承及人格单独覆盖，旧默认人格保留原资料。
- **完整记忆与语音**：按需读页、搜索、来源校验和维护回执继续保留；记忆导出仅包含选中聊天及人格的资料。语音工具将朗读正文与 `voiceStyle` 情绪、语速和停顿说明分开；MiMo 接收逐条说明，本地 Windows 语音不具备相同情绪控制。

保留二代逐条消息快照、引用与语音拆分、明确沉默处理，以及“实际发送内容只经一个出口”的规则。安装包不带账号、密钥、聊天记录、记忆或录音。隔离测试不代表真实模型的语义判断质量或真实QQ联调已通过；验证范围见[验证记录](docs/VALIDATION.md)。

## 下载与安装

从本仓库的 [Releases](https://github.com/mocias/qq-bot-dsh/releases) 下载 `qq-bot-dsh-0.25.0-windows-portable.zip`。这是 Windows 便携安装包，包含服务、轻量插件、启动/更新脚本及服务的 Node 依赖；不是包含全部环境的 EXE。Node.js 22+、DSH 桌面版及 QQ/NapCat 需要另行安装。压缩包不包含任何账号、密钥、聊天记录、私人记忆或语音模型。

先将压缩包解压到一个新的版本目录，例如 `C:\QQRSI\releases\0.25.0`，进入该目录执行：

```powershell
# 选择部署根目录与当前版本，统一启用原生模式
node scripts/activate-release.mjs "C:\QQRSI" "C:\QQRSI\releases\0.25.0"

# 首次安装时登记轻量插件；后两个路径须替换为实际 DSH profile 和安装目录
node scripts/install-native-plugin.mjs "C:\QQRSI" "<DSH profile目录>" "<DSH安装目录>"

# 启动并打开已登录面板
& .\standalone\scripts\open-panel.ps1 -Runtime "C:\QQRSI\standalone\.runtime" -StartScript "C:\QQRSI\start-latest.ps1"
```

DSH profile 目录应包含 `package.json` 与 `cordis.patch.yml`，安装目录应包含 `resources\app.asar`。安装器只登记配套插件并备份相关配置，不修改模型预设或全局权限。首次安装后若 DSH 未显示插件，请重载 DSH，再到面板检查连接。QQ 接收默认停止，由使用者核对允许名单后手动启动。

**已有安装更新：**先在面板停止 QQ 接收并等待当前任务完成；将新包解压到新目录，运行上述 `activate-release.mjs` 和打开面板命令即可。已经登记的轻量插件会同步更新，无需另装旧 OneBot/群聊插件。部署根目录必须沿用原位置，不能改成新解压目录；原配置、记忆、会话与旧版本保留。服务和轻量插件使用同一发布指针，版本、协议或构建不一致会拒绝原生连接。详细边界见 [原生插件与统一发布](docs/NATIVE-TOOLS-0.16.md)。

`SHA256SUMS.txt` 提供安装包和源码包的下载校验值。GitHub 自动生成的 Source code 压缩包及单独源码包不带 Node 依赖，开发前需执行下方依赖安装命令。

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
| `native-dsh-plugin/` | 与服务同步发布的轻量 DSH 原生工具插件，不负责另起 QQ 接收器 |
| `dsh-onebot-source/` | 原 OneBot 插件 TypeScript 源码、已编译 lib 和测试 |
| `dsh-group-social/` | 原独立群聊插件，作为迁移参考 |
| `dsh-plugin-memory-source/` | 原长期记忆插件完整核心源码与测试 |
| `dsh-companion-voice/` | 本地 TTS / ASR、MiMo API 适配源码 |
| `dsh-qq-unified/` | 原 DSH 统一插件打包工具与设置界面 |
| `scripts/` | 工作区检查、测试和打包入口 |
| `docs/` | 开发、验证、迁移说明 |

原插件内的固定账号与路径已改为示例，不能直接当作本机部署配置。当前独立服务的账号默认值为空，允许名单默认为空。不要同时让旧插件和独立服务消费同一 QQ 聊天。

正式安装使用原生持续对话，历史 JSON 传输适配不再作为聊天模式选项。开发验证时应构建并统一激活服务与插件，而非只替换某个文件：

```powershell
node scripts/package-release.mjs "<不存在的新发布目录>"
```

## 新机器需要单独配置

DSH、QQ/NapCat、Python 环境、语音模型、API 密钥、私人记忆均不在仓库中。语音模型和部署目录的准备方式见 [开发说明](docs/DEVELOPMENT.md)。桌面 QQ 与机器人共用一个登录实例的方式见 [迁移说明](docs/MIGRATION.md)。

交接从 [HANDOFF.md](HANDOFF.md) 开始，开发约定见 [AGENTS.md](AGENTS.md)，验证范围见 [docs/VALIDATION.md](docs/VALIDATION.md)。

## 来源与许可

保留各来源模块的独立许可，详见 `dsh-onebot-source/LICENSE`、`dsh-plugin-memory-source/LICENSE` 和 [第三方说明](standalone/THIRD-PARTY-NOTICES.md)。本仓库没有把不同来源代码重新统一授权。QQ 协议接入参考 [Derpyu520/qq-bridge](https://github.com/Derpyu520/qq-bridge)，NapCat 与 DSH 需另行安装。
