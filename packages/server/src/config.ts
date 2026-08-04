import { fileURLToPath } from 'node:url';
import path from 'node:path';
import dotenv from 'dotenv';
import { z } from 'zod';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Repo root — `packages/server/src` -> up three. */
export const repoRoot = path.resolve(here, '../../..');

dotenv.config({ path: path.join(repoRoot, '.env') });

/**
 * Telephony and model credentials are deliberately optional. Phases 0-8 run
 * with none of them set; the code paths that need one check at the point of
 * use and fail with a message naming the missing var, rather than refusing to
 * boot the whole server. See docs/IMPLEMENTATION_PLAN.md.
 */
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3100),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  DASHBOARD_ORIGIN: z.string().default('http://localhost:5173'),

  ANTHROPIC_API_KEY: z.string().optional(),
  MODEL_VOICE: z.string().default('claude-sonnet-5'),
  MODEL_FAST: z.string().default('claude-haiku-4-5-20251001'),
  HAZARD_CHECK_LLM_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),

  RETELL_API_KEY: z.string().optional(),
  RETELL_AGENT_ID: z.string().optional(),

  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  TWILIO_PHONE_NUMBER: z.string().optional(),
  DISPATCHER_ALERT_NUMBER: z.string().optional(),

  PUBLIC_BASE_URL: z.string().optional(),
  SEASON_OVERRIDE: z.enum(['auto', 'heating', 'cooling', 'shoulder']).default('auto'),

  DASHBOARD_BASIC_AUTH_USER: z.string().optional(),
  DASHBOARD_BASIC_AUTH_PASS: z.string().optional(),
});

function load(): z.infer<typeof schema> {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}\n\nSee .env.example.`);
  }
  return parsed.data;
}

export const config = load();

export const isProduction = config.NODE_ENV === 'production';
export const isTest = config.NODE_ENV === 'test';

/**
 * Read a credential that is only present from Phase 9 onward. Throws with a
 * message that names the variable, so a missing key is obvious rather than
 * surfacing later as an opaque 401 from a third party.
 */
export function requireEnv(key: keyof z.infer<typeof schema>): string {
  const value = config[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${key} is not set. Add it to .env — see .env.example.`);
  }
  return value;
}
