import fp from 'fastify-plugin';
import { FastifyPluginAsync } from 'fastify';
const loggerPlugin: FastifyPluginAsync = async (fastify) => {
  fastify.addHook('onRequest', async (request) => {
    request.log.info({ url: request.raw.url }, 'Incoming Request');
  });

  fastify.addHook('onResponse', async (request, reply) => {
    request.log.info(
      {
        url: request.raw.url,
        statusCode: reply.statusCode,
        responseTime: reply.elapsedTime,
      },
      'Request Completed',
    );
  });
};

export default fp(loggerPlugin);
