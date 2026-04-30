# Agora Standalone Spec

Agora is a small persistent ticket board designed for human and agent use. It is standalone first; Aegis integration comes later through an adapter.

## Goals

- Store tickets in a durable local format that humans and agents can read.
- Support professional lifecycle columns without becoming Jira.
- Let humans create, edit, and move tickets.
- Let agents create and move tickets with validated autonomy.
- Support decomposition of a design/spec into phased, blocked, parallelizable sprint tickets.
- Keep all changes auditable through append-only events.
- Detect repeated ticket movement loops and halt before wasting agent/runtime quota.

## Non-Goals

- No web UI in v1.
- No Aegis dispatch-state integration in v1.
- No external tracker sync in v1.
- No comments, rich markdown rendering, custom fields, permissions, or labels beyond simple arrays.

## Storage

Default directory:

```text
.agora/
  tickets.json
  events.jsonl
```

Aegis can later embed the same store at `.aegis/agora/`.

`tickets.json` is the current mutable snapshot. `events.jsonl` is the append-only audit trail. Snapshot writes use temp-file then rename. Events are line-oriented JSON so humans and tools can inspect history without loading the whole store.

## Columns

```text
backlog
ready
in_progress
in_review
blocked
ready_to_merge
done
halted
```

Display labels may be friendlier, but persisted column names stay stable.

## Ticket Model

```ts
type AgoraTicket = {
  id: string;
  title: string;
  body: string;
  kind: "feature" | "bug" | "task" | "blocker" | "gate" | "review_fix";
  column: AgoraColumn;
  sprint: string | null;
  phase: string | null;
  parent: string | null;
  children: string[];
  blockedBy: string[];
  blocks: string[];
  scope: string[];
  labels: string[];
  createdBy: "human" | "agent" | "seed" | "aegis";
  createdAt: string;
  updatedAt: string;
  lease: {
    caste: "oracle" | "titan" | "sentinel" | "janus" | null;
    sessionId: string | null;
    startedAt: string | null;
  };
  artifacts: Record<string, string>;
  attempts: {
    rework: number;
    operational: number;
    loop: number;
  };
  loopSignatures: string[];
};
```

## Agent Autonomy

Agents may create and move tickets through Agora APIs/CLI. They do not edit files directly. Their actions are accepted only if the transition is legal or the operation is explicitly supported.

Humans may force moves for future UI workflows. Forced moves are always recorded with `force: true`.

## Legal Movement

Default transitions:

```text
backlog -> ready
ready -> in_progress
in_progress -> in_review
in_review -> in_progress
in_review -> blocked
in_review -> ready_to_merge
ready_to_merge -> done
blocked -> ready
any -> halted
```

Humans and Aegis may force other moves. Agents may not force moves.

When a ticket moves to `done`, Agora automatically unblocks tickets whose blockers are all done and moves them to `ready`.

## Decomposition

Agora accepts a plan file containing ticket seeds with stable keys and dependencies:

```json
{
  "title": "Animated todo app",
  "tickets": [
    {
      "key": "setup",
      "title": "Create Vite app",
      "body": "Scaffold app.",
      "kind": "task",
      "sprint": "sprint-1",
      "phase": "setup",
      "scope": ["package.json", "src/main.tsx"],
      "dependsOn": []
    },
    {
      "key": "ui",
      "title": "Build todo UI",
      "body": "Implement UI.",
      "kind": "feature",
      "sprint": "sprint-1",
      "phase": "ui",
      "scope": ["src/App.tsx"],
      "dependsOn": ["setup"]
    }
  ]
}
```

Tickets with no dependencies enter `ready`. Tickets with dependencies enter `blocked`.

## Loop Detection

Agora records recent movement signatures:

```text
from -> to : reasonKind : normalized scope
```

If the same signature reaches three occurrences on a ticket, Agora moves the ticket to `halted` unless the actor is human with `force: true`.

This catches repeated review/rework, blocked/unblocked, and merge/rework cycles without needing a full workflow engine.

## CLI

V1 commands:

```text
agora init
agora create --title ... --body ... --kind task --actor human
agora move <id> <column> --reason ... --actor agent
agora list --json
agora board --json
agora plan plan.json --actor agent
```

All commands support `--root`, `--dir`, and `--json`.

