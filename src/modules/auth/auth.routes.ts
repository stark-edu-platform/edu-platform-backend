import { FastifyPluginAsync } from 'fastify';
import {
  loginController,
  logoutAllController,
  logoutController,
  meController,
  refreshController,
  setPasswordController,
  validateSetupTokenController,
} from './auth.controller.js';
import {
  loginRouteSchema,
  logoutAllRouteSchema,
  logoutRouteSchema,
  meRouteSchema,
  refreshRouteSchema,
  setPasswordRouteSchema,
  validateSetupTokenRouteSchema,
} from './auth.schema.js';
import {
  LoginBody,
  RefreshBody,
  SetPasswordBody,
  ValidateSetupTokenBody,
} from './auth.types.js';
import { normalizeLoginId } from './auth.utils.js';

export const authRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post<{ Body: LoginBody }>(
    '/auth/login',
    {
      schema: loginRouteSchema,
      config: {
        rateLimit: {
          max: 8,
          timeWindow: '1 minute',
          // Run after body parsing/validation so the key can include loginId.
          hook: 'preHandler',
          // Key per (IP + account): a single account can't be brute-forced from
          // one IP. The per-route config overrides the global per-IP limiter on
          // this route, so cross-account stuffing from one IP is only loosely
          // bounded — acceptable per PRP-01 non-goals (no full WAF).
          keyGenerator: (request) =>
            `${request.ip}:${normalizeLoginId(
              (request.body as LoginBody | undefined)?.loginId ?? '',
            )}`,
        },
      },
    },
    loginController,
  );

  fastify.post<{ Body: RefreshBody }>(
    '/auth/refresh',
    {
      schema: refreshRouteSchema,
      config: {
        rateLimit: { max: 30, timeWindow: '1 minute' },
      },
    },
    refreshController,
  );

  fastify.post('/auth/logout', { schema: logoutRouteSchema }, logoutController);

  fastify.post<{ Body: ValidateSetupTokenBody }>(
    '/auth/setup-password/validate',
    {
      schema: validateSetupTokenRouteSchema,
      config: {
        rateLimit: { max: 10, timeWindow: '1 minute' },
      },
    },
    validateSetupTokenController,
  );

  fastify.post<{ Body: SetPasswordBody }>(
    '/auth/setup-password',
    {
      schema: setPasswordRouteSchema,
      config: {
        rateLimit: { max: 10, timeWindow: '1 minute' },
      },
    },
    setPasswordController,
  );

  fastify.get(
    '/auth/me',
    {
      onRequest: [fastify.authenticate],
      schema: meRouteSchema,
    },
    meController,
  );

  fastify.post(
    '/auth/logout-all',
    {
      onRequest: [fastify.authenticate],
      schema: logoutAllRouteSchema,
    },
    logoutAllController,
  );
};
