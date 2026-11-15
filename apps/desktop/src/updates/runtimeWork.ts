// @effect-diagnostics nodeBuiltinImport:off -- Desktop probes the live database read-only before replacing its backend.
import * as NodeSqlite from "node:sqlite";

export function runtimeHasWork(databasePath: string): boolean {
  try {
    const db = new NodeSqlite.DatabaseSync(databasePath, { readOnly: true });
    try {
      const row = db
        .prepare(`SELECT
        (SELECT count(*) FROM orchestration_v2_projection_runs
          WHERE status IN ('queued', 'preparing', 'starting', 'running', 'waiting'))
        + (SELECT count(*) FROM orchestration_v2_effect_outbox WHERE status IN ('pending', 'running'))
        + (SELECT count(*) FROM orchestration_v2_projection_runtime_requests WHERE status = 'pending')
        + (SELECT count(*) FROM orchestration_v2_projection_provider_threads
          WHERE status = 'active' OR CASE WHEN json_valid(payload_json)
            THEN json_array_length(payload_json, '$.pendingBackgroundTasks') > 0 ELSE 0 END)
        + (SELECT count(*) FROM orchestration_v2_projection_subagents
          WHERE status IN ('pending', 'running', 'waiting'))
        + (SELECT count(*) FROM orchestration_v2_projection_turn_items AS item
          WHERE item.type IN ('command_execution', 'dynamic_tool', 'subagent')
            AND item.status IN ('pending', 'running', 'waiting')
            AND NOT EXISTS (SELECT 1 FROM orchestration_v2_projection_runs AS run
              WHERE run.run_id = item.run_id AND run.status = 'rolled_back')) AS work`)
        .get();
      return row === undefined || Number(row.work) !== 0;
    } finally {
      db.close();
    }
  } catch {
    return true;
  }
}
