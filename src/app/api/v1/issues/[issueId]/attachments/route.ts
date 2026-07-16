import { z } from "zod";
import { authenticatedRequest, jsonError, jsonSuccess, requestContext } from "@/api";
import { FoundationServiceError } from "@/services/foundation";
import { listIssueAttachments, prepareIssueAttachment } from "@/services/issue-attachments";
import { issueServiceError, mutationContext } from "../../response";

const scopeSchema = z.object({ workspace_id: z.string().uuid(), project_id: z.string().uuid() }).strict();
const createSchema = scopeSchema.extend({
  comment_id: z.string().uuid().nullable().optional(),
  file_name: z.string().trim().min(1).max(255),
  mime_type: z.string().trim().min(1).max(255),
  size_bytes: z.number().int().min(0).max(10 * 1024 * 1024),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
type RouteContext = { params: Promise<{ issueId: string }> };
export const dynamic = "force-dynamic";
const responseAttachment = (item: Awaited<ReturnType<typeof listIssueAttachments>>[number]) => ({ id: item.id, issue_id: item.issueId, comment_id: item.commentId, file_name: item.fileName, mime_type: item.mimeType, size_bytes: item.sizeBytes, sha256: item.sha256, storage_state: item.storageState, scan_state: item.scanState, uploaded_by_principal_id: item.uploadedByPrincipalId, created_at: item.createdAt, available_at: item.availableAt });

export async function GET(request: Request, { params }: RouteContext) {
  const context = requestContext(request);
  const authenticated = await authenticatedRequest(request, context);
  if (!authenticated.ok) return authenticated.response;
  try {
    const { issueId } = await params;
    const id = z.string().uuid().parse(issueId);
    const url = new URL(request.url);
    const scope = scopeSchema.parse({ workspace_id: url.searchParams.get("workspace_id"), project_id: url.searchParams.get("project_id") });
    const attachments = await listIssueAttachments({ workspaceId: scope.workspace_id, projectId: scope.project_id, issueId: id }, authenticated.session.principalId);
    return jsonSuccess(attachments.map(responseAttachment), context);
  } catch (error) {
    if (error instanceof z.ZodError) return jsonError("VALIDATION_FAILED", context, 400, { fieldErrors: error.issues.map((issue) => ({ field: issue.path.join("."), code: issue.code, message: issue.message })) });
    if (error instanceof FoundationServiceError) return issueServiceError(error, context);
    return jsonError("OPERATION_FAILED", context, 500);
  }
}

export async function POST(request: Request, { params }: RouteContext) {
  const context = requestContext(request);
  const authenticated = await authenticatedRequest(request, context);
  if (!authenticated.ok) return authenticated.response;
  const idempotencyKey = request.headers.get("idempotency-key")?.trim();
  if (!idempotencyKey) return jsonError("VALIDATION_FAILED", context, 400, { fieldErrors: [{ field: "Idempotency-Key", code: "required", message: "Required" }] });
  try {
    const { issueId } = await params;
    const id = z.string().uuid().parse(issueId);
    const input = createSchema.parse(await request.json());
    const result = await prepareIssueAttachment({ workspaceId: input.workspace_id, projectId: input.project_id, issueId: id, commentId: input.comment_id, fileName: input.file_name, mimeType: input.mime_type, sizeBytes: input.size_bytes, sha256: input.sha256 }, mutationContext(authenticated.session.principalId, context, idempotencyKey));
    return jsonSuccess({ attachment: responseAttachment(result.data), upload_url: `/api/v1/issue-attachments/${result.data.id}/content?workspace_id=${input.workspace_id}&project_id=${input.project_id}`, activity_id: result.activityId, outbox_event_id: result.outboxEventId, replayed: result.replayed }, context, result.replayed ? 200 : 201);
  } catch (error) {
    if (error instanceof z.ZodError) return jsonError("VALIDATION_FAILED", context, 400, { fieldErrors: error.issues.map((issue) => ({ field: issue.path.join("."), code: issue.code, message: issue.message })) });
    if (error instanceof FoundationServiceError) return issueServiceError(error, context);
    return jsonError("OPERATION_FAILED", context, 500);
  }
}
