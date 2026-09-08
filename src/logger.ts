export type LogFields = Record<string, unknown>;

export function log(
  level: "info" | "error",
  message: string,
  fields: LogFields = {},
): void {
  console.log(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      level,
      message,
      ...fields,
    }),
  );
}
