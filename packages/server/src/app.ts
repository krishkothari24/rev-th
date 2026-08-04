import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { config, isProduction } from './config.js';
import { registerToolRoutes } from './tools/routes.js';

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
    origin: config.DASHBOARD_ORIGIN === '*' ? true : config.DASHBOARD_ORIGIN.split(','),
    credentials: true,
  });

  await app.register(rateLimit, {
    global: false,
    max: 60,
    timeWindow: '1 minute',
  });

  app.get('/health', async () => ({
    status: 'ok',
    service: 'summit-air',
    env: config.NODE_ENV,
    time: new Date().toISOString(),
  }));

  await app.register(registerToolRoutes, { prefix: '/tools' });

  return app;
}
