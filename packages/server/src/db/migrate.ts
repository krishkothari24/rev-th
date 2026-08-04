import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { db, queryClient } from './client.js';

const migrationsFolder = new URL('../../drizzle', import.meta.url).pathname;

await migrate(db, { migrationsFolder });
console.log('Migrations applied.');
await queryClient.end();
