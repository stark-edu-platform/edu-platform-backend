import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

const REFRESH_TOKEN_COOKIE_NAME = 'refreshToken';

type SameSiteValue = 'Strict' | 'Lax' | 'None';

function getRefreshCookieOptions(fastify: FastifyInstance) {
  const isProduction = fastify.config.NODE_ENV === 'production';

  return {
    httpOnly: true,
    // If you use the Proxy (Step 1), 'Lax' is safer and works better.
    // If you DON'T use the proxy, you MUST use 'None' and 'secure: true'.
    secure: isProduction,
    sameSite: (isProduction ? 'Lax' : 'Lax') as SameSiteValue,
    path: '/',
    maxAge: fastify.config.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60,
  };
}

function serializeCookie(
  name: string,
  value: string,
  options: {
    httpOnly?: boolean;
    secure?: boolean;
    sameSite?: SameSiteValue;
    path?: string;
    maxAge?: number;
    expires?: Date;
  },
) {
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

function appendSetCookie(reply: FastifyReply, cookieValue: string) {
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

function parseCookieHeader(cookieHeader?: string) {
  if (!cookieHeader) {
    return {};
  }

  return cookieHeader
    .split(';')
    .reduce<Record<string, string>>((cookies, part) => {
      const [rawName, ...rawValueParts] = part.trim().split('=');
      if (!rawName || rawValueParts.length === 0) {
        return cookies;
      }

      const rawValue = rawValueParts.join('=');
      cookies[rawName] = decodeURIComponent(rawValue);
      return cookies;
    }, {});
}

export function setRefreshTokenCookie(
  fastify: FastifyInstance,
  reply: FastifyReply,
  refreshToken: string,
) {
  appendSetCookie(
    reply,
    serializeCookie(
      REFRESH_TOKEN_COOKIE_NAME,
      refreshToken,
      getRefreshCookieOptions(fastify),
    ),
  );
}

export function clearRefreshTokenCookie(
  fastify: FastifyInstance,
  reply: FastifyReply,
) {
  const options = getRefreshCookieOptions(fastify);

  appendSetCookie(
    reply,
    serializeCookie(REFRESH_TOKEN_COOKIE_NAME, '', {
      ...options,
      maxAge: 0,
      expires: new Date(0),
    }),
  );
}

export function getRefreshTokenFromCookie(request: FastifyRequest) {
  const cookies = parseCookieHeader(request.headers.cookie);
  return cookies[REFRESH_TOKEN_COOKIE_NAME];
}
