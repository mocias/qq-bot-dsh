> 原插件参考文档：当前独立服务入口及已验证范围以仓库根目录 HANDOFF.md 为准。历史部署附件未包含在本仓库中；示例账号与路径不是真实配置。

# QQ unified voice bridge

One DSH bundle owns the OneBot connection, private channel, isolated native group
AgentLoop, private voice adapter, and the “QQ 统一设置” Web settings section.
The group uses the shared transport; its original workspace, session ID, memory,
image handling and tool restrictions remain intact. Generic OneBot group input
stays disabled, preventing a second consumer.

Build `dsh-onebot-source` with its TypeScript compiler, then run `node build.mjs`
here. The build copies the current private, group and voice modules into a new
release directory and writes a SHA-256 manifest. Pack that release. Do not pack
this authoring directory directly or overwrite only node_modules.

The active profile should load this bundle, `dsh-plugin-memory`, and unrelated
user plugins. Standalone `dsh-onebot-qq`, `dsh-companion-group-social` and
`dsh-companion-voice` bundle entries are replaced by this bundle, not co-enabled.
Existing entry IDs are retained so saved configuration overrides still apply.

The authenticated DSH `qqBridgeSettings` remote reads the existing configuration
files. Profile changes use the host config editor; policy/persona changes use
atomic file writes with strict path checks and optimistic revision conflicts.
Unknown keys, workspace reassignment and group permission expansion are refused.
Access tokens are write-only. Saves merge only the selected section, preserving
ASR paths, steering allowlists, permissions, model choices and other existing keys.

The settings page covers private behavior and proactive contact, group timing,
group model, private voice preferences, memory/rotation thresholds, separate
personas, and shared connection settings. No test-send button is provided.
