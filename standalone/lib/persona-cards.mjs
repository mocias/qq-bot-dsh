import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {readJson,writeJson} from './config.mjs';

export const DEFAULT_PERSONA='default';
const validKey=key=>typeof key==='string'&&/^\d{5,20}\/(?:private|group)\/\d{5,20}$/.test(key);
export const personaScope=(key,id=DEFAULT_PERSONA)=>{
  if(!validKey(key)||!/^default$|^[0-9a-f]{8}-[0-9a-f-]{27}$/.test(id))throw Error('人格范围无效');
  return createHash('sha256').update(key+(id===DEFAULT_PERSONA?'':'\0persona:'+id)).digest('hex');
};
// Cards belong to one chat. Default retains the exact pre-upgrade storage path.
export class PersonaCards {
  constructor(runtime){this.file=path.join(runtime,'persona-cards.private.json');}
  read(){return readJson(this.file,{revision:0,chats:{}});}
  view(key){
    if(!validKey(key))throw Error('请选择有效聊天');
    const state=this.read(),chat=state.chats[key];
    return {revision:state.revision,activeId:chat?.activeId??DEFAULT_PERSONA,
      cards:chat?.cards??[{id:DEFAULT_PERSONA,name:'默认人格'}]};
  }
  get(key,id){const view=this.view(key),card=view.cards.find(c=>c.id===(id??view.activeId));if(!card)throw Error('此聊天不存在所选人格卡');return card;}
  create({key,name,revision}){
    this.view(key);const state=this.read();
    if(revision!==state.revision)throw Error('人格配置已变化，请刷新后重试');
    if(typeof name!=='string'||!name.trim()||name.trim().length>60)throw Error('请填写 1–60 字的人格卡名称');
    const chat=state.chats[key]??={activeId:DEFAULT_PERSONA,cards:[{id:DEFAULT_PERSONA,name:'默认人格'}]};
    if(chat.cards.length>=30)throw Error('每个聊天最多保存 30 张人格卡');
    if(chat.cards.some(c=>c.name===name.trim()))throw Error('此聊天已有人格卡使用这个名称');
    const card={id:randomUUID(),name:name.trim()};chat.cards.push(card);
    state.revision++;writeJson(this.file,state);return card;
  }
  assign({key,personaId,revision}){
    this.get(key,personaId);const state=this.read();
    if(revision!==state.revision)throw Error('人格配置已变化，请刷新后重试');
    const chat=state.chats[key]??={activeId:DEFAULT_PERSONA,cards:[{id:DEFAULT_PERSONA,name:'默认人格'}]};
    chat.activeId=personaId;state.revision++;writeJson(this.file,state);return this.view(key);
  }
  rename({key,personaId,name,revision}){
    this.get(key,personaId);const state=this.read();
    if(revision!==state.revision)throw Error('人格配置已变化，请刷新后重试');
    if(typeof name!=='string'||!name.trim()||name.trim().length>60)throw Error('请填写1–60字的人格名称');
    const chat=state.chats[key]??={activeId:DEFAULT_PERSONA,cards:[{id:DEFAULT_PERSONA,name:'默认人格'}]};
    if(chat.cards.some(c=>c.id!==personaId&&c.name===name.trim()))throw Error('此聊天已有人格使用该名称');
    chat.cards.find(c=>c.id===personaId).name=name.trim();state.revision++;writeJson(this.file,state);return this.view(key);
  }
}
export function personaIdentity(runtime,key,id){
  const card=new PersonaCards(runtime).get(key,id);
  return {personaId:card.id,personaName:card.name,scope:personaScope(key,card.id)};
}
