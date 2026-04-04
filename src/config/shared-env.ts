import 'dotenv/config';

export const sharedEnvProperties = {
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
  BASE_URL: {
    type: 'string',
    default: 'http://localhost:3000',
  },
  ALLOWED_ORIGINS: {
    type: 'string',
    default: '*',
  },
  API_KEY: {
    type: 'string',
  },
  DATABASE_URL: {
    type: 'string',
    minLength: 1,
  },
  JWT_SECRET: {
    type: 'string',
  },
} as const;

export const sharedRequiredEnv = ['NODE_ENV', 'PORT', 'DATABASE_URL'] as const;

export type AppConfig = {
  NODE_ENV: 'development' | 'production' | 'test';
  PORT: number;
  HOST: string;
  ALLOWED_ORIGINS: string;
  API_KEY?: string;
  DATABASE_URL: string;
  JWT_SECRET?: string;
  BASE_URL?: string;
};

export function readSharedEnv() {
  const databaseUrl = process.env.DATABASE_URL || ''; // need to think about this
  return {
    NODE_ENV: (process.env.NODE_ENV ?? 'development') as AppConfig['NODE_ENV'],
    PORT: Number(process.env.PORT ?? 3000),
    HOST: process.env.HOST ?? '0.0.0.0',
    BASE_URL: process.env.BASE_URL ?? 'http://localhost:3000',
    ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS ?? '*',
    API_KEY: process.env.API_KEY,
    DATABASE_URL: databaseUrl,
    JWT_SECRET: process.env.JWT_SECRET,
  } satisfies AppConfig;
}
