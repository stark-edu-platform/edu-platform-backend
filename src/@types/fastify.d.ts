import { AppConfig } from '../config/env.js';
import { PrismaClient } from '../generated/prisma/client.js';

declare module 'fastify' {
  interface FastifyInstance {
    config: AppConfig;
    prisma: PrismaClient;
  }
}
