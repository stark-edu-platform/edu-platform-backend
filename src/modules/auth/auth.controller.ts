import { FastifyReply, FastifyRequest } from 'fastify';
import { AuthCookies } from './auth.cookies.js';
import { AuthService } from './auth.service.js';
import {
  LoginBody,
  RefreshBody,
  SetPasswordBody,
  ValidateSetupTokenBody,
} from './auth.types.js';
import { successResponse } from '../../utils/api-response.js';

export class AuthController {
  constructor(private readonly service: AuthService) {}

  login = async (
    request: FastifyRequest<{ Body: LoginBody }>,
    reply: FastifyReply,
  ) => {
    const result = await this.service.loginUser(request.body, {
      ipAddress: request.ip,
    });

    AuthCookies.setRefreshTokenCookie(
      request.server,
      reply,
      result.refreshToken,
    );

    return successResponse('Login successful', {
      user: result.user,
      accessToken: result.accessToken,
    });
  };

  refresh = async (
    request: FastifyRequest<{ Body: RefreshBody }>,
    reply: FastifyReply,
  ) => {
    const refreshToken = AuthCookies.getRefreshTokenFromCookie(request);
    console.log({ refreshToken });
    if (!refreshToken) {
      AuthCookies.clearRefreshTokenCookie(request.server, reply);
      throw request.server.httpErrors.unauthorized(
        'Refresh token cookie is missing',
      );
    }

    const result = await this.service.refreshUserSession(
      refreshToken,
      request.body,
      { ipAddress: request.ip },
    );

    AuthCookies.setRefreshTokenCookie(
      request.server,
      reply,
      result.refreshToken,
    );

    return successResponse('Token refreshed successfully', {
      user: result.user,
      accessToken: result.accessToken,
    });
  };

  logout = async (request: FastifyRequest, reply: FastifyReply) => {
    const refreshToken = AuthCookies.getRefreshTokenFromCookie(request);
    const result = await this.service.logoutUserSession(refreshToken);

    AuthCookies.clearRefreshTokenCookie(request.server, reply);

    return successResponse('Logout successful', result);
  };

  me = async (request: FastifyRequest) => {
    const userId = request.authenticatedUserId;

    if (!userId) {
      throw request.server.httpErrors.unauthorized('Invalid token payload');
    }

    const result = await this.service.getCurrentUser(userId);
    return successResponse('Current user fetched successfully', result);
  };

  validateSetupToken = async (
    request: FastifyRequest<{ Body: ValidateSetupTokenBody }>,
  ) => {
    const result = await this.service.validateSetupToken(request.body.token);
    return successResponse('Setup token is valid', result);
  };

  setPassword = async (request: FastifyRequest<{ Body: SetPasswordBody }>) => {
    const result = await this.service.setPasswordFromInvite(
      request.body.token,
      request.body.password,
    );
    return successResponse('Password set successfully', result);
  };

  logoutAll = async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = request.authenticatedUserId;

    if (!userId) {
      throw request.server.httpErrors.unauthorized('Invalid token payload');
    }

    const result = await this.service.logoutAllUserSessions(userId);

    AuthCookies.clearRefreshTokenCookie(request.server, reply);

    return successResponse('Logged out from all sessions successfully', result);
  };
}
