import fp from 'fastify-plugin';
import { FastifyPluginAsync } from 'fastify';
import { requireDeveloper } from '../middlewares/developer.middleware.js';
import { developerRoutes } from '../modules/developer/developer.routes.js';

const developerPlugin: FastifyPluginAsync = async (fastify) => {
  fastify.decorate('authorizeDeveloper', requireDeveloper);

  await fastify.register(
    async (developerScopedFastify) => {
      developerScopedFastify.addHook('onRequest', fastify.authenticate);
      developerScopedFastify.addHook('onRequest', fastify.authorizeDeveloper);

      await developerScopedFastify.register(developerRoutes);
    },
    {
      prefix: '/developer',
    },
  );
};

export default fp(developerPlugin, {
  name: 'developer',
  dependencies: ['prisma', 'auth'],
});
