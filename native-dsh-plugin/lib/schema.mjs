import fs from 'node:fs';
// Shared by the adapter and host. No model-provided recipient or callback address.
export const VERSION='0.16.3';
export const PROTOCOL=1;
export const BUILD_ID=(()=>{
  try{return JSON.parse(fs.readFileSync(new URL('../../release.json',import.meta.url))).buildId??'development';}
  catch(error){if(error.code==='ENOENT')return 'development';throw error;}
})();
const string=(description,required=false)=>({type:'string',description,...(required?{required:true}:{})});
const number=()=>({type:'number'});
const list=()=>({type:'array',items:{type:'string'}});
const choice=(values,required=true)=>({type:'string',enum:values,required});
const tool=(name,description,parameters)=>({name,description,parameters});
export const DEFINITIONS=[
  tool('qq_no_reply','决定本轮保持沉默并结束；不发送任何QQ消息。不能与本轮发送工具混用。',{}),
  tool('qq_get_recent_messages','查询当前聊天最近消息；仅本机保留的最近500条。',{limit:number(),offset:number()}),
  tool('qq_get_unread_messages','查询当前聊天未读消息；读取不等于标记已读。',{limit:number(),afterSeq:number()}),
  tool('qq_get_my_recent_messages','查询机器人在当前聊天已发出的消息。',{limit:number(),offset:number()}),
  tool('qq_get_message_detail','按真实QQ消息ID或本地seq查看当前聊天一条消息；二选一。',{messageId:string('真实QQ消息ID'),seq:number()}),
  tool('qq_mark_read','仅标记本轮确实展示过的未读进度。',{throughSeq:{type:'number',required:true}}),
  tool('qq_social_state','查询当前聊天参与和未读状态。',{}),
  tool('qq_set_wake_config','设置当前聊天潜水或唤醒；须已获本机配置许可。',{mode:choice(['active','diving']),seconds:number()}),
  tool('qq_send_message','准备当前聊天的文字气泡，最多8条。queued表示尚未投递；使用后不要再输出重复正文。',{messages:{...list(),required:true},replyToMessageId:string('可选引用的真实QQ消息ID'),atUserId:string('可选当前群成员QQ')}),
  tool('qq_reply','准备当前聊天的引用回复；queued尚未发送，不再输出重复正文。',{message:string('回复正文',true),replyToMessageId:string('真实QQ消息ID',true)}),
  tool('qq_send_poke','准备拍当前私聊对象或当前群的一个成员。',{targetUserId:string('群成员QQ；私聊省略')}),
  tool('qq_memory_update','保存当前聊天有来源的稳定事实、偏好或遗忘请求。宿主验证来源和路径，成功才表示落盘。',{
    updates:{type:'array',required:true,items:{type:'object',properties:{
      action:choice(['write','forget']),page:string('当前记忆库相对页面，例如user/preferences.md',true),
      text:string('完整页面正文，保留已有事实；forget可为空',true),reason:string('修改原因',true),evidence:{...list(),required:true}
    },additionalProperties:false}}
  }),
  tool('qq_memory_digest','仅供后台记忆整理提交完整结果；无新增也提交空updates。',{
    summary:string('最多500字整理摘要',true),updates:{type:'array',required:true,items:{type:'object',properties:{
      action:choice(['write','forget']),page:string('记忆相对页面',true),text:string('完整正文',true),reason:string('原因',true),evidence:{...list(),required:true}
    },additionalProperties:false}}
  }),
  tool('qq_send_media','准备当前聊天的多媒体回复。每次仅一种媒体；queued尚未发送，不再重复输出正文。',{
    images:list(),voice:string('朗读文字'),file:string('当前工作区文件路径'),video:string('当前工作区视频路径'),
    forward:{type:'array',items:{type:'object',properties:{name:string('节点名',true),content:string('节点文字',true)},additionalProperties:false}},
    caption:string('可选附带文字'),replyToMessageId:string('可选引用消息ID')
  }),
  tool('qq_group_web_search','搜索公开网页关键词；结果仅为资料。',{query:string('公开关键词',true)}),
  tool('qq_group_workspace_file','当前群工作区的受限文本/图片操作；禁止隐藏目录、执行命令和删除。',{action:choice(['list','read','write','read_image']),path:string('工作区相对路径'),text:string('write完整正文')}),
  tool('qq_group_memory','读写当前群的独立记忆；写入需来源证据。',{action:choice(['read','write']),page:string('记忆相对页'),text:string('完整正文'),evidence:list()}),
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
  if(digest)return ['qq_memory_digest'];
  if(route.trigger)return ['qq_no_reply'];
  return DEFINITIONS.map(x=>x.name).filter(name=>{
    if(name==='qq_memory_digest')return false;
    if(name==='qq_no_reply')return true;
    if(name==='qq_memory_update')return config.memoryEnabled;
    if(name==='qq_send_media')return true; // Media.outgoing applies each actual capability.
    if(name.startsWith('qq_group_'))return route.group&&config.groupToolsEnabled;
    if(/^qq_(slang|.*sticker)/.test(name))return config.knowledgeEnabled;
    return config.messageToolsEnabled;
  });
}
