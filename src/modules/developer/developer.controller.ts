import { FastifyReply, FastifyRequest } from 'fastify';
import { successResponse } from '../../utils/api-response.js';
import DeveloperService from './developer.service.js';
import { CreateSchoolWithAdminBody } from './developer.types.js';

export default class DeveloperController {
  constructor(private readonly developerService: DeveloperService) {}

  async createSchoolWithAdmin(
    request: FastifyRequest<{ Body: CreateSchoolWithAdminBody }>,
    reply: FastifyReply,
  ) {
    const result = await this.developerService.createSchoolWithAdmin(
      request.body,
    );
    void reply.status(201);
    return successResponse('School and admin created successfully', result);
  }

  async listSchools() {
    const result = await this.developerService.listSchools();
    return successResponse('Schools fetched successfully', result);
  }
}
