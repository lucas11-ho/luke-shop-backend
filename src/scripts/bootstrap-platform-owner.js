import { loadConfig } from '../config.js';
import { createDatabase } from '../db/pool.js';
import { normalizeEmail,publicId,uuid } from '../core/identifiers.js';
import { hashPassword,assertPasswordPolicy } from '../core/passwords.js';
function args(argv){const o={};for(let i=0;i<argv.length;i++){if(argv[i].startsWith('--')){o[argv[i].slice(2)]=argv[i+1];i++;}}return o;}
async function main(){const a=args(process.argv.slice(2)),email=normalizeEmail(a.email),name=String(a.name||'Platform Owner').trim(),password=assertPasswordPolicy(a.password);if(!email)throw new Error('--email is required');const db=createDatabase(loadConfig());try{const hash=await hashPassword(password);const r=await db.query(`INSERT INTO platform_users(id,public_id,email,password_hash,display_name,role,status) VALUES($1,$2,$3,$4,$5,'OWNER','ACTIVE') ON CONFLICT(email) DO UPDATE SET password_hash=EXCLUDED.password_hash,display_name=EXCLUDED.display_name,role='OWNER',status='ACTIVE',updated_at=now() RETURNING public_id,email,display_name,role,status`,[uuid(),publicId('pusr'),email,hash,name]);console.log(JSON.stringify({ready:true,user:r.rows[0]},null,2));}finally{await db.close();}}
main().catch(e=>{console.error(e.message);console.error('Usage: npm run bootstrap:platform-owner -- --email owner@example.com --password "A-long-password" [--name "Platform Owner"]');process.exitCode=1;});
