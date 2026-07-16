import type { Pool } from "pg";
import { postgresPool } from "@/db/postgres";
import { establishTenantContext } from "@/db/tenant";
import { newFolioId } from "@/lib/folio-ids";
import { executeAuditExport } from "@/services/audit-exports";
import { FoundationServiceError } from "@/services/foundation/errors";
import { inTransaction } from "@/services/foundation/internal";

export async function executeAuditExportWithActivity(
  exportId: string,
  pool: Pool = postgresPool(),
): Promise<{ exportId: string; rowCount: number; contentHash: string; objectKey: string }> {
  const target = await inTransaction(pool, async (client) => {
    await client.query("SET LOCAL ROLE folio_worker");
    const result = await client.query<{
      workspace_id: string;
      project_id: string | null;
      requested_by_principal_id: string;
    }>(`
      SELECT workspace_id,project_id,requested_by_principal_id
      FROM audit_export_requests WHERE id=$1
    `, [exportId]);
    if (!result.rows[0]) throw new FoundationServiceError("NOT_FOUND", "Audit export was not found.");
    return result.rows[0];
  });

  const result = await executeAuditExport(exportId, pool);
  await inTransaction(pool, async (client) => {
    await establishTenantContext(client, target.workspace_id, target.requested_by_principal_id);
    const requestId = newFolioId();
    await client.query(`
      INSERT INTO activity_events(
        id,workspace_id,project_id,actor_principal_id,authorizing_principal_id,
        source,action,target_type,target_id,input_summary,result_summary,request_id
      ) VALUES($1,$2,$3,$4,$4,'worker','audit_export.completed','audit_export',$5,$6,$7,$8)
    `, [newFolioId(),target.workspace_id,target.project_id,target.requested_by_principal_id,
      exportId,{},{auditExportId:exportId,rowCount:result.rowCount,contentHash:result.contentHash},requestId]);
    await client.query(`
      INSERT INTO outbox_events(
        id,workspace_id,project_id,aggregate_type,aggregate_id,aggregate_revision,event_type,
        actor_principal_id,authorizing_principal_id,request_id,payload
      ) VALUES($1,$2,$3,'audit_export',$4,2,'audit_export.completed.v1',$5,$5,$6,$7)
    `, [newFolioId(),target.workspace_id,target.project_id,exportId,
      target.requested_by_principal_id,requestId,
      {auditExportId:exportId,rowCount:result.rowCount,contentHash:result.contentHash}]);
  });
  return result;
}
