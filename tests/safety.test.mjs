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
 async function load(path,name,replacements=[]){let source=await readFile(new URL('../'+path,import.meta.url),'utf8');source=source.replace(/import \{ env(?:, init)?(?:, snapshot)? \} from [\"']@\/lib\/database[\"'];/, 'const env=globalThis.testEnv; const init=globalThis.testInit; const snapshot=async(fn)=>fn();');for(const [a,b]of replacements)source=source.replace(a,b);await writeFile(join(dir,name),ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText);return import(join(dir,name));}
 try{
 globalThis.testInit=async()=>{};
 const auth=await load('lib/pin-auth.ts','auth.mjs');const denied=`import { isAllowedOrigin } from './auth.mjs'; const requirePinSession=async()=>null;`;
 const route=await load('app/api/data/route.ts','data.mjs',[[`import { isAllowedOrigin, requirePinSession } from "@/lib/pin-auth";`,denied]]);
 const backup=await load('app/api/backup/route.ts','backup.mjs',[[`import { isAllowedOrigin, requirePinSession } from '@/lib/pin-auth';`,denied],[`from '../data/route'`,`from './data.mjs'`]]);
 const exporter=await load('app/api/export/route.ts','export.mjs',[[`import { requirePinSession } from "@/lib/pin-auth";`,'const requirePinSession=async()=>null;'],[`from "xlsx"`,`from ${JSON.stringify(new URL('../node_modules/xlsx/xlsx.mjs',import.meta.url).href)}`]]);
 globalThis.testInit=async()=>{};
 db.exec(`CREATE TABLE departments(id INTEGER PRIMARY KEY AUTOINCREMENT,meter_section TEXT,category TEXT,owner TEXT,phone TEXT,occupant TEXT,occupant_number TEXT,rent_start TEXT,rent_end TEXT,active INTEGER);CREATE TABLE monthly_records(id INTEGER PRIMARY KEY AUTOINCREMENT,month TEXT,department_id INTEGER,meter_fee REAL DEFAULT 0,kilo_price REAL DEFAULT 0,rent REAL DEFAULT 0,services REAL DEFAULT 0,previous_reading REAL DEFAULT 0,current_reading REAL DEFAULT 0,locked INTEGER DEFAULT 0,confirmed INTEGER DEFAULT 0,updated_at TEXT,UNIQUE(month,department_id));CREATE TABLE jmr_revision(id INTEGER PRIMARY KEY,version INTEGER CHECK(version>=0));INSERT INTO jmr_revision VALUES(1,0);CREATE TABLE jmr_audit(id INTEGER PRIMARY KEY,at TEXT DEFAULT CURRENT_TIMESTAMP,action TEXT,detail TEXT);CREATE TABLE jmr_backups(id INTEGER PRIMARY KEY,at TEXT DEFAULT CURRENT_TIMESTAMP,payload TEXT);`);
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
 // A far-future month would block every earlier month, so it is refused.
 assert.equal((await call({action:'createMonth',month:'2999-01'})).status,400);
 // Cross-site and oversized saves are refused before touching data.
 assert.equal((await route.POST(new Request('https://test.local/api/data',{method:'POST',headers:{origin:'https://evil.example'},body:'{}'}))).status,403);
 assert.equal((await route.POST(new Request('https://test.local/api/data',{method:'POST',headers:{origin:'https://test.local'},body:JSON.stringify({action:'x',version:0,pad:'x'.repeat(200000)})}))).status,413);
 // Behind a proxy the Host header identifies the site when APP_ORIGIN is not set.
 assert.equal(auth.isAllowedOrigin(new Request('http://127.0.0.1:3000/api/data',{method:'POST',headers:{origin:'https://mall.example',host:'mall.example'}})),true);
 // Every change stores a real data snapshot as its automatic backup, never an error body.
 const latestBackup=JSON.parse(db.prepare('SELECT payload FROM jmr_backups ORDER BY id DESC LIMIT 1').get().payload);assert(Array.isArray(latestBackup.departments));
 assert.equal((await backup.GET(new Request('https://test.local/api/backup?id=abc'))).status,400);
 // Excel: no sheet for a month that has no records, and a department added after a month
 // was approved gets no $0 invoice for that month.
 assert.equal((await exporter.GET(new Request('https://test.local/api/export?month=2026-01'))).status,404);
 await call({action:'addDepartment',department:{...d,meterSection:'C'}});
 const XLSX=await import(new URL('../node_modules/xlsx/xlsx.mjs',import.meta.url).href);
 const xlsxResponse=await exporter.GET(new Request('https://test.local/api/export?month=2026-09'));assert.equal(xlsxResponse.status,200);
 const sheet=XLSX.read(new Uint8Array(await xlsxResponse.arrayBuffer())).Sheets['Page 2 2026-09'];const billed=XLSX.utils.sheet_to_json(sheet,{header:1}).slice(1).map(row=>row[0]);
 assert.deepEqual(billed,['A']);
 const {cookie}=await auth.createSessionCookie(env.JMR_SESSION_SECRET);const req=new Request('https://test.local',{headers:{cookie:cookie.split(';')[0]}});assert(await auth.readPinSession(req));env.JMR_APP_PIN='87654321';assert.equal(await auth.readPinSession(req),null);
 assert.equal((await auth.requirePinSession(new Request('https://test.local'))).status,401);
 }finally{db.close();delete globalThis.testEnv;delete globalThis.testInit;await rm(dir,{recursive:true,force:true});}
});
