import { FastifyPluginAsync } from 'fastify';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { authSchemas } from './auth.schema.js';
import {
  LoginBody,
  RefreshBody,
  SetPasswordBody,
  ValidateSetupTokenBody,
} from './auth.types.js';

export const authRoutes: FastifyPluginAsync = async (fastify) => {
  const service = new AuthService(fastify);
  const controller = new AuthController(service);

  fastify.post<{ Body: LoginBody }>(
    '/auth/login',
    { schema: authSchemas.login },
    controller.login,
  );

  fastify.post<{ Body: RefreshBody }>(
    '/auth/refresh',
    { schema: authSchemas.refresh },
    controller.refresh,
  );

  fastify.post(
    '/auth/logout',
    { schema: authSchemas.logout },
    controller.logout,
  );

  fastify.post<{ Body: ValidateSetupTokenBody }>(
    '/auth/setup-password/validate',
    { schema: authSchemas.validateSetupToken },
    controller.validateSetupToken,
  );

  fastify.post<{ Body: SetPasswordBody }>(
    '/auth/setup-password',
    { schema: authSchemas.setPassword },
    controller.setPassword,
  );

  // ── Protected routes (JWT required) ──────────────────────────────────────────

  fastify.get(
    '/auth/me',
    { onRequest: [fastify.authenticate], schema: authSchemas.me },
    controller.me,
  );

  fastify.post(
    '/auth/logout-all',
    { onRequest: [fastify.authenticate], schema: authSchemas.logoutAll },
    controller.logoutAll,
  );
};
