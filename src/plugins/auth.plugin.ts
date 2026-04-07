import fp from 'fastify-plugin';
import jwt from '@fastify/jwt';
import { FastifyPluginAsync } from 'fastify';
import { authRoutes } from '../modules/auth/auth.routes.js';

const authPlugin: FastifyPluginAsync = async (fastify) => {
  await fastify.register(jwt, {
    secret: fastify.config.JWT_SECRET,
  });

  fastify.decorate(
    'authenticate',
    async function authenticate(request, reply): Promise<void> {
      try {
        await request.jwtVerify();
      } catch {
        void reply.unauthorized('Invalid or expired token');
      }
    },
  );

  await fastify.register(authRoutes);
};

export default fp(authPlugin, {
  name: 'auth',
  dependencies: ['prisma'],
});
