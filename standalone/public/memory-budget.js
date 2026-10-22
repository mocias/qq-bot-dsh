// A display-only heuristic, never a model window or a save-time limit.
export function estimateMemoryBudget(boot,pages,windowTokens=null){
  if(![boot,pages].every(n=>Number.isSafeInteger(n)&&n>=1000))return {valid:false};
  const total=BigInt(boot)+BigInt(pages),low=(total+3n)/4n,high=total;
  const reference=Number.isSafeInteger(windowTokens)&&windowTokens>0?BigInt(windowTokens):null;
  return {
    valid:true,total,low,high,reference,
    warning:reference
      ?high>reference?'over':high*5n>=reference*4n?'near':'none'
      :boot>30000||pages>30000?'large':'unknown',
  };
}

export function mountMemoryBudget(find,{key,personaId,request}={}){
  const block=document.createElement('div');block.className='policy-row memory-budget';
  const title=document.createElement('h3');title.textContent='预计上下文占用';
  const estimate=document.createElement('p');estimate.id='memory-budget-estimate';estimate.setAttribute('role','status');
  const label=document.createElement('label');label.htmlFor='memory-context-reference';label.textContent='模型上下文容量（token，可选，仅用于估算）';
  const reference=document.createElement('input');reference.id=label.htmlFor;reference.type='text';reference.inputMode='numeric';reference.placeholder='按所用模型填写；留空不判断是否超窗';
  // This is a calculator, not a persisted chat policy or a model setting.
  const help=document.createElement('p');help.textContent='按两项预算合计、约 1～4 字符/token 粗估，实际分词可能超出此范围。资料不足时不会填满预算；不含其他系统指令、聊天历史、工具结果和回复空间。不会自动读取模型容量，参考容量不保存、不修改模型设置。字符数沿用程序字符串计数，部分表情可能计为多个字符。';
  const warning=document.createElement('p');warning.id='memory-budget-warning';warning.setAttribute('role','status');
  const format=n=>n.toLocaleString('zh-CN');
  const update=()=>{
    const value=estimateMemoryBudget(Number(find('policy-memoryBootMaxChars').value),Number(find('policy-memoryPageMaxChars').value),reference.value===''?null:Number(reference.value));
    if(!value.valid){estimate.textContent='请输入至少 1000 的整数字符预算。';warning.textContent='';block.dataset.warning='false';return;}
    estimate.textContent=`两项合计 ${format(value.total)} 字符；按预算估算约 ${format(value.low)}～${format(value.high)} token。`;
    if(value.reference){
      const percent=n=>format((n*100n+value.reference-1n)/value.reference);
      estimate.textContent+=` 约占所填参考容量的 ${percent(value.low)}%～${percent(value.high)}%。`;
    }
    warning.textContent={
      over:'超量提示：估算区间的高值已超过所填容量，可能超出上下文窗口。仍可保存，请预留对话与回复空间。',
      near:'余量提示：估算区间的高值已占参考容量至少 80%，还需容纳对话历史和回复。仍可保存。',
      large:'大预算提示：单项超过原建议的 30,000 字符，可能挤占对话和回复空间。此数值仅作提醒，不再限制保存；填写模型容量可进一步估算。',
      unknown:'未填写模型容量，暂不能判断是否超窗；估算只供参考。',
      none:'估算暂未接近所填容量，但不代表完整请求一定不会超窗。',
    }[value.warning];
    if(reference.value!==''&&!value.reference)warning.textContent='参考容量请输入正整数；此计算器不影响预算保存。';
    block.dataset.warning=String(['over','near','large'].includes(value.warning));
  };
  block.append(title,estimate,label,reference,help,warning);
  find('policy-memoryPageMaxChars').closest('.policy-row').after(block);
  // Invalid optional calculator input must never block policy form submission.
  reference.addEventListener('input',event=>{event.stopPropagation();update();});
  for(const key of ['memoryBootMaxChars','memoryPageMaxChars']){
    find('policy-'+key).addEventListener('input',update);
    find('override-'+key)?.addEventListener('change',update);
  }
  update();
  const counters={};let stats=null,loading=false;
  for(const field of ['memoryBootMaxChars','memoryPageMaxChars']){
    const input=find('policy-'+field),box=document.createElement('div');box.className='memory-actual';box.setAttribute('role','status');
    input.after(box);counters[field]=box;
    input.addEventListener('input',paintActual);find('override-'+field)?.addEventListener('change',paintActual);
  }
  function paintActual(){
    for(const [field,box]of Object.entries(counters)){
      if(!stats){box.textContent=key?'正在读取当前人格资料…':'选择具体聊天后显示实际资料字符数；类型默认没有独立记忆库。';continue;}
      const boot=field==='memoryBootMaxChars',actual=boot?stats.boot.chars:stats.pages.chars,budget=Number(find('policy-'+field).value);
      const valid=Number.isSafeInteger(budget)&&budget>=1000,over=valid&&actual>budget;
      box.dataset.warning=String(over);
      box.textContent=`${stats.personaName} · 当前${boot?'启动资料':'有效记忆页全文'} ${format(actual)} 字符`+(valid?` / 预算 ${format(budget)} 字符`:'；请输入有效预算')+
        (over?`。超出 ${format(actual-budget)} 字符，注入时会按预算选取或截断，原资料不会删除。`:valid?'。未超过当前预算。':'');
      const detail=document.createElement('small');
      detail.textContent=boot?stats.boot.files.map(f=>f.name+' '+format(f.chars)+' 字符').join('；')+(stats.boot.personaOutsideBudget?'；人设另行注入 '+format(stats.boot.personaOutsideBudget)+' 字符，不计入此预算。':''):
        `共 ${stats.pages.count} 个有效页，排除 ${stats.pages.excluded} 个归档/合并页。按每页最多 ${format(stats.pages.perPageCap)} 字符计算，可注入候选正文共 ${format(stats.pages.candidateChars)} 字符；实际选页随查询变化。`;
      box.append(detail);
      if(!stats.exists)box.append(document.createTextNode(' 当前尚无已保存资料。'));
    }
  }
  async function refreshActual(){
    if(!key||!request||loading)return;loading=true;refreshButton.disabled=true;
    try{
      const result=await request('/api/memory-budget?'+new URLSearchParams({key,...(personaId?{personaId}:{})}));
      if(!block.isConnected)return;stats=result;paintActual();
      refreshed.textContent='统计更新于 '+new Date(stats.checkedAt).toLocaleTimeString()+'；按程序字符数统计，不是 token。';
    }catch(error){if(block.isConnected){for(const box of Object.values(counters)){box.textContent='实际资料读取失败：'+error.message;box.dataset.warning='true';}refreshed.textContent='未取得最新统计，请重试。';}}
    finally{loading=false;refreshButton.disabled=false;}
  }
  const refreshButton=document.createElement('button');refreshButton.type='button';refreshButton.className='secondary';refreshButton.textContent='刷新实际资料统计';refreshButton.hidden=!key;refreshButton.onclick=refreshActual;
  const refreshed=document.createElement('small');refreshed.className='memory-stats-time';
  counters.memoryPageMaxChars.after(refreshButton,refreshed);
  paintActual();refreshActual();
}
