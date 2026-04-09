import { FastifyReply, FastifyRequest } from 'fastify';
import {
  clearRefreshTokenCookie,
  getRefreshTokenFromCookie,
  setRefreshTokenCookie,
} from './auth.cookies.js';
import {
  getCurrentUser,
  loginUser,
  logoutAllUserSessions,
  logoutUserSession,
  refreshUserSession,
  setPasswordFromInvite,
  validateSetupToken,
} from './auth.service.js';
import {
  LoginBody,
  RefreshBody,
  SetPasswordBody,
  ValidateSetupTokenBody,
} from './auth.types.js';
import { successResponse } from '../../utils/api-response.js';

export async function loginController(
  request: FastifyRequest<{ Body: LoginBody }>,
  reply: FastifyReply,
) {
  const result = await loginUser(request.server, request.body, {
    ipAddress: request.ip,
  });
  setRefreshTokenCookie(request.server, reply, result.refreshToken);
  return successResponse('Login successful', {
    session: {
      user: result.user,
      primaryRole: 'ADMIN',
      secondaryRoles: [],
      roleAssignments: [],
    },
    accessToken: result.accessToken,
  });
}

export async function refreshController(
  request: FastifyRequest<{ Body: RefreshBody }>,
  reply: FastifyReply,
) {
  const refreshToken = getRefreshTokenFromCookie(request);
  if (!refreshToken) {
    clearRefreshTokenCookie(request.server, reply);
    throw request.server.httpErrors.unauthorized(
      'Refresh token cookie is missing',
    );
  }

  const result = await refreshUserSession(
    request.server,
    refreshToken,
    request.body,
    {
      ipAddress: request.ip,
    },
  );
  setRefreshTokenCookie(request.server, reply, result.refreshToken);
  return successResponse('Token refreshed successfully', {
    user: result.user,
    accessToken: result.accessToken,
  });
}

export async function logoutController(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const refreshToken = getRefreshTokenFromCookie(request);
  const result = await logoutUserSession(request.server, refreshToken);
  clearRefreshTokenCookie(request.server, reply);
  return successResponse('Logout successful', result);
}

export async function meController(request: FastifyRequest) {
  const userId = request.authenticatedUserId;
  if (!userId) {
    throw request.server.httpErrors.unauthorized('Invalid token payload');
  }

  const result = await getCurrentUser(request.server, userId);
  return successResponse('Current user fetched successfully', result);
}

export async function validateSetupTokenController(
  request: FastifyRequest<{ Body: ValidateSetupTokenBody }>,
) {
  const result = await validateSetupToken(request.server, request.body.token);
  return successResponse('Setup token is valid', result);
}

export async function setPasswordController(
  request: FastifyRequest<{ Body: SetPasswordBody }>,
) {
  const result = await setPasswordFromInvite(
    request.server,
    request.body.token,
    request.body.password,
  );
  return successResponse('Password set successfully', result);
}

export async function logoutAllController(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const userId = request.authenticatedUserId;
  if (!userId) {
    throw request.server.httpErrors.unauthorized('Invalid token payload');
  }

  const result = await logoutAllUserSessions(request.server, userId);
  clearRefreshTokenCookie(request.server, reply);
  return successResponse('Logged out from all sessions successfully', result);
}
