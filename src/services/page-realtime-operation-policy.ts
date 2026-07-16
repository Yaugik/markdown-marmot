import type { Pool } from "pg";
import { postgresPool } from "@/db/postgres";
import {
  submitPageCollaborationOperation,
  type PageCollaborationOperation,
} from "@/services/page-realtime-collaboration";
import type { MutationContext, MutationResult } from "@/services/foundation/types";

export async function submitPageCollaborationOperationSafely(
  input: {
    workspaceId: string;
    projectId: string;
    roomId: string;
    clientId: string;
    clientSequence: number;
    baseSequence: number;
    content: unknown;
  },
  context: MutationContext,
  pool: Pool = postgresPool(),
): Promise<MutationResult<PageCollaborationOperation>> {
  return submitPageCollaborationOperation(input, {
    ...context,
    idempotencyKey: `collaboration:${input.roomId}:${input.clientId.trim()}:${input.clientSequence}`,
  }, pool);
}
