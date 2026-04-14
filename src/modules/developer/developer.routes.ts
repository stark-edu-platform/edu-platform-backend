import { FastifyPluginAsync } from 'fastify';
import {
  createSchoolWithAdminRouteSchema,
  listSchoolsRouteSchema,
} from './developer.schema.js';
import { CreateSchoolWithAdminBody } from './developer.types.js';
import DeveloperController from './developer.controller.js';
import DeveloperService from './developer.service.js';

export const developerRoutes: FastifyPluginAsync = async (fastify) => {
  const developerService = new DeveloperService(fastify);
  const developerController = new DeveloperController(developerService);
  fastify.get(
    '/schools',
    { schema: listSchoolsRouteSchema },
    developerController.listSchools.bind(developerController),
  );

  fastify.post<{ Body: CreateSchoolWithAdminBody }>(
    '/schools',
    { schema: createSchoolWithAdminRouteSchema },
    developerController.createSchoolWithAdmin.bind(developerController),
  );
};
