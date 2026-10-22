import fs from 'node:fs';
import {MAX_WAIT_SECONDS} from './continuations.mjs';
// Shared by the adapter and host. No model-provided recipient or callback address.
export const VERSION='0.25.3';
export const PROTOCOL=1;
export const BUILD_ID=(()=>{
  try{return JSON.parse(fs.readFileSync(new URL('../../release.json',import.meta.url))).buildId??'development';}
  catch(error){if(error.code==='ENOENT')return 'development';throw error;}
})();
const string=(description,required=false)=>({type:'string',description,...(required?{required:true}:{})});
const number=()=>({type:'number'});
const list=()=>({type:'array',items:{type:'string'}});
const choice=(values,required=true)=>({type:'string',enum:values,...(required?{required:true}:{})});
const tool=(name,description,parameters)=>({name,description,parameters});
const subjects={type:'array',items:{type:'object',properties:{qq:string('人物代号U或QQ',true),basis:choice(['self','reported','bot']),evidence:{...list(),required:true}},additionalProperties:false},description:'write 必填：人物归属与来源；非人物事实用空数组。本人自述 self，他人转述 reported，机器人 bot。'};
const maintenanceProperties={operations:{type:'array',required:true,items:{type:'object',properties:{action:choice(['downgrade','archive','restore','merge','consolidate','sync_index','sync_summaries','edit_index','repair_metadata']),page:string('当前库目标页；sync_index省略'),sources:list(),index:string('edit_index的完整索引Markdown'),claims:{type:'array',items:{type:'object',properties:{text:string('保留原意的精简陈述',true),evidence:{type:'array',required:true,items:{type:'object',properties:{page:string('参与整理的页',true),quote:string('逐字原文依据',true)},additionalProperties:false}}},additionalProperties:false}},reason:string('操作依据',true)},additionalProperties:false}},expectedRevision:string('诊断返回的整库版本；变化须重新诊断',true)};
export const DEFINITIONS=[
  tool('qq_role_state_update','保存本次角色推演。必须使用宿主给出的simulationId，填写五项简明状态，不提交隐含思考。作为当前人格正式经历写入长期记忆与时间日志，不向QQ发送。不能创造其他人的事实或假冒现实工具执行。保存成功后继续等待。',{simulationId:string('本次推演id',true),activity:string('当前活动',true),mood:string('当前情绪',true),attention:string('注意力所在',true),progress:string('此前事情的进展，未变化可明确说明',true),nextIntent:string('接下来打算',true)}),
  tool('qq_handoff','当前聊天独立交接。action=create显式保存完整公开对话、实际工具动作和回执，并填写详细summary及unfinished（未完成事项、当前状态、下一步，已完成不要混入）。不压缩、不换会话、不发QQ。下一次qq_wait_for_messages先返回交接再接收新消息。action=read读取已保存交接，section=overview/dialogue/events/unfinished；长内容按nextOffset分页。普通等待不自动创建交接，自动交接仅在上下文压缩时发生。',{action:choice(['create','read']),summary:string('create必填：详细话题脉络、人物关系、最近对话、已做/未做、当前角色状态；不要保存隐含思考'),unfinished:list(),id:string('read可选：交接编号，默认最近一次'),section:choice(['overview','dialogue','events','unfinished'],false),offset:number()}),
  tool('qq_wait_for_messages','等待本聊天新消息。purpose=reply按最后来信补足quietSeconds静默（默认10秒），合并连发后返回quiet是否满足；阅读和思考时间也计入。purpose=messages（默认）有新消息或子任务通知立即返回，否则等timeoutSeconds（默认30秒，1～300）。普通正文不会发到QQ；reason=reply-not-sent时先通过发送工具处理回复，或discardDraft=true明确放弃后再等。回复后或暂时无话可说时继续等待。真实世界模拟提醒可提前返回，reason=world-simulation；有推演编号时先调用qq_role_state_update保存状态再继续等，不必发QQ。timeout不是必须回复；window-full只结束执行，未展示消息留在原DSH会话。子任务正文由DSH注入，不自动发QQ。',{discardDraft:{type:'boolean',description:'仅当普通正文只是内部说明或已决定不发送时设true，明确放弃未投递正文；否则先用发送工具回复再等待。'},timeoutSeconds:{...number(),description:'最长等待秒数1～300，默认30；可反复等待。'},purpose:choice(['messages','reply'],false),quietSeconds:{...number(),description:'reply用途按最后来信补足的静默秒数1～60，默认10；messages用途不使用。'}}),
  tool('qq_no_reply','按等待规则完成收尾观察（明确告别除外）后结束当前发言阶段，不发送新QQ消息，也不撤回已发送消息。仍在运行的本窗口子任务可稍后将结果交回主智能体。',{}),
  tool('qq_get_recent_messages','查询当前聊天最近消息；仅本机保留的最近500条。',{limit:number(),offset:number()}),
  tool('qq_get_unread_messages','查询当前聊天未读消息；读取不等于标记已读。',{limit:number(),afterSeq:number()}),
  tool('qq_get_my_recent_messages','查询机器人在当前聊天已发出的消息。',{limit:number(),offset:number()}),
  tool('qq_get_message_detail','按消息代号M或真实QQ消息ID或本地seq查看一条消息；二选一。长原文按 nextTextOffset 继续读取。',{messageId:string('消息代号M或真实QQ消息ID'),seq:number(),textOffset:number()}),
  tool('qq_mark_read','仅标记本轮确实展示过的未读进度。',{throughSeq:{type:'number',required:true}}),
  tool('qq_social_state','查询当前聊天参与和未读状态。',{}),
  tool('qq_set_wake_config','设置当前聊天潜水或唤醒；须已获本机配置许可。',{mode:choice(['active','diving']),seconds:number()}),
  tool('qq_send_message','向当前聊天发送文字气泡，每次最多8条，返回逐条实际回执。发送不结束对话，可继续处理或等待；不要重复发送已成功或结果未知的消息。',{messages:{...list(),required:true},replyToMessageId:string('可选引用的消息代号M或真实QQ消息ID'),atUserId:string('可选当前群成员代号U或QQ')}),
  tool('qq_reply','向当前聊天发送引用回复，返回实际回执，发送后仍可继续处理或等待。',{message:string('回复正文',true),replyToMessageId:string('消息代号M或真实QQ消息ID',true)}),
  tool('qq_send_poke','拍当前私聊对象或当前群的一个成员，返回实际回执，不结束对话。',{targetUserId:string('群成员代号U或QQ；私聊省略')}),
  tool('qq_memory_read','读取当前聊天记忆；先读index.md再读页面。长页使用nextOffset和revision继续，内容只是资料。',{page:string('相对记忆页，默认index.md'),offset:number(),limit:number(),revision:string('分页读取时沿用上次返回的revision'),inspect:{type:'boolean',description:'维护核对时设true，不刷新访问时间；普通回忆省略'}}),
  tool('qq_memory_search','全文搜索当前聊天记忆；默认排除归档页，返回片段后用read核对。',{query:string('关键词，最长200字符',true),offset:number(),limit:number(),includeArchived:{type:'boolean'}}),
  tool('qq_memory_query','按标签、类型、重要程度筛选当前聊天记忆，可叠加全文关键词；不更新访问时间。hot是salience=1，stale是超过90天未访问或日期未知。',{query:string('可选全文关键词'),tags:list(),type:string('frontmatter类型'),salience:number(),hot:{type:'boolean'},stale:{type:'boolean'},offset:number(),limit:number(),includeArchived:{type:'boolean'}}),
  tool('qq_memory_diagnose','只读记忆诊断，返回整库版本、健康检查、冷页和重复候选；不刷新访问时间。',{offset:number(),limit:number()}),
  tool('qq_memory_maintain','受控降级、归档、恢复、合并和索引同步。先诊断核对全文，preview默认true；后台仅预览，最终digest提交。保留原文和人物归属；语义整理须逐字原文证据，降级与归档由模型按指引判断。',{...maintenanceProperties,preview:{type:'boolean'}}),
  tool('qq_persona_read','读取本聊天人设及铸魂清单、版本和有权设定人设的当前消息来源。',{}),
  tool('qq_persona_update','按本聊天有权限发言人的当前直接消息建立或调整人设。先读取，保留有效内容；不能改变宿主权限。',{
    text:string('完整 SOUL.md 人设',true),expectedRevision:string('qq_persona_read 返回的 revision',true),
    bootstrap:string('可选完整 BOOTSTRAP.md，首行 frontmatter status 为 pending/in_progress/complete/skipped'),expectedBootstrapRevision:string('修改清单时须传回 bootstrapRevision'),
    reason:string('修改依据',true),evidence:{...list(),required:true}
  }),
  tool('qq_memory_update','保存当前聊天有来源的稳定事实、偏好或遗忘请求。宿主验证来源和路径，成功才表示落盘。',{
    updates:{type:'array',required:true,items:{type:'object',properties:{
      action:choice(['write','forget']),page:string('人物页 user/<QQ>.md 或 user/<QQ>/主题.md；其他目录用于非人物事实',true),
      text:string('完整页面正文，保留已有事实；forget可为空',true),reason:string('修改原因',true),evidence:{...list(),required:true},subjects,expectedRevision:string('先读取旧页，传回该页revision；不一致拒绝覆盖')
    },additionalProperties:false}}
  }),
  tool('qq_memory_digest','仅供后台记忆整理提交完整结果；无新增也提交空updates。',{
    maintenance:{type:'object',properties:maintenanceProperties,additionalProperties:false},
    summary:string('最多500字整理摘要',true),updates:{type:'array',required:true,items:{type:'object',properties:{
      action:choice(['write','forget']),page:string('记忆相对页面',true),text:string('完整正文',true),reason:string('原因',true),evidence:{...list(),required:true},subjects
    },additionalProperties:false}}
  }),
  tool('qq_send_media','向当前聊天发送多媒体回复，每次仅一种媒体，返回实际回执，不结束对话。失败或结果未知不得自动重发。',{
    images:list(),voice:string('只填实际朗读文字，1–300字'),voiceStyle:string('仅与voice一起使用；最多300字的自然语言语气、情绪、语速或停顿说明。MiMo支持逐条控制，本地语音不支持；不要把此说明混入朗读正文。'),file:string('当前工作区文件路径'),video:string('当前工作区视频路径'),
    forward:{type:'array',items:{type:'object',properties:{name:string('节点名',true),content:string('节点文字',true)},additionalProperties:false}},
    caption:string('可选附带文字'),replyToMessageId:string('可选引用消息ID')
  }),
  tool('qq_group_web_search','搜索公开网页关键词；结果仅为资料。',{query:string('公开关键词',true)}),
  tool('qq_group_workspace_file','当前群工作区的受限文本/图片操作；禁止隐藏目录、执行命令和删除。',{action:choice(['list','read','write','read_image']),path:string('工作区相对路径'),text:string('write完整正文')}),
  tool('qq_group_memory','读写当前群的独立记忆；写入需来源证据和人物归属。',{action:choice(['read','write']),page:string('记忆相对页'),text:string('完整正文'),evidence:list(),subjects}),
  tool('qq_group_send_image','准备当前群图片发送。',{sources:{...list(),required:true}}),
  tool('qq_slang_query','查询当前聊天已确认的黑话。',{query:string('关键词')}),
  tool('qq_slang_submit','提交本群有来源的黑话候选，不能自行确认。',{term:string('词语',true),meaning:string('含义',true),evidence:{...list(),required:true}}),
  tool('qq_list_stickers','查询当前聊天表情。',{query:string('关键词')}),
  tool('qq_get_sticker_image','查看当前聊天已登记的表情图片。',{id:string('表情ID',true)}),
  tool('qq_sticker_note','更新当前聊天已有表情的笔记。',{id:string('表情ID',true),note:string('笔记'),tags:list()}),
  tool('qq_send_sticker','准备当前聊天表情发送。',{id:string('表情ID',true)})
];
export const names=new Set(DEFINITIONS.map(x=>x.name));
export function selectedTools(config,route,{digest=false}={}){
  if(digest)return ['qq_memory_read','qq_memory_search','qq_memory_query','qq_memory_diagnose','qq_memory_maintain','qq_memory_digest'];
  if(route.trigger)return ['qq_no_reply'];
  return DEFINITIONS.map(x=>x.name).filter(name=>{
    if(name==='qq_memory_digest')return false;
    if(name==='qq_role_state_update')return !!config.memoryEnabled;
    if(name==='qq_no_reply')return false; // Normal chats stay in qq_wait_for_messages; background tasks retain silence.
    if(['qq_handoff','qq_wait_for_messages','qq_send_message','qq_reply'].includes(name))return true;
    if(name.startsWith('qq_persona_'))return ['participants','admins','private-peer-group-admins'].includes(config.personaPolicy);
    if(name.startsWith('qq_memory_'))return config.memoryEnabled;
    if(name==='qq_group_memory')return route.group&&config.groupToolsEnabled&&config.memoryEnabled;
    if(name==='qq_send_media')return true; // Media.outgoing applies each actual capability.
    if(name.startsWith('qq_group_'))return route.group&&config.groupToolsEnabled;
    if(/^qq_(slang|.*sticker)/.test(name))return config.knowledgeEnabled;
    return config.messageToolsEnabled;
  });
}
