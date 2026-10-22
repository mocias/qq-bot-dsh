export function qrLoginWatcher({load,render,onLogin,isVisible,setTimer=setTimeout,clearTimer=clearTimeout}){
  let generation=0,timer=null;
  function stop(){generation++;if(timer!==null)clearTimer(timer);timer=null;}
  async function tick(id){
    if(id!==generation||!isVisible())return;
    let finished=false;
    try{
      const result=await load();if(id!==generation||!isVisible())return;
      render(result);
      if(result.state==='logged-in'){finished=true;await onLogin();}
    }catch(error){if(id!==generation||!isVisible())return;render({state:'error',message:'二维码状态读取失败：'+error.message+'；稍后自动重试。'});}
    finally{if(!finished&&id===generation&&isVisible())timer=setTimer(()=>tick(id),3000);}
  }
  return {stop,start(){stop();return tick(generation);}};
}
