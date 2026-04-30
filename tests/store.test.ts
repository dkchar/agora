import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

import { AgoraStore } from "../src/index.js";

const tempRoots: string[] = [];

function createRoot() {
  const root = mkdtempSync(path.join(tmpdir(), "agora-"));
  tempRoots.push(root);
  return root;
}

function resolveTsxCli() {
  const candidates = [
    path.resolve(import.meta.dirname, "..", "node_modules", "tsx", "dist", "cli.mjs"),
    path.resolve(import.meta.dirname, "..", "..", "..", "node_modules", "tsx", "dist", "cli.mjs"),
  ];
  const match = candidates.find((candidate) => existsSync(candidate));
  if (!match) {
    throw new Error(`Unable to find tsx CLI. Tried: ${candidates.join(", ")}`);
  }
  return match;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("AgoraStore", () => {
  it("persists tickets and append-only events", () => {
    const root = createRoot();
    const store = new AgoraStore({ root });

    const ticket = store.createTicket({
      title: "Build UI",
      body: "Implement todo shell.",
      kind: "feature",
      column: "ready",
      scope: ["src/App.tsx"],
      actor: "human",
    }, "2026-04-30T12:00:00.000Z");

    const reloaded = new AgoraStore({ root }).listTickets();
    expect(reloaded).toHaveLength(1);
    expect(reloaded[0]).toMatchObject({
      id: ticket.id,
      title: "Build UI",
      column: "ready",
      scope: ["src/App.tsx"],
    });

    const events = readFileSync(path.join(root, ".agora", "events.jsonl"), "utf8")
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as { action: string; ticketId: string | null });
    expect(events.map((event) => event.action)).toEqual(["initialized", "created"]);
    expect(events[1]?.ticketId).toBe(ticket.id);
  });

  it("imports phased plans as ready and blocked parallel tickets", () => {
    const root = createRoot();
    const store = new AgoraStore({ root });

    const tickets = store.importPlan({
      title: "Animated todo app",
      tickets: [
        {
          key: "setup",
          title: "Setup app",
          body: "Create Vite app.",
          sprint: "sprint-1",
          phase: "setup",
          scope: ["package.json"],
        },
        {
          key: "domain",
          title: "Domain model",
          body: "Create todo domain.",
          sprint: "sprint-1",
          phase: "core",
          scope: ["src/domain/todo.ts"],
          dependsOn: ["setup"],
        },
        {
          key: "ui",
          title: "Todo UI",
          body: "Create UI.",
          sprint: "sprint-1",
          phase: "ui",
          scope: ["src/App.tsx"],
          dependsOn: ["setup"],
        },
      ],
    }, "agent");

    expect(tickets.map((ticket) => [ticket.title, ticket.column])).toEqual([
      ["Setup app", "ready"],
      ["Domain model", "blocked"],
      ["Todo UI", "blocked"],
    ]);

    const setup = tickets[0]!;
    store.moveTicket({
      ticketId: setup.id,
      to: "in_progress",
      actor: "agent",
      reason: "Start setup.",
    });
    store.moveTicket({
      ticketId: setup.id,
      to: "in_review",
      actor: "agent",
      reason: "Setup implemented.",
    });
    store.moveTicket({
      ticketId: setup.id,
      to: "ready_to_merge",
      actor: "agent",
      reason: "Review passed.",
    });
    store.moveTicket({
      ticketId: setup.id,
      to: "done",
      actor: "agent",
      reason: "Merged.",
    });

    const board = store.board();
    expect(board.columns.ready.map((ticket) => ticket.title).sort()).toEqual([
      "Domain model",
      "Todo UI",
    ]);
  });

  it("allows agent autonomy inside legal transitions and rejects illegal force", () => {
    const root = createRoot();
    const store = new AgoraStore({ root });
    const ticket = store.createTicket({
      title: "Fix bug",
      body: "Patch behavior.",
      kind: "bug",
      column: "ready",
      actor: "agent",
    });

    expect(store.moveTicket({
      ticketId: ticket.id,
      to: "in_progress",
      actor: "agent",
      reason: "Claim work.",
    }).column).toBe("in_progress");

    expect(() => store.moveTicket({
      ticketId: ticket.id,
      to: "done",
      actor: "agent",
      reason: "Skip lifecycle.",
    })).toThrow(/Illegal Agora transition/);

    expect(() => store.moveTicket({
      ticketId: ticket.id,
      to: "done",
      actor: "agent",
      reason: "Force skip.",
      force: true,
    })).toThrow(/Agent moves cannot use force/);

    expect(store.moveTicket({
      ticketId: ticket.id,
      to: "done",
      actor: "human",
      reason: "Manual override.",
      force: true,
    }).column).toBe("done");
  });

  it("halts repeated movement loops before unbounded rework", () => {
    const root = createRoot();
    const store = new AgoraStore({ root });
    const ticket = store.createTicket({
      title: "Review loop",
      body: "Exercise rework loop detection.",
      column: "in_review",
      actor: "seed",
      scope: ["src/App.tsx"],
    });

    let current = store.moveTicket({
      ticketId: ticket.id,
      to: "in_progress",
      actor: "agent",
      reason: "Same review finding.",
      reasonKind: "same_finding",
    });
    expect(current.column).toBe("in_progress");
    current = store.moveTicket({
      ticketId: ticket.id,
      to: "in_review",
      actor: "agent",
      reason: "Try again.",
      reasonKind: "retry_review",
    });
    expect(current.column).toBe("in_review");
    current = store.moveTicket({
      ticketId: ticket.id,
      to: "in_progress",
      actor: "agent",
      reason: "Same review finding.",
      reasonKind: "same_finding",
    });
    expect(current.column).toBe("in_progress");
    current = store.moveTicket({
      ticketId: ticket.id,
      to: "in_review",
      actor: "agent",
      reason: "Try again.",
      reasonKind: "retry_review",
    });
    expect(current.column).toBe("in_review");
    current = store.moveTicket({
      ticketId: ticket.id,
      to: "in_progress",
      actor: "agent",
      reason: "Same review finding.",
      reasonKind: "same_finding",
    });

    expect(current.column).toBe("halted");
    expect(current.attempts.loop).toBe(1);
  });

  it("attaches artifacts and leases tickets for caste work", () => {
    const root = createRoot();
    const store = new AgoraStore({ root });
    const ticket = store.createTicket({
      title: "Implement",
      body: "Do work.",
      column: "ready",
      actor: "human",
    });

    const leased = store.leaseTicket({
      ticketId: ticket.id,
      caste: "titan",
      sessionId: "session-1",
      actor: "agent",
      now: "2026-04-30T12:00:00.000Z",
    });
    expect(leased.lease).toMatchObject({
      caste: "titan",
      sessionId: "session-1",
      startedAt: "2026-04-30T12:00:00.000Z",
    });

    const withArtifact = store.attachArtifact({
      ticketId: ticket.id,
      key: "titan",
      ref: ".agora/artifacts/titan.json",
      actor: "agent",
    });
    expect(withArtifact.artifacts.titan).toBe(".agora/artifacts/titan.json");
  });

  it("supports the built CLI entrypoint for agent plan import", () => {
    const root = createRoot();
    const cliPath = path.resolve(import.meta.dirname, "..", "src", "cli.ts");
    const tsxPath = resolveTsxCli();
    const planPath = path.join(root, "plan.json");
    writeFileSync(planPath, JSON.stringify({
      title: "CLI plan",
      tickets: [
        { key: "a", title: "A", body: "A", dependsOn: [] },
        { key: "b", title: "B", body: "B", dependsOn: ["a"] },
      ],
    }), "utf8");

    execFileSync(process.execPath, [
      tsxPath,
      cliPath,
      "plan",
      planPath,
      "--root",
      root,
      "--actor",
      "agent",
      "--json",
    ], { stdio: "pipe" });
    const boardOutput = execFileSync(process.execPath, [
      tsxPath,
      cliPath,
      "board",
      "--root",
      root,
      "--json",
    ], { encoding: "utf8" });
    const board = JSON.parse(boardOutput) as { columns: { ready: unknown[]; blocked: unknown[] } };

    expect(board.columns.ready).toHaveLength(1);
    expect(board.columns.blocked).toHaveLength(1);
  });
});
