import type { Pool } from "pg";
import { postgresPool } from "@/db/postgres";
import { establishTenantContext } from "@/db/tenant";
import {
  authorizeOwnedEcosystemObject,
  readCanvasPolicy,
} from "@/services/ecosystem-access";
import { FoundationServiceError } from "@/services/foundation/errors";
import { inTransaction } from "@/services/foundation/internal";
import type { CanvasScene } from "@/services/canvas-scenes";

type CanvasRow = {
  id: string;
  owner_principal_id: string;
  title: string;
  visibility: "private" | "project";
  scene_version: number;
  current_revision_id: string;
  revision: string;
  created_at: Date;
  updated_at: Date;
  archived_at: Date | null;
};

export async function listPermissionFilteredCanvases(
  input: { workspaceId: string; projectId: string },
  principalId: string,
  pool: Pool = postgresPool(),
): Promise<Array<Omit<CanvasScene,"elements">>> {
  return inTransaction(pool, async (client) => {
    await establishTenantContext(client, input.workspaceId, principalId);
    const candidates = await client.query<CanvasRow>(`
      SELECT id,owner_principal_id,title,visibility,scene_version,current_revision_id,
        revision,created_at,updated_at,archived_at
      FROM canvases canvas
      WHERE workspace_id=$1 AND project_id=$2 AND archived_at IS NULL
        AND (
          visibility='project'
          OR owner_principal_id=$3
          OR EXISTS (
            SELECT 1 FROM object_grants grant_row
            WHERE grant_row.workspace_id=$1 AND grant_row.project_id=$2
              AND grant_row.principal_id=$3 AND grant_row.object_type='canvas'
              AND grant_row.object_id=canvas.id
              AND grant_row.capabilities @> ARRAY['canvas.read']::text[]
              AND (grant_row.valid_until IS NULL OR grant_row.valid_until>now())
          )
        )
      ORDER BY updated_at DESC,id
    `, [input.workspaceId,input.projectId,principalId]);
    const visible: Array<Omit<CanvasScene,"elements">> = [];
    for (const row of candidates.rows) {
      try {
        const policy = await readCanvasPolicy(client, {
          workspaceId: input.workspaceId,
          projectId: input.projectId,
          canvasId: row.id,
        });
        await authorizeOwnedEcosystemObject(client, {
          workspaceId: input.workspaceId,
          projectId: input.projectId,
          principalId,
          capability: "canvas.read",
          objectType: "canvas",
          objectId: row.id,
          ownerPrincipalId: policy.ownerPrincipalId,
          visibility: policy.visibility,
        });
      } catch (error) {
        if (error instanceof FoundationServiceError
          && ["NOT_FOUND", "CAPABILITY_DENIED"].includes(error.code)) continue;
        throw error;
      }
      visible.push({
        id: row.id,
        ownerPrincipalId: row.owner_principal_id,
        title: row.title,
        visibility: row.visibility,
        sceneVersion: row.scene_version,
        revision: Number(row.revision),
        currentRevisionId: row.current_revision_id,
        createdAt: row.created_at.toISOString(),
        updatedAt: row.updated_at.toISOString(),
        archivedAt: null,
      });
    }
    return visible;
  });
}
