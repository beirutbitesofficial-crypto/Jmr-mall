// Build-time declarations for the retained D1/Worker target; no Node runtime imports.
declare module 'cloudflare:workers' { export const env: {DB: D1Database; [key:string]:unknown}; }
interface D1Database { prepare(sql:string): D1PreparedStatement; batch(statements:D1PreparedStatement[]):Promise<D1Result[]>; }
interface D1PreparedStatement { bind(...values:unknown[]):D1PreparedStatement; all<T=Record<string,unknown>>():Promise<{results:T[]}>; first<T=Record<string,unknown>>():Promise<T|null>; run():Promise<D1Result>; }
interface D1Result {results:Record<string,unknown>[];meta:{changes:number};}
interface Fetcher {fetch(request:Request):Promise<Response>;}
