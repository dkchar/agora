#!/usr/bin/env node
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { AgoraStore } from "./store.js";
import {
  AGORA_COLUMNS,
  AGORA_KINDS,
  type AgoraActor,
  type AgoraColumn,
  type AgoraKind,
  type AgoraPlanInput,
} from "./types.js";

interface ParsedArgs {
  command: string | undefined;
  positionals: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const [command, ...rest] = argv;
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    const key = token.slice(2);
    const next = rest[index + 1];
    if (!next || next.startsWith("--")) {
      flags[key] = true;
      continue;
    }
    flags[key] = next;
    index += 1;
  }

  return { command, positionals, flags };
}

function flagString(flags: Record<string, string | boolean>, key: string): string | undefined {
  const value = flags[key];
  return typeof value === "string" ? value : undefined;
}

function requireFlag(flags: Record<string, string | boolean>, key: string): string {
  const value = flagString(flags, key);
  if (!value) {
    throw new Error(`Missing --${key}.`);
  }
  return value;
}

function parseCsv(value: string | undefined): string[] {
  if (!value) {
    return [];
  }
  return value.split(",").map((entry) => entry.trim()).filter(Boolean);
}

function parseActor(flags: Record<string, string | boolean>): AgoraActor {
  const actor = flagString(flags, "actor") ?? "human";
  if (!["human", "agent", "seed", "aegis"].includes(actor)) {
    throw new Error(`Invalid --actor "${actor}".`);
  }
  return actor as AgoraActor;
}

function parseKind(flags: Record<string, string | boolean>): AgoraKind {
  const kind = flagString(flags, "kind") ?? "task";
  if (!AGORA_KINDS.includes(kind as AgoraKind)) {
    throw new Error(`Invalid --kind "${kind}".`);
  }
  return kind as AgoraKind;
}

function parseColumn(value: string | undefined): AgoraColumn | undefined {
  if (!value) {
    return undefined;
  }
  if (!AGORA_COLUMNS.includes(value as AgoraColumn)) {
    throw new Error(`Invalid column "${value}".`);
  }
  return value as AgoraColumn;
}

function print(value: unknown, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(value, null, 2));
    return;
  }
  if (typeof value === "string") {
    console.log(value);
    return;
  }
  console.log(JSON.stringify(value, null, 2));
}

function createStore(flags: Record<string, string | boolean>) {
  return new AgoraStore({
    root: flagString(flags, "root"),
    dir: flagString(flags, "dir"),
  });
}

function usage(): string {
  return [
    "agora init [--root path] [--dir .agora] [--json]",
    "agora create --title text --body text [--kind task] [--column backlog] [--scope a,b] [--actor human] [--json]",
    "agora move <id> <column> --reason text [--actor agent] [--force] [--json]",
    "agora list [--json]",
    "agora board [--json]",
    "agora plan plan.json [--actor agent] [--json]",
    "agora install-instructions [--target AGENTS.md] [--actor human] [--json]",
  ].join("\n");
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const parsed = parseArgs(argv);
  const json = parsed.flags.json === true;
  const store = createStore(parsed.flags);

  switch (parsed.command) {
    case "init": {
      print(store.init(parseActor(parsed.flags)), json);
      return;
    }
    case "create": {
      const ticket = store.createTicket({
        title: requireFlag(parsed.flags, "title"),
        body: flagString(parsed.flags, "body") ?? "",
        kind: parseKind(parsed.flags),
        column: parseColumn(flagString(parsed.flags, "column")),
        sprint: flagString(parsed.flags, "sprint") ?? null,
        phase: flagString(parsed.flags, "phase") ?? null,
        scope: parseCsv(flagString(parsed.flags, "scope")),
        labels: parseCsv(flagString(parsed.flags, "labels")),
        actor: parseActor(parsed.flags),
      });
      print(ticket, json);
      return;
    }
    case "move": {
      const [ticketId, column] = parsed.positionals;
      if (!ticketId || !column) {
        throw new Error("move requires <id> <column>.");
      }
      const ticket = store.moveTicket({
        ticketId,
        to: parseColumn(column)!,
        actor: parseActor(parsed.flags),
        reason: requireFlag(parsed.flags, "reason"),
        reasonKind: flagString(parsed.flags, "reason-kind"),
        force: parsed.flags.force === true,
      });
      print(ticket, json);
      return;
    }
    case "list": {
      print(store.listTickets(), json);
      return;
    }
    case "board": {
      print(store.board(), json);
      return;
    }
    case "plan": {
      const [planPath] = parsed.positionals;
      if (!planPath) {
        throw new Error("plan requires a plan JSON file.");
      }
      const plan = JSON.parse(readFileSync(planPath, "utf8")) as AgoraPlanInput;
      print(store.importPlan(plan, parseActor(parsed.flags)), json);
      return;
    }
    case "install-instructions": {
      const targets = [
        ...parsed.positionals,
        ...parseCsv(flagString(parsed.flags, "target")),
      ].filter(Boolean);
      print(store.installAgentInstructions({
        actor: parseActor(parsed.flags),
        targets: targets.length > 0 ? targets : undefined,
      }), json);
      return;
    }
    case undefined:
    case "help":
    case "--help":
      print(usage(), false);
      return;
    default:
      throw new Error(`Unknown command "${parsed.command}".\n${usage()}`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
