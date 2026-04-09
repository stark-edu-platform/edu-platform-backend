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

export const authRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post<{ Body: LoginBody }>(
    '/auth/login',
    { schema: loginRouteSchema },
    loginController,
  );

  fastify.post<{ Body: RefreshBody }>(
    '/auth/refresh',
    { schema: refreshRouteSchema },
    refreshController,
  );

  fastify.post('/auth/logout', { schema: logoutRouteSchema }, logoutController);

  fastify.post<{ Body: ValidateSetupTokenBody }>(
    '/auth/setup-password/validate',
    { schema: validateSetupTokenRouteSchema },
    validateSetupTokenController,
  );

  fastify.post<{ Body: SetPasswordBody }>(
    '/auth/setup-password',
    { schema: setPasswordRouteSchema },
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
