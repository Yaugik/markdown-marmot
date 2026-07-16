import type { Pool } from "pg";
import { postgresPool } from "@/db/postgres";
import { establishTenantContext } from "@/db/tenant";
import { authorizeIssueCapability } from "@/services/issue-access";
import { FoundationServiceError } from "@/services/foundation/errors";
import { inTransaction } from "@/services/foundation/internal";
import type { MutationContext, MutationResult } from "@/services/foundation/types";
import {
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
