import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import ts from 'typescript';
test('financial integrity, optimistic concurrency, backup restore and PIN reset',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'jmr-test-'));const db=new DatabaseSync(':memory:');
 const env={DB:{prepare(sql){return {args:[],bind(...v){this.args=v;return this},async first(){return db.prepare(sql).get(...this.args)||null},async all(){return {results:db.prepare(sql).all(...this.args)}},async run(){return db.prepare(sql).run(...this.args)}}},async batch(q){db.exec('BEGIN');try{const out=[];for(const s of q)out.push(await s.run());db.exec('COMMIT');return out}catch(e){db.exec('ROLLBACK');throw e}}},JMR_APP_PIN:'4321',JMR_SESSION_SECRET:'a-test-secret-with-more-than-32-characters'};
 globalThis.testEnv=env;
 async function load(path,name,replacements=[]){let source=await readFile(new URL('../'+path,import.meta.url),'utf8');source=source.replace('import { env } from "cloudflare:workers";','const env=globalThis.testEnv;').replace("import { env } from 'cloudflare:workers';",'const env=globalThis.testEnv;');for(const [a,b]of replacements)source=source.replace(a,b);await writeFile(join(dir,name),ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText);return import(join(dir,name));}
 try{
 const auth=await load('lib/pin-auth.ts','auth.mjs');const denied='const requirePinSession=async()=>null;';
 const route=await load('app/api/data/route.ts','data.mjs',[[`import { requirePinSession } from "@/lib/pin-auth";`,denied]]);
 const backup=await load('app/api/backup/route.ts','backup.mjs',[[`import { requirePinSession } from '@/lib/pin-auth';`,denied],[`from '../data/route'`,`from './data.mjs'`]]);
 const get=async()=>route.GET(new Request('https://test.local/api/data')).then(r=>r.json());
 await get();
 const call=async(body,version)=>{const current=await get();const r=await route.POST(new Request('https://test.local/api/data',{method:'POST',headers:{origin:'https://test.local'},body:JSON.stringify({...body,version:version??current.version})}));return r;};
 const d={meterSection:'A',category:'Shop',owner:'',phone:'',occupant:'Test',occupantNumber:'',rentStart:'2026-02-31',rentEnd:''};
 assert.equal((await call({action:'addDepartment',department:d})).status,400);d.rentStart='2026-02-28';assert.equal((await call({action:'addDepartment',department:d})).status,200);
 await call({action:'createMonth',month:'2026-08'});
 const r={id:1,meterFee:5,kiloPrice:.5,rent:100,services:10,previousReading:100,currentReading:200};
 assert.equal((await call({action:'lockMonth',month:'2026-08',locked:1})).status,400);
 assert.equal((await call({action:'updateRecord',record:r})).status,200);
 await call({action:'createMonth',month:'2026-09'});
 assert.equal((await get()).records.find(x=>x.id===2).currentReading,200);
 await call({action:'updateRecord',record:{...r,id:2,previousReading:200,currentReading:300}});
 await call({action:'lockMonth',month:'2026-09',locked:1});
 assert.equal((await call({action:'updateRecord',record:{...r,currentReading:250}})).status,409);
 assert.equal((await get()).records.find(x=>x.id===2).previousReading,200);
 const version=(await get()).version;
 await call({action:'updateRecord',record:r});
 assert.equal((await get()).records.find(x=>x.id===2).confirmed,1);
 assert.equal((await call({action:'updateRecord',record:{...r,rent:999}},version)).status,409);
 assert.equal((await get()).records.find(x=>x.id===1).rent,100);
 assert.equal((await call({action:'addDepartment',department:{...d,meterSection:'B'}})).status,200);
 const data=await get();assert(data.records.some(x=>x.departmentId===2&&x.month==='2026-08'));assert(!data.records.some(x=>x.departmentId===2&&x.month==='2026-09'));
 const saved=await backup.GET(new Request('https://test.local/api/backup')).then(r=>r.json());
 const restored=await backup.POST(new Request('https://test.local/api/backup',{method:'POST',headers:{origin:'https://test.local'},body:JSON.stringify({backup:saved,version:data.version})}));assert.equal(restored.status,200,await restored.text());
 assert((await get()).audit.some(x=>x.action==='restore'));
 const {cookie}=await auth.createSessionCookie(env.JMR_SESSION_SECRET);const req=new Request('https://test.local',{headers:{cookie:cookie.split(';')[0]}});assert(await auth.readPinSession(req));env.JMR_APP_PIN='87654321';assert.equal(await auth.readPinSession(req),null);
 assert.equal((await auth.requirePinSession(new Request('https://test.local'))).status,401);
 }finally{db.close();delete globalThis.testEnv;await rm(dir,{recursive:true,force:true});}
});
