// Use the same typed-source boundary in both inbox authorization and transport.
// Host notices preserve existing authority; their content never grants it.
export function isHostContext(message,compactions=new Set()){
  return ['runtime-context','skill-catalog','time-context'].includes(message?.source?.kind)||
    message?.source?.kind==='compact-checkpoint'&&compactions.has(message.source.compactionId)||
    message?.source?.kind==='repeat-tool-reminder'&&message.source.form==='notice';
}

// Only durable parent catalog events identify children. Text resembling a
// completion notice, tool output and messages from other agents confer no scope.
export class Continuations {
  constructor(){this.children=new Set();this.pending=new Set();this.compactions=new Set();}
  observe(event){
    if(event.type==='compaction/start'&&typeof event.data?.compactionId==='string')this.compactions.add(event.data.compactionId);
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
export const CONTINUOUS_TOOL_TIMEOUT_MS=15*60*1000;
export const MAX_WAIT_SECONDS=300;
