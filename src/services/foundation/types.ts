import type { Pool, PoolClient } from "pg";

export type FoundationDatabase = Pool | PoolClient;

export type MutationContext = {
  actorPrincipalId: string;
  authorizingPrincipalId?: string;
  confirmationId?: string;
  requestId: string;
  traceId: string;
  idempotencyKey: string;
  source?: "ui" | "api" | "agent" | "worker" | "system" | "import";
};

export type AuthenticatedPrincipal = {
  userId: string;
  principalId: string;
  displayName: string;
  primaryEmail: string;
  revision: number;
};

export type WorkspaceSummary = {
  id: string;
  name: string;
  slug: string;
  defaultTimeZone: string;
  revision: number;
  membershipRole: "owner" | "member";
};

export type ProjectSummary = {
  id: string;
  workspaceId: string;
  projectKey: string;
  name: string;
  timeZone: string;
  defaultGitWritePolicy: "disabled" | "pull_request_only" | "direct_allowed";
  revision: number;
  roleTemplateKey: "admin" | "member" | "guest";
  capabilities: string[];
};

export type MutationResult<T> = {
  data: T;
  activityId: string;
  outboxEventId: string;
  replayed: boolean;
};
