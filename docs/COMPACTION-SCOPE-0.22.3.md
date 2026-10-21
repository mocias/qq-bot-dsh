# 预设隔离压缩服务 · 0.22.3

症状：启动整合已经提交并取得回执，启动状态ready，但普通对话提交在dispatch之前被“DSH压缩服务未就绪，未启动QQ回合”拒绝。待处理输入保留pending并标注rejected，避免自动反复提交；不是记忆整合失败，也不是QQ工具等待返回后主动结束。

原因：已安装DSH的standard预设把compaction-basic置于isolate.compaction的子组。外层agent.ctx.inject(['compaction'])不能读取该服务。此前SDK测试把FakeCompaction放在全局，未覆盖生产的隔离布局。

修复：显式声明agentPresets依赖，通过其公开serviceFor(agent,'compaction')接口取当前Agent绑定的预设修订服务并安装原有交接钩子。无预设服务时保留全局注入兼容；两处均不可用仍拒绝，不跳过交接、不修改DSH安装或预设。增加只读probe(sessionId)诊断字段presetCompaction，不提交输入、不创建回合。

回归使用安装版Cordis真实隔离服务以及AgentPresetRegistry.prototype.serviceFor；先复现全局通过、隔离失败，修复后两种布局都完成begin/part/commit交接并可卸载。宿主挂接通过不等于真实模型压缩验收。部署保持QQ接收停止，保留所有真实资料与待处理消息。
