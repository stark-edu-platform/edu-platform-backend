import { FastifyRequest } from 'fastify';
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
  LogoutBody,
  RefreshTokenBody,
  SetPasswordBody,
  ValidateSetupTokenBody,
} from './auth.types.js';
import { successResponse } from '../../utils/api-response.js';

export async function loginController(
  request: FastifyRequest<{ Body: LoginBody }>,
) {
  const result = await loginUser(request.server, request.body, {
    ipAddress: request.ip,
  });
  return successResponse('Login successful', result);
}

export async function refreshController(
  request: FastifyRequest<{ Body: RefreshTokenBody }>,
) {
  const result = await refreshUserSession(request.server, request.body, {
    ipAddress: request.ip,
  });
  return successResponse('Token refreshed successfully', result);
}

export async function logoutController(
  request: FastifyRequest<{ Body: LogoutBody }>,
) {
  const result = await logoutUserSession(request.server, request.body);
  return successResponse('Logout successful', result);
}

export async function meController(request: FastifyRequest) {
  const userId = (request.user as { sub?: string }).sub;
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

export async function logoutAllController(request: FastifyRequest) {
  const userId = (request.user as { sub?: string }).sub;
  if (!userId) {
    throw request.server.httpErrors.unauthorized('Invalid token payload');
  }

  const result = await logoutAllUserSessions(request.server, userId);
  return successResponse('Logged out from all sessions successfully', result);
}
