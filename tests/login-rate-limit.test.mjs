import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import ts from 'typescript';

// SQLite stand-in for the MySQL upsert syntax used by the rate limiter.
const toSqlite=sql=>sql.replace('ON DUPLICATE KEY UPDATE','ON CONFLICT(client_key) DO UPDATE SET').replace('GREATEST(','MAX(');

test('login limit cannot be bypassed with spoofed IP headers or parallel guesses',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'jmr-login-'));const db=new DatabaseSync(':memory:');
 db.exec('CREATE TABLE auth_login_rate_limits(client_key TEXT PRIMARY KEY,failure_count INTEGER NOT NULL DEFAULT 0,window_started_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)');
 let queue=Promise.resolve();
 const statement=(sql,args=[])=>({bind(...v){return statement(sql,v);},async first(){return db.prepare(toSqlite(sql)).get(...args)||null;},async run(){return db.prepare(toSqlite(sql)).run(...args);}});
 // Batches run one at a time, like row locks inside MySQL transactions.
 const batch=q=>queue=queue.then(async()=>{db.exec('BEGIN');try{const out=[];for(const s of q)out.push(await s.run());db.exec('COMMIT');return out;}catch(e){db.exec('ROLLBACK');throw e;}});
 globalThis.testEnv={DB:{prepare:sql=>statement(sql),batch},JMR_APP_PIN:'4321',JMR_SESSION_SECRET:'a-test-secret-with-more-than-32-characters'};
 globalThis.testInit=async()=>{};
 async function load(path,name,replacements=[]){let source=await readFile(new URL('../'+path,import.meta.url),'utf8');for(const [a,b]of replacements){assert(source.includes(a),a);source=source.replace(a,b);}await writeFile(join(dir,name),ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText);return import(join(dir,name));}
 try{
  await load('lib/pin-auth.ts','auth.mjs',[['import { env, init } from "@/lib/database";','const env=globalThis.testEnv; const init=globalThis.testInit;']]);
  const login=await load('app/api/auth/login/route.ts','login.mjs',[['from "@/lib/pin-auth"',"from './auth.mjs'"]]);
  const attempt=(pin,ip)=>login.POST(new Request('https://test.local/api/auth/login',{method:'POST',headers:{'x-real-ip':ip},body:JSON.stringify({pin})}));

  // Five wrong guesses from one address, then that address is blocked even with the right PIN.
  for(let i=0;i<5;i++)assert.equal((await attempt('0000','10.0.0.1')).status,401);
  assert.equal((await attempt('4321','10.0.0.1')).status,429);

  // A correct PIN from another address still works and gives back its global slot.
  assert.equal((await attempt('4321','10.0.0.2')).status,200);

  // 60 parallel guesses, each claiming a different IP: the global limit still stops them.
  const statuses=(await Promise.all(Array.from({length:60},(_,i)=>attempt(String(1000+i),`192.168.1.${i}`)))).map(r=>r.status);
  const checked=statuses.filter(s=>s===401).length;
  assert(checked<=20,`only 20 guesses may reach the PIN check per window, got ${checked}`);
  assert(statuses.filter(s=>s===429).length>=40);
  // Once the global window is exhausted, even a fresh address is told to wait.
  assert.equal((await attempt('4321','172.16.0.9')).status,429);
 }finally{db.close();delete globalThis.testEnv;delete globalThis.testInit;await rm(dir,{recursive:true,force:true});}
});
