# 源码迁移与桌面 QQ

此仓库为重新建立的干净源码快照，没有导入原嵌套 Git 历史。原部署配置、历史联调附件、QQ 账号与私人群名、记忆、会话、模型、二进制和缓存均未上传。测试使用示例号码；原插件内的固定账号/路径也为示例，默认不部署这些插件。

## 桌面窗口与机器人共存

本机此前使用后台 NapCat Shell 登录 QQ，同账号再开普通 QQ 会产生重复登录冲突。后来切换到官方 NapCat Framework 4.18.38 包的原生桌面加载器，让桌面窗口与 OneBot 共用同一个 QQ 实例；用户确认窗口正常。

来源：[官方发布](https://github.com/NapNeko/NapCatQQ/releases/tag/v4.18.38)。所用 `NapCat.Framework.zip` SHA-256：`45ef7f46aa78588c636044b6226b4b1847e31287ab6ec36b2d48adaa9785097b`。该版本包含 `napimain.exe`、`napiloader.dll`、`nativeLoader.cjs` 与 `napiLoader.bat`。运行时不包含在本仓库；安装方式可能随版本变化，应核对下载包内说明。

当前源码仓库没有自动安装器或固定桌面启动入口。新机器单独准备官方运行时，配置本机 QQ 路径及 OneBot 访问令牌，再连接 standalone。不要同时启动旧后台登录实例。迁移前备份私有配置，并确认没有正在回复的任务。

## 记忆迁移

`standalone/lib/import-memory.mjs` 提供底层导入函数。原机器专用的自动导入脚本已排除，避免误用固定账号映射。导入时显式指定 source、runtime、key 和是否群聊；key 按机器人账号/聊天类型/对象确定。目标已有内容时拒绝覆盖。

私聊与群聊不混合，账号角色互换也不交换私人记忆。新会话保留同一聊天身份的长期记忆，但不沿用旧聊天上下文。“忘记”的历史备份保留语义见 standalone README。
