import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { postgresPool } from "@/db/postgres";
import { establishTenantContext } from "@/db/tenant";
import { newFolioId } from "@/lib/folio-ids";
import { objectStore } from "@/storage/object-store";
import { assertIssueExists, authorizeIssueCapability } from "@/services/issue-access";
import { FoundationServiceError } from "@/services/foundation/errors";
import {
  findIdempotentResult,
  inTransaction,
  lockIdempotencyKey,
  recordMutation,
  requestDigest,
} from "@/services/foundation/internal";
import type { MutationContext, MutationResult } from "@/services/foundation/types";

const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const storageKey = (objectKey: string) => `issue-attachments/${objectKey}`;

export type IssueAttachment = {
  id: string;
  issueId: string;
  commentId: string | null;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  storageState: "pending" | "available" | "failed";
  scanState: "pending" | "clean" | "rejected";
  uploadedByPrincipalId: string;
  createdAt: string;
  availableAt: string | null;
};

type AttachmentRow = {
  id: string;
  issue_id: string;
  comment_id: string | null;
  object_key: string;
  file_name: string;
  mime_type: string;
  size_bytes: string;
  sha256: string;
  storage_state: IssueAttachment["storageState"];
  scan_state: IssueAttachment["scanState"];
  uploaded_by_principal_id: string;
  created_at: Date;
  available_at: Date | null;
};

const columns = `id,issue_id,comment_id,object_key,file_name,mime_type,size_bytes,sha256,
  storage_state,scan_state,uploaded_by_principal_id,created_at,available_at`;

function mapAttachment(row: AttachmentRow): IssueAttachment {
  return {
    id: row.id,
    issueId: row.issue_id,
    commentId: row.comment_id,
    fileName: row.file_name,
    mimeType: row.mime_type,
    sizeBytes: Number(row.size_bytes),
    sha256: row.sha256,
    storageState: row.storage_state,
    scanState: row.scan_state,
    uploadedByPrincipalId: row.uploaded_by_principal_id,
    createdAt: row.created_at.toISOString(),
    availableAt: row.available_at?.toISOString() ?? null,
  };
}

function validateMetadata(input: { fileName: string; mimeType: string; sizeBytes: number; sha256: string }) {
  const fileName = input.fileName.trim();
  const mimeType = input.mimeType.trim().toLowerCase();
  if (!fileName || fileName.length > 255 || fileName.includes("/") || fileName.includes("\\")) {
    throw new FoundationServiceError("VALIDATION_FAILED", "Attachment file name is invalid.");
  }
  if (!mimeType || mimeType.length > 255) throw new FoundationServiceError("VALIDATION_FAILED", "Attachment MIME type is invalid.");
  if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 0 || input.sizeBytes > MAX_ATTACHMENT_BYTES) {
    throw new FoundationServiceError("VALIDATION_FAILED", "Attachment size must be between 0 and 10 MiB.");
  }
  if (!/^[a-f0-9]{64}$/.test(input.sha256)) throw new FoundationServiceError("VALIDATION_FAILED", "Attachment SHA-256 digest is invalid.");
  return { fileName, mimeType, sizeBytes: input.sizeBytes, sha256: input.sha256 };
}

async function getAttachmentRow(
  pool: Pool,
  input: { workspaceId: string; projectId: string; attachmentId: string },
  principalId: string,
  capability: "issue.read" | "issue.edit",
): Promise<AttachmentRow> {
  return inTransaction(pool, async (client) => {
    await establishTenantContext(client,input.workspaceId,principalId);
    const result = await client.query<AttachmentRow>(`SELECT ${columns} FROM issue_attachments
      WHERE workspace_id=$1 AND project_id=$2 AND id=$3 AND archived_at IS NULL`,
    [input.workspaceId,input.projectId,input.attachmentId]);
    const row = result.rows[0];
    if (!row) throw new FoundationServiceError("NOT_FOUND", "Issue attachment was not found.");
    await authorizeIssueCapability(client,{ ...input, principalId, capability, issueId: row.issue_id });
    return row;
  });
}

export async function prepareIssueAttachment(
  raw: {
    workspaceId: string; projectId: string; issueId: string; commentId?: string | null;
    fileName: string; mimeType: string; sizeBytes: number; sha256: string;
  },
  context: MutationContext,
  pool: Pool = postgresPool(),
): Promise<MutationResult<IssueAttachment>> {
  const metadata = validateMetadata(raw);
  const input = { ...raw, ...metadata, commentId: raw.commentId ?? null };
  const operation = "issue_attachment.prepare";
  const digest = requestDigest(input);
  return inTransaction(pool, async (client) => {
    await establishTenantContext(client,input.workspaceId,context.actorPrincipalId);
    await lockIdempotencyKey(client,context.actorPrincipalId,operation,context.idempotencyKey);
    const replay = await findIdempotentResult<IssueAttachment>(client,{
      workspaceId: input.workspaceId, projectId: input.projectId, principalId: context.actorPrincipalId,
      operation, key: context.idempotencyKey, digest,
    });
    if (replay) return replay;
    await authorizeIssueCapability(client,{ ...input, principalId: context.actorPrincipalId, capability: "issue.edit" });
    const issue = await assertIssueExists(client,input.workspaceId,input.projectId,input.issueId);
    if (issue.lifecycle !== "active") throw new FoundationServiceError("CONFLICT", "Attachments require an active issue.");
    if (input.commentId) {
      const comment = await client.query(`SELECT 1 FROM issue_comments
        WHERE workspace_id=$1 AND project_id=$2 AND id=$3 AND issue_id=$4 AND archived_at IS NULL`,
      [input.workspaceId,input.projectId,input.commentId,input.issueId]);
      if (!comment.rows[0]) throw new FoundationServiceError("NOT_FOUND", "Attachment comment was not found on the issue.");
    }
    const attachmentId = newFolioId();
    const objectKey = `${input.workspaceId}/${input.projectId}/${attachmentId}`;
    const now = new Date();
    await client.query(`INSERT INTO issue_attachments(id,workspace_id,project_id,issue_id,comment_id,object_key,
      file_name,mime_type,size_bytes,sha256,uploaded_by_principal_id,created_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [attachmentId,input.workspaceId,input.projectId,input.issueId,input.commentId,objectKey,input.fileName,
      input.mimeType,input.sizeBytes,input.sha256,context.actorPrincipalId,now]);
    const data: IssueAttachment = {
      id: attachmentId, issueId: input.issueId, commentId: input.commentId,
      fileName: input.fileName, mimeType: input.mimeType, sizeBytes: input.sizeBytes,
      sha256: input.sha256, storageState: "pending", scanState: "pending",
      uploadedByPrincipalId: context.actorPrincipalId, createdAt: now.toISOString(), availableAt: null,
    };
    return recordMutation(client,{
      workspaceId: input.workspaceId, projectId: input.projectId, context, operation, digest,
      action: operation, targetType: "issue_attachment", targetId: attachmentId,
      aggregateType: "issue_attachment", aggregateRevision: 1, eventType: "issue_attachment.prepared.v1",
      inputSummary: { issueId: input.issueId, fileName: input.fileName, sizeBytes: input.sizeBytes },
      resultSummary: { attachmentId, objectKey }, data,
    });
  });
}

export async function storeIssueAttachmentContent(
  input: { workspaceId: string; projectId: string; attachmentId: string; bytes: Uint8Array },
  principalId: string,
  pool: Pool = postgresPool(),
): Promise<IssueAttachment> {
  const row = await getAttachmentRow(pool,input,principalId,"issue.edit");
  if (row.uploaded_by_principal_id !== principalId) throw new FoundationServiceError("CAPABILITY_DENIED", "Only the preparing principal may upload attachment content.");
  if (row.storage_state === "available") throw new FoundationServiceError("CONFLICT", "Attachment content is already available.");
  if (input.bytes.byteLength !== Number(row.size_bytes)) throw new FoundationServiceError("VALIDATION_FAILED", "Attachment content length does not match the prepared size.");
  const digest = createHash("sha256").update(input.bytes).digest("hex");
  if (digest !== row.sha256) throw new FoundationServiceError("VALIDATION_FAILED", "Attachment content digest does not match the prepared SHA-256.");

  const store = objectStore();
  await store.put({ key: storageKey(row.object_key), bytes: input.bytes, contentType: row.mime_type, sha256: row.sha256 });
  try {
    return await inTransaction(pool, async (client) => {
      await establishTenantContext(client,input.workspaceId,principalId);
      const result = await client.query<AttachmentRow>(`UPDATE issue_attachments
        SET storage_state='available',scan_state='clean',available_at=now()
        WHERE workspace_id=$1 AND project_id=$2 AND id=$3 AND storage_state='pending' AND archived_at IS NULL
        RETURNING ${columns}`,[input.workspaceId,input.projectId,input.attachmentId]);
      if (!result.rows[0]) throw new FoundationServiceError("CONFLICT", "Attachment state changed before upload completion.");
      return mapAttachment(result.rows[0]);
    });
  } catch (error) {
    await store.delete(storageKey(row.object_key)).catch(() => undefined);
    throw error;
  }
}

export async function readIssueAttachmentContent(
  input: { workspaceId: string; projectId: string; attachmentId: string },
  principalId: string,
  pool: Pool = postgresPool(),
): Promise<{ attachment: IssueAttachment; bytes: Buffer }> {
  const row = await getAttachmentRow(pool,input,principalId,"issue.read");
  if (row.storage_state !== "available" || row.scan_state !== "clean") throw new FoundationServiceError("CONFLICT", "Attachment content is not available.");
  let bytes: Buffer;
  try { bytes = await objectStore().get(storageKey(row.object_key)); }
  catch { throw new FoundationServiceError("NOT_FOUND", "Attachment content was not found."); }
  if (bytes.byteLength !== Number(row.size_bytes) || createHash("sha256").update(bytes).digest("hex") !== row.sha256) {
    throw new FoundationServiceError("CONFLICT", "Attachment content failed integrity verification.");
  }
  return { attachment: mapAttachment(row), bytes };
}

export async function listIssueAttachments(
  input: { workspaceId: string; projectId: string; issueId: string },
  principalId: string,
  pool: Pool = postgresPool(),
): Promise<IssueAttachment[]> {
  return inTransaction(pool, async (client) => {
    await establishTenantContext(client,input.workspaceId,principalId);
    await authorizeIssueCapability(client,{ ...input, principalId, capability: "issue.read" });
    const result = await client.query<AttachmentRow>(`SELECT ${columns} FROM issue_attachments
      WHERE workspace_id=$1 AND project_id=$2 AND issue_id=$3 AND archived_at IS NULL
      ORDER BY created_at DESC,id DESC`,[input.workspaceId,input.projectId,input.issueId]);
    return result.rows.map(mapAttachment);
  });
}
