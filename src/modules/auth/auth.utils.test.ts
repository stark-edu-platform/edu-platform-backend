import { describe, expect, it } from 'vitest';
import { hashPassword, isValidPassword, verifyPassword } from './auth.utils.js';

describe('isValidPassword', () => {
  it('accepts passwords with at least 8 characters', () => {
    expect(isValidPassword('12345678')).toBe(true);
  });

  it('rejects passwords shorter than 8 characters', () => {
    expect(isValidPassword('short')).toBe(false);
  });

  it('measures length after trimming surrounding whitespace', () => {
    expect(isValidPassword('   abc   ')).toBe(false);
  });
});

describe('hashPassword / verifyPassword', () => {
  it('produces a salt:hash string that verifies the original password', async () => {
    const stored = await hashPassword('correct horse battery');

    expect(stored).toMatch(/^[0-9a-f]+:[0-9a-f]+$/);
    await expect(verifyPassword('correct horse battery', stored)).resolves.toBe(
      true,
    );
  });

  it('uses a fresh salt so the same password hashes differently each time', async () => {
    const first = await hashPassword('correct horse battery');
    const second = await hashPassword('correct horse battery');

    expect(first).not.toBe(second);
  });

  it('rejects an incorrect password', async () => {
    const stored = await hashPassword('correct horse battery');

    await expect(verifyPassword('wrong password', stored)).resolves.toBe(false);
  });

  it('returns false for a malformed stored hash', async () => {
    await expect(verifyPassword('whatever', 'not-a-valid-hash')).resolves.toBe(
      false,
    );
  });
});
