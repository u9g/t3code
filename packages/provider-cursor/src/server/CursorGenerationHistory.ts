// @effect-diagnostics nodeBuiltinImport:off -- Cursor's native SQLite/protobuf history is a provider boundary; source databases are always read-only.
import * as NodeCrypto from "node:crypto";
import * as NodeSqlite from "node:sqlite";
import type { UsageRecord } from "@t3tools/provider-core/server/usage";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";
import { cursorRateModel } from "./accountUsage.ts";

export interface CursorGenerationRequest {
  readonly runId: string;
  readonly agentId: string;
  readonly workspaceRef: string;
  readonly startedAtMs: number;
  readonly completedAtMs: number;
}
export interface CursorGenerationSample {
  readonly runId: string;
  readonly timestampMs: number;
  readonly outputTokens: number;
  readonly generationMs: number;
}
interface ReadInput {
  readonly requests: readonly CursorGenerationRequest[];
  readonly billingRecords: readonly UsageRecord[];
  readonly homeDirectories: readonly string[];
}
interface NativeTiming {
  readonly request: CursorGenerationRequest;
  readonly model: string;
  readonly startedAtMs: number;
  readonly completedAtMs: number;
  readonly timestampMs: number;
  readonly generationMs: number;
  readonly usage: TokenCounts;
}
type TokenCounts = readonly [input: number, output: number, cacheRead: number, cacheWrite: number];
type Interval = readonly [number, number];
type ProtoField = { readonly number: number; readonly value: bigint | Uint8Array };
const parseJson = (raw: string): unknown => JSON.parse(raw);
const encodeJson = (value: unknown): string => JSON.stringify(value);
class NativeHistoryError extends Schema.TaggedError<
  NativeHistoryError,
  { readonly brand: unique symbol }
>()("NativeHistoryError", { message: Schema.String }) {}
const invalidHistory = (message: string) => new NativeHistoryError({ message });
const hash = (value: string | Uint8Array) =>
  NodeCrypto.createHash("sha256").update(value).digest("hex");
const identity = (request: CursorGenerationRequest) =>
  encodeJson([request.runId, request.agentId, request.workspaceRef]);
const object = (value: unknown): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw invalidHistory("Invalid native object");
  return value as Record<string, unknown>;
};
const text = (value: unknown): string => {
  if (typeof value !== "string" || !value) throw invalidHistory("Missing native identity");
  return value;
};
const timestamp = (value: unknown): number => {
  const result = typeof value === "string" ? Date.parse(value) : NaN;
  if (!Number.isSafeInteger(result)) throw invalidHistory("Invalid native timestamp");
  return result;
};
const count = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw invalidHistory("Invalid token count");
  return value;
};
const safeBillingKey = (record: UsageRecord): string | undefined => {
  try {
    return encodeJson([
      record.timestampMs,
      record.sessionId,
      record.model,
      billingCounts(record),
      count(record.totals.reasoningTokens),
    ]);
  } catch {
    return undefined;
  }
};
const sameCounts = (a: TokenCounts, b: TokenCounts) => a.every((value, i) => value === b[i]);
const billingCounts = (record: UsageRecord): TokenCounts => [
  count(record.totals.uncachedInputTokens) +
    count(record.totals.cachedInputTokens) +
    count(record.totals.cacheCreationTokens),
  count(record.totals.outputTokens),
  count(record.totals.cachedInputTokens),
  count(record.totals.cacheCreationTokens),
];
const parseProto = (data: Uint8Array): readonly ProtoField[] => {
  let offset = 0;
  const varint = () => {
    let value = 0n;
    for (let i = 0; i < 10; i++) {
      const byte = data[offset++];
      if (byte === undefined || (i === 9 && byte > 1))
        throw invalidHistory("Invalid protobuf integer");
      value |= BigInt(byte & 127) << BigInt(i * 7);
      if (!(byte & 128)) return value;
    }
    throw invalidHistory("Invalid protobuf integer");
  };
  const result: ProtoField[] = [];
  while (offset < data.length) {
    const tag = varint();
    const number = Number(tag >> 3n);
    const wire = Number(tag & 7n);
    if (!number || number > 0x1fffffff) throw invalidHistory("Invalid protobuf tag");
    if (wire === 0) {
      result.push({ number, value: varint() });
      continue;
    }
    const length = wire === 2 ? Number(varint()) : wire === 1 ? 8 : wire === 5 ? 4 : -1;
    if (!Number.isSafeInteger(length) || length < 0 || length > data.length - offset)
      throw invalidHistory("Invalid protobuf field");
    result.push({ number, value: data.subarray(offset, offset + length) });
    offset += length;
  }
  return result;
};
const all = (fields: readonly ProtoField[], number: number) =>
  fields.filter((field) => field.number === number);
const one = (fields: readonly ProtoField[], number: number): bigint | Uint8Array | undefined => {
  const values = all(fields, number);
  if (values.length > 1) throw invalidHistory("Duplicate native field");
  return values[0]?.value;
};
const binary = (value: bigint | Uint8Array | undefined): Uint8Array => {
  if (!(value instanceof Uint8Array)) throw invalidHistory("Missing native bytes");
  return value;
};
const clock = (fields: readonly ProtoField[], number: number): number => {
  const value = one(fields, number);
  if (typeof value !== "bigint" || value <= 0 || value > BigInt(Number.MAX_SAFE_INTEGER))
    throw invalidHistory("Missing native clock");
  return Number(value);
};
const unionMs = (intervals: readonly Interval[]) => {
  const sorted = [...intervals].sort((a, b) => a[0] - b[0]);
  let total = 0;
  let start: number | undefined;
  let end = 0;
  for (const interval of sorted) {
    if (start === undefined) {
      [start, end] = interval;
      continue;
    }
    if (interval[0] <= end) end = Math.max(end, interval[1]);
    else {
      total += end - start;
      [start, end] = interval;
    }
  }
  return total + (start === undefined ? 0 : end - start);
};

/** Reconstructs estimated model time; it includes orchestration between model requests. */
export const make = Effect.fn("CursorGenerationHistory.make")(function* (
  options: { readonly cachePath?: string } = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  const lock = yield* Semaphore.make(1);
  const timingCache = new Map<string, NativeTiming>();
  const locations = new Map<string, string>();
  const recovered = new Map<
    string,
    { readonly request: CursorGenerationRequest; readonly sample: CursorGenerationSample }
  >();
  const directories = new Map<
    string,
    { readonly version: string; readonly entries: readonly string[] }
  >();
  let loaded = false;
  let dirty = false;
  const list = Effect.fn("CursorGenerationHistory.list")(function* (directory: string) {
    return yield* Effect.gen(function* () {
      const info = yield* fs.stat(directory);
      const version = `${Option.getOrUndefined(info.ino)}:${info.size}:${Option.getOrUndefined(info.mtime)?.getTime()}`;
      const cached = directories.get(directory);
      if (cached?.version === version) return cached.entries;
      const entries = yield* fs.readDirectory(directory);
      directories.set(directory, { version, entries });
      return entries;
    }).pipe(Effect.catchCause(() => Effect.succeed([] as readonly string[])));
  });
  const indexes = Effect.fn("CursorGenerationHistory.indexes")(function* (
    request: CursorGenerationRequest,
    homes: readonly string[],
  ) {
    const found = new Set<string>();
    const projectName = request.workspaceRef
      .replace(/[^a-zA-Z0-9]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-+|-+$/g, "");
    for (const home of homes) {
      const projects = path.join(home, ".cursor", "projects");
      const preferred = path.join(projects, projectName, "sdk-agent-store");
      const candidates = yield* list(preferred);
      for (const name of candidates) found.add(path.join(preferred, name, "index.db"));
      // Only fixed-depth project/store children: never recurse into unrelated Cursor files.
      for (const project of yield* list(projects)) {
        if (project === projectName) continue;
        const store = path.join(projects, project, "sdk-agent-store");
        for (const name of yield* list(store)) found.add(path.join(store, name, "index.db"));
      }
    }
    return [...found];
  });
  const readNative = Effect.fn("CursorGenerationHistory.readNative")(function* (
    indexPath: string,
    request: CursorGenerationRequest,
  ) {
    return yield* Effect.try({
      try: (): NativeTiming | undefined => {
        const db = new NodeSqlite.DatabaseSync(indexPath, { readOnly: true });
        try {
          const row = db
            .prepare(
              "SELECT r.*, a.workspace_ref FROM runs r JOIN agents a ON a.agent_id=r.agent_id WHERE r.run_id=?",
            )
            .get(request.runId);
          if (
            !row ||
            row.agent_id !== request.agentId ||
            row.workspace_ref !== request.workspaceRef ||
            row.status !== "FINISHED"
          )
            return;
          const startedAtMs = timestamp(row.started_at);
          const completedAtMs = timestamp(row.finished_at);
          if (
            completedAtMs <= startedAtMs ||
            request.completedAtMs < startedAtMs ||
            request.startedAtMs > completedAtMs
          )
            return;
          const requestId = text(row.request_id);
          const model = text(row.model);
          const ref = object(parseJson(text(row.latest_checkpoint_ref_json)));
          const rootId = text(ref.blobId);
          if (ref.storeKind !== "local-agent-store" || !/^[a-f0-9]{64}$/.test(rootId)) return;
          const usageObject = object(parseJson(text(row.usage_json)));
          const usage: TokenCounts = [
            count(usageObject.inputTokens),
            count(usageObject.outputTokens),
            count(usageObject.cacheReadTokens ?? 0),
            count(usageObject.cacheWriteTokens ?? 0),
          ];
          const cacheKey = encodeJson([
            indexPath,
            identity(request),
            rootId,
            requestId,
            startedAtMs,
            completedAtMs,
            request.startedAtMs,
            request.completedAtMs,
            model,
            usage,
          ]);
          const cached = timingCache.get(cacheKey);
          if (cached) return cached;
          const events = db
            .prepare("SELECT created_at,payload_json FROM run_events WHERE run_id=? ORDER BY seq")
            .all(request.runId);
          let lastAssistant: number | undefined;
          let summaryStart: number | undefined;
          let finished = false;
          const intervals: Interval[] = [];
          for (const event of events) {
            const envelope = object(parseJson(text(event.payload_json)));
            if (envelope.type !== "sdk_message") continue;
            if (envelope.runId !== request.runId || envelope.agentId !== request.agentId)
              throw invalidHistory("Mismatched saved event identity");
            const message = object(envelope.message);
            if (message.run_id !== request.runId || message.agent_id !== request.agentId)
              throw invalidHistory("Mismatched SDK event identity");
            const at = timestamp(event.created_at);
            if (at < startedAtMs || at > completedAtMs)
              throw invalidHistory("Event outside native run");
            if (message.type === "assistant") lastAssistant = at;
            if (message.type === "status" && message.status === "FINISHED") finished = true;
            if (message.type === "summary") {
              if (message.status === "running") {
                if (summaryStart !== undefined) throw invalidHistory("Overlapping compactions");
                summaryStart = at;
              } else if (message.status === "completed" || message.status === "error") {
                if (summaryStart === undefined || at < summaryStart)
                  throw invalidHistory("Incomplete compaction");
                intervals.push([summaryStart, at]);
                summaryStart = undefined;
              } else throw invalidHistory("Unknown compaction status");
            }
          }
          if (!finished || lastAssistant === undefined || summaryStart !== undefined) return;
          const end = lastAssistant;
          const storePath = path.join(
            path.dirname(indexPath),
            "agents",
            `agent-${hash(request.agentId)}`,
            "store.db",
          );
          const store = new NodeSqlite.DatabaseSync(storePath, { readOnly: true });
          try {
            const blobs = store.prepare("SELECT data FROM blobs WHERE id=?");
            const readBlob = (id: string) => {
              if (!/^[a-f0-9]{64}$/.test(id)) throw invalidHistory("Invalid native blob reference");
              const data = blobs.get(id)?.data;
              if (!(data instanceof Uint8Array) || hash(data) !== id)
                throw invalidHistory("Missing or corrupt native blob");
              return parseProto(data);
            };
            const follow = (ref: bigint | Uint8Array | undefined) => {
              const value = binary(ref);
              if (value.length !== 32) throw invalidHistory("Invalid native reference length");
              return readBlob(Buffer.from(value).toString("hex"));
            };
            let current: readonly ProtoField[] | undefined;
            for (const turnRef of all(readBlob(rootId), 8)) {
              const turn = follow(turnRef.value);
              const embedded = one(turn, 1);
              if (embedded === undefined) continue;
              const agentTurn = parseProto(binary(embedded));
              if (Buffer.from(binary(one(agentTurn, 3))).toString("utf8") !== requestId) continue;
              if (current) throw invalidHistory("Ambiguous native request");
              current = agentTurn;
            }
            if (!current) return;
            const start = clock(follow(one(current, 1)), 25);
            if (start < startedAtMs || start >= end) return;
            let assistants = 0;
            for (const stepRef of all(current, 2)) {
              const step = follow(stepRef.value);
              if ([1, 2, 3].filter((kind) => one(step, kind) !== undefined).length !== 1) return;
              const toolBytes = one(step, 2);
              const assistantBytes = one(step, 1);
              if (assistantBytes !== undefined) {
                const assistant = parseProto(binary(assistantBytes));
                const at = clock(assistant, 2);
                if (at < start || at > end) return;
                assistants++;
              }
              if (toolBytes === undefined) continue;
              const tool = parseProto(binary(toolBytes));
              if (one(tool, 19) !== undefined) return; // Task tools can contain nested model time.
              text(Buffer.from(binary(one(tool, 57))).toString("utf8"));
              const from = clock(tool, 59);
              const to = clock(tool, 60);
              if (from < start || to < from || to > end) return;
              intervals.push([from, to]);
            }
            if (!assistants || intervals.some(([from, to]) => from < start || to > end)) return;
            const generationMs = end - start - unionMs(intervals);
            if (generationMs <= 0) return;
            const result = {
              request,
              model,
              startedAtMs,
              completedAtMs,
              timestampMs: start,
              generationMs,
              usage,
            };
            timingCache.set(cacheKey, result);
            return result;
          } finally {
            store.close();
          }
        } finally {
          db.close();
        }
      },
      catch: () => invalidHistory("Unreadable Cursor native history"),
    }).pipe(Effect.catchCause(() => Effect.undefined));
  });
  const read = Effect.fn("CursorGenerationHistory.read")(function* (input: ReadInput) {
    if (!loaded) {
      loaded = true;
      if (options.cachePath)
        yield* fs.readFileString(options.cachePath).pipe(
          Effect.flatMap((raw) =>
            Effect.try({
              try: () => {
                const document = object(parseJson(raw));
                if (document.version !== 1 || !Array.isArray(document.samples)) return;
                for (const entry of document.samples) {
                  try {
                    const item = object(entry);
                    const r = object(item.request);
                    const s = object(item.sample);
                    const request: CursorGenerationRequest = {
                      runId: text(r.runId),
                      agentId: text(r.agentId),
                      workspaceRef: text(r.workspaceRef),
                      startedAtMs: count(r.startedAtMs),
                      completedAtMs: count(r.completedAtMs),
                    };
                    const sample: CursorGenerationSample = {
                      runId: text(s.runId),
                      timestampMs: count(s.timestampMs),
                      generationMs: count(s.generationMs),
                      outputTokens: count(s.outputTokens),
                    };
                    if (
                      sample.runId !== request.runId ||
                      !sample.generationMs ||
                      !sample.outputTokens ||
                      request.completedAtMs <= request.startedAtMs
                    )
                      continue;
                    recovered.set(identity(request), { request, sample });
                  } catch {
                    /* An invalid entry must not discard other recovered samples. */
                  }
                }
              },
              catch: () => invalidHistory("Unreadable Cursor generation cache"),
            }),
          ),
          Effect.ignoreCause,
        );
    }
    const unique = new Map<string, CursorGenerationRequest>();
    const invalid = new Set<string>();
    for (const request of input.requests) {
      if (
        typeof request.workspaceRef !== "string" ||
        !request.workspaceRef ||
        typeof request.agentId !== "string" ||
        !request.agentId ||
        typeof request.runId !== "string" ||
        !request.runId ||
        !Number.isSafeInteger(request.startedAtMs) ||
        !Number.isSafeInteger(request.completedAtMs) ||
        request.completedAtMs <= request.startedAtMs
      )
        continue;
      const previous = unique.get(request.runId);
      if (previous && identity(previous) !== identity(request)) invalid.add(request.runId);
      unique.set(request.runId, request);
    }
    const timings: NativeTiming[] = [];
    const samples = new Map<string, CursorGenerationSample>();
    for (const request of unique.values()) {
      if (invalid.has(request.runId)) continue;
      const cached = recovered.get(identity(request));
      if (
        cached &&
        cached.request.startedAtMs === request.startedAtMs &&
        cached.request.completedAtMs === request.completedAtMs
      )
        samples.set(request.runId, cached.sample);
      const matches: NativeTiming[] = [];
      const locationKey = encodeJson([identity(request), input.homeDirectories]);
      const projectName = request.workspaceRef
        .replace(/[^a-zA-Z0-9]/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-+|-+$/g, "");
      const preferred = new Set(
        input.homeDirectories.map((home) =>
          path.join(
            home,
            ".cursor",
            "projects",
            projectName,
            "sdk-agent-store",
            hash(request.workspaceRef),
            "index.db",
          ),
        ),
      );
      const located = locations.get(locationKey);
      if (located) preferred.add(located);
      for (const indexPath of preferred) {
        const timing = yield* readNative(indexPath, request);
        if (timing) {
          matches.push(timing);
          locations.set(locationKey, indexPath);
        }
      }
      // A verified deterministic location avoids opening every unrelated native index.
      if (!matches.length)
        for (const indexPath of yield* indexes(request, input.homeDirectories)) {
          if (preferred.has(indexPath)) continue;
          const timing = yield* readNative(indexPath, request);
          if (timing) {
            matches.push(timing);
            locations.set(locationKey, indexPath);
          }
        }
      if (
        matches.length &&
        matches.every((candidate) => encodeJson(candidate) === encodeJson(matches[0]))
      )
        timings.push(matches[0]!);
      else if (matches.length) samples.delete(request.runId);
    }
    for (const timing of timings) {
      const rows = new Map<string, Map<string, Map<string, UsageRecord>>>();
      let ambiguous = false;
      for (const record of input.billingRecords) {
        if (
          record.provider !== "cursor" ||
          record.sessionId !== timing.request.agentId ||
          record.timestampMs < timing.startedAtMs ||
          record.timestampMs > timing.completedAtMs
        )
          continue;
        if (
          timings.some(
            (other) =>
              other.request.runId !== timing.request.runId &&
              other.request.agentId === record.sessionId &&
              record.timestampMs >= other.startedAtMs &&
              record.timestampMs <= other.completedAtMs,
          )
        )
          ambiguous = true;
        const key = safeBillingKey(record);
        if (key === undefined) ambiguous = true;
        else {
          const sources = rows.get(key) ?? new Map<string, Map<string, UsageRecord>>();
          // Scoped hashes differ across personal/team copies; occurrence suffixes preserve
          // legitimate repeated identical events within each source.
          const source = record.dedupeKey?.replace(/:[0-9]+$/, "") ?? "unkeyed";
          const occurrences = sources.get(source) ?? new Map<string, UsageRecord>();
          occurrences.set(record.dedupeKey ?? `${occurrences.size}`, record);
          sources.set(source, occurrences);
          rows.set(key, sources);
        }
      }
      const billing = [...rows.values()]
        .flatMap((sources) => {
          const largest = [...sources.values()].sort((a, b) => b.size - a.size)[0];
          return largest ? [...largest.values()] : [];
        })
        .sort((a, b) => a.timestampMs - b.timestampMs);
      if (
        ambiguous ||
        billing.some((record) => cursorRateModel(record.model) !== cursorRateModel(timing.model))
      ) {
        samples.delete(timing.request.runId);
        continue;
      }
      if (!billing.length) continue;
      const totals = billing.reduce<TokenCounts>(
        (sum, record) => {
          const values = billingCounts(record);
          return [sum[0] + values[0], sum[1] + values[1], sum[2] + values[2], sum[3] + values[3]];
        },
        [0, 0, 0, 0],
      );
      if (
        (!sameCounts(totals, timing.usage) &&
          !sameCounts(billingCounts(billing[billing.length - 1]!), timing.usage)) ||
        !Number.isSafeInteger(totals[1]) ||
        totals[1] <= 0
      )
        continue;
      const sample = {
        runId: timing.request.runId,
        timestampMs: timing.timestampMs,
        outputTokens: totals[1],
        generationMs: timing.generationMs,
      };
      samples.set(sample.runId, sample);
      const key = identity(timing.request);
      const value = { request: timing.request, sample };
      if (encodeJson(recovered.get(key)) !== encodeJson(value)) {
        recovered.set(key, value);
        dirty = true;
      }
    }
    if (dirty && options.cachePath) {
      yield* writeFileStringAtomically({
        filePath: options.cachePath,
        contents: encodeJson({ version: 1, samples: [...recovered.values()] }),
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
        Effect.provideService(HostProcess.Platform, platform),
        Effect.tap(() =>
          Effect.sync(() => {
            dirty = false;
          }),
        ),
        Effect.ignoreCause,
      );
    }
    return [...samples.values()];
  }, lock.withPermit);
  return { read };
});
