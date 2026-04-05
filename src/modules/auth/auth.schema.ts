const successEnvelope = (data: Record<string, unknown>) => ({
  type: 'object',
  properties: {
    success: { type: 'boolean', const: true },
    message: { type: 'string' },
    data,
  },
});

export const authUserSchema = {
  type: 'object',
  properties: {
    userId: { type: 'string' },
    name: { type: 'string', nullable: true },
    username: { type: 'string' },
    email: { type: 'string', nullable: true },
    status: { type: 'string' },
  },
};

export const loginRouteSchema = {
  tags: ['Auth'],
  summary: 'Login with email or username',
  body: {
    type: 'object',
    required: ['loginId', 'password'],
    properties: {
      loginId: { type: 'string', minLength: 3, maxLength: 120 },
      password: { type: 'string', minLength: 8, maxLength: 128 },
      deviceInfo: { type: 'string', maxLength: 255 },
    },
  },
  response: {
    200: successEnvelope({
      type: 'object',
      properties: {
        user: authUserSchema,
        accessToken: { type: 'string' },
        refreshToken: { type: 'string' },
      },
    }),
  },
};

export const refreshRouteSchema = {
  tags: ['Auth'],
  summary: 'Refresh access token and rotate refresh token',
  body: {
    type: 'object',
    required: ['refreshToken'],
    properties: {
      refreshToken: { type: 'string', minLength: 10 },
      deviceInfo: { type: 'string', maxLength: 255 },
    },
  },
  response: {
    200: successEnvelope({
      type: 'object',
      properties: {
        user: authUserSchema,
        accessToken: { type: 'string' },
        refreshToken: { type: 'string' },
      },
    }),
  },
};

export const logoutRouteSchema = {
  tags: ['Auth'],
  summary: 'Logout current session',
  body: {
    type: 'object',
    required: ['refreshToken'],
    properties: {
      refreshToken: { type: 'string', minLength: 10 },
    },
  },
  response: {
    200: successEnvelope({
      type: 'object',
      properties: {
        result: { type: 'string' },
      },
    }),
  },
};

export const logoutAllRouteSchema = {
  tags: ['Auth'],
  summary: 'Logout all sessions for current user',
  security: [{ bearerAuth: [] }],
  response: {
    200: successEnvelope({
      type: 'object',
      properties: {
        result: { type: 'string' },
      },
    }),
  },
};

export const meRouteSchema = {
  tags: ['Auth'],
  summary: 'Get current authenticated user',
  security: [{ bearerAuth: [] }],
  response: {
    200: successEnvelope({
      type: 'object',
      properties: {
        user: authUserSchema,
      },
    }),
  },
};

export const validateSetupTokenRouteSchema = {
  tags: ['Auth'],
  summary: 'Validate password setup token',
  body: {
    type: 'object',
    required: ['token'],
    properties: {
      token: { type: 'string', minLength: 10 },
    },
  },
  response: {
    200: successEnvelope({
      type: 'object',
      properties: {
        valid: { type: 'boolean' },
        email: { type: 'string', nullable: true },
        expiresAt: { type: 'string', format: 'date-time' },
      },
    }),
  },
};

export const setPasswordRouteSchema = {
  tags: ['Auth'],
  summary: 'Set password using password setup token',
  body: {
    type: 'object',
    required: ['token', 'password'],
    properties: {
      token: { type: 'string', minLength: 10 },
      password: { type: 'string', minLength: 8, maxLength: 128 },
    },
  },
  response: {
    200: successEnvelope({
      type: 'object',
      properties: {
        result: { type: 'string' },
      },
    }),
  },
};
