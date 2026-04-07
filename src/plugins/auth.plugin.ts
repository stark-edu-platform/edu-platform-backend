import fp from 'fastify-plugin';
import jwt from '@fastify/jwt';
import { FastifyPluginAsync } from 'fastify';
import { requireAuth } from '../middlewares/auth.middleware.js';
import { authRoutes } from '../modules/auth/auth.routes.js';

const authPlugin: FastifyPluginAsync = async (fastify) => {
  await fastify.register(jwt, {
    secret: fastify.config.JWT_SECRET,
  });

  fastify.decorate('authenticate', requireAuth);
  await fastify.register(authRoutes);
};

export default fp(authPlugin, {
  name: 'auth',
  dependencies: ['prisma'],
});
