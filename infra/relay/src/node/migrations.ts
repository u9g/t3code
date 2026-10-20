// @effect-diagnostics nodeBuiltinImport:off - Migrations ship as files beside the bundle.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// drizzle-kit writes one folder per migration, named so they sort in order.
const MIGRATIONS_TABLE = "relay_migrations";
const STATEMENT_BREAKPOINT = "--> statement-breakpoint";
// Any constant: it only keeps two pods starting at once from both migrating.
const MIGRATION_LOCK_ID = 7_310_455;

export const run = Effect.fn("relay.migrations.run")(function* (directory: string) {
  const sql = yield* SqlClient.SqlClient;
  const migrations = NodeFS.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql`SELECT pg_advisory_xact_lock(${MIGRATION_LOCK_ID})`;
      yield* sql`CREATE TABLE IF NOT EXISTS ${sql(MIGRATIONS_TABLE)} (
        name text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`;
      const applied = new Set(
        (yield* sql<{ readonly name: string }>`SELECT name FROM ${sql(MIGRATIONS_TABLE)}`).map(
          (row) => row.name,
        ),
      );
      for (const name of migrations) {
        if (applied.has(name)) continue;
        const source = NodeFS.readFileSync(NodePath.join(directory, name, "migration.sql"), "utf8");
        for (const statement of source.split(STATEMENT_BREAKPOINT)) {
          if (statement.trim()) yield* sql.unsafe(statement);
        }
        yield* sql`INSERT INTO ${sql(MIGRATIONS_TABLE)} (name) VALUES (${name})`;
        yield* Effect.logInfo("Applied relay migration", { name });
      }
    }),
  );
});
