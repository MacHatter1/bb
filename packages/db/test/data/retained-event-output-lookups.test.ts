import { turnScope } from "@bb/domain";
import { describe, expect, it } from "vitest";
import { insertEvents, listStoredEventRows } from "../../src/data/events.js";
import { upsertHost } from "../../src/data/hosts.js";
import { createProject } from "../../src/data/projects.js";
import {
  canHydrateRetainedEventOutputRowsWithinDataByteLimit,
  hydrateRetainedEventOutputRows,
  hydrateRetainedEventOutputRowsWithinDataByteLimit,
} from "../../src/data/retained-event-outputs.js";
import {
  COMPLETED_EVENT_OUTPUT_RETENTION_MS,
  COMPLETED_EVENT_OUTPUT_TRUNCATION_THRESHOLD_CHARS,
} from "../../src/retained-event-output.js";
import { createThread } from "../../src/data/threads.js";
import { noopNotifier } from "../../src/notifier.js";
import { createMigratedConnection } from "../helpers/migrated-connection.js";
import type {
  CreateConnectionOptions,
  SlowDbQueryLogFields,
} from "../../src/connection.js";

const NOW = 1_800_000_000_000;

function setup(options: CreateConnectionOptions = {}) {
  const db = createMigratedConnection(options);
  const host = upsertHost(db, noopNotifier, { name: "lookup-host" });
  const { project } = createProject(db, noopNotifier, {
    name: "lookup-project",
    source: { type: "local_path", hostId: host.id, path: "/tmp/lookup" },
  });
  const thread = createThread(db, noopNotifier, {
    projectId: project.id,
    providerId: "codex",
  });
  return { db, thread };
}

function insertCommandEvent(
  db: ReturnType<typeof setup>["db"],
  args: { output: string; sequence: number; threadId: string; turnId: string },
): void {
  insertEvents(db, noopNotifier, [
    {
      createdAt: NOW,
      data: JSON.stringify({
        item: {
          aggregatedOutput: args.output,
          approvalStatus: null,
          command: "cat file",
          cwd: "/tmp/lookup",
          exitCode: 0,
          id: `command-${args.sequence}`,
          status: "completed",
          type: "commandExecution",
        },
      }),
      itemId: `command-${args.sequence}`,
      itemKind: "commandExecution",
      parentToolCallId: null,
      scope: turnScope(args.turnId),
      sequence: args.sequence,
      threadId: args.threadId,
      type: "item/completed",
    },
  ]);
}

function insertSmallEvents(
  db: ReturnType<typeof setup>["db"],
  args: { count: number; threadId: string },
): void {
  insertEvents(
    db,
    noopNotifier,
    Array.from({ length: args.count }, (_, index) => ({
      createdAt: NOW,
      data: JSON.stringify({ text: `message ${index}` }),
      itemId: null,
      itemKind: null,
      parentToolCallId: null,
      scope: turnScope("turn-small"),
      sequence: index + 1,
      threadId: args.threadId,
      type: "turn/started" as const,
    })),
  );
}

function readAggregatedOutput(data: string): unknown {
  const parsed: unknown = JSON.parse(data);
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const item = (parsed as { item?: unknown }).item;
  if (typeof item !== "object" || item === null) return undefined;
  return (item as { aggregatedOutput?: unknown }).aggregatedOutput;
}

describe("retained event output lookups", () => {
  it("hydrates nothing with a single lookup when no outputs are retained", () => {
    let executions = 0;
    const { db, thread } = setup({
      slowQueryLogger: {
        info(_fields: SlowDbQueryLogFields, _message: string): void {
          executions += 1;
        },
      },
      slowQueryThresholdMs: 0,
    });
    try {
      insertSmallEvents(db, { count: 250, threadId: thread.id });
      const rows = listStoredEventRows(db, { threadId: thread.id });
      expect(rows).toHaveLength(250);

      executions = 0;
      expect(hydrateRetainedEventOutputRows(db, rows, NOW)).toEqual(rows);
      expect(executions).toBe(1);

      executions = 0;
      expect(
        hydrateRetainedEventOutputRowsWithinDataByteLimit(
          db,
          rows,
          4 * 1024 * 1024,
          NOW,
        ),
      ).toEqual(rows);
      expect(executions).toBeLessThanOrEqual(2);
    } finally {
      db.$client.close();
    }
  });

  it.each([10, 899, 949])(
    "hydrates live outputs among %i other rows without redundant lookups",
    (count) => {
      let executions = 0;
      const { db, thread } = setup({
        slowQueryLogger: {
          info(_fields: SlowDbQueryLogFields, _message: string): void {
            executions += 1;
          },
        },
        slowQueryThresholdMs: 0,
      });
      try {
        const output = `head-${"x".repeat(COMPLETED_EVENT_OUTPUT_TRUNCATION_THRESHOLD_CHARS)}-tail`;
        insertSmallEvents(db, { count, threadId: thread.id });
        insertCommandEvent(db, {
          output,
          sequence: count + 1,
          threadId: thread.id,
          turnId: "turn-live",
        });
        const rows = listStoredEventRows(db, { threadId: thread.id });
        const stored = rows.find((row) => row.itemKind === "commandExecution");
        if (!stored) throw new Error("Expected stored command event");
        expect(readAggregatedOutput(stored.data)).not.toBe(output);

        executions = 0;
        const hydrated = hydrateRetainedEventOutputRows(db, rows, NOW).find(
          (row) => row.id === stored.id,
        );
        expect(executions).toBeLessThanOrEqual(Math.ceil(rows.length / 900));
        expect(hydrated && readAggregatedOutput(hydrated.data)).toBe(output);

        const [expired] = hydrateRetainedEventOutputRows(
          db,
          [stored],
          NOW + COMPLETED_EVENT_OUTPUT_RETENTION_MS + 1,
        );
        expect(expired?.data).toBe(stored.data);

        expect(
          canHydrateRetainedEventOutputRowsWithinDataByteLimit(
            db,
            rows,
            4 * 1024 * 1024,
            NOW,
          ),
        ).toBe(true);
        executions = 0;
        expect(
          hydrateRetainedEventOutputRowsWithinDataByteLimit(
            db,
            rows,
            4 * 1024 * 1024,
            NOW,
          ).find((row) => row.id === stored.id),
        ).toEqual(hydrated);
        expect(executions).toBeLessThanOrEqual(
          2 * Math.ceil(rows.length / 900),
        );
      } finally {
        db.$client.close();
      }
    },
  );

  it("keeps the byte-budget refusal when no outputs are retained", () => {
    let executions = 0;
    const { db, thread } = setup({
      slowQueryLogger: {
        info(_fields: SlowDbQueryLogFields, _message: string): void {
          executions += 1;
        },
      },
      slowQueryThresholdMs: 0,
    });
    try {
      insertSmallEvents(db, { count: 3, threadId: thread.id });
      const rows = listStoredEventRows(db, { threadId: thread.id });
      const storedBytes = rows.reduce(
        (total, row) => total + Buffer.byteLength(row.data),
        0,
      );
      expect(
        canHydrateRetainedEventOutputRowsWithinDataByteLimit(
          db,
          rows,
          storedBytes,
          NOW,
        ),
      ).toBe(true);
      executions = 0;
      expect(
        canHydrateRetainedEventOutputRowsWithinDataByteLimit(
          db,
          rows,
          storedBytes - 1,
          NOW,
        ),
      ).toBe(false);
      expect(executions).toBe(0);
      expect(
        hydrateRetainedEventOutputRowsWithinDataByteLimit(
          db,
          rows,
          storedBytes - 1,
          NOW,
        ),
      ).toEqual(rows);
      expect(executions).toBe(0);
    } finally {
      db.$client.close();
    }
  });

  it("bounds queries for multi-batch reads", () => {
    let executions = 0;
    const { db, thread } = setup({
      slowQueryLogger: {
        info(_fields: SlowDbQueryLogFields, _message: string): void {
          executions += 1;
        },
      },
      slowQueryThresholdMs: 0,
    });
    try {
      insertSmallEvents(db, { count: 950, threadId: thread.id });
      const rows = listStoredEventRows(db, { threadId: thread.id });
      expect(rows).toHaveLength(950);

      executions = 0;
      expect(hydrateRetainedEventOutputRows(db, rows, NOW)).toEqual(rows);
      expect(executions).toBeLessThanOrEqual(2);
    } finally {
      db.$client.close();
    }
  });
});
