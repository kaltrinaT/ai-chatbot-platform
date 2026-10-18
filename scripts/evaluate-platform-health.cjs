/* eslint-disable @typescript-eslint/no-require-imports -- Standalone CommonJS evaluation script. */
const fs = require('node:fs');
const dotenv = require('dotenv');
dotenv.config({path:'.env.local',quiet:true}); dotenv.config({quiet:true});
const {neon}=require('@neondatabase/serverless');
const directory='docs/evaluation/automated';
async function main(){
 fs.mkdirSync(directory,{recursive:true});
 const tenants=await neon(process.env.DATABASE_URL).query(`SELECT t.id,t.cloud_provider,t.vector_store,t.chatbot_url,
 (SELECT status FROM deployments d WHERE d.tenant_id=t.id AND d.kind='deploy' ORDER BY started_at DESC LIMIT 1) AS latest_status
 FROM tenants t WHERE t.deleted_at IS NULL AND EXISTS
 (SELECT 1 FROM deployments d WHERE d.tenant_id=t.id AND d.kind='deploy' AND d.started_at >= '2026-09-28T01:02:44Z')`);
 const results=[];
 for(let round=1;round<=3;round++){
  const probes=await Promise.all(tenants.map(async tenant=>{
   const result={tenant_id:tenant.id,cloud:tenant.cloud_provider,vector_store:tenant.vector_store,latest_status:tenant.latest_status,round,at:new Date().toISOString()};
   if(!tenant.chatbot_url){return {...result,outcome:'skipped',reason:'No chatbot URL recorded'};}
   const url=new URL(tenant.chatbot_url);
   if(!['http:','https:'].includes(url.protocol)||!/(\.amazonaws\.com|\.cloudfront\.net|\.azurecontainerapps\.io)$/.test(url.hostname)||url.username||url.password){return {...result,outcome:'skipped',reason:'Endpoint outside recognised deployed cloud hosts'};}
   url.pathname='/api/health';url.search='';url.hash='';
   const start=performance.now();
   try{const response=await fetch(url,{signal:AbortSignal.timeout(10000),redirect:'error',headers:{Accept:'application/json'}});const body=(await response.text()).slice(0,1000);let json=null;try{json=JSON.parse(body);}catch{}
    return {...result,host:url.hostname,http_status:response.status,latency_ms:Math.round(performance.now()-start),outcome:response.status===200?'http_200':'http_error',json_response:json!==null,reported_status:json?.status??null};
   }catch(error){return {...result,host:url.hostname,latency_ms:Math.round(performance.now()-start),outcome:'request_failed',error:error.cause?.code??error.name};}
  }));results.push(...probes);
 }
 const output={extracted_at:new Date().toISOString(),method:'Three immediate rounds of GET /api/health, 10-second timeout, no redirects; HTTP 200 is reachability, not answer correctness or long-term availability.',eligible_tenants:tenants.length,results};
 fs.writeFileSync(`${directory}/health.json`,JSON.stringify(output,null,2));
 console.log(JSON.stringify(output,null,2));
}
main().catch(error=>{console.error(error.message);process.exitCode=1});
