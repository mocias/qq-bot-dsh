import {promptText} from '../../native-dsh-plugin/lib/prompt-text.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {writeJson} from './config.mjs';
import {evidenceMessages} from './message-snapshot.mjs';

const hash=s=>createHash('sha256').update(s).digest('hex');
const read=file=>fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):null;
// Stored inside the persona's memory runtime, not in the 500-message inbox.
// Historical inputs are never acknowledged, replayed or deleted here.
export class ChatHandoff {
  constructor({store,session,route,inputs=()=>[],config={}}){
    this.store=store;this.session=session;this.route=route;this.inputs=inputs;this.config=config;
    this.dir=store.safe('.runtime/handoffs/'+hash(session.id));
    this.stateFile=path.join(this.dir,'state.json');
    this.state=read(this.stateFile)??{latest:null,pending:null};
  }
  save(){fs.mkdirSync(this.dir,{recursive:true});writeJson(this.stateFile,this.state);}
  file(id){if(typeof id!=='string'||!/^[a-zA-Z0-9_-]{1,180}$/.test(id))throw Error('交接编号无效');return path.join(this.dir,id+'.json');}
  load(id){const value=read(this.file(id));if(!value)throw Error('当前聊天没有此交接');return value;}
  begin(id,reason,metadata={}){
    const file=this.file(id);if(fs.existsSync(file))return this.load(id);
    const record={version:1,id,reason,at:new Date().toISOString(),status:'preparing',
      chat:{type:this.route.group?'group':'private',label:this.route.group?'群聊':'私聊',key:this.route.key,id:this.route.id,personaId:this.session.personaId??this.route.personaId??'default'},
      sessionId:this.session.id,previous:this.state.latest,metadata,
      dialogue:evidenceMessages(this.inputs()),parts:0,summary:'',unfinished:[],
      instruction:promptText(this.config,'handoff.history')};
    fs.mkdirSync(this.dir,{recursive:true});writeJson(file,record);return record;
  }
  control(action,args){
    if(action==='begin'){this.begin(args.id,args.reason??'compaction',args.metadata);return {saved:true};}
    const record=this.load(args.id);
    if(action==='part'){
      if(record.status!=='preparing'||!Number.isSafeInteger(args.index)||args.index<0||typeof args.text!=='string'||args.text.length>120000)throw Error('交接分段无效');
      const part=path.join(this.dir,`${args.id}.part-${args.index}.json`);
      if(fs.existsSync(part)&&read(part).text!==args.text)throw Error('交接分段已存在且内容不同');
      writeJson(part,{text:args.text});record.parts=Math.max(record.parts,args.index+1);writeJson(this.file(args.id),record);return {saved:true};
    }
    if(action==='commit'){
      if(record.status==='ready'){if(this.state.latest!==record.id){this.state.latest=record.id;this.state.pending=record.id;this.save();}return {saved:true,id:record.id};}
      if(record.status!=='preparing'||!Number.isSafeInteger(args.parts)||args.parts!==record.parts)throw Error('交接尚未完整保存');
      for(let i=0;i<record.parts;i++)if(!fs.existsSync(path.join(this.dir,`${args.id}.part-${i}.json`)))throw Error('交接分段缺失');
      record.summary=String(args.summary??'');record.unfinished=Array.isArray(args.unfinished)?args.unfinished:[];
      record.compactionId=args.compactionId??null;record.status='ready';record.completedAt=new Date().toISOString();
      writeJson(this.file(args.id),record);this.state.latest=record.id;this.state.pending=record.id;this.save();
      return {saved:true,id:record.id};
    }
    if(action==='failed'){record.status='failed';record.error=String(args.error??'压缩未完成');writeJson(this.file(args.id),record);return {saved:true};}
    throw Error('交接控制操作无效');
  }
  view(args={}){
    const record=this.load(args.id??this.state.latest),section=args.section??'overview',offset=args.offset??0;
    if(!Number.isSafeInteger(offset)||offset<0||!['overview','dialogue','events','unfinished'].includes(section))throw Error('交接读取参数无效');
    let text;
    if(section==='events'){
      // Chunks form one lossless JSON document; paging is over characters.
      text=Array.from({length:record.parts},(_,i)=>read(path.join(this.dir,`${record.id}.part-${i}.json`)).text).join('');
    }else if(section==='dialogue')text=JSON.stringify(record.dialogue);
    else if(section==='unfinished')text=JSON.stringify(record.unfinished);
    else text=JSON.stringify({...record,dialogue:undefined});
    const end=Math.min(text.length,offset+12000);
    return {id:record.id,chat:record.chat,sessionId:record.sessionId,section,text:text.slice(offset,end),totalChars:text.length,nextOffset:end<text.length?end:null,
      sections:['overview','dialogue','events','unfinished'],instruction:record.instruction};
  }
  resume(){
    if(!this.state.pending||this.exposed===this.state.pending)return null;
    const id=this.state.pending,record=this.load(id);
    return {reason:'handoff',messages:[],handoff:this.view({id}),
      unfinished:this.view({id,section:'unfinished'}),
      instruction:promptText(this.config,'handoff.resume'),
      compactionId:record.compactionId};
  }
  // Do not mark delivery durable before the runtime receives the result. A
  // subsequent model tool call acknowledges it; restart before that redelivers.
  delivered(id){this.exposed=id;}
  acknowledge(){if(this.exposed&&this.state.pending===this.exposed){this.state.pending=null;this.save();this.exposed=null;}}
}
