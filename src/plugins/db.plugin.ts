import { PrismaClient } from '../generated/prisma/client.js';
import fp from 'fastify-plugin';
import { FastifyPluginAsync } from 'fastify';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';

const dbPlugin: FastifyPluginAsync = async (fastify) => {
  // 1. Create a native PostgreSQL Pool
  // This gives you direct control over PG17 connection limits and timeouts
  const pool = new pg.Pool({
    connectionString: fastify.config.DATABASE_URL,
    max: 20, // Adjust based on your DB tier (Production rule: cores * 2 + 1)
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000,
  });

  // 2. Initialize the Prisma Adapter with the pool
  const adapter = new PrismaPg(pool);

  // 3. Initialize Prisma Client
  const prisma = new PrismaClient({
    adapter,
    log:
      fastify.config.NODE_ENV === 'development'
        ? ['query', 'info', 'warn', 'error']
        : ['error'], // Reduced noise for production
  });

  try {
    // Verification: Ensure the DB is reachable before the app starts accepting traffic
    await prisma.$connect();
    await prisma.$queryRaw`SELECT 1`;
    fastify.log.info('PostgreSQL 17 connection established');
  } catch (error) {
    fastify.log.error(error, 'Failed to connect to PostgreSQL');
    await pool.end(); // Clean up pool if connection fails
    throw error;
  }

  // 4. Decorate the Fastify instance
  fastify.decorate('prisma', prisma);

  // 5. Graceful Shutdown
  fastify.addHook('onClose', async (instance) => {
    fastify.log.info('Closing PostgreSQL connection...');
    await instance.prisma.$disconnect();
    await pool.end();
    fastify.log.info('PostgreSQL connection closed');
  });
};

export default fp(dbPlugin, {
  name: 'prisma',
});

// TypeScript declaration to enable autocomplete throughout your app
declare module 'fastify' {
  interface FastifyInstance {
    prisma: PrismaClient;
  }
}
