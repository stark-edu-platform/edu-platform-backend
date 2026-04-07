import { FastifyRequest } from 'fastify';
import { successResponse } from '../../utils/api-response.js';
import { createSchoolWithAdmin } from './developer.service.js';
import { CreateSchoolWithAdminBody } from './developer.types.js';

export async function createSchoolWithAdminController(
  request: FastifyRequest<{ Body: CreateSchoolWithAdminBody }>,
) {
  const result = await createSchoolWithAdmin(request.server, request.body);

  return successResponse('School and admin created successfully', result);
}
