import { describe, expect, it } from "vitest";
import { threadScope } from "@bb/domain";
import type { ThreadEventType } from "@bb/domain";
import {
  insertEvents,
  listStoredEventRows,
  listStoredEventRowsSingleQuery,
} from "../../src/data/events.js";
import type { ListStoredEventRowsArgs } from "../../src/data/events.js";
import { upsertHost } from "../../src/data/hosts.js";
import { createProject } from "../../src/data/projects.js";
import { createThread } from "../../src/data/threads.js";
import { noopNotifier } from "../../src/notifier.js";
import { createMigratedConnection } from "../helpers/migrated-connection.js";
import type {
  CreateConnectionOptions,
  SlowDbQueryLogFields,
} from "../../src/connection.js";

const TIMELINE_CONTEXT_TYPES = [
  "client/turn/requested",
  "client/turn/rejected",
  "turn/input/accepted",
  "turn/started",
  "turn/completed",
  "system/thread/interrupted",
] as const satisfies readonly ThreadEventType[];

const OTHER_TYPES = [
  "item/completed",
  "thread/compacted",
] as const satisfies readonly ThreadEventType[];

function setup(options: CreateConnectionOptions = {}) {
  const db = createMigratedConnection(options);
  const host = upsertHost(db, noopNotifier, { name: "single-query-host" });
  const { project } = createProject(db, noopNotifier, {
    name: "single-query-project",
    source: { type: "local_path", hostId: host.id, path: "/tmp/single-query" },
  });
  const source = createThread(db, noopNotifier, {
    projectId: project.id,
    providerId: "codex",
  });
  const other = createThread(db, noopNotifier, {
    projectId: project.id,
    providerId: "codex",
  });
  const rotation = [...TIMELINE_CONTEXT_TYPES, ...OTHER_TYPES];
  insertEvents(
    db,
    noopNotifier,
    Array.from({ length: 56 }, (_, index) => ({
      createdAt: 1_700_000_000_000 + index,
      data: "{}",
      itemId: null,
      itemKind: null,
      parentToolCallId: null,
      scope: threadScope(),
      sequence: index + 1,
      threadId: source.id,
      type: rotation[index % rotation.length],
    })),
  );
  insertEvents(
    db,
    noopNotifier,
    [...TIMELINE_CONTEXT_TYPES].map((type, index) => ({
      createdAt: 1_700_000_000_000 + index,
      data: "{}",
      itemId: null,
      itemKind: null,
      parentToolCallId: null,
      scope: threadScope(),
      sequence: index + 1,
      threadId: other.id,
      type,
    })),
  );
  return { db, source, other };
}

function expectSameRows(
  db: ReturnType<typeof setup>["db"],
  args: ListStoredEventRowsArgs,
): void {
  expect(listStoredEventRowsSingleQuery(db, args)).toEqual(
    listStoredEventRows(db, args),
  );
}

describe("listStoredEventRowsSingleQuery", () => {
  it("matches the per-type lister without a type filter", () => {
    const { db, source } = setup();
    try {
      expectSameRows(db, { threadId: source.id });
      expectSameRows(db, { threadId: source.id, order: "desc", limit: 7 });
      expectSameRows(db, {
        threadId: source.id,
        afterSequence: 10,
        beforeSequence: 40,
      });
    } finally {
      db.$client.close();
    }
  });

  it("matches the per-type lister for multi-type windows", () => {
    const { db, source } = setup();
    try {
      const types = [...TIMELINE_CONTEXT_TYPES];
      expectSameRows(db, { threadId: source.id, types });
      expectSameRows(db, {
        threadId: source.id,
        types,
        afterSequence: 5,
        beforeSequence: 50,
      });
      expectSameRows(db, { threadId: source.id, types, limit: 5 });
      expectSameRows(db, {
        threadId: source.id,
        types,
        limit: 5,
        order: "desc",
      });
      expectSameRows(db, {
        threadId: source.id,
        types: [...types, ...types],
      });
    } finally {
      db.$client.close();
    }
  });

  it("matches the per-type lister for narrow and empty selections", () => {
    const { db, source, other } = setup();
    try {
      expectSameRows(db, {
        threadId: source.id,
        types: ["turn/started"],
      });
      expectSameRows(db, { threadId: source.id, types: [] });
      expectSameRows(db, {
        threadId: source.id,
        types: [...TIMELINE_CONTEXT_TYPES],
        afterSequence: 10_000,
      });
      expectSameRows(db, {
        threadId: source.id,
        types: [...TIMELINE_CONTEXT_TYPES],
        afterSequence: 20,
        beforeSequence: 21,
      });
      expectSameRows(db, { threadId: other.id });
      expectSameRows(db, {
        threadId: other.id,
        types: [...TIMELINE_CONTEXT_TYPES],
      });
    } finally {
      db.$client.close();
    }
  });

  it("issues one query where the per-type lister issues one per type", () => {
    let executions = 0;
    const slowQueryLogger = {
      info(_fields: SlowDbQueryLogFields, _message: string): void {
        executions += 1;
      },
    };
    const { db, source } = setup({
      slowQueryLogger,
      slowQueryThresholdMs: 0,
    });
    try {
      const args = {
        threadId: source.id,
        types: [...TIMELINE_CONTEXT_TYPES],
        afterSequence: 5,
        beforeSequence: 50,
      } satisfies ListStoredEventRowsArgs;
      executions = 0;
      listStoredEventRowsSingleQuery(db, args);
      expect(executions).toBe(1);
      executions = 0;
      listStoredEventRowsSingleQuery(db, { threadId: source.id });
      expect(executions).toBe(1);
      executions = 0;
      listStoredEventRows(db, args);
      expect(executions).toBe(TIMELINE_CONTEXT_TYPES.length);
    } finally {
      db.$client.close();
    }
  });
});
