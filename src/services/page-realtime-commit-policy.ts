import type { Pool } from "pg";
import { postgresPool } from "@/db/postgres";
import { establishTenantContext } from "@/db/tenant";
import {
  commitPageCollaborationRoomRecoverably,
} from "@/services/page-realtime-collaboration-policy";
import type { PageCollaborationRoom } from "@/services/page-realtime-collaboration";
import type { NativePage } from "@/services/pages";
import { inTransaction } from "@/services/foundation/internal";
import type { MutationContext, MutationResult } from "@/services/foundation/types";

export async function commitPageCollaborationRoomExactlyOnce(
  input: { workspaceId: string; projectId: string; roomId: string },
  context: MutationContext,
  pool: Pool = postgresPool(),
): Promise<MutationResult<{ room: PageCollaborationRoom; page: NativePage }>> {
  const stored = await inTransaction(pool, async (client) => {
    await establishTenantContext(client,input.workspaceId,context.actorPrincipalId);
    const result = await client.query<{
      response_body: MutationResult<{ room: PageCollaborationRoom; page: NativePage }>;
    }>(`
      SELECT response_body
      FROM idempotency_records
      WHERE workspace_id=$1 AND project_id=$2 AND principal_id=$3
        AND operation='page_collaboration.commit' AND idempotency_key=$4
        AND expires_at>now()
      ORDER BY created_at DESC LIMIT 1
    `,[input.workspaceId,input.projectId,context.actorPrincipalId,context.idempotencyKey]);
    return result.rows[0]?.response_body ?? null;
  });
  if (stored) return { ...stored,replayed:true };
  return commitPageCollaborationRoomRecoverably(input,context,pool);
}
