import type { Pool, PoolClient } from "pg";
import { postgresPool } from "@/db/postgres";
import { establishTenantContext } from "@/db/tenant";
import { newFolioId } from "@/lib/folio-ids";
import { assertIssueExists, authorizeIssueCapability } from "@/services/issue-access";
import { FoundationServiceError } from "@/services/foundation/errors";
import {
  findIdempotentResult,
  inTransaction,
  lockIdempotencyKey,
  recordMutation,
  requestDigest,
} from "@/services/foundation/internal";
import type { MutationContext, MutationResult } from "@/services/foundation/types";

export type IssueLabel = { id: string; name: string; description: string; colorKey: string; revision: number; createdAt: string; updatedAt: string };
export type Milestone = { id: string; name: string; description: string; targetOn: string | null; state: "planned" | "active" | "completed" | "canceled"; revision: number; createdAt: string; updatedAt: string };
export type Cycle = { id: string; name: string; startsOn: string; endsOn: string; state: "planned" | "active" | "completed" | "canceled"; revision: number; createdAt: string; updatedAt: string };
export type Roadmap = { id: string; name: string; description: string; visibility: "project" | "private"; ownerPrincipalId: string; revision: number; items: RoadmapItem[]; createdAt: string; updatedAt: string };
export type RoadmapItem = { issueId: string; rank: number; startsOn: string | null; endsOn: string | null; createdAt: string };
export type IssuePortfolio = { labels: IssueLabel[]; milestones: Milestone[]; cycles: Cycle[]; roadmaps: Roadmap[] };

type LabelRow = { id: string; name: string; description: string; color_key: string; revision: string; created_at: Date; updated_at: Date };
type MilestoneRow = { id: string; name: string; description: string; target_on: string | null; state: Milestone["state"]; revision: string; created_at: Date; updated_at: Date };
type CycleRow = { id: string; name: string; starts_on: string; ends_on: string; state: Cycle["state"]; revision: string; created_at: Date; updated_at: Date };
type RoadmapRow = { id: string; name: string; description: string; visibility: Roadmap["visibility"]; owner_principal_id: string; revision: string; created_at: Date; updated_at: Date };
type RoadmapItemRow = { roadmap_id: string; issue_id: string; rank: string; starts_on: string | null; ends_on: string | null; created_at: Date };

function text(value: string, label: string, max: number): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > max) throw new FoundationServiceError("VALIDATION_FAILED", `${label} must contain 1 to ${max} characters.`);
  return normalized;
}
function description(value: string | undefined): string {
  const normalized = value?.trim() ?? "";
  if (normalized.length > 4000) throw new FoundationServiceError("VALIDATION_FAILED", "Description must be at most 4000 characters.");
  return normalized;
}
function colorKey(value: string | undefined): string {
  const normalized = value?.trim() || "gray";
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(normalized)) throw new FoundationServiceError("VALIDATION_FAILED", "Color key is invalid.");
  return normalized;
}
function expectedRevision(value: number) {
  if (!Number.isSafeInteger(value) || value < 1) throw new FoundationServiceError("VALIDATION_FAILED", "Expected revision must be positive.");
}
function dateValue(value: string | null | undefined, label: string): string | null | undefined {
  if (value === null || value === undefined) return value;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw new FoundationServiceError("VALIDATION_FAILED", `${label} must use YYYY-MM-DD.`);
  }
  return value;
}

const mapLabel = (row: LabelRow): IssueLabel => ({ id: row.id, name: row.name, description: row.description, colorKey: row.color_key, revision: Number(row.revision), createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString() });
const mapMilestone = (row: MilestoneRow): Milestone => ({ id: row.id, name: row.name, description: row.description, targetOn: row.target_on, state: row.state, revision: Number(row.revision), createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString() });
const mapCycle = (row: CycleRow): Cycle => ({ id: row.id, name: row.name, startsOn: row.starts_on, endsOn: row.ends_on, state: row.state, revision: Number(row.revision), createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString() });

async function hydrateRoadmaps(client: PoolClient, rows: RoadmapRow[]): Promise<Roadmap[]> {
  if (!rows.length) return [];
  const items = await client.query<RoadmapItemRow>(`
    SELECT roadmap_id,issue_id,rank,starts_on::text,ends_on::text,created_at
    FROM roadmap_items WHERE roadmap_id=ANY($1::uuid[]) ORDER BY roadmap_id,rank,issue_id
  `, [rows.map((row) => row.id)]);
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    description: row.description,
    visibility: row.visibility,
    ownerPrincipalId: row.owner_principal_id,
    revision: Number(row.revision),
    items: items.rows.filter((item) => item.roadmap_id === row.id).map((item) => ({
      issueId: item.issue_id,
      rank: Number(item.rank),
      startsOn: item.starts_on,
      endsOn: item.ends_on,
      createdAt: item.created_at.toISOString(),
    })),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  }));
}

export async function listIssuePortfolio(
  input: { workspaceId: string; projectId: string },
  principalId: string,
  pool: Pool = postgresPool(),
): Promise<IssuePortfolio> {
  return inTransaction(pool, async (client) => {
    await establishTenantContext(client, input.workspaceId, principalId);
    await authorizeIssueCapability(client, { ...input, principalId, capability: "issue.read" });
    const [labels, milestones, cycles, roadmaps] = await Promise.all([
      client.query<LabelRow>(`SELECT id,name,description,color_key,revision,created_at,updated_at
        FROM issue_labels WHERE workspace_id=$1 AND project_id=$2 AND archived_at IS NULL ORDER BY lower(name),id`, [input.workspaceId, input.projectId]),
      client.query<MilestoneRow>(`SELECT id,name,description,target_on::text,state,revision,created_at,updated_at
        FROM milestones WHERE workspace_id=$1 AND project_id=$2 AND archived_at IS NULL ORDER BY target_on NULLS LAST,lower(name),id`, [input.workspaceId, input.projectId]),
      client.query<CycleRow>(`SELECT id,name,starts_on::text,ends_on::text,state,revision,created_at,updated_at
        FROM cycles WHERE workspace_id=$1 AND project_id=$2 AND archived_at IS NULL ORDER BY starts_on,id`, [input.workspaceId, input.projectId]),
      client.query<RoadmapRow>(`SELECT id,name,description,visibility,owner_principal_id,revision,created_at,updated_at
        FROM roadmaps WHERE workspace_id=$1 AND project_id=$2 AND archived_at IS NULL
          AND (visibility='project' OR owner_principal_id=$3)
        ORDER BY lower(name),id`, [input.workspaceId, input.projectId, principalId]),
    ]);
    return {
      labels: labels.rows.map(mapLabel),
      milestones: milestones.rows.map(mapMilestone),
      cycles: cycles.rows.map(mapCycle),
      roadmaps: await hydrateRoadmaps(client, roadmaps.rows),
    };
  });
}

export async function createIssueLabel(
  raw: { workspaceId: string; projectId: string; name: string; description?: string; colorKey?: string },
  context: MutationContext,
  pool: Pool = postgresPool(),
): Promise<MutationResult<IssueLabel>> {
  const input = { ...raw, name: text(raw.name, "Label name", 80), description: description(raw.description), colorKey: colorKey(raw.colorKey) };
  const operation = "issue_label.create";
  const digest = requestDigest(input);
  return inTransaction(pool, async (client) => {
    await establishTenantContext(client, input.workspaceId, context.actorPrincipalId);
    await lockIdempotencyKey(client, context.actorPrincipalId, operation, context.idempotencyKey);
    const replay = await findIdempotentResult<IssueLabel>(client, { workspaceId: input.workspaceId, projectId: input.projectId, principalId: context.actorPrincipalId, operation, key: context.idempotencyKey, digest });
    if (replay) return replay;
    await authorizeIssueCapability(client, { ...input, principalId: context.actorPrincipalId, capability: "project.update" });
    const id = newFolioId();
    const now = new Date();
    const result = await client.query<LabelRow>(`INSERT INTO issue_labels(
      id,workspace_id,project_id,name,description,color_key,created_by_principal_id,
      updated_by_principal_id,created_at,updated_at
    ) VALUES($1,$2,$3,$4,$5,$6,$7,$7,$8,$8)
    RETURNING id,name,description,color_key,revision,created_at,updated_at`, [id, input.workspaceId, input.projectId, input.name, input.description, input.colorKey, context.actorPrincipalId, now]);
    const data = mapLabel(result.rows[0]!);
    return recordMutation(client, { workspaceId: input.workspaceId, projectId: input.projectId, context, operation, digest, action: operation, targetType: "issue_label", targetId: id, aggregateType: "issue_label", aggregateRevision: 1, eventType: "issue_label.created.v1", inputSummary: { name: input.name, colorKey: input.colorKey }, resultSummary: { labelId: id }, data });
  });
}

export async function createMilestone(
  raw: { workspaceId: string; projectId: string; name: string; description?: string; targetOn?: string | null; state?: Milestone["state"] },
  context: MutationContext,
  pool: Pool = postgresPool(),
): Promise<MutationResult<Milestone>> {
  const input = { ...raw, name: text(raw.name, "Milestone name", 120), description: description(raw.description), targetOn: dateValue(raw.targetOn, "Target date") ?? null, state: raw.state ?? "planned" as Milestone["state"] };
  const operation = "milestone.create";
  const digest = requestDigest(input);
  return inTransaction(pool, async (client) => {
    await establishTenantContext(client, input.workspaceId, context.actorPrincipalId);
    await lockIdempotencyKey(client, context.actorPrincipalId, operation, context.idempotencyKey);
    const replay = await findIdempotentResult<Milestone>(client, { workspaceId: input.workspaceId, projectId: input.projectId, principalId: context.actorPrincipalId, operation, key: context.idempotencyKey, digest });
    if (replay) return replay;
    await authorizeIssueCapability(client, { ...input, principalId: context.actorPrincipalId, capability: "project.update" });
    const id = newFolioId(); const now = new Date();
    const result = await client.query<MilestoneRow>(`INSERT INTO milestones(
      id,workspace_id,project_id,name,description,target_on,state,created_by_principal_id,
      updated_by_principal_id,created_at,updated_at
    ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$8,$9,$9)
    RETURNING id,name,description,target_on::text,state,revision,created_at,updated_at`, [id, input.workspaceId, input.projectId, input.name, input.description, input.targetOn, input.state, context.actorPrincipalId, now]);
    const data = mapMilestone(result.rows[0]!);
    return recordMutation(client, { workspaceId: input.workspaceId, projectId: input.projectId, context, operation, digest, action: operation, targetType: "milestone", targetId: id, aggregateType: "milestone", aggregateRevision: 1, eventType: "milestone.created.v1", inputSummary: { name: input.name, targetOn: input.targetOn, state: input.state }, resultSummary: { milestoneId: id }, data });
  });
}

export async function createCycle(
  raw: { workspaceId: string; projectId: string; name: string; startsOn: string; endsOn: string; state?: Cycle["state"] },
  context: MutationContext,
  pool: Pool = postgresPool(),
): Promise<MutationResult<Cycle>> {
  const input = { ...raw, name: text(raw.name, "Cycle name", 120), startsOn: dateValue(raw.startsOn, "Start date")!, endsOn: dateValue(raw.endsOn, "End date")!, state: raw.state ?? "planned" as Cycle["state"] };
  if (input.endsOn < input.startsOn) throw new FoundationServiceError("VALIDATION_FAILED", "Cycle end date cannot precede its start date.");
  const operation = "cycle.create"; const digest = requestDigest(input);
  return inTransaction(pool, async (client) => {
    await establishTenantContext(client, input.workspaceId, context.actorPrincipalId);
    await lockIdempotencyKey(client, context.actorPrincipalId, operation, context.idempotencyKey);
    const replay = await findIdempotentResult<Cycle>(client, { workspaceId: input.workspaceId, projectId: input.projectId, principalId: context.actorPrincipalId, operation, key: context.idempotencyKey, digest });
    if (replay) return replay;
    await authorizeIssueCapability(client, { ...input, principalId: context.actorPrincipalId, capability: "project.update" });
    const id = newFolioId(); const now = new Date();
    const result = await client.query<CycleRow>(`INSERT INTO cycles(
      id,workspace_id,project_id,name,starts_on,ends_on,state,created_by_principal_id,
      updated_by_principal_id,created_at,updated_at
    ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$8,$9,$9)
    RETURNING id,name,starts_on::text,ends_on::text,state,revision,created_at,updated_at`, [id, input.workspaceId, input.projectId, input.name, input.startsOn, input.endsOn, input.state, context.actorPrincipalId, now]);
    const data = mapCycle(result.rows[0]!);
    return recordMutation(client, { workspaceId: input.workspaceId, projectId: input.projectId, context, operation, digest, action: operation, targetType: "cycle", targetId: id, aggregateType: "cycle", aggregateRevision: 1, eventType: "cycle.created.v1", inputSummary: { name: input.name, startsOn: input.startsOn, endsOn: input.endsOn }, resultSummary: { cycleId: id }, data });
  });
}

export async function createRoadmap(
  raw: { workspaceId: string; projectId: string; name: string; description?: string; visibility?: Roadmap["visibility"] },
  context: MutationContext,
  pool: Pool = postgresPool(),
): Promise<MutationResult<Roadmap>> {
  const input = { ...raw, name: text(raw.name, "Roadmap name", 120), description: description(raw.description), visibility: raw.visibility ?? "project" as Roadmap["visibility"] };
  const operation = "roadmap.create"; const digest = requestDigest(input);
  return inTransaction(pool, async (client) => {
    await establishTenantContext(client, input.workspaceId, context.actorPrincipalId);
    await lockIdempotencyKey(client, context.actorPrincipalId, operation, context.idempotencyKey);
    const replay = await findIdempotentResult<Roadmap>(client, { workspaceId: input.workspaceId, projectId: input.projectId, principalId: context.actorPrincipalId, operation, key: context.idempotencyKey, digest });
    if (replay) return replay;
    await authorizeIssueCapability(client, { ...input, principalId: context.actorPrincipalId, capability: "project.update" });
    const id = newFolioId(); const now = new Date();
    const result = await client.query<RoadmapRow>(`INSERT INTO roadmaps(
      id,workspace_id,project_id,name,description,visibility,owner_principal_id,
      created_by_principal_id,updated_by_principal_id,created_at,updated_at
    ) VALUES($1,$2,$3,$4,$5,$6,$7,$7,$7,$8,$8)
    RETURNING id,name,description,visibility,owner_principal_id,revision,created_at,updated_at`, [id, input.workspaceId, input.projectId, input.name, input.description, input.visibility, context.actorPrincipalId, now]);
    const data = (await hydrateRoadmaps(client, result.rows))[0]!;
    return recordMutation(client, { workspaceId: input.workspaceId, projectId: input.projectId, context, operation, digest, action: operation, targetType: "roadmap", targetId: id, aggregateType: "roadmap", aggregateRevision: 1, eventType: "roadmap.created.v1", inputSummary: { name: input.name, visibility: input.visibility }, resultSummary: { roadmapId: id }, data });
  });
}

export async function addRoadmapItem(
  raw: { workspaceId: string; projectId: string; roadmapId: string; issueId: string; expectedRoadmapRevision: number; rank?: number; startsOn?: string | null; endsOn?: string | null },
  context: MutationContext,
  pool: Pool = postgresPool(),
): Promise<MutationResult<Roadmap>> {
  expectedRevision(raw.expectedRoadmapRevision);
  const itemRank = raw.rank ?? 1000;
  if (!Number.isSafeInteger(itemRank) || itemRank < 0) throw new FoundationServiceError("VALIDATION_FAILED", "Roadmap rank must be non-negative.");
  const startsOn = dateValue(raw.startsOn, "Roadmap start date") ?? null;
  const endsOn = dateValue(raw.endsOn, "Roadmap end date") ?? null;
  if (startsOn && endsOn && endsOn < startsOn) throw new FoundationServiceError("VALIDATION_FAILED", "Roadmap end date cannot precede start date.");
  const input = { ...raw, rank: itemRank, startsOn, endsOn };
  const operation = "roadmap.item.add"; const digest = requestDigest(input);
  return inTransaction(pool, async (client) => {
    await establishTenantContext(client, input.workspaceId, context.actorPrincipalId);
    await lockIdempotencyKey(client, context.actorPrincipalId, operation, context.idempotencyKey);
    const replay = await findIdempotentResult<Roadmap>(client, { workspaceId: input.workspaceId, projectId: input.projectId, principalId: context.actorPrincipalId, operation, key: context.idempotencyKey, digest });
    if (replay) return replay;
    await authorizeIssueCapability(client, { ...input, principalId: context.actorPrincipalId, capability: "issue.edit", issueId: input.issueId });
    await assertIssueExists(client, input.workspaceId, input.projectId, input.issueId);
    const roadmap = await client.query<RoadmapRow>(`SELECT id,name,description,visibility,owner_principal_id,revision,created_at,updated_at
      FROM roadmaps WHERE workspace_id=$1 AND project_id=$2 AND id=$3 AND archived_at IS NULL FOR UPDATE`, [input.workspaceId, input.projectId, input.roadmapId]);
    const row = roadmap.rows[0];
    if (!row) throw new FoundationServiceError("NOT_FOUND", "Roadmap was not found.");
    if (row.visibility === "private" && row.owner_principal_id !== context.actorPrincipalId) throw new FoundationServiceError("CAPABILITY_DENIED", "Private roadmap is not editable.");
    const revision = Number(row.revision);
    if (revision !== input.expectedRoadmapRevision) throw new FoundationServiceError("REVISION_CONFLICT", "Roadmap changed after it was read.", { expectedRevision: input.expectedRoadmapRevision, currentRevision: revision });
    const now = new Date();
    await client.query(`INSERT INTO roadmap_items(
      workspace_id,project_id,roadmap_id,issue_id,rank,starts_on,ends_on,created_by_principal_id,created_at
    ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
    ON CONFLICT (roadmap_id,issue_id) DO UPDATE SET rank=EXCLUDED.rank,
      starts_on=EXCLUDED.starts_on,ends_on=EXCLUDED.ends_on`, [input.workspaceId, input.projectId, input.roadmapId, input.issueId, input.rank, input.startsOn, input.endsOn, context.actorPrincipalId, now]);
    await client.query(`UPDATE roadmaps SET revision=revision+1,updated_by_principal_id=$1,updated_at=$2 WHERE id=$3`, [context.actorPrincipalId, now, input.roadmapId]);
    const updated = await client.query<RoadmapRow>(`SELECT id,name,description,visibility,owner_principal_id,revision,created_at,updated_at FROM roadmaps WHERE id=$1`, [input.roadmapId]);
    const data = (await hydrateRoadmaps(client, updated.rows))[0]!;
    return recordMutation(client, { workspaceId: input.workspaceId, projectId: input.projectId, context, operation, digest, action: operation, targetType: "roadmap", targetId: input.roadmapId, aggregateType: "roadmap", aggregateRevision: revision + 1, eventType: "roadmap.item_added.v1", inputSummary: { issueId: input.issueId, rank: input.rank }, resultSummary: { roadmapId: input.roadmapId, issueId: input.issueId, revision: revision + 1 }, data });
  });
}

export async function archivePortfolioItem(
  raw: { workspaceId: string; projectId: string; kind: "label" | "milestone" | "cycle" | "roadmap"; id: string; expectedRevision: number },
  context: MutationContext,
  pool: Pool = postgresPool(),
): Promise<MutationResult<{ id: string; kind: string; revision: number; archivedAt: string }>> {
  expectedRevision(raw.expectedRevision);
  const config = {
    label: { table: "issue_labels", target: "issue_label" },
    milestone: { table: "milestones", target: "milestone" },
    cycle: { table: "cycles", target: "cycle" },
    roadmap: { table: "roadmaps", target: "roadmap" },
  }[raw.kind];
  const operation = `${config.target}.archive`; const digest = requestDigest(raw);
  return inTransaction(pool, async (client) => {
    await establishTenantContext(client, raw.workspaceId, context.actorPrincipalId);
    await lockIdempotencyKey(client, context.actorPrincipalId, operation, context.idempotencyKey);
    const replay = await findIdempotentResult<{ id: string; kind: string; revision: number; archivedAt: string }>(client, { workspaceId: raw.workspaceId, projectId: raw.projectId, principalId: context.actorPrincipalId, operation, key: context.idempotencyKey, digest });
    if (replay) return replay;
    await authorizeIssueCapability(client, { ...raw, principalId: context.actorPrincipalId, capability: "project.update" });
    const current = await client.query<{ revision: string; archived_at: Date | null }>(`SELECT revision,archived_at FROM ${config.table}
      WHERE workspace_id=$1 AND project_id=$2 AND id=$3 FOR UPDATE`, [raw.workspaceId, raw.projectId, raw.id]);
    const row = current.rows[0];
    if (!row || row.archived_at) throw new FoundationServiceError("NOT_FOUND", `${raw.kind} was not found.`);
    const revision = Number(row.revision);
    if (revision !== raw.expectedRevision) throw new FoundationServiceError("REVISION_CONFLICT", `${raw.kind} changed after it was read.`, { expectedRevision: raw.expectedRevision, currentRevision: revision });
    const now = new Date();
    await client.query(`UPDATE ${config.table} SET archived_at=$1,revision=revision+1,updated_by_principal_id=$2,updated_at=$1 WHERE id=$3`, [now, context.actorPrincipalId, raw.id]);
    const data = { id: raw.id, kind: raw.kind, revision: revision + 1, archivedAt: now.toISOString() };
    return recordMutation(client, { workspaceId: raw.workspaceId, projectId: raw.projectId, context, operation, digest, action: operation, targetType: config.target, targetId: raw.id, aggregateType: config.target, aggregateRevision: revision + 1, eventType: `${config.target}.archived.v1`, inputSummary: { expectedRevision: raw.expectedRevision }, resultSummary: data, data });
  });
}
