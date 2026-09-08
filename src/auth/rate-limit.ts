export const AUTH_RATE_LIMIT = 10;
export const AUTH_RATE_LIMIT_WINDOW_SECONDS = 10 * 60;

/** Pure policy: both independently counted dimensions must remain in budget. */
export function isAuthenticationAttemptAllowed(
  ipAttempts: number,
  usernameAttempts: number,
): boolean {
  return ipAttempts <= AUTH_RATE_LIMIT && usernameAttempts <= AUTH_RATE_LIMIT;
}
