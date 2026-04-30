# Agora

Agora is a small persistent ticket board for humans and coding agents.

It stores work as local JSON, keeps an append-only event log, and exposes a CLI that agents can safely use to create, move, and inspect tickets. It is designed to be useful on its own first; Aegis can later use it as a lightweight work graph backend.

## Why Agora Exists

Agent swarms work better when work is represented as real tickets instead of prompt-only todos. A ticket can be claimed, blocked, moved back for review fixes, decomposed into child work, or halted when it loops.

Agora keeps that model deliberately small:

- one mutable snapshot: `.agora/tickets.json`
- one append-only history: `.agora/events.jsonl`
- professional lifecycle columns
- legal movement rules
- human override support
- agent-safe creation and movement
- plan import for decomposing specs into phased, blocked, parallelizable tickets
- loop detection to prevent infinite review/rework churn

## Install

```bash
npm install -g @dkchar/agora
```

For local development:

```bash
npm install
npm test
npm run build
```

## Storage

By default Agora writes:

```text
.agora/
  tickets.json
  events.jsonl
```

`tickets.json` is the current board state. `events.jsonl` is the audit log.

All snapshot writes use a temp file and rename. Events are JSON Lines so humans, scripts, and agents can inspect history without custom tooling.

## Columns

Agora uses these persisted column names:

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

Typical flow:

```text
backlog -> ready -> in_progress -> in_review -> ready_to_merge -> done
```

Review can move work back:

```text
in_review -> in_progress
```

Blocked work resumes when blockers finish:

```text
blocked -> ready
```

Any ticket can be halted:

```text
any -> halted
```

## CLI

Initialize a board:

```bash
agora init
```

Create a ticket:

```bash
agora create \
  --title "Build todo input" \
  --body "Implement accessible input and submit action." \
  --kind feature \
  --column ready \
  --scope src/TodoInput.tsx,tests/TodoInput.test.ts \
  --actor human \
  --json
```

Move a ticket:

```bash
agora move AG-0001 in_progress --reason "Claim work" --actor agent --json
```

Show board:

```bash
agora board --json
```

List tickets:

```bash
agora list --json
```

Use another store location:

```bash
agora board --root C:\dev\my-project --dir .agora --json
```

Install short Agora usage instructions into common agent instruction files such as `AGENTS.md`, `CLAUDE.md`, `.codex/AGENTS.md`, and `.codex/CLAUDE.md`:

```bash
agora install-instructions --json
```

Install into a specific file:

```bash
agora install-instructions --target .codex/CLAUDE.md --json
```

## Plan Import

Agora can import a design decomposition as blocked/parallel tickets.

Example `plan.json`:

```json
{
  "title": "Calculator sprint",
  "tickets": [
    {
      "key": "setup",
      "title": "Set up calculator package",
      "body": "Create project skeleton and scripts.",
      "kind": "task",
      "sprint": "sprint-1",
      "phase": "setup",
      "scope": ["package.json", "src/index.ts"],
      "dependsOn": []
    },
    {
      "key": "add",
      "title": "Implement addition",
      "body": "Add calculator addition operation.",
      "kind": "feature",
      "sprint": "sprint-1",
      "phase": "core",
      "scope": ["src/add.ts", "tests/add.test.ts"],
      "dependsOn": ["setup"]
    },
    {
      "key": "subtract",
      "title": "Implement subtraction",
      "body": "Add calculator subtraction operation.",
      "kind": "feature",
      "sprint": "sprint-1",
      "phase": "core",
      "scope": ["src/subtract.ts", "tests/subtract.test.ts"],
      "dependsOn": ["setup"]
    }
  ]
}
```

Import it:

```bash
agora plan plan.json --actor agent --json
```

Tickets with no dependencies start in `ready`. Tickets with dependencies start in `blocked`. When all blockers reach `done`, blocked tickets move to `ready`.

## Agent Autonomy

Agents can create and move tickets through the CLI/API. They cannot force illegal moves.

Humans can force moves for manual correction and future UI drag/drop support:

```bash
agora move AG-0001 done --reason "Manual override" --actor human --force --json
```

Every move records an event.

## Loop Detection

Agora records recent movement signatures:

```text
from -> to : reason kind : scope
```

If the same signature appears three times on one ticket, Agora moves the ticket to `halted`.

This catches patterns like:

```text
in_review -> in_progress -> in_review -> in_progress
```

with the same review finding.

## Library Use

```ts
import { AgoraStore } from "@dkchar/agora";

const store = new AgoraStore({ root: process.cwd() });
store.init("human");

const ticket = store.createTicket({
  title: "Implement API",
  body: "Create endpoint and tests.",
  kind: "feature",
  column: "ready",
  actor: "agent",
});

store.moveTicket({
  ticketId: ticket.id,
  to: "in_progress",
  actor: "agent",
  reason: "Claim work.",
});
```

## Development

```bash
npm install
npm test
npm run lint
npm run build
```

## License

MIT
