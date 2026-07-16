import type { Pool } from "pg";
import { postgresPool } from "@/db/postgres";
import { establishTenantContext } from "@/db/tenant";
import { authorizeIssueCapability, issueReadScope } from "@/services/issue-access";
import { FoundationServiceError } from "@/services/foundation/errors";
import { inTransaction } from "@/services/foundation/internal";
import type { MutationContext, MutationResult } from "@/services/foundation/types";
import {
  listIssueSavedViews,
  updateIssueSavedView,
  type IssueProjectionKind,
  type IssueSavedView,
  type IssueViewFilters,
  type IssueViewGrouping,
  type IssueViewOrdering,
} from "@/services/issue-views";

type ViewPolicyRow = {
  owner_principal_id: string;
  visibility: IssueSavedView["visibility"];
  revision: string;
};

type SharedViewRow = {
  id: string;
  workspace_id: string;
  project_id: string;
  owner_principal_id: string;
  name: string;
  visibility: IssueSavedView["visibility"];
  projection: IssueProjectionKind;
  filters: IssueViewFilters;
  grouping: IssueViewGrouping;
  ordering: IssueViewOrdering;
  revision: string;
  created_at: Date;
  updated_at: Date;
};

function mapSharedView(row: SharedViewRow): IssueSavedView {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    projectId: row.project_id,
    ownerPrincipalId: row.owner_principal_id,
    name: row.name,
    visibility: row.visibility,
    projection: row.projection,
    filters: row.filters ?? {},
    grouping: row.grouping ?? {},
    ordering: row.ordering ?? [],
    revision: Number(row.revision),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export async function listIssueSavedViewsWithPolicy(
  input: { workspaceId: string; projectId: string },
  principalId: string,
  pool: Pool = postgresPool(),
): Promise<IssueSavedView[]> {
  const scope = await inTransaction(pool, async (client) => {
    await establishTenantContext(client, input.workspaceId, principalId);
    return issueReadScope(client, { ...input, principalId });
  });
  if (scope.projectWide) return listIssueSavedViews(input, principalId, pool);
  return inTransaction(pool, async (client) => {
    await establishTenantContext(client, input.workspaceId, principalId);
    const result = await client.query<SharedViewRow>(`
      SELECT id,workspace_id,project_id,owner_principal_id,name,visibility,projection,
        filters,grouping,ordering,revision,created_at,updated_at
      FROM issue_saved_views
      WHERE workspace_id=$1 AND project_id=$2 AND archived_at IS NULL
        AND visibility='private'
        AND (owner_principal_id=$3 OR EXISTS (
          SELECT 1 FROM object_grants grant
          WHERE grant.workspace_id=$1 AND grant.project_id=$2 AND grant.principal_id=$3
            AND grant.object_type='saved_view' AND grant.object_id=issue_saved_views.id
            AND grant.capabilities @> ARRAY['issue.read']::text[]
            AND (grant.valid_until IS NULL OR grant.valid_until>now())
        ))
      ORDER BY lower(name),id
    `, [input.workspaceId, input.projectId, principalId]);
    return result.rows.map(mapSharedView);
  });
}

export async function updateIssueSavedViewWithPolicy(
  raw: {
    workspaceId: string;
    projectId: string;
    viewId: string;
    expectedRevision: number;
    name?: string;
    visibility?: IssueSavedView["visibility"];
    projection?: IssueProjectionKind;
    filters?: IssueViewFilters;
    grouping?: IssueViewGrouping;
    ordering?: IssueViewOrdering;
  },
  context: MutationContext,
  pool: Pool = postgresPool(),
): Promise<MutationResult<IssueSavedView>> {
  await inTransaction(pool, async (client) => {
    await establishTenantContext(client, raw.workspaceId, context.actorPrincipalId);
    const result = await client.query<ViewPolicyRow>(`
      SELECT owner_principal_id,visibility,revision
      FROM issue_saved_views
      WHERE workspace_id=$1 AND project_id=$2 AND id=$3 AND archived_at IS NULL
    `, [raw.workspaceId, raw.projectId, raw.viewId]);
    const row = result.rows[0];
    if (!row) throw new FoundationServiceError("NOT_FOUND", "Saved view was not found.");
    if (Number(row.revision) !== raw.expectedRevision) {
      throw new FoundationServiceError("REVISION_CONFLICT", "Saved view changed after it was read.", {
        expectedRevision: raw.expectedRevision,
        currentRevision: Number(row.revision),
      });
    }
    if (row.owner_principal_id !== context.actorPrincipalId
      || row.visibility === "project"
      || raw.visibility === "project") {
      await authorizeIssueCapability(client, {
        workspaceId: raw.workspaceId,
        projectId: raw.projectId,
        principalId: context.actorPrincipalId,
        capability: "project.update",
      });
    }
  });
  return updateIssueSavedView(raw, context, pool);
}
