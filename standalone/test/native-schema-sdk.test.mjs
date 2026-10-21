import test from 'node:test';
import assert from 'node:assert/strict';
import {DEFINITIONS} from '../../native-dsh-plugin/lib/schema.mjs';

test('installed DSH accepts every QQ tool schema including optional waiting parameters',{
  skip:!process.env.QQ_RSI_DSH_SDK_ROOT
},async()=>{
  const {defineTool}=await import(process.env.QQ_RSI_DSH_SDK_ROOT.replace(/\/$/,'')+'/dsh-tools/lib/index.js');
  for(const definition of DEFINITIONS)assert.doesNotThrow(()=>defineTool({...definition,
    output:{schema:{type:'json'}},execute:async()=>({})}),definition.name);
});
