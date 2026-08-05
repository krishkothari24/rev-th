import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import formbody from '@fastify/formbody';
import websocket from '@fastify/websocket';
import { config, isProduction, resolveAllowedDashboardOrigins } from './config.js';
import { registerToolRoutes } from './tools/routes.js';
import { registerDashboardRoutes } from './dashboard/routes.js';
import { registerDashboardStatic } from './dashboard/static.js';
import { dashboardAuthConfigured, requireDashboardBasicAuth } from './dashboard/basicAuth.js';
import { registerEventsRoute } from './events/sse.js';
import { registerEventsRelayRoute } from './events/relay.js';
import { registerSmsOutboundSubscriber } from './sms/outboundSubscriber.js';
import { registerTwilioSmsRoute } from './transports/twilio/sms.js';
import { startSmsInactivitySweeper } from './transports/twilio/conversationStore.js';
import { registerRetellWebhookRoute } from './transports/retell/webhook.js';
import { registerRetellWebsocketRoute } from './transports/retell/websocket.js';

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      // Belt and braces alongside the redact helpers: never let a header or a
      // stray body field carry PII into the log stream (BUILD_GUIDE §8.4).
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers["x-retell-signature"]',
          'req.headers["x-twilio-signature"]',
          'req.body.phone',
          'req.body.address_line',
          'req.body.name',
        ],
        censor: '[redacted]',
      },
      transport: isProduction ? undefined : { target: 'pino-pretty', options: { colorize: true } },
    },
    // Retell and Twilio both sign the raw bytes. Trusting the proxy keeps the
    // reconstructed request URL correct behind Railway's load balancer, which
    // Twilio's signature is computed over.
    trustProxy: true,
  });

  await app.register(cors, {
    origin: resolveAllowedDashboardOrigins(),
    credentials: true,
  });

  await app.register(rateLimit, {
    global: false,
    max: 60,
    timeWindow: '1 minute',
  });

  // Twilio POSTs application/x-www-form-urlencoded, not JSON — Fastify has
  // no built-in parser for that content type.
  await app.register(formbody);

  await app.register(websocket);

  app.get('/health', async () => ({
    status: 'ok',
    service: 'summit-air',
    env: config.NODE_ENV,
    time: new Date().toISOString(),
  }));

  await app.register(registerToolRoutes, { prefix: '/tools' });

  // Everything a browser loads to view the dashboard — the static build,
  // its REST surface, and the SSE stream — lives in one encapsulated scope
  // so a single onRequest hook covers all three (BUILD_GUIDE §8.5). Signed
  // webhooks, the LLM socket, and /tools/* stay outside: they authenticate
  // themselves and Railway's healthcheck needs /health reachable regardless.
  await app.register(async (dashboardScope) => {
    if (dashboardAuthConfigured()) {
      dashboardScope.addHook('onRequest', async (req, reply) => {
        requireDashboardBasicAuth(req, reply);
      });
    }
    await dashboardScope.register(registerDashboardStatic);
    await dashboardScope.register(registerDashboardRoutes, { prefix: '/dashboard' });
    await dashboardScope.register(registerEventsRoute);
  });

  await app.register(registerEventsRelayRoute);
  await app.register(registerTwilioSmsRoute);
  await app.register(registerRetellWebhookRoute);
  await app.register(registerRetellWebsocketRoute);

  // Per-buildApp() registration (several tests call buildApp() more than
  // once per process), torn down on close — see sms/outboundSubscriber.ts
  // and transports/twilio/conversationStore.ts.
  const unsubscribeSmsOutbound = registerSmsOutboundSubscriber();
  const stopSmsSweeper = startSmsInactivitySweeper();
  app.addHook('onClose', async () => {
    unsubscribeSmsOutbound();
    stopSmsSweeper();
  });

  return app;
}
