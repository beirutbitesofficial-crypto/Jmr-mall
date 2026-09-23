import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import ts from 'typescript';
test('MySQL adapter pins batches to one transaction and rejects stale writes before any mutation',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'jmr-driver-'));const calls=[];let version=7;
 const c={async query(sql,values){calls.push({sql,values});if(sql==='SELECT version FROM jmr_revision WHERE id=1 FOR UPDATE')return [[{version}]];if(sql==='UPDATE jmr_revision SET version=version+1 WHERE id=1')version++;return [{affectedRows:1}];},async beginTransaction(){calls.push({sql:'BEGIN'});},async commit(){calls.push({sql:'COMMIT'});},async rollback(){calls.push({sql:'ROLLBACK'});},release(){calls.push({sql:'RELEASE'});}};
 const pool={async getConnection(){return c;},query:(...args)=>c.query(...args),async end(){}};
 globalThis.mysqlTest={createPool(){return pool;}};
 const old={...process.env};Object.assign(process.env,{DB_HOST:'localhost',DB_NAME:'test',DB_USER:'test'});
 try{
 let source=await readFile(new URL('../lib/database.ts',import.meta.url),'utf8');source=source.replace(/import mysql,.*?from 'mysql2\/promise';/,'const mysql=globalThis.mysqlTest;');await writeFile(join(dir,'db.mjs'),ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText);
 const {env,init,snapshot,closeDatabase,normalizeSql}=await import(join(dir,'db.mjs'));
 await init();calls.length=0;
 await env.DB.batch([env.DB.prepare('UPDATE jmr_revision SET version=CASE WHEN version=? THEN version+1 ELSE -1 END WHERE id=1').bind(7),env.DB.prepare('INSERT INTO jmr_audit(action,detail) VALUES (?,?)').bind('save','test')]);
 assert.equal(version,8);assert(calls.find(x=>x.sql==='COMMIT'));assert.equal(calls.filter(x=>x.sql==='BEGIN').length,1);
 calls.length=0;
 await assert.rejects(env.DB.batch([env.DB.prepare('UPDATE jmr_revision SET version=CASE WHEN version=? THEN version+1 ELSE -1 END WHERE id=1').bind(7),env.DB.prepare('DELETE FROM monthly_records')]),/REVISION_CONFLICT/);
 assert(calls.find(x=>x.sql==='ROLLBACK'));assert(!calls.find(x=>x.sql==='DELETE FROM monthly_records'));
 calls.length=0;await snapshot(()=>env.DB.prepare('SELECT 1').first());assert(calls.find(x=>x.sql==='START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY'));
 assert.equal(normalizeSql('INSERT OR IGNORE INTO monthly_records(id) VALUES (?)'),'INSERT INTO monthly_records(id) VALUES (?) ON DUPLICATE KEY UPDATE id=monthly_records.id');
 await closeDatabase();
 }finally{delete globalThis.mysqlTest;for(const k of ['DB_HOST','DB_NAME','DB_USER']){if(old[k]===undefined)delete process.env[k];else process.env[k]=old[k];}await rm(dir,{recursive:true,force:true});}
});
