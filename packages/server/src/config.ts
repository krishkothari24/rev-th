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

  // OpenAI Realtime (IMPLEMENTATION_PLAN Phase 11) — the live voice vendor.
  // Model/voice defaults are current as of this migration's research pass
  // (BUILD_GUIDE §12); confirm against the OpenAI dashboard before Phase 11
  // step 4 (accounts) in case the GA lineup has moved on again.
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_REALTIME_MODEL: z.string().default('gpt-realtime'),
  OPENAI_REALTIME_VOICE: z.string().default('marin'),
  // Svix-format webhook signing secret ("whsec_..."), issued when the
  // realtime.call.incoming webhook endpoint is configured in the OpenAI
  // dashboard. See transports/openai-realtime/signature.ts.
  OPENAI_WEBHOOK_SECRET: z.string().optional(),

  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  TWILIO_PHONE_NUMBER: z.string().optional(),
  DISPATCHER_ALERT_NUMBER: z.string().optional(),

  PUBLIC_BASE_URL: z.string().optional(),
  SEASON_OVERRIDE: z.enum(['auto', 'heating', 'cooling', 'shoulder']).default('auto'),

  DASHBOARD_BASIC_AUTH_USER: z.string().optional(),
  DASHBOARD_BASIC_AUTH_PASS: z.string().optional(),
}).superRefine((env, ctx) => {
  // Exactly one of the pair set is unambiguously a config mistake (a typo'd
  // var name pasting into Railway, most likely) — and dashboardAuthConfigured()
  // treats "not both set" as "auth disabled," so silently accepting this
  // would fail open: the dashboard ships with no auth and no warning. Fail
  // the boot instead of fail open.
  const hasUser = Boolean(env.DASHBOARD_BASIC_AUTH_USER);
  const hasPass = Boolean(env.DASHBOARD_BASIC_AUTH_PASS);
  if (hasUser !== hasPass) {
    const missing = hasUser ? 'DASHBOARD_BASIC_AUTH_PASS' : 'DASHBOARD_BASIC_AUTH_USER';
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [missing],
      message: `${missing} must be set alongside its pair — the dashboard would otherwise deploy with no auth at all. Set both, or clear both to leave the dashboard unauthenticated on purpose.`,
    });
  }
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

/**
 * The same origin-list parsing `app.ts` hands to `@fastify/cors`. Also
 * needed by `events/sse.ts`: `reply.hijack()` (required for a long-lived SSE
 * response written straight to `reply.raw`) bypasses the cors plugin's own
 * onSend hook entirely, so that route has to replicate this check by hand
 * rather than getting `Access-Control-Allow-Origin` for free like every
 * other route.
 */
export function resolveAllowedDashboardOrigins(): string[] | true {
  return config.DASHBOARD_ORIGIN === '*' ? true : config.DASHBOARD_ORIGIN.split(',');
}
