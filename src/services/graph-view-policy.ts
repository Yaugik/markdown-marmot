import type { Pool } from "pg";
import { postgresPool } from "@/db/postgres";
import { establishTenantContext } from "@/db/tenant";
import { authorizeGraphEntityRead } from "@/services/ecosystem-access";
import { FoundationServiceError } from "@/services/foundation/errors";
import { inTransaction } from "@/services/foundation/internal";
import { listSavedGraphViews, type SavedGraphView } from "@/services/graph-explorer";

export async function listPermissionFilteredGraphViews(
  input: { workspaceId: string; projectId: string },
  principalId: string,
  pool: Pool = postgresPool(),
): Promise<SavedGraphView[]> {
  const views = await listSavedGraphViews(input, principalId, pool);
  return inTransaction(pool, async (client) => {
    await establishTenantContext(client, input.workspaceId, principalId);
    const filtered: SavedGraphView[] = [];
    for (const view of views) {
      const roots: SavedGraphView["rootEntities"] = [];
      for (const root of view.rootEntities) {
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
      if (roots.length) filtered.push({ ...view, rootEntities: roots });
    }
    return filtered;
  });
}
