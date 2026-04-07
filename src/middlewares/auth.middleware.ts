import { FastifyReply, FastifyRequest } from 'fastify';

type JwtUserPayload = {
  sub?: string;
  username?: string;
};

export async function requireAuth(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  try {
    await request.jwtVerify<JwtUserPayload>();
  } catch {
    throw reply.unauthorized('Invalid or expired token');
  }

  const payload = request.user as JwtUserPayload | undefined;
  const userId = payload?.sub;
  if (!userId) {
    throw reply.unauthorized('Invalid token payload');
  }

  request.userId = userId;
}
