import cors from '@fastify/cors';
import env from '@fastify/env';
import helmet from '@fastify/helmet';
import sensible from '@fastify/sensible';
import Fastify, { FastifyInstance } from 'fastify';
import { AppConfig, envOptions } from './config/env.js';
import { loggerConfig } from './config/logger.js';
import { registerPlugins } from './plugins/index.js';

function parseAllowedOrigins(origins: string) {
  if (origins.trim() === '*') {
    return true;
  }

  return origins
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}

export async function buildApp(): Promise<FastifyInstance> {
  const nodeEnv = (process.env.NODE_ENV ??
    'development') as AppConfig['NODE_ENV'];
  const fastify = Fastify({
    logger: loggerConfig[nodeEnv],
    disableRequestLogging: true,
    trustProxy: true,
  });

  await fastify.register(env, envOptions);

  await fastify.register(helmet, {
    global: true,
    contentSecurityPolicy:
      fastify.config.NODE_ENV === 'production' ? undefined : false,
  });

  await fastify.register(cors, {
    origin: parseAllowedOrigins(fastify.config.ALLOWED_ORIGINS),
    credentials: true,
  });

  await fastify.register(sensible);
  await registerPlugins(fastify);

  fastify.get('/health', async (request, reply) => {
    try {
      await fastify.prisma.$queryRaw`SELECT 1`;

      return {
        status: 'ok',
        database: 'up',
        timestamp: new Date().toISOString(),
        uptime: Math.round(process.uptime()),
      };
    } catch (error) {
      request.log.error(error, 'Health check failed');
      void reply.status(503);

      return {
        status: 'degraded',
        database: 'down',
        timestamp: new Date().toISOString(),
        uptime: Math.round(process.uptime()),
      };
    }
  });

  fastify.setNotFoundHandler((request, reply) => {
    void reply.status(404).send({
      message: `Route ${request.method} ${request.url} not found`,
    });
  });

  fastify.setErrorHandler((error, request, reply) => {
    request.log.error(error);
    if (reply.sent) {
      return;
    }

    const normalizedError =
      error instanceof Error ? error : new Error('Unexpected non-error thrown');
    const statusCode =
      typeof error === 'object' &&
      error !== null &&
      'statusCode' in error &&
      typeof error.statusCode === 'number'
        ? error.statusCode
        : 500;
    const isProduction = fastify.config.NODE_ENV === 'production';

    void reply.status(statusCode).send({
      message:
        statusCode >= 500 && isProduction
          ? 'Internal server error'
          : normalizedError.message,
    });
  });

  return fastify;
}
