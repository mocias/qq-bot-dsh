// Only durable parent catalog events identify children. Text resembling a
// completion notice, tool output and messages from other agents confer no scope.
export class Continuations {
  constructor(){this.children=new Set();this.pending=new Set();}
  observe(event){
    if(event.type==='subagent/catalog'&&[0,2].includes(event.data?.version)&&typeof event.data.childId==='string'){
      this.children.add(event.data.childId);this.pending.add(event.data.childId);
    }
    if(event.type==='user/message'){
      const message=event.data?.message??event.data;
      if(this.owns(message)&&message.source.kind==='subagent-settled')this.pending.delete(message.source.senderSessionId);
    }
  }
  owns(message){return ['agent-message','subagent-settled'].includes(message?.source?.kind)&&this.children.has(message.source.senderSessionId);}
}
export const CONTINUOUS_TIMEOUT_MS=15*60*1000;
export const MAX_WAIT_SECONDS=300;
