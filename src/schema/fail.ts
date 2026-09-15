/** Throws a programmer error: configuration that can't describe a valid constraint. */
export function fail(message: string): never {
  throw new Error(`drizzle-exclude: ${message}`);
}
