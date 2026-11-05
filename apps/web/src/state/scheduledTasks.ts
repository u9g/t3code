import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ScheduledTaskListResult } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";

import { environmentAtomList } from "./environmentAtomList";
import { serverEnvironment } from "./server";

/** Live scheduled tasks for each environment, keyed by `environmentIdsKey`. */
export const scheduledTasksListAtom = environmentAtomList(
  "web-scheduled-tasks-list",
  (environmentId) => serverEnvironment.scheduledTasksLive({ environmentId, input: {} }),
);

/**
 * Keys of threads an enabled scheduled task posts its runs to. Such a thread is waiting on its
 * automation, so it belongs on the Automations shelf before the task's first run lands.
 */
export function scheduledTaskThreadKeys(
  environmentIds: ReadonlyArray<EnvironmentId>,
  results: ReadonlyArray<AsyncResult.AsyncResult<ScheduledTaskListResult, unknown>>,
): ReadonlySet<string> {
  const keys = new Set<string>();
  environmentIds.forEach((environmentId, index) => {
    const result = results[index];
    const tasks = result === undefined ? [] : AsyncResult.getOrElse(result, () => null)?.tasks;
    for (const task of tasks ?? []) {
      if (task.enabled && task.threadId !== null) {
        keys.add(scopedThreadKey(scopeThreadRef(environmentId, task.threadId)));
      }
    }
  });
  return keys;
}
