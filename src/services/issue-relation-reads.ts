import type { Pool } from "pg";
import { postgresPool } from "@/db/postgres";
import { establishTenantContext } from "@/db/tenant";
import { issueReadScope, authorizeIssueCapability } from "@/services/issue-access";
import { authorizePageCapability } from "@/services/page-access";
import { FoundationServiceError } from "@/services/foundation/errors";
import { inTransaction } from "@/services/foundation/internal";
import type { IssueDependency, IssueLink } from "@/services/issue-relations";

type DependencyRow = {
  id: string;
  source_issue_id: string;
  target_issue_id: string;
  relation_kind: IssueDependency["relationKind"];
  created_at: Date;
};

type LinkRow = {
  id: string;
  issue_id: string;
  link_kind: IssueLink["linkKind"];
  target_issue_id: string | null;
  target_page_id: string | null;
  external_url: string | null;
  label: string | null;
  created_at: Date;
};

const mapDependency = (row: DependencyRow): IssueDependency => ({
  id: row.id,
  sourceIssueId: row.source_issue_id,
  targetIssueId: row.target_issue_id,
  relationKind: row.relation_kind,
  createdAt: row.created_at.toISOString(),
});

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

export async function listReadableIssueDependencies(
  input: { workspaceId: string; projectId: string; issueId: string },
  principalId: string,
  pool: Pool = postgresPool(),
): Promise<IssueDependency[]> {
  return inTransaction(pool, async (client) => {
    await establishTenantContext(client, input.workspaceId, principalId);
    await authorizeIssueCapability(client, { ...input, principalId, capability: "issue.read" });
    const scope = await issueReadScope(client, {
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      principalId,
    });
    const result = await client.query<DependencyRow>(`
      SELECT id,source_issue_id,target_issue_id,relation_kind,created_at
      FROM issue_dependencies
      WHERE workspace_id=$1 AND project_id=$2
        AND (source_issue_id=$3 OR target_issue_id=$3)
        AND archived_at IS NULL
      ORDER BY relation_kind,created_at,id
    `, [input.workspaceId, input.projectId, input.issueId]);
    if (scope.projectWide) return result.rows.map(mapDependency);
    const readableIds = new Set(scope.issueIds);
    return result.rows
      .filter((row) => readableIds.has(row.source_issue_id) && readableIds.has(row.target_issue_id))
      .map(mapDependency);
  });
}

export async function listReadableIssueLinks(
  input: { workspaceId: string; projectId: string; issueId: string },
  principalId: string,
  pool: Pool = postgresPool(),
): Promise<IssueLink[]> {
  return inTransaction(pool, async (client) => {
    await establishTenantContext(client, input.workspaceId, principalId);
    await authorizeIssueCapability(client, { ...input, principalId, capability: "issue.read" });
    const issueScope = await issueReadScope(client, {
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      principalId,
    });
    const readableIssueIds = new Set(issueScope.issueIds);
    const result = await client.query<LinkRow>(`
      SELECT id,issue_id,link_kind,target_issue_id,target_page_id,external_url,label,created_at
      FROM issue_links
      WHERE workspace_id=$1 AND project_id=$2 AND issue_id=$3 AND archived_at IS NULL
      ORDER BY created_at,id
    `, [input.workspaceId, input.projectId, input.issueId]);
    const visible: IssueLink[] = [];
    for (const row of result.rows) {
      if (row.link_kind === "external") {
        visible.push(mapLink(row));
        continue;
      }
      if (row.link_kind === "issue") {
        if (row.target_issue_id && (issueScope.projectWide || readableIssueIds.has(row.target_issue_id))) {
          visible.push(mapLink(row));
        }
        continue;
      }
      if (!row.target_page_id) continue;
      try {
        await authorizePageCapability(client, {
          workspaceId: input.workspaceId,
          projectId: input.projectId,
          principalId,
          capability: "page.read",
          pageId: row.target_page_id,
        });
        visible.push(mapLink(row));
      } catch (error) {
        if (!(error instanceof FoundationServiceError)) throw error;
      }
    }
    return visible;
  });
}
