/**
 * Drops and recreates the public schema, then reapplies migrations. Local
 * dev/demo convenience only — never wired to anything that could touch a
 * hosted database.
 */
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { db, queryClient } from './client.js';
import { config } from '../config.js';

if (config.NODE_ENV === 'production') {
  throw new Error('db:reset refuses to run with NODE_ENV=production.');
}

await db.execute(sql`DROP SCHEMA public CASCADE`);
await db.execute(sql`CREATE SCHEMA public`);

const migrationsFolder = new URL('../../drizzle', import.meta.url).pathname;
await migrate(db, { migrationsFolder });

console.log('Schema reset and migrations reapplied.');
await queryClient.end();
