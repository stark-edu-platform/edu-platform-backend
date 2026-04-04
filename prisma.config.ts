import { defineConfig } from 'prisma/config';
import { readSharedEnv } from './src/config/shared-env.js';

const env = readSharedEnv();

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: env.DATABASE_URL,
  },
});
