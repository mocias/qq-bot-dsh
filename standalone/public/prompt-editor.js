export function mountPromptEditor({request,notice}){
  const $=id=>document.getElementById(id),drafts=new Map();
  let data=null,scope='',section='',serial=0,busy=false;
  const token=(key,personaId)=>key?JSON.stringify([key,personaId]):'';
  const target=value=>value?Object.fromEntries(['key','personaId'].map((k,i)=>[k,JSON.parse(value)[i]])):{};
  const same=(a,b)=>JSON.stringify(Object.entries(a).sort())===JSON.stringify(Object.entries(b).sort());
  function lock(value){busy=value;for(const id of ['prompt-save','prompt-scope','prompt-section','prompt-search','prompt-override','prompt-reset','prompt-reset-all','prompt-reload','prompt-text'])$(id).disabled=value;if(!value&&data)editor();}
  function stash(){if(!data)return;if(!dirty()){drafts.delete(scope);return;}drafts.set(scope,{revision:data.revision,overrides:{...data.overrides},dirty:true});}
  function dirty(){return !!data&&!same(data.overrides,data.saved);}
  function status(){if(data){$('prompt-state').textContent=(dirty()?'有未保存修改。':'当前内容已保存。')+(data.stale?' 此草稿基于旧版本，请先重新加载再保存。':'')+' 保存后，在下次启动该人格的对话执行时生效。';
    $('prompt-full').textContent=data.catalog.map(e=>'【'+e.title+'】\n'+(Object.hasOwn(data.overrides,e.id)?data.overrides[e.id]:data.inherited[e.id])).join('\n\n');}}
  function editor(){
    const e=data.catalog.find(x=>x.id===section);$('prompt-editor').hidden=!e;if(!e)return;
    const custom=Object.hasOwn(data.overrides,e.id);
    $('prompt-title').textContent=e.title;$('prompt-meta').textContent=e.when+' · '+e.source;
    $('prompt-override').checked=custom;$('prompt-override-label').textContent=data.scope==='global'?'使用自定义内容':'此人格单独覆盖';
    $('prompt-text').value=custom?data.overrides[e.id]:data.inherited[e.id];$('prompt-text').disabled=!custom||busy;
    $('prompt-reset').textContent=data.scope==='global'?'恢复此项内置默认':'此项恢复继承';
    $('prompt-default').textContent=data.inherited[e.id];$('prompt-count').textContent=$('prompt-text').value.length+' 字符';status();
  }
  function list(){
    const query=$('prompt-search').value.trim().toLowerCase(),rows=data.catalog.filter(e=>[e.title,e.group,e.id,e.text,data.overrides[e.id]??''].join(' ').toLowerCase().includes(query));
    const sel=$('prompt-section');sel.replaceChildren();
    for(const e of rows)sel.add(new Option(e.group+' · '+e.title+(Object.hasOwn(data.overrides,e.id)?' · 已覆盖':''),e.id));
    if(!rows.some(e=>e.id===section))section=rows[0]?.id??'';sel.value=section;editor();
  }
  function paint(result,restore=true){
    scope=token(result.key,result.personaId);
    const draft=restore?drafts.get(scope):null;
    data={...result,saved:{...result.overrides},overrides:draft?{...draft.overrides}:{...result.overrides},stale:!!draft&&draft.revision!==result.revision};
    if(draft)data.revision=draft.revision;
    const select=$('prompt-scope');select.replaceChildren(new Option('全局默认',''));
    for(const t of result.targets)for(const c of t.cards){const [,kind,id]=t.key.split('/');select.add(new Option(`${kind==='group'?'群聊':'私聊'} ${id} · ${c.name}${c.id===t.activeId?'（当前使用）':''}`,token(t.key,c.id)));}
    select.value=scope;$('prompt-components').replaceChildren();
    for(const item of result.components){const p=document.createElement('p'),b=document.createElement('strong');b.textContent=item.name+'：';p.append(b,item.location);$('prompt-components').append(p);}
    $('prompt-scope-hint').textContent=result.scope==='global'?'未单独覆盖的人格继承这里；未自定义的项目使用内置默认。':'当前仅编辑 '+result.personaName+'。未勾选单独覆盖的项目随全局默认更新。';
    list();
  }
  async function load(value=$('prompt-scope').value,restore=true){
    if(busy)return;const n=++serial,t=target(value);lock(true);
    try{const result=await request('/api/prompts?'+new URLSearchParams(t));if(n!==serial)return;paint(result,restore);}
    catch(e){if(n===serial){$('prompt-scope').value=scope;notice(e.message,true);}}
    finally{if(n===serial)lock(false);}
  }
  $('prompt-scope').onchange=()=>{stash();load();};
  $('prompt-section').onchange=()=>{section=$('prompt-section').value;editor();};
  $('prompt-search').oninput=()=>data&&list();
  $('prompt-override').onchange=()=>{
    if(!data||!section)return;
    if($('prompt-override').checked)data.overrides[section]=data.inherited[section];else delete data.overrides[section];stash();list();
  };
  $('prompt-text').oninput=()=>{if(!data)return;data.overrides[section]=$('prompt-text').value;stash();$('prompt-count').textContent=$('prompt-text').value.length+' 字符';status();};
  $('prompt-reset').onclick=()=>{if(!data)return;delete data.overrides[section];stash();list();};
  $('prompt-reset-all').onclick=()=>{if(!data)return;if(!confirm('恢复当前范围全部提示词的继承/默认？点击保存后才生效。'))return;data.overrides={};stash();list();};
  $('prompt-reload').onclick=()=>{if(dirty()&&!confirm('放弃当前范围未保存的提示词修改并重新加载？'))return;drafts.delete(scope);load(scope,false);};
  $('prompt-save').onclick=async()=>{
    if(!data||busy)return;lock(true);
    const submitted={...target(scope),revision:data.revision,overrides:{...data.overrides}};
    try{const result=await request('/api/prompts',submitted);drafts.delete(scope);paint(result,false);notice('提示词已保存。下次启动对应人格的对话执行时生效，未发送任何消息。');}
    catch(e){notice(e.message,true);}finally{lock(false);}
  };
  window.addEventListener('beforeunload',e=>{if(dirty()||[...drafts].some(([k,d])=>k!==scope&&d.dirty)){e.preventDefault();e.returnValue='';}});
  return {load:()=>{if(busy)return Promise.resolve();stash();return load(scope);}};
}
