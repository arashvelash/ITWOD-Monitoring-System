import { z } from 'zod';

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

/** Small deny-list of the most common passwords that satisfy the length rule. */
const COMMON = new Set([
  'password1234',
  'password12345',
  'passwordpassword',
  '123456789012',
  '1234567890123',
  'qwertyuiopas',
  'qwerty123456',
  'administrator',
  'admin1234567',
  'letmein12345',
  'iloveyou1234',
  'changeme1234',
  'welcome12345',
  'aaaaaaaaaaaa',
]);

export interface PasswordPolicyResult {
  ok: boolean;
  errors: string[];
}

/**
 * Length-based policy in line with NIST SP 800-63B: long passphrases are
 * encouraged, composition rules are not enforced, known-bad values are denied.
 */
export function checkPasswordPolicy(password: string, username?: string): PasswordPolicyResult {
  const errors: string[] = [];
  if (password.length < PASSWORD_MIN_LENGTH) errors.push(`Password must be at least ${PASSWORD_MIN_LENGTH} characters`);
  if (password.length > PASSWORD_MAX_LENGTH) errors.push(`Password must be at most ${PASSWORD_MAX_LENGTH} characters`);
  const lower = password.toLowerCase();
  if (COMMON.has(lower)) errors.push('Password is too common');
  if (/^(.)\1+$/.test(password)) errors.push('Password must not be a single repeated character');
  if (username && username.length >= 3 && lower.includes(username.toLowerCase())) {
    errors.push('Password must not contain the username');
  }
  return { ok: errors.length === 0, errors };
}

export const usernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9][a-z0-9._-]{2,31}$/, 'Username must be 3-32 characters: letters, digits, dot, dash, underscore');

export const passwordSchema = z.string().min(1).max(PASSWORD_MAX_LENGTH);
