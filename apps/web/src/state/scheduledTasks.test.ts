import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ScheduledTaskId,
  ThreadId,
  type ScheduledTask,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import { scheduledTaskThreadKeys } from "./scheduledTasks";

const local = EnvironmentId.make("local");
const remote = EnvironmentId.make("remote");

const task = (id: string, overrides: Partial<ScheduledTask>): ScheduledTask => ({
  id: ScheduledTaskId.make(id),
  title: "Check the deploy",
  prompt: "Merge once deployed",
  enabled: true,
  schedule: { type: "interval", everyMs: 3_600_000 },
  projectId: ProjectId.make("project"),
  threadId: null,
  workspaceStrategy: { type: "root" },
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
  runtimeMode: "full-access",
  interactionMode: "default",
  createdBy: "agent",
  creationSource: "mcp",
  createdAt: "2026-11-04T00:00:00.000Z",
  updatedAt: "2026-11-04T00:00:00.000Z",
  nextRunAt: null,
  lastRunAt: null,
  lastRunStatus: "never",
  lastRunError: null,
  runCount: 0,
  ...overrides,
});

const key = (environmentId: EnvironmentId, threadId: string) =>
  scopedThreadKey(scopeThreadRef(environmentId, ThreadId.make(threadId)));

describe("scheduledTaskThreadKeys", () => {
  it("keeps threads an enabled task is bound to, per environment", () => {
    const keys = scheduledTaskThreadKeys(
      [local, remote],
      [
        AsyncResult.success({
          tasks: [
            task("bound", { threadId: ThreadId.make("waiting") }),
            task("paused", { threadId: ThreadId.make("paused"), enabled: false }),
            task("unbound", {}),
          ],
        }),
        AsyncResult.success({ tasks: [task("remote", { threadId: ThreadId.make("waiting") })] }),
      ],
    );

    expect([...keys].toSorted()).toEqual(
      [key(local, "waiting"), key(remote, "waiting")].toSorted(),
    );
  });

  it("skips environments whose tasks have not loaded", () => {
    expect(scheduledTaskThreadKeys([local], [AsyncResult.initial(true)]).size).toBe(0);
  });
});
