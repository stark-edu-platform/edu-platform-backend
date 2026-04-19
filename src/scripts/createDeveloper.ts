import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import { PrismaClient } from '../generated/prisma/client.js';
import { SystemRole, UserStatus } from '../generated/prisma/enums.js';
import { readSharedEnv } from '../config/shared-env.js';
import { emailTemplateService } from '../modules/email/email-template.service.js';
import { TokenService } from '../modules/auth/token.service.js';
import {
  buildUsernameFromEmail,
  hashPassword,
  isEmail,
  normalizeEmail,
} from '../modules/auth/auth.utils.js';

async function generateUniqueUsername(prisma: PrismaClient, email: string) {
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

async function askToSendInviteAgain(
  rl: ReturnType<typeof createInterface>,
  email: string,
) {
  const answer = await rl.question(
    `An inactive developer account already exists for ${email}. Send setup email again? (y/N): `,
  );

  return ['y', 'yes'].includes(answer.trim().toLowerCase());
}

async function main() {
  const env = readSharedEnv();
  const rl = createInterface({ input, output });

  try {
    const emailInput = await rl.question('Enter developer email: ');
    const email = normalizeEmail(emailInput);

    if (!isEmail(email)) {
      throw new Error('Invalid email address.');
    }

    if (!env.BREVO_API_KEY || !env.SENDER_EMAIL) {
      throw new Error(
        'BREVO_API_KEY and SENDER_EMAIL must be configured before creating a developer invite.',
      );
    }

    const passwordSetupUrlBase = `${env.BASE_URL ?? 'http://localhost:3000'}/set-password`;

    const pool = new pg.Pool({
      connectionString: env.DATABASE_URL,
    });
    const adapter = new PrismaPg(pool);
    const prisma = new PrismaClient({ adapter });

    try {
      await prisma.$connect();

      const existingUser = await prisma.user.findFirst({
        where: { email },
        select: {
          userId: true,
          email: true,
          username: true,
          status: true,
        },
      });

      if (existingUser) {
        if (existingUser.status !== UserStatus.INACTIVE) {
          throw new Error('A user with this email already exists.');
        }

        const shouldResend = await askToSendInviteAgain(rl, email);
        if (!shouldResend) {
          output.write('Setup email cancelled.\n');
          return;
        }

        const invite = await TokenService.createPasswordSetupInvite(
          prisma,
          existingUser.userId,
          passwordSetupUrlBase,
          env.PASSWORD_SETUP_TOKEN_TTL_MINUTES,
        );

        await emailTemplateService.sendTemplate({
          to: email,
          template: 'setPassword',
          data: { setupUrl: invite.setupUrl },
        });

        output.write(`Developer invite resent for ${email}\n`);
        output.write(`Username reserved: ${existingUser.username}\n`);
        output.write(
          `Setup link expires at: ${invite.expiresAt.toISOString()}\n`,
        );
        return;
      }

      const username = await generateUniqueUsername(prisma, email);
      const placeholderPasswordHash = await hashPassword(
        `invite-${crypto.randomUUID()}`,
      );

      const user = await prisma.user.create({
        data: {
          email,
          username,
          passwordHash: placeholderPasswordHash,
          status: UserStatus.INACTIVE,
          systemRole: SystemRole.DEVELOPER,
          isEmailVerified: false,
        },
        select: {
          userId: true,
          email: true,
          username: true,
        },
      });

      const invite = await TokenService.createPasswordSetupInvite(
        prisma,
        user.userId,
        passwordSetupUrlBase,
        env.PASSWORD_SETUP_TOKEN_TTL_MINUTES,
      );

      await emailTemplateService.sendTemplate({
        to: email,
        template: 'setPassword',
        data: { setupUrl: invite.setupUrl },
      });

      output.write(`Developer invite created for ${email}\n`);
      output.write(`Username reserved: ${user.username}\n`);
      output.write(
        `Setup link expires at: ${invite.expiresAt.toISOString()}\n`,
      );
    } finally {
      await prisma.$disconnect();
      await pool.end();
    }
  } finally {
    rl.close();
  }
}

void main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
