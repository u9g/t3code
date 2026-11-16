// @effect-diagnostics nodeBuiltinImport:off -- Synthetic SQLite/protobuf fixtures exercise Cursor's native history format.
import * as NodeCrypto from "node:crypto";
import * as NodeSqlite from "node:sqlite";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type * as Scope from "effect/Scope";
import type { UsageRecord } from "@t3tools/provider-core/server/usage";
import * as CursorGenerationHistory from "./CursorGenerationHistory.ts";

const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));
const START = Date.parse("2026-08-01T10:00:00Z");
const bytes = (text: string) => Buffer.from(text);
const sha = (value: string | Uint8Array) =>
  NodeCrypto.createHash("sha256").update(value).digest("hex");
const vi = (value: number) => {
  const out: number[] = [];
  let rest = BigInt(value);
  do {
    out.push(Number(rest & 127n) | (rest > 127n ? 128 : 0));
    rest >>= 7n;
  } while (rest);
  return Buffer.from(out);
};
const field = (number: number, value: number | Uint8Array) =>
  typeof value === "number"
    ? Buffer.concat([vi(number * 8), vi(value)])
    : Buffer.concat([vi(number * 8 + 2), vi(value.length), value]);
const proto = (...fields: readonly Uint8Array[]) => Buffer.concat(fields);

const fixture = (
  options: {
    readonly toolEnd?: boolean;
    readonly task?: boolean;
    readonly legacy?: boolean;
    readonly project?: string;
  } = {},
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "cursor-generation-" });
    const workspaceRef = "/work/acme";
    const root = path.join(
      home,
      ".cursor/projects",
      options.project ?? "work-acme",
      "sdk-agent-store",
      options.legacy ? "legacy-layout" : sha(workspaceRef),
    );
    const agentId = "agent-example";
    const runId = "run-example";
    const requestId = "request-example";
    const agentPath = path.join(root, "agents", `agent-${sha(agentId)}`, "store.db");
    const indexPath = path.join(root, "index.db");
    yield* fs.makeDirectory(path.dirname(agentPath), { recursive: true });
    const rootId = yield* Effect.sync(() => {
      const db = new NodeSqlite.DatabaseSync(agentPath);
      try {
        db.exec("CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB)");
        const blob = (data: Uint8Array) => {
          const id = sha(data);
          db.prepare("INSERT OR IGNORE INTO blobs VALUES (?, ?)").run(id, data);
          return Buffer.from(id, "hex");
        };
        const user = blob(
          proto(
            field(1, bytes("synthetic prompt")),
            field(25, START + 1000),
            field(26, START + 1000),
          ),
        );
        const thought = blob(
          field(
            3,
            proto(
              field(1, bytes("synthetic reasoning")),
              field(2, 500),
              field(3, START + 1000),
              field(4, START + 1500),
            ),
          ),
        );
        const tool = (name: string, start: number, end: number) =>
          blob(
            field(
              2,
              proto(
                field(options.task ? 19 : 44, proto()),
                field(57, bytes(name)),
                field(59, START + start),
                ...(options.toolEnd === false ? [] : [field(60, START + end)]),
              ),
            ),
          );
        const assistant = blob(
          field(1, proto(field(1, bytes("synthetic answer")), field(2, START + 9000))),
        );
        const previous = blob(
          field(
            1,
            proto(
              field(3, bytes("previous-request")),
              field(2, bytes("invalid previous-turn reference")),
            ),
          ),
        );
        const current = blob(
          field(
            1,
            proto(
              field(1, user),
              field(2, thought),
              field(2, tool("hidden-tool", 2000, 5000)),
              field(2, tool("parallel-tool", 4000, 6000)),
              field(2, assistant),
              field(3, bytes(requestId)),
            ),
          ),
        );
        return blob(
          proto(
            field(1, blob(bytes('{"role":"system"}'))),
            field(8, previous),
            field(8, current),
            field(26, START + 1000),
          ),
        ).toString("hex");
      } finally {
        db.close();
      }
    });
    yield* Effect.sync(() => {
      const db = new NodeSqlite.DatabaseSync(indexPath);
      try {
        db.exec(
          "CREATE TABLE agents (agent_id TEXT PRIMARY KEY, workspace_ref TEXT); CREATE TABLE runs (run_id TEXT PRIMARY KEY, request_id TEXT, agent_id TEXT, model TEXT, status TEXT, started_at TEXT, finished_at TEXT, latest_checkpoint_ref_json TEXT, usage_json TEXT); CREATE TABLE run_events (run_id TEXT, seq INTEGER, created_at TEXT, payload_json TEXT)",
        );
        db.prepare("INSERT INTO agents VALUES (?, ?)").run(agentId, workspaceRef);
        db.prepare("INSERT INTO runs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
          runId,
          requestId,
          agentId,
          "composer-2.5",
          "FINISHED",
          iso(START),
          iso(START + 11000),
          JSON.stringify({ blobId: rootId, storeKind: "local-agent-store" }),
          JSON.stringify({
            inputTokens: 30,
            outputTokens: 200,
            cacheReadTokens: 20,
            cacheWriteTokens: 0,
          }),
        );
        const events = [
          [0, { type: "status", status: "RUNNING" }],
          [5500, { type: "summary", status: "running" }],
          [6500, { type: "summary", status: "completed" }],
          [10000, { type: "assistant", message: { role: "assistant", content: [] } }],
          [10100, { type: "usage", usage: { outputTokens: 200 } }],
          [11000, { type: "status", status: "FINISHED" }],
        ] as const;
        for (const [seq, [at, message]] of events.entries())
          db.prepare("INSERT INTO run_events VALUES (?, ?, ?, ?)").run(
            runId,
            seq,
            iso(START + at),
            JSON.stringify({
              schemaVersion: 1,
              type: "sdk_message",
              agentId,
              runId,
              message: { ...message, agent_id: agentId, run_id: runId },
            }),
          );
      } finally {
        db.close();
      }
    });
    const request = {
      runId,
      agentId,
      workspaceRef,
      startedAtMs: START + 2000,
      completedAtMs: START + 12000,
    };
    const billed = (at: number, outputTokens: number, scope: string): UsageRecord => ({
      provider: "cursor",
      model: "composer-2.5",
      timestampMs: START + at,
      sessionId: agentId,
      totals: {
        uncachedInputTokens: 10,
        cachedInputTokens: 20,
        cacheCreationTokens: 0,
        outputTokens,
        reasoningTokens: 0,
      },
      reportedCostUsd: null,
      speed: "standard",
      dedupeKey: `${scope}:${at}`,
    });
    const billingRecords = [
      billed(1500, 100, "personal"),
      billed(8000, 200, "personal"),
      billed(1500, 100, "team"),
      billed(8000, 200, "team"),
    ];
    const input = { requests: [request], billingRecords, homeDirectories: [home] };
    const expected = { runId, timestampMs: START + 1000, outputTokens: 300, generationMs: 4500 };
    const updateIndex = (sql: string) =>
      Effect.sync(() => {
        const db = new NodeSqlite.DatabaseSync(indexPath);
        try {
          db.exec(sql);
        } finally {
          db.close();
        }
      });
    return { fs, path, home, root, indexPath, agentPath, request, input, expected, updateIndex };
  });

const run = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | Scope.Scope>) =>
  effect.pipe(Effect.scoped, Effect.provide(NodeServices.layer));

describe("Cursor generation history", () => {
  it.effect(
    "joins all billing segments once and excludes overlapping native tools and compaction",
    () =>
      run(
        Effect.gen(function* () {
          const f = yield* fixture();
          const reader = yield* CursorGenerationHistory.make();
          const before = yield* f.fs.readFile(f.indexPath);
          expect(yield* reader.read(f.input)).toEqual([f.expected]);
          expect(yield* f.fs.readFile(f.indexPath)).toEqual(before);
          expect(yield* reader.read({ ...f.input, requests: [f.request, f.request] })).toEqual([
            f.expected,
          ]);
        }),
      ),
  );

  it.effect("keeps native timing cached while late billing joins refresh", () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture();
        const reader = yield* CursorGenerationHistory.make();
        expect(yield* reader.read({ ...f.input, billingRecords: [] })).toEqual([]);
        expect(yield* reader.read(f.input)).toEqual([f.expected]);
        const bill = f.input.billingRecords.map((record) => ({
          ...record,
          totals: { ...record.totals, outputTokens: record.totals.outputTokens + 100 },
        }));
        yield* f.updateIndex(
          'UPDATE runs SET usage_json=\'{"inputTokens":30,"outputTokens":300,"cacheReadTokens":20,"cacheWriteTokens":0}\'',
        );
        expect(yield* reader.read({ ...f.input, billingRecords: bill })).toEqual([
          { ...f.expected, outputTokens: 500 },
        ]);
      }),
    ),
  );

  it.effect.each([
    ["unfinished run", "UPDATE runs SET status='RUNNING'"],
    ["wrong agent", "UPDATE runs SET agent_id='agent-other'"],
    ["wrong workspace", "UPDATE agents SET workspace_ref='/work/other'"],
    ["wrong request", "UPDATE runs SET request_id='request-other'"],
    [
      "corrupt root reference",
      'UPDATE runs SET latest_checkpoint_ref_json=\'{"blobId":"not-a-hash"}\'',
    ],
    ["missing output events", "DELETE FROM run_events WHERE seq=3"],
    ["incomplete compaction", "DELETE FROM run_events WHERE seq=2"],
  ])("leaves %s untimed", ([_label, sql]) =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.updateIndex(sql!);
        const reader = yield* CursorGenerationHistory.make();
        expect(yield* reader.read(f.input)).toEqual([]);
      }),
    ),
  );

  it.effect.each([{ toolEnd: false }, { task: true }])(
    "rejects incomplete or subagent native tools %j",
    (options) =>
      run(
        Effect.gen(function* () {
          const f = yield* fixture(options);
          const reader = yield* CursorGenerationHistory.make();
          expect(yield* reader.read(f.input)).toEqual([]);
        }),
      ),
  );

  it.effect("does not open missing or corrupt native stores for writing", () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.fs.remove(f.agentPath);
        const reader = yield* CursorGenerationHistory.make();
        expect(yield* reader.read(f.input)).toEqual([]);
        expect(yield* f.fs.exists(f.agentPath)).toBe(false);
        yield* f.fs.writeFileString(f.indexPath, "invalid database");
        expect(yield* reader.read(f.input)).toEqual([]);
      }),
    ),
  );

  it.effect("rejects mixed-model billing and ambiguous overlapping requests", () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture();
        const reader = yield* CursorGenerationHistory.make();
        expect(
          yield* reader.read({
            ...f.input,
            billingRecords: [
              ...f.input.billingRecords,
              { ...f.input.billingRecords[0]!, model: "other-model" },
            ],
          }),
        ).toEqual([]);
        yield* f.updateIndex(
          "INSERT INTO runs SELECT 'run-overlap',request_id,agent_id,model,status,started_at,finished_at,latest_checkpoint_ref_json,usage_json FROM runs; INSERT INTO run_events SELECT 'run-overlap',seq,created_at,replace(payload_json,'run-example','run-overlap') FROM run_events WHERE run_id='run-example'",
        );
        expect(
          yield* reader.read({
            ...f.input,
            requests: [f.request, { ...f.request, runId: "run-overlap" }],
          }),
        ).toEqual([]);
      }),
    ),
  );

  it.effect.each([{ legacy: true }, { project: "moved-project" }])(
    "finds legacy and moved default layouts %j",
    (options) =>
      run(
        Effect.gen(function* () {
          const f = yield* fixture(options);
          const reader = yield* CursorGenerationHistory.make();
          expect(yield* reader.read(f.input)).toEqual([f.expected]);
        }),
      ),
  );
  it.effect("waits for the final native usage segment before recovering timing", () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture();
        const reader = yield* CursorGenerationHistory.make();
        expect(
          yield* reader.read({
            ...f.input,
            billingRecords: f.input.billingRecords.filter(
              (record) => record.timestampMs === START + 1500,
            ),
          }),
        ).toEqual([]);
        expect(yield* reader.read(f.input)).toEqual([f.expected]);
      }),
    ),
  );

  it.effect(
    "persists recovered samples across native history cleanup with matching identities",
    () =>
      run(
        Effect.gen(function* () {
          const f = yield* fixture();
          const cachePath = f.path.join(f.home, "app-state", "cursor-history.json");
          const reader = yield* CursorGenerationHistory.make({ cachePath });
          expect(yield* reader.read(f.input)).toEqual([f.expected]);
          expect(yield* f.fs.exists(cachePath)).toBe(true);
          yield* f.fs.remove(f.root, { recursive: true });
          const restarted = yield* CursorGenerationHistory.make({ cachePath });
          expect(yield* restarted.read({ ...f.input, billingRecords: [] })).toEqual([f.expected]);
          expect(
            yield* restarted.read({
              ...f.input,
              requests: [{ ...f.request, agentId: "another-agent" }],
            }),
          ).toEqual([]);
          expect(
            yield* restarted.read({
              ...f.input,
              requests: [{ ...f.request, workspaceRef: "/different/workspace" }],
            }),
          ).toEqual([]);
        }),
      ),
  );

  it.effect("preserves identical same-millisecond billing occurrences while deduping scopes", () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture();
        const reader = yield* CursorGenerationHistory.make();
        const records = ["personal", "team"].flatMap((scope) =>
          [0, 1].map((occurrence) => ({
            ...f.input.billingRecords[1]!,
            dedupeKey: `cursor-account:account:${scope}:${occurrence}`,
          })),
        );
        expect(yield* reader.read({ ...f.input, billingRecords: records })).toEqual([
          { ...f.expected, outputTokens: 400 },
        ]);
      }),
    ),
  );

  it.effect("matches billing model effort aliases to their native model", () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture();
        const reader = yield* CursorGenerationHistory.make();
        expect(
          yield* reader.read({
            ...f.input,
            billingRecords: f.input.billingRecords.map((record) => ({
              ...record,
              model: "composer-2.5-thinking",
            })),
          }),
        ).toEqual([f.expected]);
      }),
    ),
  );

  it.effect("rejects missing and corrupt referenced checkpoint blobs", () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* Effect.sync(() => {
          const db = new NodeSqlite.DatabaseSync(f.agentPath);
          try {
            db.exec("UPDATE blobs SET data=X'010203'");
          } finally {
            db.close();
          }
        });
        const reader = yield* CursorGenerationHistory.make();
        expect(yield* reader.read(f.input)).toEqual([]);
      }),
    ),
  );
});
