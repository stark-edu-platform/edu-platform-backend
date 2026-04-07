const successEnvelope = (data: Record<string, unknown>) => ({
  type: 'object',
  properties: {
    success: { type: 'boolean', const: true },
    message: { type: 'string' },
    data,
  },
});

export const createSchoolWithAdminRouteSchema = {
  tags: ['Developer'],
  summary: 'Create a school and its first school admin',
  security: [{ bearerAuth: [] }],
  body: {
    type: 'object',
    required: [
      'schoolName',
      'subdomain',
      'adminName',
      'adminEmail',
    ],
    properties: {
      schoolName: { type: 'string', minLength: 2, maxLength: 120 },
      subdomain: { type: 'string', minLength: 3, maxLength: 80 },
      board: { type: 'string', maxLength: 120 },
      address: { type: 'string', maxLength: 500 },
      schoolPhone: { type: 'string', maxLength: 30 },
      schoolEmail: { type: 'string', format: 'email', maxLength: 255 },
      adminName: { type: 'string', minLength: 2, maxLength: 120 },
      adminEmail: { type: 'string', format: 'email', maxLength: 255 },
      adminPhone: { type: 'string', maxLength: 30 },
      adminDesignation: { type: 'string', maxLength: 120 },
    },
  },
  response: {
    201: successEnvelope({
      type: 'object',
      properties: {
        school: {
          type: 'object',
          properties: {
            schoolId: { type: 'string' },
            name: { type: 'string' },
            subdomain: { type: 'string' },
            status: { type: 'string' },
          },
        },
        admin: {
          type: 'object',
          properties: {
            userId: { type: 'string' },
            name: { type: 'string', nullable: true },
            username: { type: 'string' },
            email: { type: 'string', nullable: true },
            status: { type: 'string' },
            systemRole: { type: 'string' },
          },
        },
        setup: {
          type: 'object',
          properties: {
            expiresAt: { type: 'string', format: 'date-time' },
          },
        },
      },
    }),
  },
};
