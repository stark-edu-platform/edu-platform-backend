import { FastifyEnvOptions } from '@fastify/env';
import {
  AppConfig,
  sharedEnvProperties,
  sharedRequiredEnv,
} from './shared-env.js';

export const envSchema = {
  type: 'object',
  required: [...sharedRequiredEnv],
  properties: sharedEnvProperties,
};

export const envOptions: FastifyEnvOptions = {
  confKey: 'config', // This makes it available as fastify.config
  schema: envSchema,
  dotenv: true, // Automatically loads .env file in development
};
export type { AppConfig };
