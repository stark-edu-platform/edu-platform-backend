import {
  createHash,
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from 'node:crypto';
import { promisify } from 'node:util';

/** Promisified version of Node's scrypt — used for password hashing. */
const scrypt = promisify(scryptCallback);

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function normalizeLoginId(loginId: string): string {
  return loginId.trim().toLowerCase();
}

export function isEmail(value: string): boolean {
  return EMAIL_PATTERN.test(value);
}

export function isValidPassword(password: string): boolean {
  return password.trim().length >= 8;
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString('hex');
  const derivedKey = (await scrypt(password, salt, 64)) as Buffer;
  return `${salt}:${derivedKey.toString('hex')}`;
}

export async function verifyPassword(
  password: string,
  storedPasswordHash: string,
): Promise<boolean> {
  const [salt, hash] = storedPasswordHash.split(':');
  if (!salt || !hash) {
    return false;
  }

  const derivedKey = (await scrypt(password, salt, 64)) as Buffer;
  const storedHashBuffer = Buffer.from(hash, 'hex');

  // Buffer lengths must match for timingSafeEqual (otherwise it throws).
  if (storedHashBuffer.length !== derivedKey.length) {
    return false;
  }

  return timingSafeEqual(storedHashBuffer, derivedKey);
}

/**
 * Computes the SHA-256 hex digest of a token.
 *
 * Used to derive the stored hash from a raw token so the raw value is
 * never persisted in the database. Verification re-hashes the presented
 * raw token and compares hashes.
 *
 * @param token - Raw token string (hex or arbitrary string).
 * @returns 64-character hex SHA-256 hash.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Generates a cryptographically secure random token (32 bytes → 64 hex chars).
 *
 * Used for both refresh tokens and password-setup invite tokens.
 * 256 bits of entropy makes brute-force attacks computationally infeasible.
 *
 * @returns A 64-character hexadecimal string.
 */
export function createRawToken(): string {
  return randomBytes(32).toString('hex');
}

/**
 * Builds the full password-setup URL by appending the token as a query param.
 *
 * Handles both `baseUrl` values that already contain a `?` and those that
 * don't, so callers don't need to worry about URL construction.
 *
 * @param baseUrl - The frontend password-setup page URL
 *                  (e.g. `https://app.example.com/setup-password`).
 * @param token   - The raw (un-hashed) setup token to append.
 * @returns The complete URL with the token encoded as a query parameter.
 *
 * @example
 * buildPasswordSetupUrl('https://app.example.com/setup-password', 'abc123')
 * // → 'https://app.example.com/setup-password?token=abc123'
 */
export function buildPasswordSetupUrl(baseUrl: string, token: string): string {
  const separator = baseUrl.includes('?') ? '&' : '?';
  return `${baseUrl}${separator}token=${encodeURIComponent(token)}`;
}

/**
 * Derives a safe username from an email address.
 *
 * Rules applied to the local part (before `@`):
 *  - Normalize to lowercase.
 *  - Replace any character that is not `a-z`, `0-9`, `.`, or `_` with `.`.
 *  - Collapse consecutive dots into a single dot.
 *  - Strip leading and trailing dots.
 *  - Truncate to 30 characters.
 *  - Fall back to `"developer"` when the result would be empty.
 *
 * @param email - A valid email address.
 * @returns A sanitized username of up to 30 characters.
 *
 * @example
 * buildUsernameFromEmail('john.doe+test@example.com')
 * // → 'john.doe.test'
 */
export function buildUsernameFromEmail(email: string): string {
  const [localPart] = normalizeEmail(email).split('@');
  const sanitized = (localPart ?? 'developer')
    .replace(/[^a-z0-9._]/g, '.')
    .replace(/\.{2,}/g, '.')
    .replace(/^\.|\.$/g, '');

  return (sanitized || 'developer').slice(0, 30);
}
