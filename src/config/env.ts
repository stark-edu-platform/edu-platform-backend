import { FastifyEnvOptions } from '@fastify/env';

export const envSchema = {
  type: 'object',
  required: ['NODE_ENV', 'PORT'],
  properties: {
    // Core Server Config
    NODE_ENV: {
      type: 'string',
      enum: ['development', 'production', 'test'],
      default: 'development',
    },
    PORT: {
      type: 'number',
      default: 3000,
    },
    HOST: {
      type: 'string',
      default: '0.0.0.0',
    },

    // Security & Logic
    ALLOWED_ORIGINS: {
      type: 'string',
      default: '*',
    },
    API_KEY: {
      type: 'string',
    },

    // Database (If applicable)
    DATABASE_URL: {
      type: 'string',
    },

    // JWT Secret (If doing Auth)
    JWT_SECRET: {
      type: 'string',
    },
  },
};

export const envOptions: FastifyEnvOptions = {
  confKey: 'config', // This makes it available as fastify.config
  schema: envSchema,
  dotenv: true, // Automatically loads .env file in development
};
