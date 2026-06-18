export class OlfsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OlfsError";
  }
}

export function assertDefined<T>(value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) {
    throw new OlfsError(message);
  }
  return value;
}
