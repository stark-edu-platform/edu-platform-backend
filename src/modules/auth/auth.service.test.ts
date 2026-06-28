import { beforeEach, describe, expect, it } from 'vitest';
import { asMock, makeFastifyStub } from '../../testing/fastify-stub.js';
import { getCurrentUser } from './auth.service.js';

describe('getCurrentUser', () => {
  let fastify: ReturnType<typeof makeFastifyStub>;

  beforeEach(() => {
    fastify = makeFastifyStub();
  });

  it('maps the user and flattens its school memberships', async () => {
    asMock(fastify.prisma.user.findUnique).mockResolvedValue({
      userId: 'user-1',
      name: 'Ada Lovelace',
      username: 'ada',
      email: 'ada@example.com',
      status: 'ACTIVE',
      systemRole: 'USER',
      userSchools: [
        {
          primaryRole: 'ADMIN',
          school: {
            schoolId: 'school-1',
            name: 'Springfield High',
            subdomain: 'springfield',
            status: 'ACTIVE',
          },
        },
      ],
    });

    const result = await getCurrentUser(fastify, 'user-1');

    expect(asMock(fastify.prisma.user.findUnique)).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 'user-1' } }),
    );
    expect(result.user).toMatchObject({
      userId: 'user-1',
      username: 'ada',
      email: 'ada@example.com',
      schools: [
        {
          schoolId: 'school-1',
          name: 'Springfield High',
          subdomain: 'springfield',
          status: 'ACTIVE',
          primaryRole: 'ADMIN',
        },
      ],
    });
  });

  it('throws a 404 when the user does not exist', async () => {
    asMock(fastify.prisma.user.findUnique).mockResolvedValue(null);

    await expect(getCurrentUser(fastify, 'missing')).rejects.toMatchObject({
      statusCode: 404,
    });
    expect(asMock(fastify.httpErrors.notFound)).toHaveBeenCalledWith(
      'User not found',
    );
  });
});
