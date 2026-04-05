import {
  createHash,
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

export function normalizeLoginId(loginId: string) {
  return loginId.trim().toLowerCase();
}

export function isEmail(value: string) {
  return EMAIL_PATTERN.test(value);
}

export function isValidPassword(password: string) {
  return password.trim().length >= 8;
}

export async function hashPassword(password: string) {
  const salt = randomBytes(16).toString('hex');
  const derivedKey = (await scrypt(password, salt, 64)) as Buffer;
  return `${salt}:${derivedKey.toString('hex')}`;
}

export async function verifyPassword(
  password: string,
  storedPasswordHash: string,
) {
  const [salt, hash] = storedPasswordHash.split(':');
  if (!salt || !hash) {
    return false;
  }

  const derivedKey = (await scrypt(password, salt, 64)) as Buffer;
  const storedHashBuffer = Buffer.from(hash, 'hex');
  if (storedHashBuffer.length !== derivedKey.length) {
    return false;
  }

  return timingSafeEqual(storedHashBuffer, derivedKey);
}

export function hashToken(token: string) {
  return createHash('sha256').update(token).digest('hex');
}

export function createRawToken() {
  return randomBytes(32).toString('hex');
}

export function buildPasswordSetupUrl(baseUrl: string, token: string) {
  const separator = baseUrl.includes('?') ? '&' : '?';
  return `${baseUrl}${separator}token=${encodeURIComponent(token)}`;
}

export function buildUsernameFromEmail(email: string) {
  const [localPart] = normalizeEmail(email).split('@');
  const sanitized = (localPart ?? 'developer')
    .replace(/[^a-z0-9._]/g, '.')
    .replace(/\.{2,}/g, '.')
    .replace(/^\.|\.$/g, '');

  return (sanitized || 'developer').slice(0, 30);
}
