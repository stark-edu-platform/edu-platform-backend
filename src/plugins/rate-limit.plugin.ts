import fp from 'fastify-plugin';
import rateLimit from '@fastify/rate-limit';
import { FastifyPluginAsync } from 'fastify';

// Liveness checks and API docs must never be throttled.
const ALLOW_LIST_PREFIXES = ['/api/health', '/api/docs'];

const rateLimitPlugin: FastifyPluginAsync = async (fastify) => {
  await fastify.register(rateLimit, {
    global: true,
    max: fastify.config.RATE_LIMIT_MAX,
    timeWindow: fastify.config.RATE_LIMIT_WINDOW,
    allowList: (request) =>
      ALLOW_LIST_PREFIXES.some((prefix) => request.url.startsWith(prefix)),
    // @fastify/rate-limit THROWS this value, so it must be a real Error carrying
    // a top-level `statusCode`. The app's global error handler then renders it
    // through the standard error envelope as a 429; returning a plain object
    // here would be re-mapped to 500.
    errorResponseBuilder: () =>
      fastify.httpErrors.tooManyRequests(
        'Too many requests, please try again later',
      ),
  });
};

export default fp(rateLimitPlugin, {
  name: 'rate-limit',
});
