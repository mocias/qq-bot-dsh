# qq-bot-dsh

当前发布版本 **0.18.0**，合并持续对话与记忆机制更新。主线是 `standalone/` 独立 Node.js 服务，配套 `native-dsh-plugin/` 轻量 DSH 插件；两者随同一便携安装包更新，不能混装版本。

- **持续对话成为正式原生聊天的唯一模式**：发送工具经统一出口即时投递并返回实际回执，发送后模型可继续处理或等待。普通正文不再次转发，移除旧模式开关，旧配置中的 `continuousChat` 被忽略。
- **等待与子任务回传**：模型每次选择1～300秒（默认30秒）；用户消息、当前活动窗口内子任务进展或结果到达可提前唤醒。子任务结果交主智能体决定怎么回复，活动窗口最多15分钟，不保证跨重启继续回传。关闭“消息查询”只禁用主动查历史等辅助工具，不关闭接收、发送和等待。见[持续对话](docs/CONTINUOUS-CHAT.md)。
- **私聊与群聊完整记忆流程**：按需读页、全文搜索、元数据筛选、当前 Agent 运行时上下文与记忆操作指引；支持按本聊天授权自动建立和修改独立人设。各聊天继续隔离，保留人物QQ、来源与完整原文。
- **无需等压缩才整理**：压缩后空闲、累积完成对话后空闲、记忆库久未写入提醒共用一个维护调度。默认累积3轮，空闲时间沿用已保存设置；不会因此提前轮换。私聊/群聊默认和单对象覆盖均可配置。
- **记忆维护对齐**：降级归档由模型按原版指引判断，180/90天为建议；索引分区和顺序可编辑，支持旧摘要回填、带逐字原文证据的语义精简/合并及严格诊断。旧全文和人物来源保留，Git实现沿用现有方式。见[当前记忆契约](docs/MEMORY-PARITY-0.18.md)。

保留二代逐条消息快照、引用与语音拆分、明确沉默处理，以及“实际发送内容只经一个出口”的规则。安装包不带账号、密钥、聊天记录、记忆或录音。隔离测试不代表真实模型的语义判断质量或真实QQ联调已通过；验证范围见[验证记录](docs/VALIDATION.md)。

## 下载与安装

从本私有仓库的 [Releases](https://github.com/mocias/qq-bot-dsh/releases) 下载 `qq-bot-dsh-0.18.0-windows-portable.zip`。这是 Windows 便携安装包，包含服务、轻量插件、启动/更新脚本及服务的 Node 依赖；不是包含全部环境的 EXE。Node.js 22+、DSH 桌面版及 QQ/NapCat 需要另行安装。压缩包不包含任何账号、密钥、聊天记录、私人记忆或语音模型。

先将压缩包解压到一个新的版本目录，例如 `C:\QQRSI\releases\0.18.0`，进入该目录执行：

```powershell
# 选择部署根目录与当前版本，统一启用原生模式
node scripts/activate-release.mjs "C:\QQRSI" "C:\QQRSI\releases\0.18.0"

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
