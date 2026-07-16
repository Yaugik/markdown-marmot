import type { Pool } from "pg";
import { postgresPool } from "@/db/postgres";
import { establishTenantContext } from "@/db/tenant";
import { authorizePageCapability } from "@/services/page-access";
import {
  commitPageCollaborationRoom,
  openPageCollaborationRoom,
  readPageCollaborationRoom,
  type PageCollaborationRoom,
  type PageCollaborationSnapshot,
} from "@/services/page-realtime-collaboration";
import { readNativePage, type NativePage } from "@/services/pages";
import { FoundationServiceError } from "@/services/foundation/errors";
import {
  findIdempotentResult,
  inTransaction,
  lockIdempotencyKey,
  recordMutation,
  requestDigest,
} from "@/services/foundation/internal";
import type { MutationContext, MutationResult } from "@/services/foundation/types";

type RoomRow = {
  id: string;
  page_id: string;
  state: "active" | "closing" | "closed";
  base_revision_id: string;
  current_sequence: string;
  revision: string;
  created_by_principal_id: string;
  created_at: Date;
  updated_at: Date;
  closed_at: Date | null;
};
type RecoveryRow = RoomRow & {
  checkpoint_hash: string;
  current_revision_id: string;
  current_parent_revision_id: string | null;
  current_content_hash: string;
};

function mapRoom(row: RoomRow): PageCollaborationRoom {
  return {
    id: row.id,
    pageId: row.page_id,
    state: row.state,
    baseRevisionId: row.base_revision_id,
    currentSequence: Number(row.current_sequence),
    revision: Number(row.revision),
    createdByPrincipalId: row.created_by_principal_id,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    closedAt: row.closed_at?.toISOString() ?? null,
  };
}

export async function openPageCollaborationRoomWithSnapshot(
  input: { workspaceId: string; projectId: string; pageId: string },
  context: MutationContext,
  pool: Pool = postgresPool(),
): Promise<MutationResult<PageCollaborationSnapshot>> {
  const opened = await openPageCollaborationRoom(input, context, pool);
  const snapshot = await readPageCollaborationRoom({
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    roomId: opened.data.room.id,
    afterSequence: 0,
    limit: 500,
  }, context.actorPrincipalId, pool);
  return { ...opened, data: snapshot };
}

async function recoveryCandidate(
  input: { workspaceId: string; projectId: string; roomId: string },
  principalId: string,
  pool: Pool,
): Promise<RecoveryRow | null> {
  return inTransaction(pool, async (client) => {
    await establishTenantContext(client, input.workspaceId, principalId);
    const result = await client.query<RecoveryRow>(`
      SELECT room.id,room.page_id,room.state,room.base_revision_id,room.current_sequence,
        room.revision,room.created_by_principal_id,room.created_at,room.updated_at,room.closed_at,
        cp.content_hash checkpoint_hash,np.current_revision_id,
        revision.parent_revision_id current_parent_revision_id,
        revision.content_hash current_content_hash
      FROM page_collaboration_rooms room
      JOIN LATERAL (
        SELECT content_hash FROM page_collaboration_checkpoints
        WHERE room_id=room.id ORDER BY server_sequence DESC LIMIT 1
      ) cp ON true
      JOIN native_pages np
        ON np.workspace_id=room.workspace_id AND np.project_id=room.project_id AND np.page_id=room.page_id
      JOIN native_page_revisions revision
        ON revision.workspace_id=np.workspace_id AND revision.project_id=np.project_id
        AND revision.id=np.current_revision_id
      WHERE room.workspace_id=$1 AND room.project_id=$2 AND room.id=$3
    `, [input.workspaceId,input.projectId,input.roomId]);
    const row = result.rows[0];
    if (!row) return null;
    await authorizePageCapability(client, {
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      principalId,
      capability: "page.collaborate",
      pageId: row.page_id,
    });
    return row;
  });
}

export async function commitPageCollaborationRoomRecoverably(
  input: { workspaceId: string; projectId: string; roomId: string },
  context: MutationContext,
  pool: Pool = postgresPool(),
): Promise<MutationResult<{ room: PageCollaborationRoom; page: NativePage }>> {
  try {
    return await commitPageCollaborationRoom(input, context, pool);
  } catch (error) {
    if (!(error instanceof FoundationServiceError)
      || !["REVISION_CONFLICT", "CONFLICT"].includes(error.code)) throw error;
  }

  const candidate = await recoveryCandidate(input, context.actorPrincipalId, pool);
  if (!candidate
    || candidate.state !== "closing"
    || candidate.current_parent_revision_id !== candidate.base_revision_id
    || candidate.current_content_hash !== candidate.checkpoint_hash) {
    throw new FoundationServiceError(
      "REVISION_CONFLICT",
      "Collaboration commit could not be recovered because the canonical page no longer matches the room checkpoint.",
      { roomId: input.roomId },
    );
  }

  const page = await readNativePage({
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    pageId: candidate.page_id,
  }, context.actorPrincipalId, pool);
  const operation = "page_collaboration.commit";
  const digest = requestDigest({
    ...input,
    serverSequence: Number(candidate.current_sequence),
    pageRevision: page.revision,
    recoveredNativeRevisionId: candidate.current_revision_id,
  });

  return inTransaction(pool, async (client) => {
    await establishTenantContext(client, input.workspaceId, context.actorPrincipalId);
    await lockIdempotencyKey(client, context.actorPrincipalId, operation, context.idempotencyKey);
    const replay = await findIdempotentResult<{ room: PageCollaborationRoom; page: NativePage }>(client, {
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      principalId: context.actorPrincipalId,
      operation,
      key: context.idempotencyKey,
      digest,
    });
    if (replay) return replay;

    const closed = await client.query<RoomRow>(`
      UPDATE page_collaboration_rooms room
      SET state='closed',closed_by_principal_id=$4,closed_at=now(),
        revision=revision+1,updated_at=now()
      WHERE room.workspace_id=$1 AND room.project_id=$2 AND room.id=$3
        AND room.state='closing' AND room.current_sequence=$5
        AND EXISTS (
          SELECT 1
          FROM native_pages np
          JOIN native_page_revisions revision
            ON revision.workspace_id=np.workspace_id AND revision.project_id=np.project_id
            AND revision.id=np.current_revision_id
          WHERE np.workspace_id=room.workspace_id AND np.project_id=room.project_id
            AND np.page_id=room.page_id
            AND revision.parent_revision_id=room.base_revision_id
            AND revision.content_hash=(
              SELECT cp.content_hash FROM page_collaboration_checkpoints cp
              WHERE cp.room_id=room.id ORDER BY cp.server_sequence DESC LIMIT 1
            )
        )
      RETURNING room.id,room.page_id,room.state,room.base_revision_id,room.current_sequence,
        room.revision,room.created_by_principal_id,room.created_at,room.updated_at,room.closed_at
    `, [input.workspaceId,input.projectId,input.roomId,context.actorPrincipalId,
      Number(candidate.current_sequence)]);
    const row = closed.rows[0];
    if (!row) throw new FoundationServiceError("CONFLICT", "Collaboration recovery lost its canonical-page precondition.");
    const data = { room: mapRoom(row), page };
    return recordMutation(client, {
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      context,
      operation,
      digest,
      action: "page_collaboration.commit_recovered",
      targetType: "page_collaboration_room",
      targetId: input.roomId,
      aggregateType: "page_collaboration_room",
      aggregateRevision: Number(row.revision),
      eventType: "page_collaboration.commit_recovered.v1",
      inputSummary: { roomId: input.roomId, serverSequence: Number(row.current_sequence) },
      resultSummary: {
        roomId: input.roomId,
        pageId: page.id,
        pageRevision: page.revision,
        nativeRevisionId: page.currentRevision.id,
      },
      data,
    });
  });
}
