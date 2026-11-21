/**
 * Rough client-side strength estimate (0-4) for UI feedback only.
 * The server enforces the actual policy.
 */
export function passwordScore(password: string): number {
  if (password.length < 12) return 0;
  let classes = 0;
  if (/[a-z]/.test(password)) classes++;
  if (/[A-Z]/.test(password)) classes++;
  if (/\d/.test(password)) classes++;
  if (/[^A-Za-z0-9]/.test(password)) classes++;
  const unique = new Set(password).size;
  let score = 1;
  if (password.length >= 16) score++;
  if (classes >= 3) score++;
  if (password.length >= 20 && unique >= 10) score++;
  if (unique < 5) score = 1;
  return Math.min(score, 4);
}
