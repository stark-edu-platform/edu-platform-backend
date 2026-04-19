import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

export type SameSiteValue = 'Strict' | 'Lax' | 'None';

export interface CookieOptions {
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: SameSiteValue;
  path?: string;
  maxAge?: number;
  expires?: Date;
}

export class AuthCookies {
  private static readonly REFRESH_TOKEN_COOKIE_NAME = 'refreshToken';

  private static parseCookieHeader(
    cookieHeader?: string,
  ): Record<string, string> {
    if (!cookieHeader) {
      return {};
    }

    return cookieHeader
      .split(';')
      .reduce<Record<string, string>>((cookies, part) => {
        const [rawName, ...rawValueParts] = part.trim().split('=');

        // Skip malformed segments (no name, or missing '=').
        if (!rawName || rawValueParts.length === 0) {
          return cookies;
        }

        // Re-join on '=' to correctly handle values that contain '='.
        const rawValue = rawValueParts.join('=');
        cookies[rawName] = rawValue;
        return cookies;
      }, {});
  }

  public static setRefreshTokenCookie(
    fastify: FastifyInstance,
    reply: FastifyReply,
    refreshToken: string,
  ): void {
    // const isProduction = fastify.config.NODE_ENV === 'production';

    reply.setCookie(this.REFRESH_TOKEN_COOKIE_NAME, refreshToken, {
      httpOnly: true,
      secure: true, // ✅ fix
      sameSite: 'none', // ✅ fix
      path: '/',
      maxAge: fastify.config.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60, // ✅ fix
    });
  }

  public static clearRefreshTokenCookie(
    _fastify: FastifyInstance,
    reply: FastifyReply,
  ): void {
    reply.clearCookie(this.REFRESH_TOKEN_COOKIE_NAME, {
      path: '/',
    });
  }

  public static getRefreshTokenFromCookie(
    request: FastifyRequest,
  ): string | undefined {
    const cookies = this.parseCookieHeader(request.headers.cookie);
    return cookies[this.REFRESH_TOKEN_COOKIE_NAME];
  }
}
