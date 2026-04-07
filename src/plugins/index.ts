import { FastifyInstance } from 'fastify';
import authPlugin from './auth.plugin.js';
import dbPlugin from './db.plugin.js';
import developerPlugin from './developer.plugin.js';
import loggerPlugin from './logger.plugin.js';
import swaggerPlugin from './swagger.plugin.js'; // From previous step

export async function registerPlugins(fastify: FastifyInstance) {
  await fastify.register(dbPlugin);
  await fastify.register(loggerPlugin);

  await fastify.register(
    async (apiFastify) => {
      await apiFastify.register(authPlugin);
      await apiFastify.register(developerPlugin);
      await apiFastify.register(swaggerPlugin);
    },
    {
      prefix: '/api',
    },
  );
}
