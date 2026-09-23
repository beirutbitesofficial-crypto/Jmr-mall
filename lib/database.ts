import mysql, {type Pool, type PoolConnection, type RowDataPacket, type ResultSetHeader} from 'mysql2/promise';
import {AsyncLocalStorage} from 'node:async_hooks';

let pool:Pool|undefined;
let initialized:Promise<void>|undefined;
const context=new AsyncLocalStorage<PoolConnection>();

export function options() {
  const url=process.env.DATABASE_URL;
  let config;
  if(url){const parsed=new URL(url);if(parsed.protocol!=='mysql:')throw new Error('DATABASE_URL must use mysql://');config={host:parsed.hostname,port:Number(parsed.port||3306),user:decodeURIComponent(parsed.username),password:decodeURIComponent(parsed.password),database:decodeURIComponent(parsed.pathname.slice(1))};}
  else config={host:process.env.DB_HOST,port:Number(process.env.DB_PORT||3306),user:process.env.DB_USER,password:process.env.DB_PASSWORD,database:process.env.DB_NAME};
  if(!config.host||!config.user||!config.database)throw new Error('MySQL settings are missing');
  if(!Number.isInteger(config.port)||config.port<1||config.port>65535)throw new Error('Invalid database port');
  return {...config,connectionLimit:5,connectTimeout:10000,charset:'utf8mb4',decimalNumbers:true,dateStrings:true,timezone:'Z',multipleStatements:false,
    ...(process.env.DB_SSL==='true'?{ssl:{rejectUnauthorized:true,...(process.env.DB_SSL_CA?{ca:process.env.DB_SSL_CA.replace(/\\n/g,'\n')}:{})}}:{})};
}
function getPool(){return pool??=mysql.createPool(options());}
const schema=[
`CREATE TABLE IF NOT EXISTS departments (
 id INT PRIMARY KEY AUTO_INCREMENT, meter_section VARCHAR(180) NOT NULL,
 category VARCHAR(180) NOT NULL DEFAULT '', owner VARCHAR(180) NOT NULL DEFAULT '',
 phone VARCHAR(180) NOT NULL DEFAULT '', occupant VARCHAR(180) NOT NULL DEFAULT '',
 occupant_number VARCHAR(180) NOT NULL DEFAULT '', rent_start VARCHAR(10) NOT NULL DEFAULT '',
 rent_end VARCHAR(10) NOT NULL DEFAULT '', active INT NOT NULL DEFAULT 1,
 created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE KEY jmr_department_meter(meter_section)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
`CREATE TABLE IF NOT EXISTS monthly_records (
 id INT PRIMARY KEY AUTO_INCREMENT, month VARCHAR(7) NOT NULL, department_id INT NOT NULL,
 meter_fee DECIMAL(20,6) NOT NULL DEFAULT 0, kilo_price DECIMAL(20,6) NOT NULL DEFAULT 0,
 rent DECIMAL(20,6) NOT NULL DEFAULT 0, services DECIMAL(20,6) NOT NULL DEFAULT 0,
 previous_reading DECIMAL(20,6) NOT NULL DEFAULT 0, current_reading DECIMAL(20,6) NOT NULL DEFAULT 0,
 locked INT NOT NULL DEFAULT 0, confirmed INT NOT NULL DEFAULT 0,
 updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
 FOREIGN KEY(department_id) REFERENCES departments(id),
 UNIQUE KEY jmr_month_department(month,department_id),
 INDEX jmr_department_month(department_id,month)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
`CREATE TABLE IF NOT EXISTS jmr_revision (id INT PRIMARY KEY,version BIGINT NOT NULL) ENGINE=InnoDB`,
`INSERT IGNORE INTO jmr_revision(id,version) VALUES (1,0)`,
`CREATE TABLE IF NOT EXISTS jmr_audit (id INT PRIMARY KEY AUTO_INCREMENT,at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,action VARCHAR(80) NOT NULL,detail LONGTEXT NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
`CREATE TABLE IF NOT EXISTS jmr_backups (id INT PRIMARY KEY AUTO_INCREMENT,at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,payload LONGTEXT NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
`CREATE TABLE IF NOT EXISTS auth_login_rate_limits (client_key VARCHAR(100) PRIMARY KEY,failure_count INT NOT NULL DEFAULT 0,window_started_at BIGINT NOT NULL,updated_at BIGINT NOT NULL,INDEX jmr_login_updated(updated_at)) ENGINE=InnoDB`,
];
export async function init(){
  if(!initialized)initialized=(async()=>{const c=await getPool().getConnection();try{for(const sql of schema)await c.query(sql);}finally{c.release();}})().catch(e=>{initialized=undefined;throw e;});
  await initialized;
}
export function normalizeSql(sql:string){
  if(/^INSERT OR IGNORE INTO/i.test(sql.trim())){const table=sql.trim().match(/^INSERT OR IGNORE INTO ([a-z_]+)/i)?.[1];if(!table)throw Error('Unsupported insert');return sql.replace(/INSERT OR IGNORE INTO/i,'INSERT INTO').replace(/;?$/,` ON DUPLICATE KEY UPDATE id=${table}.id`);}
  return sql;
}
type Statement={bind(...values:unknown[]):Statement;first<T=Record<string,unknown>>():Promise<T|null>;all<T=Record<string,unknown>>():Promise<{results:T[]}>;run():Promise<unknown>};
async function transaction<T>(fn:()=>Promise<T>,readonly=false):Promise<T>{
  if(context.getStore())return fn();
  await init();const c=await getPool().getConnection();
  try{
    await c.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    if(readonly)await c.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');else await c.beginTransaction();
    const value=await context.run(c,fn);await c.commit();return value;
  }catch(e){await c.rollback();throw e;}finally{c.release();}
}
export async function snapshot<T>(fn:()=>Promise<T>):Promise<T>{return transaction(fn,true);}
function prepare(sql:string,values:unknown[]=[]):Statement{
  async function execute(){
    await init();const c=context.getStore()??getPool();
    // Explicit comparison avoids relying on different MySQL/MariaDB CHECK enforcement.
    if(/^UPDATE jmr_revision SET version=CASE/i.test(sql)){
      if(!context.getStore())throw Error('Revision update requires a transaction');
      const [rows]=await c.query<RowDataPacket[]>('SELECT version FROM jmr_revision WHERE id=1 FOR UPDATE');
      if(!rows.length||Number(rows[0].version)!==values[0])throw Error('REVISION_CONFLICT');
      return (await c.query('UPDATE jmr_revision SET version=version+1 WHERE id=1'))[0];
    }
    const [rows]=await c.query(normalizeSql(sql),values);return rows;
  }
  return {bind(...next){return prepare(sql,next);},async first<T>(){const rows=await execute() as T[];return rows[0]??null;},async all<T>(){return {results:await execute() as T[]};},async run(){const r=await execute() as ResultSetHeader;return {meta:{changes:r.affectedRows??0}};}};
}
export const env={DB:{prepare,async batch(statements:Statement[]){return transaction(async()=>{const results=[];for(const s of statements)results.push(await s.run());return results;});}},get JMR_APP_PIN(){return process.env.JMR_APP_PIN;},get JMR_SESSION_SECRET(){return process.env.JMR_SESSION_SECRET;}};
export async function closeDatabase(){await pool?.end();pool=undefined;initialized=undefined;}
