import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {readJson,writeJson} from './config.mjs';
import {scopeOf} from './memory.mjs';
import {publicResultUrl} from '../../dsh-group-social/lib/search.mjs';

// Adapted concepts from qq-bridge a56164e: candidate/confirmed/rejected slang
// and sticker meaning/tags. Unlike its account-wide library, every store here
// belongs to exactly one QQ chat. No remote text can confirm its own meaning.
const clean=(v,n=300)=>String(v??'').replace(/[\x00-\x1f\u200b-\u200f]/g,' ').slice(0,n).trim();
export class Knowledge {
  constructor(runtime,key){
    if(!/^\d{5,20}\/(?:private|group)\/\d{5,20}$/.test(key))throw Error('无效聊天');
    this.key=key;this.file=path.join(runtime,'knowledge',scopeOf(key)+'.json');
  }
  read(){const state=readJson(this.file,{key:this.key,revision:0,slang:[],stickers:[]});if(state.key!==this.key)throw Error('知识库范围不匹配');return state;}
  save(value){value.revision++;writeJson(this.file,value);return value;}
  observe(segments,sourceId){
    const state=this.read();
    for(const s of (segments??[]).slice(0,100)){
      if(s.type!=='image'||typeof s.data?.url!=='string'||s.data.url.length>4000||!publicResultUrl(s.data.url))continue;
      const d=s.data;if(!d.emoji_id&&String(d.sub_type)!=='1')continue;
      const id=createHash('sha256').update(d.url).digest('hex').slice(0,24);
      let item=state.stickers.find(x=>x.id===id);
      if(!item){item={id,url:d.url,emojiId:clean(d.emoji_id,128),note:'',tags:[],uses:0,sources:[]};state.stickers.push(item);}
      item.sources=[...new Set([...item.sources,sourceId])].slice(-10);
    }
    state.stickers=state.stickers.slice(-500);return this.save(state);
  }
  learn(proposals,evidenceIds){
    const state=this.read(),allowed=new Set(evidenceIds);
    for(const p of (Array.isArray(proposals)?proposals:[]).slice(0,5)){
      const term=clean(p.term,50),meaning=clean(p.meaning);
      if(!term||!meaning||!Array.isArray(p.evidence)||!p.evidence.length||p.evidence.some(x=>!allowed.has(x)))continue;
      if(state.slang.some(x=>x.term===term))continue;
      state.slang.push({id:randomUUID(),term,meaning,status:'candidate',evidence:p.evidence.slice(0,10),sources:[],createdAt:Date.now()});
    }
    state.slang=state.slang.slice(-500);return this.save(state);
  }
  update(input){
    const state=this.read();if(input.revision!==state.revision)throw Error('资料已更新，请重新加载后保存');
    if(input.kind==='slang'){
      const item=state.slang.find(x=>x.id===input.id);if(!item)throw Error('词条不存在');
      if(!['candidate','confirmed','rejected'].includes(input.status))throw Error('词条状态无效');
      item.meaning=clean(input.meaning);item.status=input.status;
    }else if(input.kind==='sticker'){
      const item=state.stickers.find(x=>x.id===input.id);if(!item)throw Error('表情不存在');
      item.note=clean(input.note);item.tags=(Array.isArray(input.tags)?input.tags:[]).slice(0,10).map(x=>clean(x,24));
    }else throw Error('资料类型无效');
    return this.save(state);
  }
  addFavorites(faces){
    if(!Array.isArray(faces))throw Error('当前 OneBot 未返回收藏表情列表');
    const state=this.read();
    for(const face of faces.slice(0,100)){
      const url=typeof face==='string'?face:face.url;if(typeof url!=='string'||url.length>4000||!publicResultUrl(url))continue;
      const id=createHash('sha256').update(url).digest('hex').slice(0,24);
      if(!state.stickers.some(x=>x.id===id))state.stickers.push({id,url,emojiId:clean(face.emoji_id??face.emojiId??face.resId,128),note:clean(face.desc),tags:[],uses:0,sources:['panel-import']});
    }
    state.stickers=state.stickers.slice(-500);return this.save(state);
  }
  sticker(id){const item=this.read().stickers.find(x=>x.id===id);if(!item)throw Error('表情不属于当前聊天知识库');return item;}
  use(id){const state=this.read(),item=state.stickers.find(x=>x.id===id);if(item){item.uses++;this.save(state);}}
  context(){
    const state=this.read();
    return JSON.stringify({slang:state.slang.filter(x=>x.status==='confirmed').slice(-40).map(({term,meaning})=>({term,meaning})),
      stickers:state.stickers.slice(-30).map(({id,note,tags})=>({id,note,tags}))});
  }
}
