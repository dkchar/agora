import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import {
  AGORA_ACTORS,
  AGORA_COLUMNS,
  AGORA_KINDS,
  type AgoraActor,
  type AgoraBoard,
  type AgoraColumn,
  type AgoraEvent,
  type AgoraEventAction,
  type AgoraKind,
  type AgoraPlanInput,
  type AgoraSnapshot,
  type AgoraTicket,
  type AttachArtifactInput,
  type CreateTicketInput,
  type LeaseTicketInput,
  type MoveTicketInput,
} from "./types.js";

export interface AgoraStoreOptions {
  root?: string;
  dir?: string;
}

export interface InstallAgentInstructionsInput {
  targets?: string[];
  actor?: AgoraActor;
}

export interface InstallAgentInstructionsResult {
  updated: string[];
  skipped: string[];
}

const DEFAULT_DIR = ".agora";
const LOOP_SIGNATURE_LIMIT = 3;
const DEFAULT_AGENT_INSTRUCTION_TARGETS = [
  "AGENTS.md",
  "CLAUDE.md",
  ".codex/AGENTS.md",
  ".codex/CLAUDE.md",
];
const AGORA_INSTRUCTIONS_START = "<!-- AGORA:START -->";
const AGORA_INSTRUCTIONS_END = "<!-- AGORA:END -->";
const AGORA_INSTRUCTIONS_BLOCK = `${AGORA_INSTRUCTIONS_START}
## Agora

Use Agora for persistent local ticket tracking.

- Inspect the board with \`agora board --json\`.
- List tickets with \`agora list --json\`.
- Create tickets with \`agora create --title "..." --body "..." --kind task --actor agent --json\`.
- Move tickets with \`agora move <id> <column> --reason "..." --actor agent --json\`.
- Import decomposed plans with \`agora plan plan.json --actor agent --json\`.
- Do not edit \`.agora/tickets.json\` directly; use the CLI/API so events are recorded.
- Agents may move tickets through legal lifecycle transitions. Humans may use \`--force\` for manual overrides.

Columns: backlog, ready, in_progress, in_review, blocked, ready_to_merge, done, halted.
${AGORA_INSTRUCTIONS_END}`;
const LEGAL_TRANSITIONS: ReadonlySet<string> = new Set([
  "backlog->ready",
  "ready->in_progress",
  "in_progress->in_review",
  "in_review->in_progress",
  "in_review->blocked",
  "in_review->ready_to_merge",
  "ready_to_merge->done",
  "blocked->ready",
]);

function assertString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Expected ${field} to be a non-empty string.`);
  }
  return value.trim();
}

function assertColumn(value: unknown): AgoraColumn {
  if (!AGORA_COLUMNS.includes(value as AgoraColumn)) {
    throw new Error(`Invalid Agora column "${String(value)}".`);
  }
  return value as AgoraColumn;
}

function assertKind(value: unknown): AgoraKind {
  if (!AGORA_KINDS.includes(value as AgoraKind)) {
    throw new Error(`Invalid Agora kind "${String(value)}".`);
  }
  return value as AgoraKind;
}

function assertActor(value: unknown): AgoraActor {
  if (!AGORA_ACTORS.includes(value as AgoraActor)) {
    throw new Error(`Invalid Agora actor "${String(value)}".`);
  }
  return value as AgoraActor;
}

function normalizeStringList(value: unknown, field: string): string[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error(`Expected ${field} to be an array.`);
  }
  return [...new Set(value.map((entry, index) =>
    assertString(entry, `${field}[${index}]`).replace(/\\/g, "/")))].sort();
}

function atomicWriteJson(filePath: string, value: unknown): void {
  const tmpPath = `${filePath}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(tmpPath, filePath);
}

function emptySnapshot(): AgoraSnapshot {
  return {
    schema: "agora.tickets.v1",
    nextId: 1,
    tickets: {},
  };
}

function createTicketId(nextId: number): string {
  return `AG-${String(nextId).padStart(4, "0")}`;
}

function createLease(): AgoraTicket["lease"] {
  return {
    caste: null,
    sessionId: null,
    startedAt: null,
  };
}

function nowIso(now?: string): string {
  return now ?? new Date().toISOString();
}

function isDone(snapshot: AgoraSnapshot, ticketId: string): boolean {
  return snapshot.tickets[ticketId]?.column === "done";
}

function canMove(from: AgoraColumn, to: AgoraColumn): boolean {
  return to === "halted" || LEGAL_TRANSITIONS.has(`${from}->${to}`);
}

function normalizeReasonKind(input: MoveTicketInput): string {
  return (input.reasonKind ?? input.reason).toLowerCase().replace(/\s+/g, "_").slice(0, 80);
}

function createLoopSignature(ticket: AgoraTicket, input: MoveTicketInput): string {
  const scope = [...ticket.scope].sort().join(",");
  return `${ticket.column}->${input.to}:${normalizeReasonKind(input)}:${scope}`;
}

function createEventId(eventsPath: string): number {
  if (!existsSync(eventsPath)) {
    return 1;
  }
  const raw = readFileSync(eventsPath, "utf8").trim();
  if (!raw) {
    return 1;
  }
  const lastLine = raw.split(/\r?\n/).at(-1);
  if (!lastLine) {
    return 1;
  }
  try {
    const parsed = JSON.parse(lastLine) as { id?: unknown };
    return typeof parsed.id === "number" ? parsed.id + 1 : 1;
  } catch {
    return 1;
  }
}

export class AgoraStore {
  readonly root: string;
  readonly dir: string;
  readonly storePath: string;
  readonly ticketsPath: string;
  readonly eventsPath: string;

  constructor(options: AgoraStoreOptions = {}) {
    this.root = path.resolve(options.root ?? process.cwd());
    this.dir = options.dir ?? DEFAULT_DIR;
    this.storePath = path.isAbsolute(this.dir) ? this.dir : path.join(this.root, this.dir);
    this.ticketsPath = path.join(this.storePath, "tickets.json");
    this.eventsPath = path.join(this.storePath, "events.jsonl");
  }

  init(actor: AgoraActor = "human"): AgoraSnapshot {
    mkdirSync(this.storePath, { recursive: true });
    const snapshot = existsSync(this.ticketsPath) ? this.load() : emptySnapshot();
    if (!existsSync(this.ticketsPath)) {
      this.save(snapshot);
    }
    if (!existsSync(this.eventsPath)) {
      writeFileSync(this.eventsPath, "", "utf8");
      this.appendEvent({
        actor,
        action: "initialized",
        ticketId: null,
        reason: "Initialized Agora store.",
      });
    }
    return snapshot;
  }

  load(): AgoraSnapshot {
    if (!existsSync(this.ticketsPath)) {
      return emptySnapshot();
    }
    const parsed = JSON.parse(readFileSync(this.ticketsPath, "utf8")) as AgoraSnapshot;
    if (parsed.schema !== "agora.tickets.v1" || typeof parsed.tickets !== "object") {
      throw new Error(`Invalid Agora snapshot at ${this.ticketsPath}.`);
    }
    return parsed;
  }

  save(snapshot: AgoraSnapshot): void {
    mkdirSync(this.storePath, { recursive: true });
    atomicWriteJson(this.ticketsPath, snapshot);
  }

  appendEvent(input: Omit<AgoraEvent, "schema" | "id" | "ts"> & { ts?: string }): AgoraEvent {
    mkdirSync(this.storePath, { recursive: true });
    const event: AgoraEvent = {
      schema: "agora.event.v1",
      id: createEventId(this.eventsPath),
      ts: input.ts ?? new Date().toISOString(),
      ticketId: input.ticketId,
      actor: assertActor(input.actor),
      action: input.action,
      reason: input.reason,
      ...(input.from ? { from: input.from } : {}),
      ...(input.to ? { to: input.to } : {}),
      ...(input.force !== undefined ? { force: input.force } : {}),
      ...(input.artifactRef ? { artifactRef: input.artifactRef } : {}),
      ...(input.metadata ? { metadata: input.metadata } : {}),
    };
    appendFileSync(this.eventsPath, `${JSON.stringify(event)}\n`, "utf8");
    return event;
  }

  listTickets(): AgoraTicket[] {
    return Object.values(this.load().tickets)
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  board(): AgoraBoard {
    const columns = Object.fromEntries(
      AGORA_COLUMNS.map((column) => [column, [] as AgoraTicket[]]),
    ) as AgoraBoard["columns"];
    for (const ticket of this.listTickets()) {
      columns[ticket.column].push(ticket);
    }
    return { columns };
  }

  createTicket(input: CreateTicketInput, now?: string): AgoraTicket {
    const actor = assertActor(input.actor);
    const timestamp = nowIso(now);
    const snapshot = this.init(actor);
    const id = createTicketId(snapshot.nextId);
    const blockedBy = normalizeStringList(input.blockedBy, "blockedBy");
    const column = blockedBy.length > 0
      ? "blocked"
      : assertColumn(input.column ?? "backlog");
    const ticket: AgoraTicket = {
      id,
      title: assertString(input.title, "title"),
      body: input.body ?? "",
      kind: assertKind(input.kind ?? "task"),
      column,
      sprint: input.sprint ?? null,
      phase: input.phase ?? null,
      parent: input.parent ?? null,
      children: [],
      blockedBy,
      blocks: [],
      scope: normalizeStringList(input.scope, "scope"),
      labels: normalizeStringList(input.labels, "labels"),
      createdBy: actor,
      createdAt: timestamp,
      updatedAt: timestamp,
      lease: createLease(),
      artifacts: {},
      attempts: {
        rework: 0,
        operational: 0,
        loop: 0,
      },
      loopSignatures: [],
    };

    const tickets = { ...snapshot.tickets, [id]: ticket };
    if (ticket.parent && tickets[ticket.parent]) {
      tickets[ticket.parent] = {
        ...tickets[ticket.parent],
        children: [...new Set([...tickets[ticket.parent].children, id])].sort(),
        updatedAt: timestamp,
      };
    }
    for (const blockerId of ticket.blockedBy) {
      if (tickets[blockerId]) {
        tickets[blockerId] = {
          ...tickets[blockerId],
          blocks: [...new Set([...tickets[blockerId].blocks, id])].sort(),
          updatedAt: timestamp,
        };
      }
    }

    this.save({
      schema: snapshot.schema,
      nextId: snapshot.nextId + 1,
      tickets,
    });
    this.appendEvent({
      actor,
      action: "created",
      ticketId: id,
      to: ticket.column,
      reason: "Ticket created.",
      metadata: { title: ticket.title, kind: ticket.kind },
    });
    return ticket;
  }

  moveTicket(input: MoveTicketInput, now?: string): AgoraTicket {
    const actor = assertActor(input.actor);
    const to = assertColumn(input.to);
    const snapshot = this.init(actor);
    const ticket = snapshot.tickets[input.ticketId];
    if (!ticket) {
      throw new Error(`Unknown Agora ticket "${input.ticketId}".`);
    }
    const force = input.force === true;
    if (force && actor === "agent") {
      throw new Error("Agent moves cannot use force.");
    }
    if (!force && !canMove(ticket.column, to)) {
      throw new Error(`Illegal Agora transition ${ticket.column}->${to} for ${ticket.id}.`);
    }

    const timestamp = nowIso(now);
    const signature = createLoopSignature(ticket, input);
    const loopSignatures = [...ticket.loopSignatures, signature].slice(-12);
    const repeatCount = loopSignatures.filter((entry) => entry === signature).length;
    const shouldHaltForLoop = !force && to !== "halted" && repeatCount >= LOOP_SIGNATURE_LIMIT;
    const finalColumn = shouldHaltForLoop ? "halted" : to;
    const moved: AgoraTicket = {
      ...ticket,
      column: finalColumn,
      lease: finalColumn === "done" || finalColumn === "halted" ? createLease() : ticket.lease,
      attempts: {
        ...ticket.attempts,
        loop: shouldHaltForLoop ? ticket.attempts.loop + 1 : ticket.attempts.loop,
        rework: ticket.column === "in_review" && to === "in_progress"
          ? ticket.attempts.rework + 1
          : ticket.attempts.rework,
      },
      loopSignatures,
      updatedAt: timestamp,
    };
    const tickets = { ...snapshot.tickets, [ticket.id]: moved };
    const unblocked: string[] = [];

    if (finalColumn === "done") {
      for (const blockedId of moved.blocks) {
        const candidate = tickets[blockedId];
        if (!candidate || candidate.column !== "blocked") {
          continue;
        }
        if (candidate.blockedBy.every((blockerId) => isDone({ ...snapshot, tickets }, blockerId))) {
          tickets[blockedId] = {
            ...candidate,
            column: "ready",
            updatedAt: timestamp,
          };
          unblocked.push(blockedId);
        }
      }
    }

    this.save({ ...snapshot, tickets });
    this.appendEvent({
      actor,
      action: shouldHaltForLoop ? "halted" : "moved",
      ticketId: ticket.id,
      from: ticket.column,
      to: finalColumn,
      reason: shouldHaltForLoop
        ? `Loop detected for signature ${signature}.`
        : input.reason,
      force,
      metadata: {
        requestedTo: to,
        loopSignature: signature,
        repeatCount,
      },
    });
    for (const unblockedId of unblocked) {
      this.appendEvent({
        actor: "aegis",
        action: "unblocked",
        ticketId: unblockedId,
        from: "blocked",
        to: "ready",
        reason: `All blockers for ${unblockedId} are done.`,
      });
    }
    return this.load().tickets[ticket.id];
  }

  leaseTicket(input: LeaseTicketInput): AgoraTicket {
    const actor = assertActor(input.actor);
    const snapshot = this.init(actor);
    const ticket = snapshot.tickets[input.ticketId];
    if (!ticket) {
      throw new Error(`Unknown Agora ticket "${input.ticketId}".`);
    }
    if (ticket.lease.sessionId) {
      throw new Error(`Agora ticket "${ticket.id}" is already leased.`);
    }
    const leased: AgoraTicket = {
      ...ticket,
      lease: {
        caste: input.caste,
        sessionId: assertString(input.sessionId, "sessionId"),
        startedAt: nowIso(input.now),
      },
      updatedAt: nowIso(input.now),
    };
    this.save({ ...snapshot, tickets: { ...snapshot.tickets, [ticket.id]: leased } });
    this.appendEvent({
      actor,
      action: "leased",
      ticketId: ticket.id,
      reason: `Ticket leased by ${input.caste}.`,
      metadata: { caste: input.caste, sessionId: input.sessionId },
    });
    return leased;
  }

  attachArtifact(input: AttachArtifactInput): AgoraTicket {
    const actor = assertActor(input.actor);
    const snapshot = this.init(actor);
    const ticket = snapshot.tickets[input.ticketId];
    if (!ticket) {
      throw new Error(`Unknown Agora ticket "${input.ticketId}".`);
    }
    const ref = assertString(input.ref, "ref");
    const key = assertString(input.key, "key");
    const updated = {
      ...ticket,
      artifacts: {
        ...ticket.artifacts,
        [key]: ref,
      },
      updatedAt: new Date().toISOString(),
    };
    this.save({ ...snapshot, tickets: { ...snapshot.tickets, [ticket.id]: updated } });
    this.appendEvent({
      actor,
      action: "artifact",
      ticketId: ticket.id,
      reason: input.reason ?? `Attached artifact ${key}.`,
      artifactRef: ref,
      metadata: { key },
    });
    return updated;
  }

  importPlan(plan: AgoraPlanInput, actor: AgoraActor = "agent"): AgoraTicket[] {
    assertActor(actor);
    if (!Array.isArray(plan.tickets)) {
      throw new Error("Agora plan must include a tickets array.");
    }

    const keyToId = new Map<string, string>();
    const created: AgoraTicket[] = [];
    for (const seed of plan.tickets) {
      const dependsOn = normalizeStringList(seed.dependsOn, `tickets.${seed.key}.dependsOn`);
      const blockedBy = dependsOn.map((key) => {
        const id = keyToId.get(key);
        if (!id) {
          throw new Error(`Ticket "${seed.key}" depends on unknown or later key "${key}".`);
        }
        return id;
      });
      const parent = seed.parentKey ? keyToId.get(seed.parentKey) ?? null : null;
      if (seed.parentKey && !parent) {
        throw new Error(`Ticket "${seed.key}" parentKey "${seed.parentKey}" is unknown or later.`);
      }
      const ticket = this.createTicket({
        title: seed.title,
        body: seed.body,
        kind: seed.kind ?? "task",
        column: blockedBy.length === 0 ? "ready" : "blocked",
        sprint: seed.sprint ?? null,
        phase: seed.phase ?? null,
        parent,
        scope: seed.scope ?? [],
        labels: seed.labels ?? [],
        blockedBy,
        actor,
      });
      keyToId.set(assertString(seed.key, "key"), ticket.id);
      created.push(ticket);
    }
    this.appendEvent({
      actor,
      action: "plan_imported",
      ticketId: null,
      reason: `Imported Agora plan "${plan.title}".`,
      metadata: {
        title: plan.title,
        ticketCount: created.length,
        keyToId: Object.fromEntries(keyToId),
      },
    });
    return created;
  }

  installAgentInstructions(
    input: InstallAgentInstructionsInput = {},
  ): InstallAgentInstructionsResult {
    const actor = input.actor ? assertActor(input.actor) : "human";
    const targets = input.targets ?? DEFAULT_AGENT_INSTRUCTION_TARGETS;
    const updated: string[] = [];
    const skipped: string[] = [];

    for (const target of targets) {
      const relativeTarget = target.replace(/\\/g, "/").replace(/^\.\//, "");
      const absoluteTarget = path.join(this.root, relativeTarget);
      if (!existsSync(absoluteTarget)) {
        skipped.push(relativeTarget);
        continue;
      }

      const current = readFileSync(absoluteTarget, "utf8");
      const next = current.includes(AGORA_INSTRUCTIONS_START) && current.includes(AGORA_INSTRUCTIONS_END)
        ? current.replace(
          new RegExp(`${AGORA_INSTRUCTIONS_START}[\\s\\S]*?${AGORA_INSTRUCTIONS_END}`),
          AGORA_INSTRUCTIONS_BLOCK,
        )
        : `${current.trimEnd()}\n\n${AGORA_INSTRUCTIONS_BLOCK}\n`;

      if (next === current) {
        skipped.push(relativeTarget);
        continue;
      }
      writeFileSync(`${absoluteTarget}.tmp`, next, "utf8");
      renameSync(`${absoluteTarget}.tmp`, absoluteTarget);
      updated.push(relativeTarget);
    }

    this.init(actor);
    this.appendEvent({
      actor,
      action: "artifact",
      ticketId: null,
      reason: "Installed Agora agent instructions.",
      metadata: { updated, skipped },
    });

    return { updated, skipped };
  }
}
