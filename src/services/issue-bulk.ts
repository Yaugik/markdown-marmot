import type { Pool } from "pg";
import { postgresPool } from "@/db/postgres";
import { FoundationServiceError } from "@/services/foundation/errors";
import type { MutationContext, MutationResult } from "@/services/foundation/types";
import {
  executeIssueBulkOperation as executeHardenedIssueBulkOperation,
  readIssueBulkPreview,
  type IssueBulkPreview,
} from "./issue-bulk-implementation";

export * from "./issue-bulk-implementation";

export async function executeIssueBulkOperation(
  raw: { workspaceId: string; projectId: string; previewId: string; expectedRevision: number },
  context: MutationContext,
  pool: Pool = postgresPool(),
): Promise<MutationResult<IssueBulkPreview>> {
  const preview = await readIssueBulkPreview({
    workspaceId: raw.workspaceId,
    projectId: raw.projectId,
    previewId: raw.previewId,
  }, context.actorPrincipalId, pool);
  if (preview.state === "expired") {
    throw new FoundationServiceError("CONFLICT", "Bulk preview has expired.", {
      currentRevision: preview.revision,
    });
  }
  return executeHardenedIssueBulkOperation(raw, context, pool);
}
