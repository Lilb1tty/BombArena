export const USERNAME_PATTERN = /^[A-Za-z0-9_]{3,20}$/;
export const MINIMUM_PASSWORD_LENGTH = 8;
export const MAXIMUM_PASSWORD_LENGTH = 128;

export function normalizeUsername(value: unknown): string | undefined {
  if (typeof value !== "string" || !USERNAME_PATTERN.test(value)) {
    return undefined;
  }

  return value.toLowerCase();
}

export function isAcceptablePassword(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= MINIMUM_PASSWORD_LENGTH &&
    value.length <= MAXIMUM_PASSWORD_LENGTH
  );
}
