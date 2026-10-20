import {layoutGraph,typeColor} from './memory-layout.js';
import {resetView,zoomAt,toGraphPoint,panBy} from './memory-view.js';
const el=(tag,text)=>{const e=document.createElement(tag);if(text!==undefined)e.textContent=text;return e;};
export function renderHealth(container,insights){
  container.replaceChildren();
  const score=el('strong',insights.health.score+' / 100');score.className='health-score';container.append(score);
  const metrics=el('div');metrics.className='metrics';
  for(const [label,value] of [['记忆页',insights.overview.pages],['索引路由',insights.overview.indexEntries],['记忆字数',insights.overview.chars]]){
    const card=el('article');card.append(el('strong',String(value)),el('small',label));metrics.append(card);
  }container.append(metrics,el('h3','访问新鲜度'));
  for(const bucket of insights.freshness.buckets){
    const row=el('div');row.className='freshness-row';const bar=el('progress');bar.max=Math.max(1,insights.overview.pages);bar.value=bucket.count;bar.setAttribute('aria-label',bucket.label);
    row.append(el('span',bucket.label),bar,el('span',String(bucket.count)));container.append(row);
  }
  container.append(el('p','尚未访问：'+insights.freshness.never+' 页'),el('h3','体检'));
  for(const check of insights.health.checks)container.append(el('p',(check.ok?'✓ ':'! ')+check.label+' · '+check.detail));
  container.append(el('h3','最近动态'));
  for(const item of insights.recent)container.append(el('p',typeof item==='string'?item:JSON.stringify(item)));
  if(!insights.recent.length)container.append(el('p','尚无记忆变更记录。'));
}
export function renderGraph(container,data,onSelect){
  container.replaceChildren();
  const controls=el('div');controls.className='actions';
  const caption=el('p',`${data.nodes.length} 个节点 · ${data.edges.length} 条关系 · 更新于 ${new Date().toLocaleTimeString()}`);
  const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.classList.add('memory-canvas');svg.setAttribute('preserveAspectRatio','none');svg.setAttribute('aria-label','记忆关系图，可缩放和拖动');
  const make=(tag,attrs={})=>{const x=document.createElementNS(svg.namespaceURI,tag);for(const [key,value]of Object.entries(attrs))x.setAttribute(key,value);return x;};
  let view=resetView(),drag=null,moved=false;
  const layout=layoutGraph(data.nodes,data.edges),positions=layout.positions;
  const lines=data.edges.filter(e=>positions.has(e.source)&&positions.has(e.target)).map(edge=>{
    const line=make('line',{class:'graph-edge '+edge.kind});svg.append(line);return {line,edge};
  });
  const nodes=data.nodes.map(node=>{
    const group=make('g',{'data-node':node.id,tabindex:'0',role:'button','aria-label':node.label??node.id,class:'graph-node'});
    const circle=make('circle',{r:layout.radius(node.id)+4,fill:typeColor(node.type)});
    const text=make('text',{x:layout.radius(node.id)+10,y:5});text.textContent=node.label??node.id;
    const title=make('title');title.textContent=node.id+' · '+(node.tags??[]).join(', ');
    group.append(circle,text,title);svg.append(group);
    const select=()=>onSelect(node.id);
    group.addEventListener('click',()=>{if(!moved)select();});
    group.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();select();}});
    const highlight=active=>{for(const {line,edge}of lines)line.classList.toggle('related',active&&(edge.source===node.id||edge.target===node.id));};
    group.addEventListener('pointerenter',()=>highlight(true));group.addEventListener('pointerleave',()=>highlight(false));
    group.addEventListener('focus',()=>highlight(true));group.addEventListener('blur',()=>highlight(false));
    return {group,node,text};
  });
  function draw(){
    svg.setAttribute('viewBox',`${view.x} ${view.y} ${view.w} ${view.h}`);
    for(const {line,edge}of lines){const a=positions.get(edge.source),b=positions.get(edge.target);for(const [k,v]of Object.entries({x1:a.x,y1:a.y,x2:b.x,y2:b.y}))line.setAttribute(k,v);}
    for(const {group,node,text}of nodes){const p=positions.get(node.id);group.setAttribute('transform',`translate(${p.x},${p.y})`);const right=p.x>400;text.setAttribute('text-anchor',right?'end':'start');text.setAttribute('x',(right?-1:1)*(layout.radius(node.id)+10));}
  }
  for(const [label,fn]of [['放大',()=>{view=zoomAt(view,view.x+view.w/2,view.y+view.h/2,.8);}],['缩小',()=>{view=zoomAt(view,view.x+view.w/2,view.y+view.h/2,1.25);}],['重置视图',()=>{view=resetView();const fresh=layoutGraph(data.nodes,data.edges);for(const [id,p]of fresh.positions)positions.set(id,p);}]]){
    const button=el('button',label);button.className='secondary';button.type='button';button.onclick=()=>{fn();draw();};controls.append(button);
  }
  svg.addEventListener('wheel',e=>{e.preventDefault();const p=toGraphPoint(view,svg.getBoundingClientRect(),e.clientX,e.clientY);view=zoomAt(view,p.x,p.y,e.deltaY>0?1.12:.88);draw();},{passive:false});
  svg.addEventListener('pointerdown',e=>{
    if(e.button!==0)return;
    const target=e.target.closest('[data-node]'),id=target?.getAttribute('data-node');
    drag={id,x:e.clientX,y:e.clientY,view:{...view},rect:svg.getBoundingClientRect(),position:id?{...positions.get(id)}:null};moved=false;svg.setPointerCapture(e.pointerId);
  });
  svg.addEventListener('pointermove',e=>{
    if(!drag)return;const dx=e.clientX-drag.x,dy=e.clientY-drag.y;if(Math.abs(dx)+Math.abs(dy)>3)moved=true;
    const scale={scaleX:drag.view.w/drag.rect.width,scaleY:drag.view.h/drag.rect.height};
    if(drag.id)positions.set(drag.id,{x:drag.position.x+dx*scale.scaleX,y:drag.position.y+dy*scale.scaleY});
    else view=panBy(drag.view,dx,dy,scale);draw();
  });
  svg.addEventListener('pointerup',()=>{const selected=drag?.id;drag=null;if(selected&&!moved)onSelect(selected);});
  for(const event of ['pointercancel','lostpointercapture'])svg.addEventListener(event,()=>{drag=null;});
  const legend=el('p','实线：页面互链 · 虚线：索引路由 · 细线：共享标签。滚轮缩放，拖动空白平移，拖动节点整理视图；悬停高亮关系。图谱只读，位置不修改记忆。');
  legend.className='hint';container.append(controls,caption,svg,legend);draw();
}
