// @effect-diagnostics nodeBuiltinImport:off -- Work admission is tested against isolated SQLite databases.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { runtimeHasWork } from "./runtimeWork.ts";

function setup() {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "runtime-work-"));
  const file = NodePath.join(directory, "db.sqlite");
  const db = new NodeSqlite.DatabaseSync(file);
  db.exec(`CREATE TABLE orchestration_v2_projection_runs (run_id TEXT, status TEXT);
    CREATE TABLE orchestration_v2_effect_outbox (status TEXT);
    CREATE TABLE orchestration_v2_projection_runtime_requests (status TEXT);
    CREATE TABLE orchestration_v2_projection_provider_threads (status TEXT, payload_json TEXT);
    CREATE TABLE orchestration_v2_projection_subagents (status TEXT);
    CREATE TABLE orchestration_v2_projection_turn_items (type TEXT, status TEXT, run_id TEXT);`);
  return {
    file,
    db,
    [Symbol.dispose]() {
      db.close();
      NodeFS.rmSync(directory, { recursive: true, force: true });
    },
  };
}

describe("runtime work admission", () => {
  it("fails closed for absent or incompatible databases", () => {
    using fixture = setup();
    expect(runtimeHasWork(fixture.file + ".missing")).toBe(true);
    fixture.db.exec("DROP TABLE orchestration_v2_projection_runs");
    expect(runtimeHasWork(fixture.file)).toBe(true);
  });
  it.each(["pending", "running"])("waits for uncommitted work effects: %s", (status) => {
    using fixture = setup();
    fixture.db.prepare("INSERT INTO orchestration_v2_effect_outbox VALUES (?)").run(status);
    expect(runtimeHasWork(fixture.file)).toBe(true);
  });
  it("does not count stopped sessions, finished work, or rolled-back tool items", () => {
    using fixture = setup();
    fixture.db.exec(`INSERT INTO orchestration_v2_projection_runs VALUES ('r', 'rolled_back');
      INSERT INTO orchestration_v2_projection_turn_items VALUES ('dynamic_tool','running','r');
      INSERT INTO orchestration_v2_projection_provider_threads VALUES ('idle','{}');`);
    expect(runtimeHasWork(fixture.file)).toBe(false);
  });
  it.each([
    ["runs", "'r','running'"],
    ["runs", "'r','queued'"],
    ["runs", "'r','preparing'"],
    ["runs", "'r','starting'"],
    ["runs", "'r','waiting'"],
    ["runtime_requests", "'pending'"],
    ["provider_threads", "'active','{}'"],
    ["provider_threads", "'idle','{\"pendingBackgroundTasks\":[1]}'"],
    ["subagents", "'pending'"],
    ["subagents", "'running'"],
    ["subagents", "'waiting'"],
    ["turn_items", "'command_execution','running','r'"],
    ["turn_items", "'dynamic_tool','pending','r'"],
    ["turn_items", "'subagent','waiting','r'"],
  ])("waits for %s: %s", (table, row) => {
    using fixture = setup();
    fixture.db.exec(`INSERT INTO orchestration_v2_projection_${table} VALUES (${row})`);
    expect(runtimeHasWork(fixture.file)).toBe(true);
  });
});
