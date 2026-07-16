import type { Pool } from "pg";
import { postgresPool } from "@/db/postgres";
import { establishTenantContext } from "@/db/tenant";
import {
  authorizeGraphEntityRead,
  authorizeOwnedEcosystemObject,
  readGraphViewPolicy,
} from "@/services/ecosystem-access";
import { FoundationServiceError } from "@/services/foundation/errors";
import { inTransaction } from "@/services/foundation/internal";
import type { GraphEntityRef, SavedGraphView } from "@/services/graph-explorer";

type ViewRow = {
  id: string;
  owner_principal_id: string;
  name: string;
  visibility: SavedGraphView["visibility"];
  root_entities: GraphEntityRef[];
  filters: Record<string, unknown>;
  traversal: Record<string, unknown>;
  layout: Record<string, unknown>;
  revision: string;
  created_at: Date;
  updated_at: Date;
};

function mapView(row: ViewRow, roots: GraphEntityRef[]): SavedGraphView {
  return {
    id: row.id,
    ownerPrincipalId: row.owner_principal_id,
    name: row.name,
    visibility: row.visibility,
    rootEntities: roots,
    filters: row.filters,
    traversal: row.traversal,
    layout: row.layout,
    revision: Number(row.revision),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export async function listPermissionFilteredGraphViews(
  input: { workspaceId: string; projectId: string },
  principalId: string,
  pool: Pool = postgresPool(),
): Promise<SavedGraphView[]> {
  return inTransaction(pool, async (client) => {
    await establishTenantContext(client, input.workspaceId, principalId);
    const candidates = await client.query<ViewRow>(`
      SELECT id,owner_principal_id,name,visibility,root_entities,filters,traversal,
        layout,revision,created_at,updated_at
      FROM saved_graph_views view
      WHERE workspace_id=$1 AND project_id=$2 AND archived_at IS NULL
        AND (
          visibility='project'
          OR owner_principal_id=$3
          OR EXISTS (
            SELECT 1 FROM object_grants grant_row
            WHERE grant_row.workspace_id=$1 AND grant_row.project_id=$2
              AND grant_row.principal_id=$3 AND grant_row.object_type='graph_view'
              AND grant_row.object_id=view.id
              AND grant_row.capabilities @> ARRAY['graph.read']::text[]
              AND (grant_row.valid_until IS NULL OR grant_row.valid_until>now())
          )
        )
      ORDER BY updated_at DESC,id
    `, [input.workspaceId,input.projectId,principalId]);
    const filtered: SavedGraphView[] = [];
    for (const view of candidates.rows) {
      try {
        const policy = await readGraphViewPolicy(client, {
          workspaceId: input.workspaceId,
          projectId: input.projectId,
          viewId: view.id,
        });
        await authorizeOwnedEcosystemObject(client, {
          workspaceId: input.workspaceId,
          projectId: input.projectId,
          principalId,
          capability: "graph.read",
          objectType: "graph_view",
          objectId: view.id,
          ownerPrincipalId: policy.ownerPrincipalId,
          visibility: policy.visibility,
        });
      } catch (error) {
        if (error instanceof FoundationServiceError
          && ["NOT_FOUND", "CAPABILITY_DENIED"].includes(error.code)) continue;
        throw error;
      }
      const roots: GraphEntityRef[] = [];
      for (const root of view.root_entities) {
        try {
          await authorizeGraphEntityRead(client, {
            workspaceId: input.workspaceId,
            projectId: input.projectId,
            principalId,
            entityType: root.type,
            entityId: root.id,
          });
          roots.push(root);
        } catch (error) {
          if (error instanceof FoundationServiceError
            && ["NOT_FOUND", "CAPABILITY_DENIED"].includes(error.code)) continue;
          throw error;
        }
      }
      if (roots.length) filtered.push(mapView(view,roots));
    }
    return filtered;
  });
}
