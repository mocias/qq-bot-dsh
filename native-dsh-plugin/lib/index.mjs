import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {TypertRemoteService,Remote} from '@deepseek-ai/dsh-typert-protocol';
import {defineTool} from '@deepseek-ai/dsh-tools';

// Stable entry point. The manifest is selected by the same release operation
// as the standalone service, not by requests or model arguments.
export default class QQRSINative extends TypertRemoteService{
  static inject=['agents','tools','sessionController','attachments','systemPrompt','skills','agentPresets'];
  constructor(ctx,config={}){
    super(ctx,'qqRsiNative');this.owner=ctx;this.manifest=config.releaseManifest;
    this.loading=Promise.resolve();this.runtime=null;this.entry=null;
    ctx.on('dispose',()=>this.runtime?.dispose());
  }
  async current(){
    const load=async()=>{
      if(!path.isAbsolute(this.manifest??''))throw Error('请配置QQ RSI统一发布清单');
      const manifest=JSON.parse(fs.readFileSync(this.manifest,'utf8'));
      if(!path.isAbsolute(manifest.releaseRoot??'')||manifest.protocol!==1)throw Error('QQ RSI发布清单无效');
      const entry=path.join(manifest.releaseRoot,'native-dsh-plugin','lib','runtime.mjs');
      if(this.entry===entry)return this.runtime;
      if(this.runtime?.bindings.size)throw Error('QQ原生工具仍有活动回合，暂不能更新插件');
      const mod=await import(pathToFileURL(entry).href);
      this.runtime?.dispose();this.runtime=null;
      const candidate=new mod.NativeRuntime(this.owner,defineTool,{scheduleRoot:path.resolve(path.dirname(this.manifest),'../standalone/.runtime')});
      if(candidate.probe().version!==manifest.version||candidate.probe().buildId!==manifest.buildId)throw Error('插件与统一发布清单版本或构建不一致');
      this.runtime=candidate;this.entry=entry;return candidate;
    };
    const result=this.loading.then(load);this.loading=result.catch(()=>{});return result;
  }
  async probe(request){return (await this.current()).probe(request);}
  async submit(request){return (await this.current()).submit(request);}
  async release(request){return this.runtime?.release(request)??{released:true};}
}
for(const name of ['probe','submit','release']){
  const initializers=[];Remote(name)(undefined,{name,private:false,static:false,addInitializer(fn){initializers.push(fn);}});
  const receiver=Object.create(QQRSINative.prototype);for(const fn of initializers)fn.call(receiver);
}
