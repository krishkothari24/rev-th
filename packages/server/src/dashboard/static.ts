/**
 * Serves the built dashboard (`packages/dashboard/dist`, produced by
 * `npm run build`) same-origin off this backend — Phase 9's dashboard-deploy
 * decision: one Railway service instead of a paired static site, so there's
 * no cross-origin CORS/auth surface between the dashboard and its API.
 *
 * Only registers when the build output exists. Local dev never has it
 * (the dashboard runs its own Vite dev server on :5173 instead — see
 * `npm run dev:dashboard`), so this is a no-op outside a production build.
 *
 * No client-side router (BUILD_GUIDE §6: "single page, no router"), so
 * `/` serving `index.html` is the only path that matters — no SPA fallback
 * for deep links, deliberately: a custom `setNotFoundHandler` here would
 * apply prefix-wide (this scope has no prefix), which risks shadowing the
 * real 404 behavior of unrelated routes like `/tools/*` for no benefit this
 * app actually needs.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { repoRoot } from '../config.js';

export const dashboardDistDir = path.join(repoRoot, 'packages/dashboard/dist');

export function dashboardBuildExists(): boolean {
  return existsSync(path.join(dashboardDistDir, 'index.html'));
}

export async function registerDashboardStatic(app: FastifyInstance): Promise<void> {
  if (!dashboardBuildExists()) return;

  await app.register(fastifyStatic, {
    root: dashboardDistDir,
    index: 'index.html',
  });
}
