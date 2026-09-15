/** PostgreSQL silently truncates identifiers longer than this many bytes (NAMEDATALEN - 1). */
export const MAX_IDENTIFIER_BYTES = 63;

/** Length of an identifier in bytes, which is what PostgreSQL's limit counts. */
export function identifierBytes(name: string): number {
  return new TextEncoder().encode(name).length;
}
