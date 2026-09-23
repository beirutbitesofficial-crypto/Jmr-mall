import {init,closeDatabase} from '../lib/database.ts';
try {await init();console.log('JMR MySQL schema is ready.');} catch {console.error('Database initialization failed. Check MySQL access and environment settings.');process.exitCode=1;} finally{await closeDatabase();}
