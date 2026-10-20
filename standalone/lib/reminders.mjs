// Follows only sessions owned by this bridge. Snapshots are baselines, never replay queues.
export class ReminderRelay {
  constructor({deliver,reserve,onError}){Object.assign(this,{deliver,reserve,onError});this.followers=new Map();}
  sync(dsh,sessions){
    const ids=new Set(sessions.map(s=>s.id));
    for(const [id,f]of this.followers)if(!ids.has(id)){f.close();this.followers.delete(id);}
    for(const session of sessions){
      if(this.followers.has(session.id)||!dsh.watch)continue;
      let current,turns=new Map();
      const close=dsh.watch(session.id,event=>{
        const d=event?.data??{};
        if(event.type==='turn/start'){current=d.turn;turns.set(current,{scheduled:false,foreign:false,text:''});if(turns.size>100)turns.delete(turns.keys().next().value);}
        const turn=turns.get(d.turn??current);if(!turn)return;
        if(event.type==='user/message'){
          const source=(d.message??d).source;
          if(source?.kind==='plugin'&&source.plugin==='schedule')turn.scheduled=true;else turn.foreign=true;
        }
        if(event.type==='assistant/message')turn.text=(d.message?.content??[]).filter(c=>c.type==='text').map(c=>c.text).join('').slice(0,100000);
        if(event.type==='turn/end'){
          turns.delete(d.turn??current);
          if((d.reason?.kind??d.reason)!=='completed'||!turn.scheduled||turn.foreign||!turn.text.trim())return;
          const id=session.id+'/'+String(d.turn??current);
          if(!this.reserve(id,session))return;
          Promise.resolve(this.deliver(session,turn.text,id)).catch(this.onError);
        }
      },error=>{this.followers.delete(session.id);this.onError(error);});
      this.followers.set(session.id,{close});
    }
  }
  close(){for(const f of this.followers.values())f.close();this.followers.clear();}
}
