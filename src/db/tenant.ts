import type { PoolClient } from "pg";

export async function establishTenantContext(
  client: PoolClient,
  workspaceId: string,
  principalId: string,
): Promise<void> {
  await client.query("SET LOCAL ROLE folio_runtime");
  await client.query("SELECT folio.set_transaction_context($1, $2)", [workspaceId, principalId]);
}
