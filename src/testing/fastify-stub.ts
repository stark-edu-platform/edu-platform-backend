import type { FastifyInstance } from 'fastify';
import { vi, type Mock } from 'vitest';
import type { AppConfig } from '../config/env.js';
import type { PrismaClient } from '../generated/prisma/client.js';

/**
 * Unit-test stub for the Fastify instance that services receive as their first
 * argument. Every `prisma` model method is an auto-created `vi.fn()`, so service
 * logic can be tested without a database:
 *
 *   const fastify = makeFastifyStub();
 *   asMock(fastify.prisma.user.findUnique).mockResolvedValue(row);
 *   const result = await getCurrentUser(fastify, 'user-1');
 *   expect(asMock(fastify.prisma.user.findUnique)).toHaveBeenCalled();
 *
 * See `PRP/Tests/README.md` for the full pattern.
 */

type StubFn = ReturnType<typeof vi.fn>;

const DEFAULT_CONFIG: AppConfig = {
  NODE_ENV: 'test',
  PORT: 3000,
  HOST: '0.0.0.0',
  BASE_URL: 'http://localhost:3000',
  ALLOWED_ORIGINS: '*',
  DATABASE_URL: 'postgresql://localhost:5432/test',
  JWT_SECRET: 'test-secret',
  PASSWORD_SETUP_TOKEN_TTL_MINUTES: 1440,
  ACCESS_TOKEN_TTL_MINUTES: 15,
  REFRESH_TOKEN_TTL_DAYS: 30,
};

// A Proxy whose every property access yields a memoized `vi.fn()`. One bag backs
// each Prisma model delegate, so `prisma.user.findUnique`, `prisma.school.update`
// etc. all resolve to mockable functions without enumerating the schema.
function createMethodBag() {
  const methods = new Map<string, StubFn>();
  return new Proxy({} as Record<string, StubFn>, {
    get(_target, property) {
      if (typeof property !== 'string' || property === 'then') {
        return undefined;
      }
      let method = methods.get(property);
      if (!method) {
        method = vi.fn();
        methods.set(property, method);
      }
      return method;
    },
  });
}

// Mirrors the PrismaClient surface: model delegates (`user`, `school`, ...) are
// method bags; top-level client methods (`$transaction`, `$queryRaw`, ...) are
// single `vi.fn()`s.
function createPrismaStub(): PrismaClient {
  const members = new Map<string, unknown>();
  return new Proxy(
    {},
    {
      get(_target, property) {
        if (typeof property !== 'string' || property === 'then') {
          return undefined;
        }
        let member = members.get(property);
        if (!member) {
          member = property.startsWith('$') ? vi.fn() : createMethodBag();
          members.set(property, member);
        }
        return member;
      },
    },
  ) as unknown as PrismaClient;
}

function createHttpError(statusCode: number, fallbackMessage: string) {
  return vi.fn((message?: string) => {
    const error = new Error(message ?? fallbackMessage) as Error & {
      statusCode: number;
    };
    error.statusCode = statusCode;
    return error;
  });
}

// Mirror the subset of `@fastify/sensible`'s `httpErrors` that services throw.
// Each returns an `Error` carrying `statusCode`, so tests can assert on both the
// thrown shape and the message the service passed.
function createHttpErrorsStub() {
  return {
    badRequest: createHttpError(400, 'Bad Request'),
    unauthorized: createHttpError(401, 'Unauthorized'),
    forbidden: createHttpError(403, 'Forbidden'),
    notFound: createHttpError(404, 'Not Found'),
    conflict: createHttpError(409, 'Conflict'),
    internalServerError: createHttpError(500, 'Internal Server Error'),
  };
}

export type FastifyStubOverrides = {
  config?: Partial<AppConfig>;
};

export function makeFastifyStub(
  overrides: FastifyStubOverrides = {},
): FastifyInstance {
  const stub = {
    config: { ...DEFAULT_CONFIG, ...overrides.config },
    prisma: createPrismaStub(),
    httpErrors: createHttpErrorsStub(),
    jwt: {
      sign: vi.fn(),
      verify: vi.fn(),
    },
  };

  return stub as unknown as FastifyInstance;
}

/** Narrow a stubbed function to a Vitest `Mock` for its `.mock*` helpers. */
export function asMock(fn: unknown): Mock {
  return fn as Mock;
}
