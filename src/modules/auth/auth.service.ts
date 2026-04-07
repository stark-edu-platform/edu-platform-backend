import { FastifyInstance } from 'fastify';
import { UserStatus } from '../../generated/prisma/enums.js';
import {
  createRefreshTokenRecord,
  findActiveRefreshToken,
  findValidPasswordSetupToken,
  revokeAllUserRefreshTokens,
  revokeRefreshToken,
} from './token.service.js';
import {
  AuthResponse,
  AuthUser,
  LoginBody,
  LogoutBody,
  RefreshTokenBody,
} from './auth.types.js';
import {
  hashPassword,
  isEmail,
  isValidPassword,
  normalizeLoginId,
  verifyPassword,
} from './auth.utils.js';

function toAuthUser(user: AuthUser) {
  return {
    userId: user.userId,
    name: user.name,
    username: user.username,
    email: user.email,
    status: user.status,
    systemRole: user.systemRole,
    schools: user.schools,
  };
}

function getAccessTokenExpiry(minutes: number) {
  return `${minutes}m`;
}

async function buildAuthTokens(
  fastify: FastifyInstance,
  user: AuthUser,
  input?: {
    deviceInfo?: string;
    ipAddress?: string;
  },
): Promise<AuthResponse> {
  const accessToken = await fastify.jwt.sign(
    {
      sub: user.userId,
      username: user.username,
    },
    {
      expiresIn: getAccessTokenExpiry(fastify.config.ACCESS_TOKEN_TTL_MINUTES),
    },
  );

  const { refreshToken } = await createRefreshTokenRecord(fastify.prisma, {
    userId: user.userId,
    ttlDays: fastify.config.REFRESH_TOKEN_TTL_DAYS,
    deviceInfo: input?.deviceInfo,
    ipAddress: input?.ipAddress,
  });

  return {
    user: toAuthUser(user),
    accessToken,
    refreshToken,
  };
}

export async function loginUser(
  fastify: FastifyInstance,
  input: LoginBody,
  context?: {
    ipAddress?: string;
  },
): Promise<AuthResponse> {
  const loginId = normalizeLoginId(input.loginId);

  const user = await fastify.prisma.user.findFirst({
    where: isEmail(loginId) ? { email: loginId } : { username: loginId },
    select: {
      userId: true,
      name: true,
      username: true,
      email: true,
      status: true,
      systemRole: true,
      passwordHash: true,
    },
  });

  if (!user) {
    throw fastify.httpErrors.unauthorized('Invalid login ID or password');
  }

  const passwordMatches = await verifyPassword(
    input.password,
    user.passwordHash,
  );
  if (!passwordMatches) {
    throw fastify.httpErrors.unauthorized('Invalid login ID or password');
  }

  if (user.status !== UserStatus.ACTIVE) {
    throw fastify.httpErrors.forbidden(
      'Account is not active. Please finish password setup first.',
    );
  }

  return buildAuthTokens(fastify, user, {
    deviceInfo: input.deviceInfo,
    ipAddress: context?.ipAddress,
  });
}

export async function getCurrentUser(fastify: FastifyInstance, userId: string) {
  const user = await fastify.prisma.user.findUnique({
    where: { userId },
    select: {
      userId: true,
      name: true,
      username: true,
      email: true,
      status: true,
      systemRole: true,
      userSchools: {
        select: {
          primaryRole: true,
          school: {
            select: {
              schoolId: true,
              name: true,
              subdomain: true,
              status: true,
            },
          },
        },
      },
    },
  });

  if (!user) {
    throw fastify.httpErrors.notFound('User not found');
  }

  return {
    user: toAuthUser({
      ...user,
      schools: user.userSchools.map((userSchool) => ({
        schoolId: userSchool.school.schoolId,
        name: userSchool.school.name,
        subdomain: userSchool.school.subdomain,
        status: userSchool.school.status,
        primaryRole: userSchool.primaryRole,
      })),
    }),
  };
}

export async function validateSetupToken(
  fastify: FastifyInstance,
  token: string,
) {
  const verification = await findValidPasswordSetupToken(fastify.prisma, token);
  if (!verification) {
    throw fastify.httpErrors.badRequest('Invalid or expired setup token');
  }

  return {
    valid: true,
    email: verification.user.email,
    expiresAt: verification.expiresAt.toISOString(),
  };
}

export async function refreshUserSession(
  fastify: FastifyInstance,
  input: RefreshTokenBody,
  context?: {
    ipAddress?: string;
  },
): Promise<AuthResponse> {
  const refreshTokenRecord = await findActiveRefreshToken(
    fastify.prisma,
    input.refreshToken,
  );

  if (!refreshTokenRecord) {
    throw fastify.httpErrors.unauthorized('Invalid or expired refresh token');
  }

  if (refreshTokenRecord.user.status !== UserStatus.ACTIVE) {
    throw fastify.httpErrors.forbidden('User account is not active');
  }

  const rotatedSession = await fastify.prisma.$transaction(async (tx) => {
    const revoked = await tx.refreshToken.updateMany({
      where: {
        id: refreshTokenRecord.id,
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
      data: {
        revokedAt: new Date(),
      },
    });

    if (revoked.count !== 1) {
      throw fastify.httpErrors.unauthorized('Invalid or expired refresh token');
    }

    const nextRefreshToken = await createRefreshTokenRecord(tx, {
      userId: refreshTokenRecord.user.userId,
      ttlDays: fastify.config.REFRESH_TOKEN_TTL_DAYS,
      deviceInfo:
        input.deviceInfo ?? refreshTokenRecord.deviceInfo ?? undefined,
      ipAddress:
        context?.ipAddress ?? refreshTokenRecord.ipAddress ?? undefined,
    });

    return nextRefreshToken;
  });

  const accessToken = await fastify.jwt.sign(
    {
      sub: refreshTokenRecord.user.userId,
      username: refreshTokenRecord.user.username,
    },
    {
      expiresIn: getAccessTokenExpiry(fastify.config.ACCESS_TOKEN_TTL_MINUTES),
    },
  );

  return {
    user: toAuthUser(refreshTokenRecord.user),
    accessToken,
    refreshToken: rotatedSession.refreshToken,
  };
}

export async function logoutUserSession(
  fastify: FastifyInstance,
  input: LogoutBody,
) {
  const revoked = await revokeRefreshToken(fastify.prisma, input.refreshToken);

  if (revoked.count !== 1) {
    throw fastify.httpErrors.unauthorized('Invalid or expired refresh token');
  }

  return {
    result: 'Logged out successfully.',
  };
}

export async function logoutAllUserSessions(
  fastify: FastifyInstance,
  userId: string,
) {
  await revokeAllUserRefreshTokens(fastify.prisma, userId);

  return {
    result: 'Logged out from all sessions successfully.',
  };
}

export async function setPasswordFromInvite(
  fastify: FastifyInstance,
  token: string,
  password: string,
) {
  if (!isValidPassword(password)) {
    throw fastify.httpErrors.badRequest(
      'Password must be at least 8 characters long',
    );
  }

  const verification = await findValidPasswordSetupToken(fastify.prisma, token);
  if (!verification) {
    throw fastify.httpErrors.badRequest('Invalid or expired setup token');
  }

  const passwordHash = await hashPassword(password);

  await fastify.prisma.$transaction([
    fastify.prisma.user.update({
      where: { userId: verification.userId },
      data: {
        passwordHash,
        status: UserStatus.ACTIVE,
        isEmailVerified: true,
      },
    }),
    fastify.prisma.verification.update({
      where: { id: verification.id },
      data: {
        verifiedAt: new Date(),
      },
    }),
  ]);

  return {
    result: 'Account is now active.',
  };
}
