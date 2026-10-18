/* eslint-disable @typescript-eslint/no-require-imports -- Standalone CommonJS evaluation script. */
const dotenv = require('dotenv');
dotenv.config({ path: '.env.local', quiet: true });
dotenv.config({ quiet: true });
const { neon } = require('@neondatabase/serverless');
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL missing');
const sql = neon(process.env.DATABASE_URL);
sql.query(`SELECT t.cloud_provider,t.vector_store,d.kind,d.status,
count(*)::int AS attempts,count(distinct d.tenant_id)::int AS tenants,
count(d.finished_at)::int AS finished,count(d.github_run_id)::int AS workflow_ids,
round(avg(extract(epoch from(d.finished_at-d.started_at))/60)::numeric,2) AS mean_minutes,
min(d.started_at) AS earliest,max(d.started_at) AS latest
FROM deployments d JOIN tenants t ON t.id=d.tenant_id
GROUP BY 1,2,3,4 ORDER BY 1,2,3,4`)
.then(rows => console.log(JSON.stringify(rows, null, 2)))
.catch(error => { console.error(error.message); process.exitCode = 1; });
