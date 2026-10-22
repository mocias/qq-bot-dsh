import path from 'node:path';
import {createHash} from 'node:crypto';
import {DEFAULT_PERSONA} from './persona-cards.mjs';
import {workspaceFor,beijingDate,ensureWorkspaceDirectory} from './workspace.mjs';
import {initializeLife} from './lifecycle.mjs';

const transportFor = config => config.dshNativeTools ? 'native-v1' : 'legacy';

// Session metadata, permission setup and durable naming have one owner. Callers
// still own admission, exit confirmation and the chat's serial queue.
export class ChatSessions {
  constructor(runtime,getState,{now=Date.now,persist}) {
    Object.assign(this,{runtime,getState,now,persist});
  }

  get state() { return this.getState(); }

  record(id,route,workspace,preset,config) {
    const personaId=route.personaId??DEFAULT_PERSONA;
    const session={id,personaId,transport:transportFor(config),blocked:false,
      route:{key:route.key,id:route.id,group:route.group,personaId},
      workspace,preset,backend:config.dshUrl,namingPending:true,
      permissionPreset:config.permissionPreset??'',permissionPending:!!config.permissionPreset};
    initializeLife(session,this.now());
    return session;
  }

  async name(route,id,config,dsh) {
    const naming=this.state.sessionNaming;
    const token=createHash('sha256').update(config.dshUrl+'|'+route.key+'|'+id).digest('hex');
    let entry=naming.names[token];
    if(!entry) {
      const previous=new Set([...Object.values(this.state.sessions),...this.state.retired]
        .filter(s=>s.route?.key===route.key&&s.id!==id).map(s=>(s.backend??config.dshUrl)+'|'+s.id));
      const number=Math.max(naming.counters[route.key]??0,previous.size)+1;
      entry={number,title:`${beijingDate(this.now())}-${route.group?'群聊':'私聊'}-${route.id}-${number}`};
      naming.counters[route.key]=number;
      naming.names[token]=entry;
    }
    // Reserve the number before RPC; retries and restarts use the same title.
    this.persist();
    await dsh.rename(id,entry.title);
    return {...entry};
  }

  async ready(session,{config,dsh,check}) {
    check();
    ensureWorkspaceDirectory(this.runtime,session.workspace);
    await dsh.ensureWorkspace?.(session.id,session.workspace);
    check();
    if(session.permissionPending) {
      await dsh.applyPermission(session.id,session.permissionPreset);
      check();
      delete session.permissionPending;
      this.persist();
    }
    if(session.namingPending) {
      const name=await this.name(session.route,session.id,config,dsh);
      check();
      Object.assign(session,name);
      delete session.namingPending;
      this.persist();
    }
    return session;
  }

  async ensure(route,{scope,config,dsh,check,recoveryReason}) {
    check();
    let session=this.state.sessions[scope];
    const changed=session&&(session.transport??'legacy')!==transportFor(config);
    if(!session||session.blocked||changed) {
      const workspace=workspaceFor(this.runtime,this.state,route,scope,this.now(),this.persist);
      const preset=route.group?config.groupPreset:config.privatePreset;
      const id=await dsh.createSession(workspace,preset);
      check();
      const next=this.record(id,route,workspace,preset,config);
      if(session)this.state.retired.push({...session,reason:recoveryReason??(changed?'transport-upgrade':'interrupted'),retiredAt:this.now()});
      this.state.sessions[scope]=session=next;
      this.persist();
    }
    // Adopt established records without renaming them or changing permissions.
    session.route??={key:route.key,id:route.id,group:route.group};
    session.workspace??=path.join(this.runtime,'workspaces',scope);
    session.preset??=route.group?config.groupPreset:config.privatePreset;
    session.backend??=config.dshUrl;
    initializeLife(session,this.now());
    return this.ready(session,{config,dsh,check});
  }

  async replace(scope,previous,{config,dsh,isCurrent,reason,journal={}}) {
    if(!isCurrent())return null;
    ensureWorkspaceDirectory(this.runtime,previous.workspace);
    if(!journal.newId) {
      journal.newId=await dsh.createSession(previous.workspace,previous.preset);
      journal.permissionPreset=config.permissionPreset??'';
      this.persist();
    }
    if(!isCurrent())return null;
    if(journal.permissionPreset&&!journal.permissionReady) {
      await dsh.applyPermission(journal.newId,journal.permissionPreset);
      journal.permissionReady=true;
      this.persist();
    }
    if(!isCurrent())return null;
    const name=await this.name(previous.route,journal.newId,config,dsh);
    if(!isCurrent())return null;
    const next=this.record(journal.newId,{...previous.route,personaId:previous.personaId??DEFAULT_PERSONA},previous.workspace,previous.preset,
      {...config,permissionPreset:journal.permissionPreset});
    Object.assign(next,name,{lastUserAt:previous.lastUserAt});
    delete next.namingPending;
    delete next.permissionPending;
    const length=this.state.retired.length;
    this.state.retired.push({...previous,retiredAt:this.now(),reason});
    this.state.sessions[scope]=next;
    journal.status='complete';
    try { this.persist(); }
    catch(error) {
      this.state.sessions[scope]=previous;
      this.state.retired.length=length;
      journal.status='pending';
      throw error;
    }
    return next;
  }
}
