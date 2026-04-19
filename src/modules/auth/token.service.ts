import { Prisma, PrismaClient } from '../../generated/prisma/client.js';
import { VerificationType } from '../../generated/prisma/enums.js';
import {
  buildPasswordSetupUrl,
  createRawToken,
  hashToken,
} from './auth.utils.js';

type DbClient = PrismaClient | Prisma.TransactionClient;

export class TokenService {
  static async createPasswordSetupInvite(
    prisma: DbClient,
    userId: string,
    baseUrl: string,
    ttlMinutes: number,
  ) {
    const rawToken = createRawToken();
    const tokenHash = hashToken(rawToken);
    const expiresAt = new Date(Date.now() + ttlMinutes * 60 * 1000);

    await prisma.verification.updateMany({
      where: {
        userId,
        type: VerificationType.PASSWORD_RESET,
        verifiedAt: null,
      },
      data: {
        verifiedAt: new Date(),
      },
    });

    await prisma.verification.create({
      data: {
        userId,
        type: VerificationType.PASSWORD_RESET,
        otpHash: tokenHash,
        expiresAt,
      },
    });

    return {
      token: rawToken,
      expiresAt,
      setupUrl: buildPasswordSetupUrl(baseUrl, rawToken),
    };
  }

  static async findValidPasswordSetupToken(prisma: DbClient, rawToken: string) {
    const tokenHash = hashToken(rawToken);

    return prisma.verification.findFirst({
      where: {
        type: VerificationType.PASSWORD_RESET,
        otpHash: tokenHash,
        verifiedAt: null,
        expiresAt: { gt: new Date() },
      },
      include: {
        user: {
          select: {
            userId: true,
            email: true,
            username: true,
            status: true,
            systemRole: true,
          },
        },
      },
    });
  }

  static async createRefreshTokenRecord(
    prisma: DbClient,
    input: {
      userId: string;
      ttlDays: number;
      deviceInfo?: string;
      ipAddress?: string;
    },
  ) {
    const refreshToken = createRawToken();
    // const tokenHash = hashToken(refreshToken);
    const expiresAt = new Date(
      Date.now() + input.ttlDays * 24 * 60 * 60 * 1000,
    );

    await prisma.refreshToken.create({
      data: {
        userId: input.userId,
        tokenHash: refreshToken,
        expiresAt,
        deviceInfo: input.deviceInfo,
        ipAddress: input.ipAddress,
      },
    });

    return {
      refreshToken,
      expiresAt,
    };
  }

  static async findActiveRefreshToken(prisma: DbClient, refreshToken: string) {
    return await prisma.refreshToken.findFirst({
      where: {
        tokenHash: refreshToken,
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
      include: {
        user: {
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
        },
      },
    });
  }

  static async revokeRefreshToken(prisma: DbClient, refreshToken: string) {
    const tokenHash = hashToken(refreshToken);

    return prisma.refreshToken.updateMany({
      where: {
        tokenHash,
        revokedAt: null,
      },
      data: {
        revokedAt: new Date(),
      },
    });
  }

  static async revokeAllUserRefreshTokens(prisma: DbClient, userId: string) {
    return prisma.refreshToken.updateMany({
      where: {
        userId,
        revokedAt: null,
      },
      data: {
        revokedAt: new Date(),
      },
    });
  }
}
