import { env, init } from '@/lib/database';
import { isAllowedOrigin, requirePinSession } from '@/lib/pin-auth';
import { GET as data } from '../data/route';
export async function GET(request:Request) {
  const denied=await requirePinSession(request); if(denied)return denied;
  await init();
  const id=new URL(request.url).searchParams.get('id');
  if(id!==null&&!/^[1-9]\d{0,15}$/.test(id))return Response.json({error:'رقم النسخة غير صالح'},{status:400});
  const snapshot=id ? await env.DB.prepare('SELECT payload FROM jmr_backups WHERE id=?').bind(Number(id)).first<{payload:string}>() : null;
  if(id&&!snapshot)return Response.json({error:'النسخة غير موجودة'},{status:404});
  if(new URL(request.url).searchParams.has('list')){
    const rows=await env.DB.prepare('SELECT id,at FROM jmr_backups ORDER BY id DESC LIMIT 100').all();
    return Response.json(rows.results,{headers:{'Cache-Control':'no-store'}});
  }
  let current;
  if(snapshot)current=JSON.parse(snapshot.payload);
  else{const response=await data(request);if(!response.ok)return response;current=await response.json();}
  return Response.json({format:'jmr-backup-v1',...current},{headers:{'Cache-Control':'no-store','Content-Disposition':'attachment; filename="jmr-backup.json"'}});
}
export async function POST(request:Request) {
  const denied=await requirePinSession(request); if(denied)return denied;
  if(!isAllowedOrigin(request))return new Response(null,{status:403});
  await init();
  try {
    const raw=await request.text();if(raw.length>5000000)throw Error('الملف كبير جداً');
    const {backup:b,version}=JSON.parse(raw);
    if(!Number.isSafeInteger(version)||version<0||b?.format!=='jmr-backup-v1'||!Array.isArray(b.departments)||!Array.isArray(b.records)||b.departments.length>10000||b.records.length>50000)throw Error('صيغة النسخة غير صالحة');
    const ids=new Set<number>(), keys=new Set<string>(), recordIds=new Set<number>();
    const textFields=['meterSection','category','owner','phone','occupant','occupantNumber','rentStart','rentEnd'];
    const numericFields=['meterFee','kiloPrice','rent','services','previousReading','currentReading'];
    for(const d of b.departments){
      if(!Number.isSafeInteger(d.id)||d.id<=0||ids.has(d.id)||![0,1].includes(d.active)||textFields.some(k=>typeof d[k]!=='string'||d[k].length>180)||!d.meterSection.trim()||!d.category.trim()||!d.occupant.trim())throw Error('بيانات الأقسام غير صالحة');
      for(const k of ['rentStart','rentEnd'])if(d[k]&&(!/^\d{4}-\d{2}-\d{2}$/.test(d[k])||!Number.isFinite(Date.parse(d[k]))||new Date(d[k]).toISOString().slice(0,10)!==d[k]))throw Error('تاريخ عقد غير صالح');
      if(d.rentStart&&d.rentEnd&&d.rentEnd<d.rentStart)throw Error('تواريخ العقد غير صالحة');
      const name=d.meterSection.trim().toLowerCase();if(keys.has(name))throw Error('أقسام مكرّرة');keys.add(name);ids.add(d.id);
    }
    keys.clear();
    for(const r of b.records){
      const key=`${r.month}:${r.departmentId}`;
      if(!Number.isSafeInteger(r.id)||r.id<=0||recordIds.has(r.id)||keys.has(key)||!ids.has(r.departmentId)||!/^\d{4}-(0[1-9]|1[0-2])$/.test(r.month)||![0,1].includes(r.locked)||![0,1].includes(r.confirmed)||numericFields.some(k=>typeof r[k]!=='number'||!Number.isFinite(r[k])||r[k]<0||r[k]>100000000)||r.currentReading<r.previousReading||(r.locked&&!r.confirmed))throw Error('قراءات النسخة غير صالحة');
      recordIds.add(r.id);keys.add(key);
    }
    for(const id of ids){const rows=b.records.filter((r:{departmentId:number})=>r.departmentId===id).sort((a:{month:string},c:{month:string})=>a.month.localeCompare(c.month));for(let i=1;i<rows.length;i++)if(rows[i].previousReading!==rows[i-1].currentReading)throw Error('تسلسل القراءات غير صالح');}
    const current=await data(request);if(!current.ok)throw Error('تعذّر حفظ نسخة من البيانات الحالية قبل الاسترجاع');
    const before=await current.json();
    const q=[env.DB.prepare('UPDATE jmr_revision SET version=CASE WHEN version=? THEN version+1 ELSE -1 END WHERE id=1').bind(version),env.DB.prepare('INSERT INTO jmr_backups(payload) VALUES (?)').bind(JSON.stringify(before)),env.DB.prepare('DELETE FROM monthly_records'),env.DB.prepare('DELETE FROM departments')];
    for(const d of b.departments)q.push(env.DB.prepare('INSERT INTO departments(id,meter_section,category,owner,phone,occupant,occupant_number,rent_start,rent_end,active) VALUES (?,?,?,?,?,?,?,?,?,?)').bind(d.id,...textFields.map(k=>d[k].trim()),d.active));
    for(const r of b.records)q.push(env.DB.prepare('INSERT INTO monthly_records(id,month,department_id,meter_fee,kilo_price,rent,services,previous_reading,current_reading,locked,confirmed) VALUES (?,?,?,?,?,?,?,?,?,?,?)').bind(r.id,r.month,r.departmentId,...numericFields.map(k=>r[k]),r.locked,r.confirmed));
    q.push(env.DB.prepare('INSERT INTO jmr_audit(action,detail) VALUES (?,?)').bind('restore',`استرجاع ${b.records.length} سجل عبر جلسة PIN مشتركة`));
    q.push(env.DB.prepare('DELETE FROM jmr_backups WHERE id NOT IN (SELECT id FROM (SELECT id FROM jmr_backups ORDER BY id DESC LIMIT 100) AS retained_backups)'));
    await env.DB.batch(q);return Response.json({ok:true});
  }catch(e){return Response.json({error:/CHECK constraint|REVISION_CONFLICT/i.test(String(e))?'تغيّرت البيانات. حدّث الصفحة قبل الاسترجاع.':e instanceof Error?e.message:'فشل الاسترجاع'},{status:400});}
}
