# 0.18.4 提交拒绝与消息恢复

普通聊天注册记忆技能曾直接读取 `agent.ctx.skills`，实际 Agent 的插件依赖表未声明该服务，因此整理和招呼成功后，普通聊天在提交前失败。修复在继承当前 Agent 作用域的子插件中显式 inject skills，并在回合结束时同步注销技能；不注册到全局。

原生提交在进入 Agent followup/steer 前失败时返回 `accepted:false` 与 `QQ_SUBMIT_REJECTED`。客户端保留脱敏错误；仅首条请求被明确拒绝且此前没有已接受输入时标记 notSubmitted。网络失败、格式不匹配、进入 dispatch 后的异常仍保守处理，不能自动重放。进入 dispatch 后出现异常先撤销执行并等待结束，再卸载工具。

明确拒绝的输入保留 pending 和 rejected 原因，不消费未读、不标记会话仍在运行、不进行每秒重试。管理端可通过鉴权的 POST `/api/bridge/resume`（key 为已有聊天键）恢复；uncertain、running、exitUnconfirmed 阻止恢复。一般新启动仍先整理和招呼。仅显式维护恢复时可在 `/api/bridge/start` 传 `resumeCompleted:true`，同后端且已有 ready 和招呼成功回执的聊天跳过重复启动，继续原队列。

旧版本 uncertain 不自动转换为 pending。维护者必须先备份，确认 DSH 空闲，核对原生输入与发送回执，证明目标消息未执行后才逐条恢复。其他未知记录保留。

验证使用已安装 DSH SDK 的真实插件加载与 inject 边界，覆盖缺失依赖的旧错误、整理/招呼/聊天顺序、技能隔离、释放，以及明确拒绝后的消息保留与手动恢复。模拟测试不替代现场模型、QQ 接收和发送验证。

## 0.18.5 现场恢复补充

现场提交成功后，DSH 把 runtime-context、skill-catalog、time-context 以 user/message 形式追加。持续聊天此前误将这些宿主投影识别为外部输入并取消。按真实事件 source.kind 放行这三类投影，不信任正文里的来源声明；真正 user 输入仍中止。旧中止回合只有确认没有工具调用、没有正式输出和公开发送，且 DSH 已结束时才可恢复原消息。
