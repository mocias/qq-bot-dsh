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

export function mountMemoryBudget(find){
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
}
