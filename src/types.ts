export const AGORA_COLUMNS = [
  "backlog",
  "ready",
  "in_progress",
  "in_review",
  "blocked",
  "ready_to_merge",
  "done",
  "halted",
] as const;

export type AgoraColumn = (typeof AGORA_COLUMNS)[number];

export const AGORA_KINDS = [
  "feature",
  "bug",
  "task",
  "blocker",
  "gate",
  "review_fix",
] as const;

export type AgoraKind = (typeof AGORA_KINDS)[number];

export const AGORA_ACTORS = [
  "human",
  "agent",
  "seed",
  "aegis",
] as const;

export type AgoraActor = (typeof AGORA_ACTORS)[number];

export type AgoraCaste = "oracle" | "titan" | "sentinel" | "janus";

export interface AgoraLease {
  caste: AgoraCaste | null;
  sessionId: string | null;
  startedAt: string | null;
}

export interface AgoraTicket {
  id: string;
  title: string;
  body: string;
  kind: AgoraKind;
  column: AgoraColumn;
  sprint: string | null;
  phase: string | null;
  parent: string | null;
  children: string[];
  blockedBy: string[];
  blocks: string[];
  scope: string[];
  labels: string[];
  createdBy: AgoraActor;
  createdAt: string;
  updatedAt: string;
  lease: AgoraLease;
  artifacts: Record<string, string>;
  attempts: {
    rework: number;
    operational: number;
    loop: number;
  };
  loopSignatures: string[];
}

export interface AgoraSnapshot {
  schema: "agora.tickets.v1";
  nextId: number;
  tickets: Record<string, AgoraTicket>;
}

export type AgoraEventAction =
  | "initialized"
  | "created"
  | "leased"
  | "released"
  | "artifact"
  | "moved"
  | "child_linked"
  | "blocked"
  | "unblocked"
  | "halted"
  | "plan_imported";

export interface AgoraEvent {
  schema: "agora.event.v1";
  id: number;
  ts: string;
  ticketId: string | null;
  actor: AgoraActor;
  action: AgoraEventAction;
  from?: AgoraColumn;
  to?: AgoraColumn;
  reason: string;
  force?: boolean;
  artifactRef?: string;
  metadata?: Record<string, unknown>;
}

export interface CreateTicketInput {
  title: string;
  body: string;
  kind?: AgoraKind;
  column?: AgoraColumn;
  sprint?: string | null;
  phase?: string | null;
  parent?: string | null;
  scope?: string[];
  labels?: string[];
  actor: AgoraActor;
  blockedBy?: string[];
}

export interface MoveTicketInput {
  ticketId: string;
  to: AgoraColumn;
  actor: AgoraActor;
  reason: string;
  reasonKind?: string;
  force?: boolean;
}

export interface LeaseTicketInput {
  ticketId: string;
  caste: AgoraCaste;
  sessionId: string;
  actor: AgoraActor;
  now?: string;
}

export interface AttachArtifactInput {
  ticketId: string;
  key: string;
  ref: string;
  actor: AgoraActor;
  reason?: string;
}

export interface AgoraPlanTicketInput {
  key: string;
  title: string;
  body: string;
  kind?: AgoraKind;
  sprint?: string | null;
  phase?: string | null;
  parentKey?: string | null;
  scope?: string[];
  labels?: string[];
  dependsOn?: string[];
}

export interface AgoraPlanInput {
  title: string;
  tickets: AgoraPlanTicketInput[];
}

export interface AgoraBoard {
  columns: Record<AgoraColumn, AgoraTicket[]>;
}
