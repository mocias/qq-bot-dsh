# qq-bot-dsh

当前发布版本 **0.16.3**。主线为 `standalone/` 独立 Node.js 服务，包含配置面板、QQ 多媒体桥接、长期记忆、插话、会话轮换、按聊天配置和本地/MiMo 语音；配套 `native-dsh-plugin/` 轻量 DSH 插件，两者随同一安装包更新。

0.16.3 修复引用语音混发与“无回复”误发；原生发送工具结束回合后展示实际投递回执，避免模型续写另一版措辞及重复发送。详见[投递规则与限制](docs/DELIVERY-0.16.3.md)。

**独立进程仍依赖 DSH 提供模型推理、Agent 工具循环和权限审批。** 本仓库不是完全脱离 DSH 的 Agent harness。

## 本版更新

- 安装包包含独立服务和 **QQ RSI 轻量插件**（`dsh-qq-rsi-native`）。插件负责向 DSH 提交原生执行请求、登记当轮工具并回调本机服务；QQ 连接、记忆保存和最终发送仍由独立服务负责。
- 插件在 DSH 已安装插件列表中显示名称、版本和启停开关；控制面板“连接与配置”可检查插件是否安装、启用，以及服务/插件版本和构建是否一致。更新保留插件原有关闭状态。
- 启动资料与相关记忆页预算取消每项 30,000 的固定上限，统一为“字符数”；新增 token 粗估、可选模型容量参考和不阻断保存的超量提醒。见 [预算说明](docs/MEMORY-BUDGETS.md)。
- **本版尚未修改 DSH 最终正文与 QQ 实际投递正文的显示一致性。** 调用发送工具后仍以工具消息为准，普通最终回答不重复发到 QQ。

## 下载与安装

从本私有仓库的 [Releases](https://github.com/mocias/qq-bot-dsh/releases) 下载 `qq-bot-dsh-0.16.3-windows-portable.zip`。这是 Windows 便携安装包，包含服务、轻量插件、启动/更新脚本及服务的 Node 依赖；不是包含全部环境的 EXE。Node.js 22+、DSH 桌面版及 QQ/NapCat 需要另行安装。压缩包不包含任何账号、密钥、聊天记录、私人记忆或语音模型。

先将压缩包解压到一个新的版本目录，例如 `C:\QQRSI\releases\0.16.3`，进入该目录执行：

```powershell
# 选择部署根目录与当前版本，统一启用原生模式
node scripts/activate-release.mjs "C:\QQRSI" "C:\QQRSI\releases\0.16.3"

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

源码开发默认保留旧模式兼容入口；需要验证原生工具模式时，应构建并统一激活发布包，而非只替换某个插件文件：

```powershell
node scripts/package-release.mjs "<不存在的新发布目录>"
```

## 新机器需要单独配置

DSH、QQ/NapCat、Python 环境、语音模型、API 密钥、私人记忆均不在仓库中。语音模型和部署目录的准备方式见 [开发说明](docs/DEVELOPMENT.md)。桌面 QQ 与机器人共用一个登录实例的方式见 [迁移说明](docs/MIGRATION.md)。

交接从 [HANDOFF.md](HANDOFF.md) 开始，开发约定见 [AGENTS.md](AGENTS.md)，验证范围见 [docs/VALIDATION.md](docs/VALIDATION.md)。

## 来源与许可

保留各来源模块的独立许可，详见 `dsh-onebot-source/LICENSE`、`dsh-plugin-memory-source/LICENSE` 和 [第三方说明](standalone/THIRD-PARTY-NOTICES.md)。本仓库没有把不同来源代码重新统一授权。QQ 协议接入参考 [Derpyu520/qq-bridge](https://github.com/Derpyu520/qq-bridge)，NapCat 与 DSH 需另行安装。
