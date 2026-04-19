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

  private static getRefreshCookieOptions(
    fastify: FastifyInstance,
  ): CookieOptions {
    const isProduction = fastify.config.NODE_ENV === 'production';

    return {
      httpOnly: true,
      secure: isProduction,
      sameSite: 'None',
      path: '/',
      maxAge: fastify.config.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60,
    };
  }

  private static serializeCookie(
    name: string,
    value: string,
    options: CookieOptions,
  ): string {
    const parts = [`${name}=${encodeURIComponent(value)}`];

    if (options.maxAge !== undefined) {
      parts.push(`Max-Age=${Math.floor(options.maxAge)}`);
    }

    if (options.expires) {
      parts.push(`Expires=${options.expires.toUTCString()}`);
    }

    if (options.path) {
      parts.push(`Path=${options.path}`);
    }

    if (options.httpOnly) {
      parts.push('HttpOnly');
    }

    if (options.secure) {
      parts.push('Secure');
    }

    if (options.sameSite) {
      parts.push(`SameSite=${options.sameSite}`);
    }

    return parts.join('; ');
  }

  private static appendSetCookie(
    reply: FastifyReply,
    cookieValue: string,
  ): void {
    const current = reply.getHeader('Set-Cookie');

    if (!current) {
      reply.header('Set-Cookie', cookieValue);
      return;
    }

    const nextValue = Array.isArray(current)
      ? [...current, cookieValue]
      : [String(current), cookieValue];

    reply.header('Set-Cookie', nextValue);
  }

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
        cookies[rawName] = decodeURIComponent(rawValue);
        return cookies;
      }, {});
  }

  public static setRefreshTokenCookie(
    fastify: FastifyInstance,
    reply: FastifyReply,
    refreshToken: string,
  ): void {
    this.appendSetCookie(
      reply,
      this.serializeCookie(
        this.REFRESH_TOKEN_COOKIE_NAME,
        refreshToken,
        this.getRefreshCookieOptions(fastify),
      ),
    );
  }

  public static clearRefreshTokenCookie(
    fastify: FastifyInstance,
    reply: FastifyReply,
  ): void {
    const options = this.getRefreshCookieOptions(fastify);

    this.appendSetCookie(
      reply,
      this.serializeCookie(this.REFRESH_TOKEN_COOKIE_NAME, '', {
        ...options,
        maxAge: 0,
        expires: new Date(0),
      }),
    );
  }

  public static getRefreshTokenFromCookie(
    request: FastifyRequest,
  ): string | undefined {
    const cookies = this.parseCookieHeader(request.headers.cookie);
    return cookies[this.REFRESH_TOKEN_COOKIE_NAME];
  }
}
