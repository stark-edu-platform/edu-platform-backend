import fp from 'fastify-plugin';
import { FastifyPluginAsync } from 'fastify';

const loggerPlugin: FastifyPluginAsync = async (fastify) => {
  fastify.addHook('onRequest', async (request) => {
    request.log.info(
      {
        method: request.method,
        url: request.url,
        requestId: request.id,
      },
      'Incoming request',
    );
  });

  fastify.addHook('onResponse', async (request, reply) => {
    request.log.info(
      {
        method: request.method,
        url: request.url,
        requestId: request.id,
        statusCode: reply.statusCode,
        responseTime: reply.elapsedTime,
      },
      'Request completed',
    );
  });
};

export default fp(loggerPlugin);
