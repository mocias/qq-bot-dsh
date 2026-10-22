import {promptText} from '../../native-dsh-plugin/lib/prompt-text.mjs';

export const closingAbsence=s=>['handoff','digest'].includes(s?.absence?.phase);
export function resumeAfterMaintenance(session,now,memorySaved){
  session.absence={...session.absence,phase:'active',memorySaved,resumePending:true,
    handledHumanMessageAt:session.lastHumanMessageAt??session.lastUserAt??now,loopResumedAt:now};
  session.loopResumePending=true;session.worldSimulationInputAt=now;delete session.worldSimulationPaused;
}
export function sleepAfterAbsence(session,now,memorySaved){
  session.absence={...session.absence,phase:'asleep',memorySaved,sleptAt:now,resumePending:true};
  delete session.absence.handledHumanMessageAt;delete session.absence.loopResumedAt;
  session.loopResumePending=false;session.worldSimulationPaused=true;
}
export class AbsenceClock{
  constructor(session,{now=Date.now,persist=()=>{},config={},onBegin=()=>{}}={}){Object.assign(this,{session,now,persist,config,onBegin});this.startedAt=now();}
  remaining(){
    const lastHuman=this.session.lastHumanMessageAt??this.session.lastUserAt??this.session.absence?.lastHumanMessageAt;
    // Startup/background maintenance can open one bounded listening window,
    // but never suppress departure forever. Scheduled wakes keep the old clock.
    const baseline=Math.max(lastHuman??this.startedAt,this.session.absence?.loopResumedAt??0);
    return Math.max(0,baseline+(this.config.userAwaySeconds??600)*1000-this.now());
  }
  begin(){
    if(!closingAbsence(this.session)){this.session.absence={phase:'handoff',at:this.now(),lastHumanMessageAt:this.session.lastHumanMessageAt??this.session.lastUserAt??this.startedAt};this.persist();this.onBegin();}
    return {reason:'user-away',messages:[],hasMore:false,absenceSeconds:Math.max(0,Math.floor((this.now()-this.session.absence.lastHumanMessageAt)/1000)),thresholdSeconds:this.config.userAwaySeconds??600,instruction:promptText(this.config,'absence.handoff')};
  }
}
