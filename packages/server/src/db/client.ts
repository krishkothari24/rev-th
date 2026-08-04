import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { config } from '../config.js';
import * as schema from './schema.js';

/**
 * One pooled connection per process. `prepare: false` because pgbouncer-style
 * poolers (which Railway's managed Postgres sits behind) don't support
 * server-side prepared statements across pooled connections.
 */
export const queryClient = postgres(config.DATABASE_URL, { prepare: false });

export const db = drizzle(queryClient, { schema });

export type Db = typeof db;
