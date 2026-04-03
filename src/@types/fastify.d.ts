import { AppConfig } from '../config/env.js';
declare module 'fastify' {
  interface FastifyInstance {
    config: AppConfig;
  }
}
