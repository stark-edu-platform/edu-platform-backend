import fp from 'fastify-plugin';
import jwt from '@fastify/jwt';
import { FastifyPluginAsync } from 'fastify';
import {
  loginController,
  logoutAllController,
  logoutController,
  meController,
  refreshController,
  setPasswordController,
  validateSetupTokenController,
} from '../modules/auth/auth.controller.js';
import {
  loginRouteSchema,
  logoutAllRouteSchema,
  logoutRouteSchema,
  meRouteSchema,
  refreshRouteSchema,
  setPasswordRouteSchema,
  validateSetupTokenRouteSchema,
} from '../modules/auth/auth.schema.js';
import {
  LoginBody,
  LogoutBody,
  RefreshTokenBody,
  SetPasswordBody,
  ValidateSetupTokenBody,
} from '../modules/auth/auth.types.js';

const authPlugin: FastifyPluginAsync = async (fastify) => {
  await fastify.register(jwt, {
    secret: fastify.config.JWT_SECRET,
  });

  fastify.decorate(
    'authenticate',
    async function authenticate(request, reply): Promise<void> {
      try {
        await request.jwtVerify();
      } catch {
        void reply.unauthorized('Invalid or expired token');
      }
    },
  );

  fastify.post<{ Body: LoginBody }>(
    '/auth/login',
    { schema: loginRouteSchema },
    loginController,
  );

  fastify.post<{ Body: RefreshTokenBody }>(
    '/auth/refresh',
    { schema: refreshRouteSchema },
    refreshController,
  );

  fastify.post<{ Body: LogoutBody }>(
    '/auth/logout',
    { schema: logoutRouteSchema },
    logoutController,
  );

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

export default fp(authPlugin, {
  name: 'auth',
  dependencies: ['prisma'],
});
