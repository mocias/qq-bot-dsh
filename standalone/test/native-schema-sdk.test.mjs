import test from 'node:test';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {DEFINITIONS} from '../../native-dsh-plugin/lib/schema.mjs';

test('installed DSH accepts every QQ tool schema including optional waiting parameters',{
  skip:!process.env.QQ_RSI_DSH_SDK_ROOT&&!process.env.QQ_RSI_DSH_TOOLS_ENTRY
},async()=>{
  const entry=process.env.QQ_RSI_DSH_TOOLS_ENTRY??process.env.QQ_RSI_DSH_SDK_ROOT.replace(/[\\/]$/,'')+'/dsh-tools/lib/index.js';
  // The SDK root is accepted either as a Windows path or as an already resolved file URL.
  const {defineTool}=await import(entry.startsWith('file:')?entry:pathToFileURL(entry).href);
  for(const definition of DEFINITIONS)assert.doesNotThrow(()=>defineTool({...definition,
    output:{schema:{type:'json'}},execute:async()=>({})}),definition.name);
});
