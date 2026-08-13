import { loadConfig } from '../config.js';
import { createDatabase } from '../db/pool.js';
import { provisionTenant } from '../modules/platform/provisioning.js';
function args(argv){const out={};for(let i=0;i<argv.length;i++){if(!argv[i].startsWith('--'))continue;out[argv[i].slice(2)]=argv[i+1];i++;}return out;}
async function main(){const a=args(process.argv.slice(2));const db=createDatabase(loadConfig());try{const result=await db.transaction(client=>provisionTenant(client,{slug:a.slug,name:a.name,owner_email:a['owner-email'],owner_password:a['owner-password'],owner_name:a['owner-name'],currency:a.currency,locale:a.locale,timezone:a.timezone,plan_key:a.plan||'STARTER',template_key:a.template||'MODERN_COMMERCE'}));console.log(JSON.stringify({created:true,...result},null,2));}finally{await db.close();}}
main().catch(error=>{console.error(error.message);console.error('Usage: npm run bootstrap:tenant -- --slug acme --name "Acme Store" --owner-email owner@example.com --owner-password "A-long-password" [--owner-name Owner] [--currency USD] [--locale en] [--timezone UTC] [--plan STARTER] [--template MODERN_COMMERCE]');process.exitCode=1;});
