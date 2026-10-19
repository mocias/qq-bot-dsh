import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol';
import { QQSettingsStore } from './settings-core.mjs';

export default class QQBridgeSettings extends TypertRemoteService{
  static inject=['configEditor','profileContext','llm','agentDefaultModel'];
  constructor(ctx){
    super(ctx,'qqBridgeSettings');this.owner=ctx;
    this.store=new QQSettingsStore({editor:ctx.get('configEditor'),
      hub:{snapshot:()=>globalThis[Symbol.for('dsh.qq.shared-transport.v1')]?.snapshot()??{connected:false,connectionCount:0,subscribers:0}},
      defaultModel:()=>{try{return ctx.agentDefaultModel.currentSelection()}catch{return null}},
      models:async(provider,model)=>{const list=await ctx.llm.listModels(provider);if(!list.some(m=>(m.id??m.model)===model))throw Error('所选模型不在当前提供方的可用列表中');}});
  }
  async getSettings(){return this.store.snapshot();}
  async updateSettings(section,patch,expectedRevision){return this.store.update(section,patch,expectedRevision);}
  async listModels(provider){
    const providers=this.owner.llm.listProviders().map(p=>({id:p.id,label:p.name??p.label??p.id}));
    const models=provider?(await this.owner.llm.listModels(provider)).map(m=>({id:m.id,label:m.name??m.label??m.id})):[];
    return JSON.parse(JSON.stringify({providers,models}));
  }
}
for(const name of ['getSettings','updateSettings','listModels']){
  const initializers=[];Remote(name)(undefined,{name,private:false,static:false,addInitializer(fn){initializers.push(fn)}});
  const receiver=Object.create(QQBridgeSettings.prototype);for(const fn of initializers)fn.call(receiver);
}
