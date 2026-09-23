import {env} from '@/lib/database';
export const dynamic='force-dynamic';
export async function GET(){try{await env.DB.prepare('SELECT 1 AS ok').first();return Response.json({ok:true},{headers:{'Cache-Control':'no-store'}});}catch{return Response.json({ok:false},{status:503,headers:{'Cache-Control':'no-store'}});}}
