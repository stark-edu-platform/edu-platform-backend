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
  RESEND_API_KEY: {
    type: 'string',
  },
  MAIL_FROM: {
    type: 'string',
  },
  PASSWORD_SETUP_URL_BASE: {
    type: 'string',
  },
  PASSWORD_SETUP_TOKEN_TTL_MINUTES: {
    type: 'number',
    default: 1440,
  },
  ACCESS_TOKEN_TTL_MINUTES: {
    type: 'number',
    default: 15,
  },
  REFRESH_TOKEN_TTL_DAYS: {
    type: 'number',
    default: 30,
  },
} as const;

export const sharedRequiredEnv = [
  'NODE_ENV',
  'PORT',
  'DATABASE_URL',
  'JWT_SECRET',
] as const;

export type AppConfig = {
  NODE_ENV: 'development' | 'production' | 'test';
  PORT: number;
  HOST: string;
  ALLOWED_ORIGINS: string;
  API_KEY?: string;
  DATABASE_URL: string;
  JWT_SECRET: string;
  BASE_URL?: string;
  RESEND_API_KEY?: string;
  MAIL_FROM?: string;
  PASSWORD_SETUP_URL_BASE?: string;
  PASSWORD_SETUP_TOKEN_TTL_MINUTES: number;
  ACCESS_TOKEN_TTL_MINUTES: number;
  REFRESH_TOKEN_TTL_DAYS: number;
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
    JWT_SECRET: process.env.JWT_SECRET ?? '',
    RESEND_API_KEY: process.env.RESEND_API_KEY,
    MAIL_FROM: process.env.MAIL_FROM,
    PASSWORD_SETUP_URL_BASE: process.env.PASSWORD_SETUP_URL_BASE,
    PASSWORD_SETUP_TOKEN_TTL_MINUTES: Number(
      process.env.PASSWORD_SETUP_TOKEN_TTL_MINUTES ?? 1440,
    ),
    ACCESS_TOKEN_TTL_MINUTES: Number(
      process.env.ACCESS_TOKEN_TTL_MINUTES ?? 15,
    ),
    REFRESH_TOKEN_TTL_DAYS: Number(process.env.REFRESH_TOKEN_TTL_DAYS ?? 30),
  } satisfies AppConfig;
}
