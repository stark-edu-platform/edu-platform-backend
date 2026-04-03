import fp from 'fastify-plugin';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { FastifyInstance } from 'fastify';

export default fp(async (fastify: FastifyInstance) => {
  if (process.env.NODE_ENV === 'production') return;

  await fastify.register(swagger, {
    openapi: {
      info: {
        title: 'Fastify TypeScript API',
        description: 'Production-ready API documentation',
        version: '1.0.0',
      },
      servers: [
        {
          url: process.env.BASE_URL || 'http://localhost:3000',
        },
      ],
      tags: [
        { name: 'Auth', description: 'Authentication APIs' },
        { name: 'User', description: 'User APIs' },
      ],
      components: {
        securitySchemes: {
          bearerAuth: {
            type: 'http',
            scheme: 'bearer',
            bearerFormat: 'JWT',
          },
        },
      },
      security: [{ bearerAuth: [] }],
    },
  });

  await fastify.register(swaggerUi, {
    routePrefix: '/docs',
    uiConfig: {
      docExpansion: 'list',
      deepLinking: false,
    },
    staticCSP: true,
    transformStaticCSP: (header) => header,
  });
});
