import { FastifyReply, FastifyRequest } from 'fastify';
import { SystemRole, UserStatus } from '../generated/prisma/enums.js';

export async function requireDeveloper(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const userId = request.authenticatedUserId;
  if (!userId) {
    throw reply.unauthorized('Authentication is required');
  }

  const actor = await request.server.prisma.user.findUnique({
    where: { userId },
    select: {
      userId: true,
      status: true,
      systemRole: true,
    },
  });

  if (!actor || actor.status !== UserStatus.ACTIVE) {
    throw reply.forbidden('Only active developers can do this');
  }

  if (actor.systemRole !== SystemRole.DEVELOPER) {
    throw reply.forbidden('Developer access is required');
  }
}
