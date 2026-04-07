import { FastifyPluginAsync } from 'fastify';
import {
  createSchoolWithAdminController,
  listSchoolsController,
} from './developer.controller.js';
import {
  createSchoolWithAdminRouteSchema,
  listSchoolsRouteSchema,
} from './developer.schema.js';
import { CreateSchoolWithAdminBody } from './developer.types.js';

export const developerRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get(
    '/schools',
    { schema: listSchoolsRouteSchema },
    listSchoolsController,
  );

  fastify.post<{ Body: CreateSchoolWithAdminBody }>(
    '/schools',
    { schema: createSchoolWithAdminRouteSchema },
    async (request, reply) => {
      const result = await createSchoolWithAdminController(request);
      void reply.status(201);
      return result;
    },
  );
};
