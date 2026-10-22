import {promptText} from '../../native-dsh-plugin/lib/prompt-text.mjs';

export const closingAbsence=s=>['handoff','digest'].includes(s?.absence?.phase);
export function resumeAfterMaintenance(session,now,memorySaved){
  session.absence={...session.absence,phase:'active',memorySaved,resumePending:true,
    handledHumanMessageAt:session.lastHumanMessageAt??session.lastUserAt??now,loopResumedAt:now};
  session.loopResumePending=true;session.worldSimulationInputAt=now;delete session.worldSimulationPaused;
}
export class AbsenceClock{
  constructor(session,{now=Date.now,persist=()=>{},config={},onBegin=()=>{}}={}){Object.assign(this,{session,now,persist,config,onBegin});this.startedAt=now();}
  remaining(){
    const lastHuman=this.session.lastHumanMessageAt??this.session.lastUserAt;
    if(this.session.absence?.handledHumanMessageAt!==undefined&&(lastHuman===undefined||lastHuman<=this.session.absence.handledHumanMessageAt))return Infinity;
    return Math.max(0,(lastHuman??this.startedAt)+(this.config.userAwaySeconds??1800)*1000-this.now());
  }
  begin(){
    if(!closingAbsence(this.session)){this.session.absence={phase:'handoff',at:this.now(),lastHumanMessageAt:this.session.lastHumanMessageAt??this.session.lastUserAt??this.startedAt};this.persist();this.onBegin();}
    return {reason:'user-away',messages:[],hasMore:false,absenceSeconds:Math.max(0,Math.floor((this.now()-this.session.absence.lastHumanMessageAt)/1000)),thresholdSeconds:this.config.userAwaySeconds??1800,instruction:promptText(this.config,'absence.handoff')};
  }
}
