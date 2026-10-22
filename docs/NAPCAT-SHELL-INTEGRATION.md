# NapCat Shell 集成计划与首版验收边界

当前状态（rc.2 冻结前只读证据）：rc.1 已按用户授权部署本机，用户随后自行登录成功；真实预期账号与 OneBot 在线，接收保持停止。rc.2 修复源码只读检查当前组件为 verified，705 项原程序摘要不变；候选打包与实际部署状态另记录。此前两次扫码失败属于历史现象。

更新日期：2026-10-22。当前源码修复版 **0.26.0-rc.2**，见 [版本说明](RELEASE-0.26.0-rc.2.md)。rc.1 已本地部署但未提交推送或发布 GitHub；用户完成真实登录，身份及 OneBot 在线已只读确认。原生运行库新增 guild1.db 及 SQLite sidecar 导致旧组件检查误判，服务/面板同时存在仅按在线显示就绪的问题；本版分别修复，真实消息、媒体和拍一拍仍未验证。

## 目标架构

当前业务主线保持：`QQ/NapCat → standalone Node → 原生 DSH 插件 → DSH Agent/模型`。Standalone 继续负责允许名单、接收启停、会话和人格隔离、媒体准备与发送计划；`Bridge.sendPlan` 是所有公开 QQ 输出的唯一出口，按计划逐项等待 OneBot 回执。适配层只负责将选定后端暴露为现有 OneBot 调用形态，不能另建发送通路。

NapCat Shell 的职责是准备/启动独立 NapCat 组件并提供私有 OneBot 连接配置。登录动作由 QQ/NapCat 组件完成；本项目面板展示组件返回的真实二维码并轮询登录状态。启动后必须读取登录账号并与配置账号核对，确认 online，才允许将后端报告为已连接。`get_status.good` 的明确 false 仍应拒绝连接；NapCat 固定返回 true 的事实意味着该值不能证明 PacketBackend、媒体或其他扩展动作可用。

机器状态采用相互独立的 `onebot` 与 `capabilities.packet` 字段。`onebot.state=ready` 代表接口、账号和在线检查通过；`capabilities.packet` 则只接受只读 `nc_get_packet_status` 探针结果：`ready`、`unavailable`、`unsupported`、`timeout` 或 `unknown`，并记录检查时间和稳定 reason code。NapCat 4.18.41 该动作成功时 `data:null` 是预期契约，可判 PacketBackend 检查通过；仍需注明“拍一拍实际投递未验证”。接口缺失、显式 PacketBackend 错误、超时与异常响应不能合并成一个健康布尔值。Packet 探针非 ready 不阻止基本文字聊天；依赖该能力的操作保持不可用，不能因 `get_status.good=true` 开放。

接收开关和聊天允许名单继续默认关闭/空。确认在线或扫码登录绝不自动扩大私聊/群聊范围。身份隔离键仍为机器人账号、聊天类型、对象及人格；共享会话或媒体缓存不得跨键读写。

首版限制应用层可调用的能力和发送对象；官方固定版 NapCat/QQ native archive 没有做物理源码裁剪或二进制删减。本轮没有完成上游源码裁剪，因此不能描述成已实现最小化源码包；运行组件仅由固定版本归档自动准备、校验并隔离管理。

## 四组能力审查

状态用语：**代码已复用**表示源码已有业务实现；**模拟已覆盖**表示临时 OneBot fixture 检查了请求/响应边界；**未验证**表示缺少真实 Shell/QQ 的端到端证据；**首版不可用**表示明确 fail-closed 或不提供该能力。名称出现在 OneBot 协议中不等于真实后端已验证。

| 范围 | 当前代码/动作 | 首版判断与验收要求 |
| --- | --- | --- |
| 1. 登录、二维码、账号校验、在线状态 | Shell/QQ 组件完成登录；面板展示组件真实二维码并轮询状态；`get_login_info` 校验数字账号及预期 botQQ；`get_status.online` 必须为 true | 用户已自行登录成功，管理接口、预期账号与 OneBot 在线只读检查通过；历史两次扫码失败原因未确定，账号切换及其他二维码场景未验证。不得以扫码成功代替账号校验；`good:false` 拒绝，`good:true` 不代表扩展能力可用。 |
| 2. 私聊/群聊文字、引用、@、消息回执 | `send_private_msg` / `send_group_msg`；入站 `get_msg` 校验引用属于当前聊天；群 @ 先 `get_group_member_info` 校验目标；Bridge 为每条计划持久化送达状态及消息 ID | 文本路径已复用；逐条成功回执与失败停止/未知状态不重放由 Bridge 保持。模拟可验证构造与回执处理；真实私聊/群聊送达和 reply/@ 展示仍未验证。 |
| 3. 图片、表情、语音 | 图片入站 `get_image` 后检查类型/大小并作为模型附件；图片出站检查允许目录或公网地址后发 base64；入站 `face` 转可读表情文本并在快照保留原类型；语音入站 `get_record(out_format=wav)` 后本地转写；语音出站先合成并验证 WAV，准备失败才回退文字 | 图片和语音业务已复用，公网 DNS/IP、重定向、目录、链接和大小限制必须保留。普通图片、表情图片及 GIF 均按图片处理，Unicode 表情随文字发送。新增的系统表情仅允许固定 NapCat v4.18.41 `face_config.json` 中 329 个 `sysface[].QSid`，发送标准 `{type:'face',data:{id:'14'}}` 段；可单独发送或与单条文字、引用、@共存，仍只发到当前聊天，并受当前聊天 `stickerSend` 策略控制，不依赖图片发送开关。固定 NapCat 转换器会从 face 配置按 QSid 派生 faceType 和可能存在的 AniSticker 元数据；本项目不开放 `resultId`、`chainCount` 等额外输入。入站 `face` 保留原类型并提供规范化视图。标准段已模拟验证，真实展示未验证；不能据此声称所有特殊动画或附加参数组合都能投递。模型视觉能力、QQ 图像解码和真实语音质量未验证。 |
| 4. 合并转发、文件、视频、拍一拍 | 转发接收 `get_forward_msg`，最多四层/百段约束；私聊/群聊分别构造 `send_private_forward_msg` / `send_forward_msg`；文件收取 `get_file`，上传 `upload_private_file` / `upload_group_file`；视频以消息段发送；拍一拍由群 `group_poke` 或私聊 `send_poke` 工具执行 | 文字转发、文件和视频适配已有，本轮 fixture 覆盖文件/视频取回与上传动作边界；真实文件/视频内容与上传回执未验证。NapCat 动作清单包含 `group_poke` 与 `send_poke`，但 QQ 拍一拍依赖的 PacketBackend 能力需要独立探测；目前未做真实发送，应显示未验证/不可用，不能据动作名或 `good` 声称可用。 |

所有媒体输入必须经同聊天隔离目录、来源 ID 校验、大小上限与公网地址校验。收到 URL 或文件 ID 不等于文件可读。超时或断线发生在发送动作已派发之后时，结果保留为 unknown 并停止该计划；不能补发、自动改成文字或重放。

## 模块职责与实施范围

| 模块 | 职责 | 本轮边界 |
| --- | --- | --- |
| `standalone/lib/onebot.mjs` | OneBot 请求关联、登录身份和在线校验 | 仅保留通用握手边界；不将 `good` 当作功能探测。 |
| `standalone/lib/media.mjs` | 复用的引用、图片/语音/转发/文件/视频准备及安全检查 | 只补实际兼容缺口和 fixture；不另造媒体业务系统。 |
| `standalone/lib/bridge.mjs`、`reply-control.mjs` | 队列、允许名单、逐条发送和唯一公开出口 | 不增设旁路；不自动重试 unknown。 |
| `standalone/lib/qq-runtime/index.mjs` 及 `archive.mjs`、`components.mjs`、`processes.mjs`、`versions.mjs` | NapCat 组件准备、受管进程/连接生命周期、版本记录与回退 | 通过 OneBot 接口接入现有业务；只限制应用层能力，不物理裁剪第三方 archive；不把它复制进本项目发行包。 |
| `server.mjs`、`qq-control.mjs`、`napcat-sync.mjs`、`public/`（UI 子任务） | 后端选择、配置、控制和能力展示 | 显示 verified/unverified/unavailable 边界；不得把 `get_status.good` 映射成完整能力。 |
| `scripts/package-release.mjs` 与发行清单 | 可复核的自有项目打包与外部依赖声明 | NapCat/QQ/Node/DSH 均为外部组件；第三方源码、二进制与安装包不随本项目自有包分发。 |

## 准备、登录、接收状态与运行状态

本轮已实现 Windows x64 固定归档准备：只在隔离临时目录下载/解包，验证官方 HTTPS redirect、完整归档 SHA256、关键入口摘要和全程序文件 inventory，成功后原子建目录；失败清理暂存并保留现有现场。未提供可核实清单时明确阻断，不能用手动复制描述成自动安装。运行组件从固定官方来源在用户设备准备，不随本项目自有包分发。

建议状态序列：`未准备 → 正在准备 → 待登录 → 正在核验账号 → 在线`；准备、启动、接口、账号不匹配或离线错误分别保留原因。停止状态必须保留；服务重启不自动开始接收。状态切换只影响后端进程和 OneBot 会话，不删除配置、记忆、媒体或聊天数据。

## 升级与回滚

源码包和便携包要记录版本、协议、构建哈希、组件是否被发布包包含、组件准备策略及校验状态。`external-components.json` 中 `includedInRelease:false` 仅表示发行包没有嵌入第三方二进制；不等于所有外部组件都必须手工安装。Node 和 DSH 仍由用户单独提供；QQ native runtime 已包含在官方 Windows Node archive 中，Shell 目标为项目自动下载并校验整包，不需要用户再安装系统 QQ。NapCat 与 QQ runtime 均不随本项目发行包再分发。缺少官方归档与校验清单时阻断准备，不允许把手动复制组件视为自动准备完成。

准备新的 NapCat 版本时先保留活动目录，校验归档并隔离准备该版本的私有账号配置；切换只允许在接收停止、消息/发送队列空闲、QQ 进程退出确认后提交活动指针。失败不更改指针、原账号配置或人工停止状态；回退只切换到同机器人账号下摘要校验通过的前一版本，不重置允许名单、人格或业务数据。当前有版本事务夹具与面板流程，但只有一个真实版本清单条目，真实旧版切换/回退尚未验收，也不自动恢复接收。源码构建成功不等于外部 NapCat 已准备，也不等于实际 QQ 已登录。

项目 release staging 脚本已生成自有源码包、`external-components.json` 与 `release.json` 哈希，并在隔离临时目录检查过清单。官方归档生产 prepare 已用固定 zip 验收，705 个程序文件 / 361,466,126 字节 inventory 通过，含 310 字节原包 `napcat/config/napcat.json`；账号工作目录中的 WebUI/OneBot 配置不在程序 inventory。该测试未启动包内程序。版本目录、原子活动指针、私有工作目录和受控 UI 回退入口已实现并经模拟事务验收；真实可用旧版尚未纳入 catalog，故暂时无法执行真实包回退。

## 临时模拟验收矩阵

| 验收项 | Fixture/断言 | 当前真实环境状态 |
| --- | --- | --- |
| OneBot 登录 | `get_login_info` 账号格式与预期账号；`get_status.online`；显式 `good:false` 拒绝 | 用户已自行登录成功，预期账号和 OneBot 在线只读核验通过；历史失败不代表当前状态，也不证明所有二维码场景可用 |
| PacketBackend | 可注入只读 `nc_get_packet_status`；4.18.41 的 `status:ok, retcode:0, data:null` 判 `ready`；retcode/wording 报不可用、未知动作和超时分别判态；异常 payload 为 `unknown` | 只验证 fixture 与上游返回契约；没有实际拍一拍发送证据 |
| 文本、引用、@、回执 | 私聊/群聊动作和对象；引用跨聊天拒绝；目标成员校验；每条送达/失败/unknown | 未真实发送 |
| 图片与表情 | `get_image` 返回媒体、格式/大小、路径与公网地址限制；入站 face 文本化；系统表情使用固定 QSid 目录，标准 OneBot face 段发至当前对象 | `standalone/test/napcat-shell-capabilities.test.mjs` 覆盖目录 329 项、ID 14 可用/138 拒绝、纯表情段、引用表情、跨聊天参数拒绝及未知回执只发一次；真实 QQ 展示未验证。普通 Unicode 表情、表情图片和 GIF 按原消息/图片处理；未开放独立 QQ face 的特殊动画参数 |
| 语音 | `get_record` 明确请求 WAV；隔离临时音频转写；合成文件校验及 voice 失败前回退 | 未接真实 QQ 语音及真实音质 |
| 转发 | `get_forward_msg` 多节点/嵌套边界；私聊/群聊各自发送动作 | 未真实发送或展开 |
| 文件与视频 | `get_file` opaque ID 临时返回 bytes/URL；仅允许当前聊天路径；发送动作/大小限制 | NapCat 文件和视频回执格式未验证 |
| 拍一拍 | PacketBackend 单独探针；群 `group_poke` / 私聊 `send_poke` 仅可在后端检查通过后显示候选能力，不进行副作用探针 | PacketBackend 真实状态及真实拍一拍均未验证 |
| 版本事务及回退 | 临时目录构造两份测试组件摘要，验证安装/激活分离、切换/回退、版本私有配置隔离、失败与陈旧 revision 保持旧指针 | fixture 通过；当前官方 catalog 只有一个版本，真实旧版条目和真实包回退未验证 |
| Unknown 发送 | 模拟已派发后超时/断线，确认该项状态 unknown、后续计划停止且不重放 | 不执行真实网络发送 |
| 发布清单 | 临时新目录打包，断言不含 NapCat/QQ 文件，外部依赖和哈希可检查 | 已通过临时 staging；未激活、不上传、不发布 |

继续真实验证仅限已授权的单一机器人账号与一个私聊对象，群聊禁止；当前用户已自行登录成功并确认账号/OneBot在线；接收与真实消息收发尚未启动。隔离 fixture 和合成媒体均不等同真实消息验收。

## 授权与第三方边界

NapCat、QQ runtime 及其依赖属于外部组件。发行目录包含本项目代码、服务 Node 依赖、依赖锁定与外部组件清单/验证器；不包含第三方 NapCat/QQ 源码、客户端、加载器或官方归档。运行时通过固定官方来源在用户设备上自动准备组件，缺少归档或来源/校验无法确认时清晰阻断 Shell 启动。这些打包边界不对第三方许可作法律结论，真实兼容性也不能由接口动作名称推定。

## 完成状态与未验项

### 分阶段基线

下列阶段是本轮统一的设计基线，状态只按本仓代码与临时证据填写。把某阶段标成“已实现”不等于真实 QQ 已验。

| 阶段 | 验收目标 | 当前状态 |
| --- | --- | --- |
| M0 固定组合 | 固定 Windows x64 的 QQ/NapCat/启动器组合，记录官方来源和 SHA256；启动参数来自官方对应版本脚本 | 只读核验官方 `NapCat.Shell.Windows.Node.zip`（124,089,498 bytes）后，推荐固定该包与 QQ `9.9.31-49738-x64`、Node `22.11.0`。压缩包根入口为 `node.exe index.js`；`index.js` 直接指向本包内 `wrapper.node`、`package.json`、`config.json` 和 `napcat/napcat.mjs`，无 QQ.exe 或注册表查找依赖。嵌入版 `napcat.mjs` 明确含 PacketBackend 键 `9.9.31-49738-x64`，收/发偏移分别为 `2007901` / `0AF9FCC`。这证明版本表命中，不证明本机 native 初始化、登录或真实拍一拍成功，仍须运行时探针和真实验收。 |
| M1 项目准备 | 项目按固定官方清单下载、校验、暂存 NapCat 组件；只回收项目拥有的 Shell 进程 | Windows x64 官方 Node 包准备、摘要校验及受管进程生命周期已实现。指定执行器真实启动 4.18.41 后再次验证组件完整性通过；初测发现启动生成 `beacon_report.log`，运行时已调整该动态文件边界并重新启动验证。其他 QQ 进程不会被接管或停止。 |
| M2 面板生命周期 | 面板准备→启动登录→二维码/账号核验→允许名单→显式接收；基础QQ登录、OneBot、接收运行状态独立呈现 | 管理 API/UI、配置迁移及模拟 DOM 验收已完成；用户已自行登录成功，真实账号和 OneBot 在线只读确认；接收仍保持停止，消息未验。新安装接收默认停止，旧配置缺少 `qqBackend` 时兼容 `external`。 |
| M3 消息能力 | 四组列出的功能作为 V1 必需；图片/表情按普通与动图处理且保留原始媒体类型；PacketBackend状态与实际拍一拍分开 | 大部分媒体业务在 `media.mjs` 已有并复用；fixture 覆盖文件/视频、GIF MIME/原段类型、系统 face 标准段和 PacketBackend探针。系统 face ID 来源为固定 commit `859eb530c5801577633c2c3ae871d23586edf281` 的 `packages/napcat-core/external/face_config.json`，SHA256 `517d9a42ec48a96f33a626a62e955b8df26dd06d5485438e1f3fe677029135ba`；自有数据清单记录 329 个 QSid，不复制上游实现。真实 QQ 图片、动画、语音、文件、视频、转发、系统表情展示与拍一拍均未验证。 |
| M4 更新回退 | 新版本校验后才切换；停止接收并确认任务退出；版本与私有账号数据分离；未知发送不重放 | 受控版本安装/切换/回退 API 与面板已实现。组件按摘要放入 `qq-shell/versions/<版本-摘要>/components`，每个版本/账号的连接数据放在 `qq-shell/work/<版本>/<QQ>`；`active.private.json` 原子记录 active/previous/revision。服务层要求接收、任务、队列及进程均停止/确认，切换不自动启动或恢复接收；夹具验证陈旧修订拒绝、失败保持原活动指针、跨账号隔离和回滚。可独立审包的 v4.18.38 官方 Node 归档为 124,079,600 字节、SHA256 `b88007a373a30deefb387e7cf17911752ff900bce22c534b3da6b644f5c6d0ae`，入口和 QQ 元数据已只读核对，但当前真实 catalog 仍仅含 4.18.41，v4.18.38 未安装/未加入可用目录。故目前没有可用真实旧组件回退，真实版本回滚/状态恢复未验。 |
| M5 验收 | 临时模拟能力、DOM操作、干净目录打包验收 | 最终 standalone 全套 438 项：430 通过、0 失败、8 项可选 SDK 条件跳过。系统 face、表情策略和 schema SDK 专项 14/14 通过、无跳过；已安装 DSH `defineTool` schema 独立检查 1/1 通过。其余 8 项旧 SDK 检查受 `QQ_RSI_DSH_SDK_ROOT` 可选 guard 控制；可访问的本机 SDK 目录缺少其中部分独立 compaction、skill 与 scheduler 包。模拟 DOM 操作无 console 告警。官方 archive prepare 与干净目录 release staging 已验证；用户后来已自行登录，身份和 OneBot 在线核验通过；真实消息收发尚未验。 |
| M6 真实账号 | 在明确账号/聊天范围后由指定单一执行器扫码，并对指定私聊对象作最小双向收发验收 | 已授权单一机器人账号与一个私聊对象，禁止群聊。用户在 rc.1 本地部署后自行登录成功，真实预期账号及 OneBot 在线只读核验通过；本轮没有真实 QQ 消息发送验收。合成媒体样本位于独立临时 workspace，具体位置仅交给执行器；模拟结果不能记为真实消息验收。 |

### 能力与测试证据映射

OneBot成功回执只表示接口确认接受或执行，不表示对方已读、文件已下载、语音已播放。上传文件接口成功时可能不返回 `message_id`，不得合成假的 QQ 消息 ID。连接丢失或超时发生在动作派发之后时视为结果未知；停止剩余计划且不自动重放。

系统表情清单是本项目自有的 ID allowlist 元数据，不含上游实现：固定 NapCat v4.18.41 commit `859eb530c5801577633c2c3ae871d23586edf281` 的 `packages/napcat-core/external/face_config.json` SHA256 为 `517d9a42ec48a96f33a626a62e955b8df26dd06d5485438e1f3fe677029135ba`。`standalone/lib/qq-face-catalog.json` 由唯一数字 `sysface[].QSid` 汇总，整数校验通过后才接受系统表情计划；无效或该版本未列出的 ID 明确拒绝，避免 NapCat 静默丢弃消息段。发送只通过现有 `qq_send_message`、媒体适配和 `Bridge.sendPlan`，不接受模型指定 OneBot 动作、目标对象或额外 face 参数。

| 能力范围 | 当前源码及测试证据 | 真实边界 |
| --- | --- | --- |
| 登录、账号、在线 | `standalone/lib/onebot.mjs::verifyQQ`；`standalone/test/napcat-shell-capabilities.test.mjs` 的 `login requires a valid configured account and online state; good is only a veto`；`standalone/test/service.test.mjs` 的 `end-to-end OneBot to DSH: dedup, private/group separation, receipts and safe restart` | 不扫码、不登录真实 QQ；NapCat `get_status.good` 不作为可选动作探针。 |
| 私聊/群聊文字、引用、@、逐项回执 | `standalone/lib/media.mjs::outgoing`、`standalone/lib/bridge.mjs::sendPlan`；新增测试 `private and group text, quote and mention plans keep destinations scoped`；既有 `standalone/test/migration.test.mjs` 的 `quotes cannot leak messages from another private chat or group`、`standalone/test/chat-migration.test.mjs` 的 `failed model continuation sends no queued messages` 和 `standalone/test/multi-reply.test.mjs` 的 `failed second QQ delivery is recorded and stops later parts without resending earlier ones` | 夹具证明对象/计划和回执逻辑；没有真实送达、已读或展示证据。 |
| 图片、表情、动图、语音 | `standalone/lib/media.mjs::incoming/outgoing`；既有 `standalone/test/media-proactive.test.mjs` 的 `image and forwarded-image bytes become real model attachments; records use resolved trusted files`、`outgoing image, merged-forward and voice follow original envelopes and fallback only before send`、`group voice quote and mention never share a record bubble; synthesis fallback keeps normal quote`、`real bridge media path attaches pixels and sends image exactly once even on unknown delivery`；新增 `standalone/test/napcat-shell-capabilities.test.mjs` 的 `animated image bytes retain GIF media type and face segments retain their source kind`、`QQ system face uses fixed official QSid catalog and one current-chat send segment`、`quoted face send validates the current peer and keeps quote, text and face in one bubble`、`unknown QQ face delivery is reported once and never retried`、`QQ system face obeys per-chat stickerSend policy in native tools and payload preparation`、`voice plan keeps a record bubble and an unknown post-dispatch result is never replayed`；既有 `standalone/test/migration.test.mjs` 的 `CQ, faces, cards and quotes route; ambient messages require opt-in` | 模拟验证 GIF MIME/归档扩展名、入站 face 查询视图规范化且保留 image/face 原类型、系统 face 标准段与固定目录校验，以及未知回执只尝试一次；普通 Unicode 表情按文字发送，表情图片/GIF按图片处理。策略关闭时工具和 payload 两侧拒绝系统表情；策略开启时即使图片发送关闭仍允许标准 face 段。真实 QQ 展示未验证，也不涵盖需附加参数的特殊/动画表情；没有真实 QQ 媒体/模型视图或音质证据。 |
| 合并转发、文件、视频 | 新增 `standalone/test/napcat-shell-capabilities.test.mjs` 的 `file and video receive use scoped IDs, bounded bytes and isolated local archives`、`outgoing file, video and merged forward preserve OneBot action boundaries`；既有媒体测试验证图片嵌套转发 | 文件/视频上传回执、QQ侧播放/下载及真实转发树仍未验证。 |
| 拍一拍 PacketBackend | 新增 `PacketBackend read-only probe distinguishes ready, unavailable, unsupported, timeout and unknown`、`PacketBackend status adapter verifies account and uses one read-only websocket fixture`；`standalone/test/chat-migration.test.mjs` 的 `private and group poke use scoped OneBot actions and persistent cooldown` | 只读检查成功不会代替真实拍一拍；不执行模拟之外的主动探针。 |
| 多气泡及未知发送 | `standalone/test/multi-reply.test.mjs` 的 `failed second QQ delivery is recorded and stops later parts without resending earlier ones`、`stopping during a multi-part QQ reply prevents subsequent sends`；`standalone/test/media-proactive.test.mjs` 的 `real bridge media path attaches pixels and sends image exactly once even on unknown delivery` | 这些是模拟“未知不重放”证据，不是真实接口行为证明。 |

### 官方 Windows 制品核对

官方 [NapCat v4.18.41 release](https://github.com/NapNeko/NapCatQQ/releases/tag/v4.18.41) 于 2026-10-21 发布，tag 指向 `859eb530c5801577633c2c3ae871d23586edf281`。经 SHA256 核验的官方 [release assets 索引](https://github.com/NapNeko/NapCatQQ/releases/expanded_assets/v4.18.41) 给出：`NapCat.Shell.Windows.Node.zip` SHA256 `51fbb10e7bcd56b0c2a6de86c37811e7518330e48a137ac689ab1e4d8627d3f0`；`NapCat.Shell.Windows.OneKey.zip` SHA256 `46c3ec155aa61f12e89bbf97013a21243d00b0019b5565992a88852d7627f39c`；`NapCat.Shell.zip` SHA256 `6801f93e533846cea05f4f531874a0e84371ab2331c5585b57cd7e3b869cf96b`；`NapCat.Framework.zip` SHA256 `3c526f5789ff6cc56d78381eb10536c8273fe394d227187b27dea94b59965822`。

官方 [NapCat release workflow（固定 commit，L997-L1243）](https://github.com/NapNeko/NapCatQQ/blob/859eb530c5801577633c2c3ae871d23586edf281/.github/workflows/release-publish.yml#L997-L1243) 固定 Windows Node 制品中的 QQ 为 `9.9.31-49738-x64`，校验上游 QQ 安装程序 SHA256 `0beb5cb4ff776cba822caa0abadbd53f5892f12628a86dabea1b372c82c086bc`，并包含 Node `22.11.0`。只读检查下载的 Node zip 时，根 `package.json` 和 `config.json` 分别报告 `9.9.31-49738`/build `49738`、平台 `win32`、架构 `x64`；根 `index.js`（SHA256 `5de31bef6cc1b48cef0229a8b22b32b3211e41253c3e75a9547e996becf9b388`）设置包内路径并导入 `napcat/napcat.mjs`，没有系统 QQ.exe/注册表读取。官方 [napcat.bat](https://github.com/NapNeko/NapCatQQ/blob/859eb530c5801577633c2c3ae871d23586edf281/packages/napcat-develop/napcat.bat) 只是运行 `node.exe index.js %*`，项目可直接启动等效入口而不执行 bat。归档 SHA256 为 `51fbb10e7bcd56b0c2a6de86c37811e7518330e48a137ac689ab1e4d8627d3f0`；这覆盖固定 Windows Node 包，不代表项目发行包再分发了它。

Windows Node 便携包带有自身 `node.exe`、QQ wrapper 和 QQNT native 文件。包内 PacketBackend 表用 `QQ完整版本 + '-' + arch` 精确查询；当前包的 `getFullQQVersion()` 从根配置/包元数据得到 `9.9.31-49738`，Windows x64 的键为 `9.9.31-49738-x64`，收/发偏移分别为 `2007901` / `0AF9FCC`。这只证明固定包的版本键命中；本机 native 初始化仍由只读 PacketBackend 状态探针核实。

固定包内 NapCat 配置模板是 `napcat/config/napcat.json`（`fileLog:false`、`consoleLog:true`、`packetBackend:"auto"`），已包含在 705 文件摘要 inventory 内。经只读核对的 `PathWrapper` 支持 `NAPCAT_WORKDIR`；运行时将其指向 `qq-shell/work/<版本>/<QQ>` 并在其中创建 WebUI、OneBot 配置、日志、缓存与插件目录，不改写只读版本目录。NapCat 代码把 QQ native 数据根交给 `wrapper.NodeQQNTWrapperUtil.getNTUserDataInfoConfig()`；取不到时回退到用户主目录下 `.config/QQ`，再在该根目录下创建 `NapCat/` 与 `NapCat/temp/`。该账号数据路径位于 QQ wrapper/用户数据区域，不在版本组件目录内；本轮未执行 native wrapper，因此不宣称其在 Windows 上返回的实际绝对路径。更新和回滚只应切换/校验项目版本目录，不能清理 QQ wrapper 返回的用户数据目录。

上游 NapCat 的 `LICENSE` 对源码复制/分发设置了限制；当前项目不将其源码/二进制带入本仓或生成包。用户首次点击准备时，项目可以从固定官方 Release URL 下载并校验 SHA256，再隔离解包；这与项目发布者自行转发第三方组件是不同路径，仍需完成来源/许可评估。

- 已确认现有 `media.mjs` 已承担主流媒体和引用业务，可在 OneBot 后端复用；安全下载和单出口发送边界是集成约束。
- 已确认 `verifyQQ` 需要保留账号/online 校验和对显式 `good:false` 的拒绝；`good:true` 不参与扩展能力声明。
- 本轮模拟测试只证明 fixture 下的消息构造、校验和结果处理。生产 prepare 实际验证了官方 zip 的下载/解压/摘要流水线，但未运行包内代码，不证明官方归档的再分发许可、真实 QQ 登录、多媒体收发、PacketBackend 拍一拍或干净机器完整登录流程。
- 尚待处理：将第二个真实旧版官方归档摘要、根入口和 QQ 元数据核实后加入 catalog；真实 QQ 指定私聊对象双向收发；四组媒体的真实端到端验收；实际启动后的 PacketBackend/拍一拍；以及第三方许可与账号条款的发布前核查。官方包底层没有做源码/二进制物理裁剪，仅有应用层能力边界。
- 发布、提交、上传、激活及运行副本更新均不属于本轮授权。

## 0.26.0-rc.1 版本冻结与离线发布检查

2026-10-22：服务、原生插件、锁文件和面板显示统一至 0.26.0-rc.1，协议保持 1。复用现有面板启动脚本，根 open-panel.cmd 打开本包独立空数据面板；打包不执行激活，也不复制生产配置或 QA mock 数据。

离线代理复核：portable 103 项（102 通过、1 个原有环境条件跳过、0 失败），original-memory self-test PASS；native-release 相关定向集合 34 项（33 通过、1 个可选 DSH SDK 跳过、0 失败）。受限沙箱的首次临时目录原子替换遇 EPERM，正常权限仅重跑隔离 fixtures 后通过，不修改产品防护。候选 staging 的服务/插件/schema 一致、111 项构建摘要通过，source 明确为 dirty working-tree-snapshot。

本轮打包不会刷新二维码、启动 QQ、尝试真实登录或发送。本节为 rc.1 初次冻结记录：当时两次扫码未成功；后续用户已自行登录并核验身份及在线，真实收发仍未验，不能标记全功能完成。最终交付使用全文件 SHA256 清单及 ZIP 摘要复核，不以测试跳过冒充通过。

## 0.26.0-rc.2 修复冻结证据

用户登录后新增根 guild1.db、guild1.db-shm、guild1.db-wal，705 项原程序摘要保持不变。严格 runtime 专项 29/29、无跳过，源码 inspect 当前已登录现场为 verified；固定三个 SQLite 运行文件与既有日志受类型/路径/大小验证，其他未知文件与程序摘要变化继续拒绝。服务与面板专项 shell-management 14/14、定向 DOM/API 3/3 通过，完整性/归属受阻优先于在线展示。

候选完成并验证后再停旧管理器拥有的 QQ、确认退出、备份稳定缓存，然后正常统一激活重启服务。官方固定版本 QQLogin 路由与 handler 已核对，快捷登录仅使用 SetQuickLogin({uin})，当前列表精确包含预期账号；如获执行指令恢复登录最多一次，请求接受后只读核验，不能当成登录成功。当前仅修改源码与文档，未因修复准备中断已在线用户，部署证据另写私有记录。

冻结后最终隔离回归：standalone 446 项，438 通过、0 失败、8 项可选 SDK 条件跳过；native-release/native-status 专项 4/4、无跳过。runtime 29/29 与 shell-management 14/14 均通过。此前 portable 与原记忆核心结果保留，本轮未修改对应模块，未重复运行；跳过不计为通过。候选生成后不再修改其源码或文档，部署证据保存在私有记录。
