import { FastifyInstance } from 'fastify';
import {
  SchoolRole,
  SchoolStatus,
  UserStatus,
} from '../../generated/prisma/enums.js';
import { TokenService } from './token.service.js';
import {
  AuthSessionResult,
  AuthUser,
  AuthUserSchool,
  LoginBody,
  RefreshBody,
} from './auth.types.js';
import {
  hashPassword,
  isEmail,
  isValidPassword,
  normalizeLoginId,
  verifyPassword,
} from './auth.utils.js';

export class AuthService {
  constructor(private readonly fastify: FastifyInstance) {}

  private toAuthUser(user: AuthUser) {
    return {
      userId: user.userId,
      name: user.name,
      username: user.username,
      email: user.email,
      status: user.status,
      systemRole: user.systemRole,
      schools: user.schools ?? [],
    };
  }

  private accessTokenExpiry(minutes: number): string {
    return `${minutes}m`;
  }

  private mapSchools(
    userSchools: Array<{
      primaryRole: string;
      school: {
        schoolId: string;
        name: string;
        subdomain: string;
        status: string;
      };
    }>,
  ): AuthUserSchool[] {
    return userSchools.map((us) => ({
      schoolId: us.school.schoolId,
      name: us.school.name,
      subdomain: us.school.subdomain,
      status: us.school.status,
      primaryRole: us.primaryRole,
    }));
  }

  /*
   * Access token, used for refresh or login
   */
  private async buildAuthTokens(
    user: AuthUser,
    input?: { deviceInfo?: string; ipAddress?: string },
  ): Promise<AuthSessionResult> {
    const { fastify } = this;

    const accessToken = await fastify.jwt.sign(
      { sub: user.userId, username: user.username },
      {
        expiresIn: this.accessTokenExpiry(
          fastify.config.ACCESS_TOKEN_TTL_MINUTES,
        ),
      },
    );

    const { refreshToken } = await TokenService.createRefreshTokenRecord(
      fastify.prisma,
      {
        userId: user.userId,
        ttlDays: fastify.config.REFRESH_TOKEN_TTL_DAYS,
        deviceInfo: input?.deviceInfo,
        ipAddress: input?.ipAddress,
      },
    );

    return {
      user: this.toAuthUser(user),
      accessToken,
      refreshToken,
    };
  }

  // ── Public Methods ───────────────────────────────────────────────────────────

  async loginUser(
    input: LoginBody,
    context?: { ipAddress?: string },
  ): Promise<AuthSessionResult> {
    const { fastify } = this;
    const loginId = normalizeLoginId(input.loginId); //Either email or username

    //checking used exist in db or not
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

    //if exist then verify password by matching with db password
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

    return this.buildAuthTokens(
      { ...user },
      { deviceInfo: input.deviceInfo, ipAddress: context?.ipAddress },
    );
  }

  async getCurrentUser(userId: string) {
    const { fastify } = this;

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
          where: { isActive: true },
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
      user: this.toAuthUser({
        ...user,
        schools: this.mapSchools(user.userSchools),
      }),
    };
  }

  //when user come to set password
  async validateSetupToken(token: string) {
    const { fastify } = this;

    const verification = await TokenService.findValidPasswordSetupToken(
      fastify.prisma,
      token,
    );
    if (!verification) {
      throw fastify.httpErrors.badRequest('Invalid or expired setup token');
    }

    return {
      valid: true,
      email: verification.user.email,
      expiresAt: verification.expiresAt.toISOString(),
    };
  }

  //when user refresh token
  async refreshUserSession(
    refreshToken: string,
    input: RefreshBody | undefined,
    context?: { ipAddress?: string },
  ): Promise<AuthSessionResult> {
    const { fastify } = this;

    const record = await TokenService.findActiveRefreshToken(
      fastify.prisma,
      refreshToken,
    );
    if (!record) {
      throw fastify.httpErrors.unauthorized('Invalid or expired refresh token');
    }

    if (record.user.status !== UserStatus.ACTIVE) {
      throw fastify.httpErrors.forbidden('User account is not active');
    }

    const rotated = await fastify.prisma.$transaction(async (tx) => {
      // token from succeeding — only the first update will match `revokedAt: null`.
      const revoked = await tx.refreshToken.updateMany({
        where: {
          id: record.id,
          revokedAt: null,
          expiresAt: { gt: new Date() },
        },
        data: { revokedAt: new Date() },
      });

      if (revoked.count !== 1) {
        throw fastify.httpErrors.unauthorized(
          'Invalid or expired refresh token',
        );
      }

      return TokenService.createRefreshTokenRecord(tx, {
        userId: record.user.userId,
        ttlDays: fastify.config.REFRESH_TOKEN_TTL_DAYS,
        deviceInfo: input?.deviceInfo ?? record.deviceInfo ?? undefined,
        ipAddress: context?.ipAddress ?? record.ipAddress ?? undefined,
      });
    });

    const accessToken = await fastify.jwt.sign(
      { sub: record.user.userId, username: record.user.username },
      {
        expiresIn: this.accessTokenExpiry(
          fastify.config.ACCESS_TOKEN_TTL_MINUTES,
        ),
      },
    );

    return {
      user: this.toAuthUser({
        ...record.user,
        schools: this.mapSchools(record.user.userSchools ?? []),
      }),
      accessToken,
      refreshToken: rotated.refreshToken,
    };
  }

  async logoutUserSession(refreshToken?: string) {
    if (refreshToken) {
      await TokenService.revokeRefreshToken(this.fastify.prisma, refreshToken);
    }
    return { result: 'Logged out successfully.' };
  }

  async logoutAllUserSessions(userId: string) {
    await TokenService.revokeAllUserRefreshTokens(this.fastify.prisma, userId);
    return { result: 'Logged out from all sessions successfully.' };
  }

  // Activating user and setting up login password
  async setPasswordFromInvite(token: string, password: string) {
    const { fastify } = this;

    if (!isValidPassword(password)) {
      throw fastify.httpErrors.badRequest(
        'Password must be at least 8 characters long',
      );
    }

    const verification = await TokenService.findValidPasswordSetupToken(
      fastify.prisma,
      token,
    );
    if (!verification) {
      throw fastify.httpErrors.badRequest('Invalid or expired setup token');
    }

    const passwordHash = await hashPassword(password);

    await fastify.prisma.$transaction([
      // 1. Activate the user and store the hashed password.
      fastify.prisma.user.update({
        where: { userId: verification.userId },
        data: {
          passwordHash,
          status: UserStatus.ACTIVE,
          isEmailVerified: true,
        },
      }),
      // 2. Consume the invite token to prevent reuse.
      fastify.prisma.verification.update({
        where: { id: verification.id },
        data: { verifiedAt: new Date() },
      }),
      // 3. Activate schools that were waiting for this admin's acceptance.
      fastify.prisma.school.updateMany({
        where: {
          status: SchoolStatus.INVITED,
          userSchools: {
            some: {
              userId: verification.userId,
              primaryRole: SchoolRole.ADMIN,
            },
          },
        },
        data: { status: SchoolStatus.ACTIVE },
      }),
    ]);

    return { result: 'Account is now active.' };
  }
}
