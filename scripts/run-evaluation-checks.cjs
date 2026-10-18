/* eslint-disable @typescript-eslint/no-require-imports -- Standalone CommonJS evaluation runner. */
const fs=require('node:fs');
const {spawnSync}=require('node:child_process');
const path=require('node:path');
const directory='docs/evaluation/automated';fs.mkdirSync(directory,{recursive:true});
const results=[];
function run(name,command,args,options={}){
 const result=spawnSync(command,args,{encoding:'utf8',timeout:60000,maxBuffer:8*1024*1024,...options});
 const output={name,at:new Date().toISOString(),exit_code:result.status,error:result.error?.code,stdout:result.stdout,stderr:result.stderr};
 fs.writeFileSync(`${directory}/${name}.json`,JSON.stringify(output,null,2));results.push({name,exit_code:result.status,error:result.error?.code});
}
run('lint-source',process.execPath,['node_modules/eslint/bin/eslint.js','src','--format','json']);
const env={...process.env,CHECKPOINT_DISABLE:'1'};
run('terraform-aws','terraform',['validate','-json'],{cwd:path.resolve('infra/terraform'),env});
run('terraform-azure','terraform',['validate','-json'],{cwd:path.resolve('infra/terraform/azure'),env});
if(fs.existsSync('C:/Program Files/Git/bin/bash.exe')){
 const key=Object.keys(process.env).find(k=>k.toUpperCase()==='PATH');
 run('bash-script-tests',process.execPath,['node_modules/vitest/vitest.mjs','run','src/lib/terraformInit.test.ts','--reporter=json','--outputFile='+directory+'/bash-tests.json'],{env:{...process.env,[key]:'C:/Program Files/Git/bin;'+process.env[key]}});
}
console.log(JSON.stringify(results,null,2));
