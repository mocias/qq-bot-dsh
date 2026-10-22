# 受管 QQ Shell

`NapcatShellRuntime({runtimeRoot, ...testAdapters})` 提供 `status(config)`、`inspect(config)`、`installVersion(config,{versionId})`、`activateVersion(config,{versionId,expectedActiveId,expectedRevision})`、`rollback(config,{expectedActiveId,expectedRevision})`、`prepare(config)`、`start(config)`、`stop(config)` 和同步的内部 `resolveConfig(config)`。`config.botQQ` 必须是明确预期的账号；后者返回私有 OneBot 地址/token，仅供宿主内部使用，不能作为面板响应。

默认清单固定官方 `v4.18.41/NapCat.Shell.Windows.Node.zip`，归档 SHA256 为 `51fbb10e7bcd56b0c2a6de86c37811e7518330e48a137ac689ab1e4d8627d3f0`，QQ 元数据为 `9.9.31-49738`，仅支持 Windows x64。官方原包根 `index.js` 加载同包 `wrapper.node`、`package.json`、`config.json` 和 `napcat/napcat.mjs`，启动直接使用同包 `node.exe index.js`，不运行 bat，不查找系统 QQ.exe，不传猜测的账号参数。账号通过二维码完成后仍须核验 `get_login_info` 与 `get_status`。

`installVersion` 只下载、校验并安装固定目录中的版本，不激活、不改变原来的停止状态，可以保留现有 QQ 登录。`prepare` 兼容首次安装并激活，同版本重复准备不重写配置；已有其他活动版本时仅安装候选版，要求另行明确激活。下载检查每次重定向、大小及完整 SHA256，限定 ZIP 解析拒绝 ZIP64、加密、链接、重复/穿越/Windows 歧义路径和超额解压。归档经全部程序文件 inventory 和固定的关键入口摘要校验后原子安装到 `qq-shell/versions/<版本-摘要>/components`；版本记录位于同级 `version.json`。失败清理临时物；已有无效版本保留现场并拒绝覆盖。这个 ZIP 解析器只为已验证的官方包格式提供支持，不承诺任意 ZIP 兼容。

`active.private.json` 通过单次原子写同时保存 active、previous 和递增 revision，只保存版本与账号标识，不保存 token。激活和回退要求无 QQ 或未确认退出进程，验证目标组件、明确账号、私有连接和端口后才提交；上层服务必须另持接收/任务/发送队列空闲门禁直到操作完成。陈旧版本 ID 或 revision 请求会被拒绝，包括同版本切换账号的情况。任何安装、配置、校验或指针提交失败都不改变原活动版本、原配置或人工停止状态；安装/指针临时文件即使在崩溃后残留也不会被当作活动版本。不会自动启动 QQ、接收消息或重放未知发送。

官方 `PathWrapper` 明确支持 `NAPCAT_WORKDIR`，管理器将其设置为 `qq-shell/work/<版本-摘要>/<账号>`，使 `config/logs/cache/plugins` 与只读组件树分离。不同版本使用独立的上游私有配置，不默认复制未经证明兼容的另一版配置；宿主 app config 继续独立保存。回退恢复原版本已保留的工作目录及凭据，不丢弃候选版配置；不同账号的 previous 只保留记录，禁止自动回退或导入。旧 `current` 仅在同一归档摘要完整校验后复制到新版本目录，原路径与全局旧连接记录保持不变；同一明确账号的旧配置复制到对应新 work，其他账号的 OneBot 配置不导入。上游 QQ 原生账号数据由 `NodeQQNTWrapperUtil.getNTUserDataInfoConfig()` 指定，fallback 为用户 home 下 `.config/QQ`；本轮未执行原生模块，不能断言其 Windows 实际路径。准备、重试和清理均不访问、删除该数据。接收的停止与 Shell 进程停止是两个独立动作。

只管理本次服务现场捕获的进程，以 PID、创建时刻、可执行路径建立归属；后代只接管组件目录内的可执行文件。不会停止其他 QQ 或外部浏览器。服务重启遇到旧实例时保持 orphaned，不以磁盘 PID 记录接管。启动、退出或归属未知时保留 exit_unconfirmed 并阻止替代实例。端口被占用不自动覆盖；两个 loopback 端口和独立随机 token 保存于私有连接记录。连接记录损坏时保留现场并明确报错。操作锁中断后不自动清理，需要先核对进程；没有后台无限重启或消息重放。

`status.validation` 分别报告组件摘要、进程观察、账号在线核验；组件可准备不等于真实 QQ 功能已通过。PacketBackend 单独采用只读 `nc_get_packet_status`，不会主动发拍一拍；基础接口在线不代表高级能力可用。

4.18.41 真实启动及登录运行时观察到组件根新增 `beacon_report.log`、`guild1.db`、`guild1.db-shm`、`guild1.db-wal`，原有 705 项程序摘要均未改变。固定官方 `wrapper.node` 含 `guild1.db` 字面量，但静态证据不证明实际写入者或全部原生存储路径。运行期仅 official-node 预设允许这四个精确根文件名的普通运行数据文件，不允许同名目录/链接、嵌套同名路径、其他新增文件或任何程序变化；这些运行数据不能出现在安装 staging 或程序 inventory 中，迁移已安装组件也不复制、删除或读取其内容。

组件校验失败时 `component.reasonCode` 区分 `manifest_invalid`、`metadata_invalid`、`inventory_invalid`、`unexpected_file`、`file_integrity`、`runtime_data_invalid`、`path_invalid` 和 `entry_invalid`，安全说明不含私有绝对路径或文件内容。`status.state` 与 `status.message` 保留组件失败优先级；即使独立的 `process`、`interface` 字段确认进程运行及账号在线，也不能将顶层状态覆盖为 online。

隔离回归：`node --test standalone/test/qq-runtime.test.mjs`。涵盖两种独立 fixture 版本的安装/激活/回退、独立配置保留、指针失败及崩溃中断、账号与 revision 校验；fixture 版本不代表真实官方第二版本已验收。已用实际 4.18.41 官方归档进行生产 prepare 验收：124,089,498 字节，705 个只读文件/361,466,126 字节 inventory，包含原包配置模板。完整摘要、关键入口、原子完成及 dummy 账号本机配置通过，未启动包内任何程序，未连接或发送真实 QQ。归档解包 fixture 已清理。真实登录、原生模块初始化和发送功能需要另行验收。官方原包获取与修改/重新分发的许可边界不同，当前 `redistribution:unreviewed`，不把上游二进制纳入本项目发布包。

当前仍保留官方完整 Node 归档。传统启动器、批处理与可选资源尚无足够证据证明物理删除不会影响全部媒体/原生能力；安全解压的路径白名单不等于功能裁剪。不会为缩小体积删除原生组件、媒体资源或许可证。

上游证据：[固定发布](https://github.com/NapNeko/NapCatQQ/releases/tag/v4.18.41)、[对应打包工作流](https://github.com/NapNeko/NapCatQQ/blob/859eb530c5801577633c2c3ae871d23586edf281/.github/workflows/release-publish.yml)。
