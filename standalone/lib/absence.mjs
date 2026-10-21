import {promptText} from '../../native-dsh-plugin/lib/prompt-text.mjs';

export const closingAbsence=s=>['handoff','digest'].includes(s?.absence?.phase);
export class AbsenceClock{
  constructor(session,{now=Date.now,persist=()=>{},config={},onBegin=()=>{}}={}){Object.assign(this,{session,now,persist,config,onBegin});this.startedAt=now();}
  remaining(){return Math.max(0,(this.session.lastHumanMessageAt??this.session.lastUserAt??this.startedAt)+(this.config.userAwaySeconds??1800)*1000-this.now());}
  begin(){
    if(!closingAbsence(this.session)){this.session.absence={phase:'handoff',at:this.now(),lastHumanMessageAt:this.session.lastHumanMessageAt??this.session.lastUserAt??this.startedAt};this.persist();this.onBegin();}
    return {reason:'user-away',messages:[],hasMore:false,absenceSeconds:Math.max(0,Math.floor((this.now()-this.session.absence.lastHumanMessageAt)/1000)),thresholdSeconds:this.config.userAwaySeconds??1800,instruction:promptText(this.config,'absence.handoff')};
  }
}
