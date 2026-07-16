import type { Pool } from "pg";
import { postgresPool } from "@/db/postgres";
import { establishTenantContext } from "@/db/tenant";
import { authorizeIssueCapability } from "@/services/issue-access";
import { FoundationServiceError } from "@/services/foundation/errors";
import { inTransaction } from "@/services/foundation/internal";
import type { MutationContext, MutationResult } from "@/services/foundation/types";
import { restoreIssue, type Issue } from "@/services/issues";

type RestoreRow = {
  revision: string;
  lifecycle: "active" | "archived";
  parent_issue_id: string | null;
  parent_lifecycle: "active" | "archived" | null;
};

function isParentConstraintError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; message?: unknown };
  return candidate.code === "23514"
    && typeof candidate.message === "string"
    && candidate.message.includes("active issue requires an active parent");
}

export async function restoreIssueWithParentPolicy(
  raw: { workspaceId: string; projectId: string; issueId: string; expectedRevision: number },
  context: MutationContext,
  pool: Pool = postgresPool(),
): Promise<MutationResult<Issue>> {
  await inTransaction(pool, async (client) => {
    await establishTenantContext(client, raw.workspaceId, context.actorPrincipalId);
    await authorizeIssueCapability(client, {
      workspaceId: raw.workspaceId,
      projectId: raw.projectId,
      principalId: context.actorPrincipalId,
      capability: "issue.archive",
      issueId: raw.issueId,
    });
    const result = await client.query<RestoreRow>(`
      SELECT child.revision,child.lifecycle,child.parent_issue_id,
        parent.lifecycle parent_lifecycle
      FROM issues child
      LEFT JOIN issues parent
        ON parent.workspace_id=child.workspace_id
       AND parent.project_id=child.project_id
       AND parent.id=child.parent_issue_id
      WHERE child.workspace_id=$1 AND child.project_id=$2 AND child.id=$3
    `, [raw.workspaceId, raw.projectId, raw.issueId]);
    const row = result.rows[0];
    if (!row) throw new FoundationServiceError("NOT_FOUND", "Issue was not found.");
    if (Number(row.revision) !== raw.expectedRevision) {
      throw new FoundationServiceError("REVISION_CONFLICT", "Issue changed after it was read.", {
        expectedRevision: raw.expectedRevision,
        currentRevision: Number(row.revision),
      });
    }
    if (row.lifecycle !== "archived") {
      throw new FoundationServiceError("CONFLICT", "Issue is already active.");
    }
    if (row.parent_issue_id && row.parent_lifecycle !== "active") {
      throw new FoundationServiceError("CONFLICT", "Restore the parent issue first.", {
        parentIssueId: row.parent_issue_id,
      });
    }
  });
  try {
    return await restoreIssue(raw, context, pool);
  } catch (error) {
    if (isParentConstraintError(error)) {
      throw new FoundationServiceError("CONFLICT", "Restore the parent issue first.");
    }
    throw error;
  }
}
