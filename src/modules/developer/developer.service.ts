import crypto from 'node:crypto';
import { FastifyInstance } from 'fastify';
import { Prisma, PrismaClient } from '../../generated/prisma/client.js';
import {
  SchoolRole,
  SchoolStatus,
  SystemRole,
  UserStatus,
} from '../../generated/prisma/enums.js';
import { emailTemplateService } from '../email/email-template.service.js';
import { createPasswordSetupInvite } from '../auth/token.service.js';
import {
  buildUsernameFromEmail,
  hashPassword,
  isEmail,
  normalizeEmail,
} from '../auth/auth.utils.js';
import {
  CreateSchoolWithAdminBody,
  DeveloperSchoolListItem,
} from './developer.types.js';

type DbClient = PrismaClient | Prisma.TransactionClient;

async function generateUniqueUsername(prisma: DbClient, email: string) {
  const base = buildUsernameFromEmail(email);
  let candidate = base;
  let attempt = 1;

  while (true) {
    const existingUser = await prisma.user.findUnique({
      where: { username: candidate },
      select: { userId: true },
    });

    if (!existingUser) {
      return candidate;
    }

    const suffix = `.${attempt}`;
    candidate = `${base.slice(0, Math.max(1, 30 - suffix.length))}${suffix}`;
    attempt += 1;
  }
}

function normalizeSubdomain(value: string) {
  return value.trim().toLowerCase();
}

export async function createSchoolWithAdmin(
  fastify: FastifyInstance,
  input: CreateSchoolWithAdminBody,
) {
  const adminEmail = normalizeEmail(input.adminEmail);
  if (!isEmail(adminEmail)) {
    throw fastify.httpErrors.badRequest('Invalid admin email address');
  }

  const normalizedSchoolEmail = input.schoolEmail
    ? normalizeEmail(input.schoolEmail)
    : undefined;

  const subdomain = normalizeSubdomain(input.subdomain);
  if (!/^[a-z0-9-]+$/.test(subdomain)) {
    throw fastify.httpErrors.badRequest(
      'Subdomain can contain only lowercase letters, numbers, and hyphens',
    );
  }

  const passwordSetupUrlBase = `${fastify.config?.BASE_URL ?? 'http://localhost:3000'}/set-password`;

  const result = await fastify.prisma.$transaction(async (tx) => {
    const existingUser = await tx.user.findFirst({
      where: { email: adminEmail },
      select: { userId: true },
    });

    if (existingUser) {
      throw fastify.httpErrors.conflict(
        'A user with this admin email already exists',
      );
    }

    const username = await generateUniqueUsername(tx, adminEmail);
    const placeholderPasswordHash = await hashPassword(
      `invite-${crypto.randomUUID()}`,
    );

    const school = await tx.school.create({
      data: {
        name: input.schoolName.trim(),
        subdomain,
        board: input.board?.trim() || undefined,
        address: input.address?.trim() || undefined,
        phone: input.schoolPhone?.trim() || undefined,
        email: normalizedSchoolEmail,
        status: SchoolStatus.INVITED,
      },
    });

    const adminUser = await tx.user.create({
      data: {
        name: input.adminName.trim(),
        username,
        email: adminEmail,
        phone: input.adminPhone?.trim() || undefined,
        passwordHash: placeholderPasswordHash,
        status: UserStatus.INACTIVE,
        systemRole: SystemRole.USER,
        isEmailVerified: false,
      },
    });

    const userSchool = await tx.userSchool.create({
      data: {
        userId: adminUser.userId,
        schoolId: school.schoolId,
        primaryRole: SchoolRole.ADMIN,
        isActive: true,
      },
    });

    await tx.adminProfile.create({
      data: {
        schoolId: school.schoolId,
        userSchoolId: userSchool.userSchoolId,
        designation: input.adminDesignation?.trim() || undefined,
      },
    });

    const invite = await createPasswordSetupInvite(
      tx,
      adminUser.userId,
      passwordSetupUrlBase,
      fastify.config.PASSWORD_SETUP_TOKEN_TTL_MINUTES,
    );

    return {
      school,
      adminUser,
      invite,
    };
  });

  await emailTemplateService.sendTemplate({
    to: adminEmail,
    template: 'schoolAdminInvite',
    data: {
      schoolName: result.school.name,
      setupUrl: result.invite.setupUrl,
    },
  });

  return {
    school: {
      schoolId: result.school.schoolId,
      name: result.school.name,
      subdomain: result.school.subdomain,
      status: result.school.status,
    },
    admin: {
      userId: result.adminUser.userId,
      name: result.adminUser.name,
      username: result.adminUser.username,
      email: result.adminUser.email,
      status: result.adminUser.status,
      systemRole: result.adminUser.systemRole,
    },
    setup: {
      expiresAt: result.invite.expiresAt.toISOString(),
    },
  };
}

export async function listSchools(
  fastify: FastifyInstance,
): Promise<{ schools: DeveloperSchoolListItem[] }> {
  const schools = await fastify.prisma.school.findMany({
    orderBy: {
      createdAt: 'desc',
    },
    select: {
      schoolId: true,
      name: true,
      subdomain: true,
      board: true,
      email: true,
      phone: true,
      status: true,
      createdAt: true,
      userSchools: {
        where: {
          primaryRole: SchoolRole.ADMIN,
        },
        take: 1,
        select: {
          user: {
            select: {
              userId: true,
              name: true,
              email: true,
              status: true,
            },
          },
        },
      },
    },
  });

  return {
    schools: schools.map((school) => ({
      schoolId: school.schoolId,
      name: school.name,
      subdomain: school.subdomain,
      board: school.board,
      email: school.email,
      phone: school.phone,
      status: school.status,
      createdAt: school.createdAt.toISOString(),
      admin: school.userSchools[0]
        ? {
            userId: school.userSchools[0].user.userId,
            name: school.userSchools[0].user.name,
            email: school.userSchools[0].user.email,
            status: school.userSchools[0].user.status,
          }
        : null,
    })),
  };
}
