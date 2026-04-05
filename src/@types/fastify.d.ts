import { AppConfig } from '../config/env.js';
import { PrismaClient } from '../generated/prisma/client.js';
import '@fastify/jwt';

declare module 'fastify' {
  interface FastifyRequest {
    user: {
      sub?: string;
      username?: string;
    };
  }

  interface FastifyInstance {
    config: AppConfig;
    prisma: PrismaClient;
    authenticate: (
      request: FastifyRequest,
      reply: FastifyReply,
    ) => Promise<void>;
  }
}
