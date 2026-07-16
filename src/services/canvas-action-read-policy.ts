import type { Pool } from "pg";
import { postgresPool } from "@/db/postgres";
import { establishTenantContext } from "@/db/tenant";
import { inTransaction } from "@/services/foundation/internal";
import { readCanvasActionPreview, type CanvasActionPreview } from "@/services/canvas-action-previews";

export type PresentedCanvasActionPreview = Omit<CanvasActionPreview, "state"> & {
  state: CanvasActionPreview["state"] | "approved";
};

export async function readPresentedCanvasActionPreview(
  input: { workspaceId: string; projectId: string; previewId: string },
  principalId: string,
  pool: Pool = postgresPool(),
): Promise<PresentedCanvasActionPreview> {
  const preview = await readCanvasActionPreview(input, principalId, pool);
  if (preview.riskLevel !== "R2" || preview.state !== "pending" || !preview.confirmationId) return preview;
  const approved = await inTransaction(pool, async (client) => {
    await establishTenantContext(client, input.workspaceId, principalId);
    const result = await client.query(`
      SELECT 1 FROM action_confirmations
      WHERE workspace_id=$1 AND project_id=$2 AND id=$3
        AND action_digest=$4 AND status='approved' AND expires_at>now()
    `, [input.workspaceId,input.projectId,preview.confirmationId,preview.actionDigest]);
    return Boolean(result.rows[0]);
  });
  return approved ? { ...preview, state: "approved" } : preview;
}
