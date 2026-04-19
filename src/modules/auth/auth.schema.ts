import SchemaBuilder, {
  SchemaNode,
} from '../../common/builder/SchemaBuilder.js';
class AuthSchemas {
  private readonly builder: SchemaBuilder;

  /**
   * Validation constraint values for this domain.
   * Centralised here so changes propagate to every schema automatically.
   */
  private readonly LIMITS = {
    LOGIN_ID: { min: 3, max: 120 },
    PASSWORD: { min: 8, max: 128 },
    TOKEN: { min: 10 },
    DEVICE_INFO: { max: 255 },
  } as const;

  readonly login: SchemaNode;
  readonly refresh: SchemaNode;
  readonly logout: SchemaNode;
  readonly logoutAll: SchemaNode;
  readonly me: SchemaNode;
  readonly validateSetupToken: SchemaNode;
  readonly setPassword: SchemaNode;

  constructor() {
    this.builder = new SchemaBuilder();
    this.login = this.buildLogin();
    this.refresh = this.buildRefresh();
    this.logout = this.buildLogout();
    this.logoutAll = this.buildLogoutAll();
    this.me = this.buildMe();
    this.validateSetupToken = this.buildValidateSetupToken();
    this.setPassword = this.buildSetPassword();
  }

  private schoolSchema(): SchemaNode {
    const S = this.builder;
    return S.object({
      schoolId: S.string(),
      name: S.string(),
      subdomain: S.string(),
      status: S.string(),
      primaryRole: S.string(),
    });
  }

  private userSchema(): SchemaNode {
    const S = this.builder;
    return S.object({
      userId: S.string(),
      name: S.string({ nullable: true }),
      username: S.string(),
      email: S.string({ nullable: true }),
      status: S.string(),
      systemRole: S.string(),
      schools: S.array(this.schoolSchema(), { nullable: true }),
    });
  }

  private successEnvelope(data: SchemaNode): SchemaNode {
    const S = this.builder;
    return S.object({
      success: { type: 'boolean', const: true },
      message: S.string(),
      data,
    });
  }

  private sessionResponse(): SchemaNode {
    const S = this.builder;
    return S.object({
      user: this.userSchema(),
      accessToken: S.string(),
    });
  }

  private resultResponse(): SchemaNode {
    return this.builder.object({
      result: this.builder.string(),
    });
  }

  // ── Private Route Builders ────────────────────────────────────────────────
  private buildLogin(): SchemaNode {
    const { S, LIMITS } = { S: this.builder, LIMITS: this.LIMITS };
    return {
      tags: ['Auth'],
      summary: 'Login with email or username',
      body: S.object(
        {
          loginId: S.string({
            minLength: LIMITS.LOGIN_ID.min,
            maxLength: LIMITS.LOGIN_ID.max,
          }),
          password: S.string({
            minLength: LIMITS.PASSWORD.min,
            maxLength: LIMITS.PASSWORD.max,
          }),
          deviceInfo: S.string({ maxLength: LIMITS.DEVICE_INFO.max }),
        },
        { required: ['loginId', 'password'], additionalProperties: false },
      ),
      response: {
        200: this.successEnvelope(this.sessionResponse()),
      },
    };
  }

  private buildRefresh(): SchemaNode {
    const { S, LIMITS } = { S: this.builder, LIMITS: this.LIMITS };
    return {
      tags: ['Auth'],
      summary: 'Refresh access token and rotate refresh token',
      body: S.object(
        {
          deviceInfo: S.string({ maxLength: LIMITS.DEVICE_INFO.max }),
        },
        { additionalProperties: false },
      ),
      response: {
        200: this.successEnvelope(this.sessionResponse()),
      },
    };
  }

  private buildLogout(): SchemaNode {
    return {
      tags: ['Auth'],
      summary: 'Logout current session',
      response: {
        200: this.successEnvelope(this.resultResponse()),
      },
    };
  }

  private buildLogoutAll(): SchemaNode {
    return {
      tags: ['Auth'],
      summary: 'Logout all sessions for current user',
      security: [{ bearerAuth: [] }],
      response: {
        200: this.successEnvelope(this.resultResponse()),
      },
    };
  }

  private buildMe(): SchemaNode {
    return {
      tags: ['Auth'],
      summary: 'Get current authenticated user',
      security: [{ bearerAuth: [] }],
      response: {
        200: this.successEnvelope(
          this.builder.object({ user: this.userSchema() }),
        ),
      },
    };
  }

  private buildValidateSetupToken(): SchemaNode {
    const { S, LIMITS } = { S: this.builder, LIMITS: this.LIMITS };
    return {
      tags: ['Auth'],
      summary: 'Validate password setup token',
      body: S.object(
        {
          token: S.string({ minLength: LIMITS.TOKEN.min }),
        },
        { required: ['token'], additionalProperties: false },
      ),
      response: {
        200: this.successEnvelope(
          S.object({
            valid: S.boolean(),
            email: S.string({ nullable: true }),
            expiresAt: S.string({ format: 'date-time' }),
          }),
        ),
      },
    };
  }

  private buildSetPassword(): SchemaNode {
    const { S, LIMITS } = { S: this.builder, LIMITS: this.LIMITS };
    return {
      tags: ['Auth'],
      summary: 'Set password using password setup token',
      body: S.object(
        {
          token: S.string({ minLength: LIMITS.TOKEN.min }),
          password: S.string({
            minLength: LIMITS.PASSWORD.min,
            maxLength: LIMITS.PASSWORD.max,
          }),
        },
        { required: ['token', 'password'], additionalProperties: false },
      ),
      response: {
        200: this.successEnvelope(this.resultResponse()),
      },
    };
  }
}

export const authSchemas = new AuthSchemas();

export const authUserSchema = authSchemas['me'];
