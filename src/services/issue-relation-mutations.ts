import type { Pool } from "pg";
import { postgresPool } from "@/db/postgres";
import { establishTenantContext } from "@/db/tenant";
import { FoundationServiceError } from "@/services/foundation/errors";
import { inTransaction } from "@/services/foundation/internal";
import type { MutationContext, MutationResult } from "@/services/foundation/types";
import { removeIssueLink } from "@/services/issue-link-lifecycle";
import {
  removeIssueDependency,
  type IssueDependency,
  type IssueLink,
} from "@/services/issue-relations";

async function assertDependencyRouteIssue(
  pool: Pool,
  input: { workspaceId: string; projectId: string; issueId: string; dependencyId: string },
  principalId: string,
): Promise<void> {
  await inTransaction(pool, async (client) => {
    await establishTenantContext(client, input.workspaceId, principalId);
    const result = await client.query<{ source_issue_id: string }>(`
      SELECT source_issue_id
      FROM issue_dependencies
      WHERE workspace_id=$1 AND project_id=$2 AND id=$3 AND archived_at IS NULL
    `, [input.workspaceId, input.projectId, input.dependencyId]);
    if (!result.rows[0] || result.rows[0].source_issue_id !== input.issueId) {
      throw new FoundationServiceError("NOT_FOUND", "Issue dependency was not found.");
    }
  });
}

async function assertLinkRouteIssue(
  pool: Pool,
  input: { workspaceId: string; projectId: string; issueId: string; linkId: string },
  principalId: string,
): Promise<void> {
  await inTransaction(pool, async (client) => {
    await establishTenantContext(client, input.workspaceId, principalId);
    const result = await client.query<{ issue_id: string }>(`
      SELECT issue_id
      FROM issue_links
      WHERE workspace_id=$1 AND project_id=$2 AND id=$3 AND archived_at IS NULL
    `, [input.workspaceId, input.projectId, input.linkId]);
    if (!result.rows[0] || result.rows[0].issue_id !== input.issueId) {
      throw new FoundationServiceError("NOT_FOUND", "Issue link was not found.");
    }
  });
}

export async function removeIssueDependencyForIssue(
  raw: {
    workspaceId: string;
    projectId: string;
    issueId: string;
    dependencyId: string;
    expectedSourceRevision: number;
  },
  context: MutationContext,
  pool: Pool = postgresPool(),
): Promise<MutationResult<IssueDependency>> {
  await assertDependencyRouteIssue(pool, raw, context.actorPrincipalId);
  return removeIssueDependency({
    workspaceId: raw.workspaceId,
    projectId: raw.projectId,
    dependencyId: raw.dependencyId,
    expectedSourceRevision: raw.expectedSourceRevision,
  }, context, pool);
}

export async function removeIssueLinkForIssue(
  raw: {
    workspaceId: string;
    projectId: string;
    issueId: string;
    linkId: string;
    expectedIssueRevision: number;
  },
  context: MutationContext,
  pool: Pool = postgresPool(),
): Promise<MutationResult<IssueLink>> {
  await assertLinkRouteIssue(pool, raw, context.actorPrincipalId);
  return removeIssueLink({
    workspaceId: raw.workspaceId,
    projectId: raw.projectId,
    linkId: raw.linkId,
    expectedIssueRevision: raw.expectedIssueRevision,
  }, context, pool);
}
