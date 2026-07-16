import type { Pool } from "pg";
import { postgresPool } from "@/db/postgres";
import { establishTenantContext } from "@/db/tenant";
import { authorizeIssueCapability } from "@/services/issue-access";
import { FoundationServiceError } from "@/services/foundation/errors";
import {
  findIdempotentResult,
  inTransaction,
  lockIdempotencyKey,
  recordMutation,
  requestDigest,
} from "@/services/foundation/internal";
import type { MutationContext, MutationResult } from "@/services/foundation/types";
import type { IssueLink } from "@/services/issue-relations";

type LinkRow = {
  id: string;
  issue_id: string;
  link_kind: IssueLink["linkKind"];
  target_issue_id: string | null;
  target_page_id: string | null;
  external_url: string | null;
  label: string | null;
  created_at: Date;
  archived_at: Date | null;
};

const mapLink = (row: LinkRow): IssueLink => ({
  id: row.id,
  issueId: row.issue_id,
  linkKind: row.link_kind,
  targetIssueId: row.target_issue_id,
  targetPageId: row.target_page_id,
  externalUrl: row.external_url,
  label: row.label,
  createdAt: row.created_at.toISOString(),
});

export async function removeIssueLink(
  raw: {
    workspaceId: string;
    projectId: string;
    linkId: string;
    expectedIssueRevision: number;
  },
  context: MutationContext,
  pool: Pool = postgresPool(),
): Promise<MutationResult<IssueLink>> {
  if (!Number.isSafeInteger(raw.expectedIssueRevision) || raw.expectedIssueRevision < 1) {
    throw new FoundationServiceError("VALIDATION_FAILED", "Expected issue revision must be positive.");
  }
  const operation = "issue.link.archive";
  const digest = requestDigest(raw);
  return inTransaction(pool, async (client) => {
    await establishTenantContext(client, raw.workspaceId, context.actorPrincipalId);
    await lockIdempotencyKey(client, context.actorPrincipalId, operation, context.idempotencyKey);
    const replay = await findIdempotentResult<IssueLink>(client, {
      workspaceId: raw.workspaceId,
      projectId: raw.projectId,
      principalId: context.actorPrincipalId,
      operation,
      key: context.idempotencyKey,
      digest,
    });
    if (replay) return replay;
    const link = await client.query<LinkRow>(`
      SELECT id,issue_id,link_kind,target_issue_id,target_page_id,external_url,label,
        created_at,archived_at
      FROM issue_links
      WHERE workspace_id=$1 AND project_id=$2 AND id=$3 FOR UPDATE
    `, [raw.workspaceId, raw.projectId, raw.linkId]);
    const row = link.rows[0];
    if (!row || row.archived_at) throw new FoundationServiceError("NOT_FOUND", "Issue link was not found.");
    await authorizeIssueCapability(client, {
      workspaceId: raw.workspaceId,
      projectId: raw.projectId,
      principalId: context.actorPrincipalId,
      capability: "issue.edit",
      issueId: row.issue_id,
    });
    const issue = await client.query<{ revision: string; lifecycle: string }>(`
      SELECT revision,lifecycle FROM issues
      WHERE workspace_id=$1 AND project_id=$2 AND id=$3 FOR UPDATE
    `, [raw.workspaceId, raw.projectId, row.issue_id]);
    const issueRow = issue.rows[0];
    if (!issueRow) throw new FoundationServiceError("NOT_FOUND", "Issue was not found.");
    const revision = Number(issueRow.revision);
    if (revision !== raw.expectedIssueRevision) {
      throw new FoundationServiceError("REVISION_CONFLICT", "Issue changed after it was read.", {
        expectedRevision: raw.expectedIssueRevision,
        currentRevision: revision,
      });
    }
    if (issueRow.lifecycle !== "active") throw new FoundationServiceError("CONFLICT", "Archived issues cannot change links.");
    const now = new Date();
    await client.query("UPDATE issue_links SET archived_at=$1 WHERE id=$2", [now, raw.linkId]);
    await client.query(`UPDATE issues SET revision=revision+1,updated_by_principal_id=$1,
      updated_at=$2 WHERE id=$3`, [context.actorPrincipalId, now, row.issue_id]);
    const data = mapLink(row);
    return recordMutation(client, {
      workspaceId: raw.workspaceId,
      projectId: raw.projectId,
      context,
      operation,
      digest,
      action: operation,
      targetType: "issue_link",
      targetId: raw.linkId,
      aggregateType: "issue",
      aggregateRevision: revision + 1,
      eventType: "issue_link.archived.v1",
      inputSummary: { expectedIssueRevision: raw.expectedIssueRevision },
      resultSummary: { linkId: raw.linkId, issueId: row.issue_id, issueRevision: revision + 1 },
      data,
    });
  });
}
