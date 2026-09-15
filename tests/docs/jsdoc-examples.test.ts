// T5.3: every public export has JSDoc with an @example, and every example compiles against the
// package's real source (D31). Examples are compiled in memory; nothing is written to disk.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '../..');
const toPosix = (file: string) => file.split(path.sep).join('/');
const ENTRY_POINTS = ['src/index.ts', 'src/testing/index.ts'];

/** The tables and data the examples imagine. */
const SCHEMA = [
  "import { sql } from 'drizzle-orm';",
  "import { boolean, date, integer, pgTable, timestamp, uuid } from 'drizzle-orm/pg-core';",
  "import { exclude, tstzRange } from 'drizzle-exclude';",
  '',
  "export const bookings = pgTable('bookings', {",
  '  id: uuid().defaultRandom().primaryKey(),',
  '  roomId: uuid().notNull(),',
  '  startsAt: timestamp({ withTimezone: true }).notNull(),',
  '  endsAt: timestamp({ withTimezone: true }).notNull(),',
  '  cancelled: boolean().notNull().default(false),',
  '});',
  '',
  'export const bookingsNoOverlap = exclude(bookings, {',
  "  using: 'gist',",
  "  with: [[bookings.roomId, '='], [tstzRange(bookings.startsAt, bookings.endsAt), '&&']],",
  '  where: sql`not ${bookings.cancelled}`,',
  "  deferrable: 'immediate',",
  '});',
  '',
  "export const stays = pgTable('stays', {",
  '  id: uuid().defaultRandom().primaryKey(),',
  '  roomId: uuid().notNull(),',
  '  checkIn: date().notNull(),',
  '  checkOut: date().notNull(),',
  '});',
  '',
  "export const seatHolds = pgTable('seat_holds', {",
  '  id: uuid().defaultRandom().primaryKey(),',
  '  showId: uuid().notNull(),',
  '  firstSeat: integer().notNull(),',
  '  lastSeat: integer().notNull(),',
  '});',
].join('\n');

/** Names examples use without declaring them. An example's own imports and declarations win. */
const GLOBALS = [
  "import type { NodePgDatabase } from 'drizzle-orm/node-postgres';",
  "import type { PgTable } from 'drizzle-orm/pg-core';",
  "import type * as api from 'drizzle-exclude';",
  "import type * as testing from 'drizzle-exclude/testing';",
  "import type * as schema from './docs/schema';",
  '',
  'type Booking = typeof schema.bookings.$inferInsert;',
  '',
  'declare global {',
  '  const exclude: typeof api.exclude;',
  '  const tstzRange: typeof api.tstzRange;',
  '  const catchOverlap: typeof api.catchOverlap;',
  '  const parseExclusionViolation: typeof api.parseExclusionViolation;',
  '  const needsBtreeGist: typeof api.needsBtreeGist;',
  '  const btreeGistSql: typeof api.btreeGistSql;',
  '  const raceAttempts: typeof testing.raceAttempts;',
  "  const sql: typeof import('drizzle-orm').sql;",
  '  type ExcludeIndexMethod = api.ExcludeIndexMethod;',
  '  type ExcludeOperator = api.ExcludeOperator;',
  '  type ExcludeElement<T extends PgTable> = api.ExcludeElement<T>;',
  '  type ExcludePair<T extends PgTable> = api.ExcludePair<T>;',
  '  type ExcludeConfig<T extends PgTable> = api.ExcludeConfig<T>;',
  '  type RangeBounds = api.RangeBounds;',
  '  type RangeOptions = api.RangeOptions;',
  '  type ExclusionKey = api.ExclusionKey;',
  '  type ExclusionResult<T> = api.ExclusionResult<T>;',
  '  type ExclusionConstraintSqlOptions = api.ExclusionConstraintSqlOptions;',
  '  type ExclusionMigrationSqlOptions = api.ExclusionMigrationSqlOptions;',
  '  type ExpectNoOverlapOptions = testing.ExpectNoOverlapOptions;',
  '  type RaceOptions = testing.RaceOptions;',
  '',
  '  const db: NodePgDatabase;',
  '  const bookings: typeof schema.bookings;',
  '  const bookingsNoOverlap: typeof schema.bookingsNoOverlap;',
  '  const stays: typeof schema.stays;',
  '  const seatHolds: typeof schema.seatHolds;',
  '  const roomId: string;',
  '  const roomA: string;',
  '  const roomB: string;',
  '  const first: string;',
  '  const second: string;',
  '  const startsAt: Date;',
  '  const endsAt: Date;',
  '  const slot: Booking;',
  '  const error: unknown;',
  '  const result: ExclusionResult<unknown>;',
  '  function isSlotFree(slot: Booking): Promise<boolean>;',
  '  function book(slot: Booking, guest: string): Promise<string>;',
  '  function bookSlot(): PromiseLike<unknown>;',
  '  function runConcurrentBookings(): Promise<void>;',
  '  function test(name: string, body: () => Promise<void>): void;',
  '  function expect(actual: unknown): { toHaveLength(length: number): void; toEqual(expected: unknown): void };',
  '}',
  '',
  'export {};',
].join('\n');

interface Example {
  symbol: string;
  source: string;
  code: string;
}

function publicExportNames(): Set<string> {
  const names = new Set<string>();
  for (const entry of ENTRY_POINTS) {
    const sourceFile = ts.createSourceFile(entry, readFileSync(path.join(root, entry), 'utf8'), ts.ScriptTarget.Latest);
    for (const statement of sourceFile.statements) {
      if (ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
        for (const element of statement.exportClause.elements) {
          names.add(element.name.text);
        }
      }
    }
  }
  return names;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.name.endsWith('.ts') ? [full] : [];
  });
}

function exportedName(statement: ts.Statement): string | undefined {
  const named =
    ts.isFunctionDeclaration(statement) ||
    ts.isClassDeclaration(statement) ||
    ts.isInterfaceDeclaration(statement) ||
    ts.isTypeAliasDeclaration(statement);
  if (!named || statement.name === undefined) return undefined;
  const exported = (ts.getCombinedModifierFlags(statement) & ts.ModifierFlags.Export) !== 0;
  return exported ? statement.name.text : undefined;
}

function collectExamples(publicNames: Set<string>): Example[] {
  const examples: Example[] = [];
  for (const file of sourceFiles(path.join(root, 'src'))) {
    const sourceFile = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    for (const statement of sourceFile.statements) {
      const name = exportedName(statement);
      if (name === undefined || !publicNames.has(name)) continue;
      for (const tag of ts.getJSDocTags(statement)) {
        if (tag.tagName.text !== 'example') continue;
        const code = /```ts\n([\s\S]*?)\n```/.exec(ts.getTextOfJSDocComment(tag.comment) ?? '')?.[1];
        if (code === undefined) continue;
        const { line } = sourceFile.getLineAndCharacterOfPosition(statement.getStart());
        examples.push({ symbol: name, source: `${toPosix(path.relative(root, file))}:${String(line + 1)}`, code });
      }
    }
  }
  return examples;
}

/** Compiles every example against the real source and returns readable diagnostics. */
function compile(examples: Example[]): string[] {
  const virtualRoot = toPosix(path.join(root, '.jsdoc-examples'));
  const files = new Map<string, string>([
    // A .ts file, not .d.ts, so skipLibCheck doesn't hide mistakes in the prelude itself.
    [`${virtualRoot}/globals.ts`, GLOBALS],
    [`${virtualRoot}/docs/schema.ts`, SCHEMA],
    [`${virtualRoot}/src/schema.ts`, "export * from '../docs/schema';\n"],
  ]);
  const exampleFiles = new Map<string, Example>();
  examples.forEach((example, index) => {
    const file = `${virtualRoot}/docs/example-${String(index)}.ts`;
    // `export {}` makes each example a module, so top-level await and imports behave as in real code.
    files.set(file, `export {};\n${example.code}\n`);
    exampleFiles.set(file, example);
  });

  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    lib: ['lib.es2023.d.ts'],
    types: ['node'],
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    paths: {
      'drizzle-exclude': [toPosix(path.join(root, 'src/index.ts'))],
      'drizzle-exclude/testing': [toPosix(path.join(root, 'src/testing/index.ts'))],
    },
  };

  const host = ts.createCompilerHost(options, true);
  const key = (file: string) => host.getCanonicalFileName(toPosix(file));
  const contents = new Map([...files].map(([file, text]) => [key(file), text]));
  const examplesByKey = new Map([...exampleFiles].map(([file, example]) => [key(file), example]));
  const fileExists = host.fileExists.bind(host);
  const readFile = host.readFile.bind(host);
  const getSourceFile = host.getSourceFile.bind(host);
  const directoryExists = host.directoryExists?.bind(host);
  // Module resolution checks a folder exists before looking inside it, and the virtual ones don't exist on disk.
  host.directoryExists = (dir) =>
    key(dir) === key(virtualRoot) || key(dir).startsWith(`${key(virtualRoot)}/`) || (directoryExists?.(dir) ?? true);
  host.fileExists = (file) => contents.has(key(file)) || fileExists(file);
  host.readFile = (file) => contents.get(key(file)) ?? readFile(file);
  host.getSourceFile = (file, languageVersion, onError, shouldCreate) => {
    const text = contents.get(key(file));
    return text === undefined
      ? getSourceFile(file, languageVersion, onError, shouldCreate)
      : ts.createSourceFile(file, text, languageVersion, true);
  };

  const program = ts.createProgram([...files.keys()], options, host);
  return ts
    .getPreEmitDiagnostics(program)
    .filter((diagnostic) => diagnostic.file === undefined || key(diagnostic.file.fileName).startsWith(key(virtualRoot)))
    .map((diagnostic) => {
      const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
      if (diagnostic.file === undefined) return message;
      const { line } = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start ?? 0);
      const example = examplesByKey.get(key(diagnostic.file.fileName));
      return example === undefined
        ? `${toPosix(path.relative(root, diagnostic.file.fileName))}:${String(line + 1)}: ${message}`
        : `${example.symbol} example (${example.source}), line ${String(line)}: ${message}`;
    });
}

describe('JSDoc examples', () => {
  const publicNames = publicExportNames();
  const examples = collectExamples(publicNames);

  it('cover every public export', () => {
    const documented = new Set(examples.map((example) => example.symbol));

    expect(publicNames.size).toBeGreaterThan(0);
    expect([...publicNames].filter((name) => !documented.has(name))).toEqual([]);
  });

  it('all compile against the real API', () => {
    expect(compile(examples)).toEqual([]);
  }, 120_000);

  it('would catch a broken example (so the check above is not vacuous)', () => {
    const broken: Example = {
      symbol: 'broken',
      source: 'this test',
      code: "const expression: ExcludeElement<typeof bookings> = sql`lower(${bookings.code})`;",
    };

    expect(compile([broken])).toEqual([expect.stringContaining("Property 'code' does not exist")]);
  }, 120_000);
});
