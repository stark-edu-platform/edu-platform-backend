import { FastifyInstance } from 'fastify';
import authPlugin from './auth.plugin.js';
import dbPlugin from './db.plugin.js';
import loggerPlugin from './logger.plugin.js';
import swaggerPlugin from './swagger.plugin.js'; // From previous step

export async function registerPlugins(fastify: FastifyInstance) {
  // Order of registration can matter (e.g., DB before Auth)
  await fastify.register(dbPlugin);
  await fastify.register(authPlugin);
  await fastify.register(loggerPlugin);
  await fastify.register(swaggerPlugin);
}
