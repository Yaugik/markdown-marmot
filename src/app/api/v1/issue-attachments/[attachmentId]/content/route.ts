import { z } from "zod";
import { authenticatedRequest, jsonError, jsonSuccess, requestContext } from "@/api";
import { FoundationServiceError } from "@/services/foundation";
import { readIssueAttachmentContent, storeIssueAttachmentContent } from "@/services/issue-attachments";
import { issueServiceError } from "../../../issues/response";

const scopeSchema = z.object({ workspace_id: z.string().uuid(), project_id: z.string().uuid() }).strict();
type RouteContext = { params: Promise<{ attachmentId: string }> };
export const dynamic = "force-dynamic";
function safeDisposition(fileName: string) {
  const ascii = fileName.replace(/[^\x20-\x7E]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

export async function GET(request: Request, { params }: RouteContext) {
  const context = requestContext(request);
  const authenticated = await authenticatedRequest(request, context);
  if (!authenticated.ok) return authenticated.response;
  try {
    const { attachmentId } = await params;
    const id = z.string().uuid().parse(attachmentId);
    const url = new URL(request.url);
    const scope = scopeSchema.parse({ workspace_id: url.searchParams.get("workspace_id"), project_id: url.searchParams.get("project_id") });
    const result = await readIssueAttachmentContent({ workspaceId: scope.workspace_id, projectId: scope.project_id, attachmentId: id }, authenticated.session.principalId);
    return new Response(result.bytes, { status: 200, headers: { "content-type": result.attachment.mimeType, "content-length": String(result.bytes.byteLength), "content-disposition": safeDisposition(result.attachment.fileName), "cache-control": "private, no-store", "x-content-type-options": "nosniff", "x-request-id": context.requestId, "x-trace-id": context.traceId } });
  } catch (error) {
    if (error instanceof z.ZodError) return jsonError("VALIDATION_FAILED", context, 400, { fieldErrors: error.issues.map((issue) => ({ field: issue.path.join("."), code: issue.code, message: issue.message })) });
    if (error instanceof FoundationServiceError) return issueServiceError(error, context);
    return jsonError("OPERATION_FAILED", context, 500);
  }
}

export async function PUT(request: Request, { params }: RouteContext) {
  const context = requestContext(request);
  const authenticated = await authenticatedRequest(request, context);
  if (!authenticated.ok) return authenticated.response;
  try {
    const { attachmentId } = await params;
    const id = z.string().uuid().parse(attachmentId);
    const url = new URL(request.url);
    const scope = scopeSchema.parse({ workspace_id: url.searchParams.get("workspace_id"), project_id: url.searchParams.get("project_id") });
    const declaredHeader = request.headers.get("content-length");
    const declaredLength = declaredHeader === null ? null : Number(declaredHeader);
    if (declaredLength !== null && (!Number.isSafeInteger(declaredLength) || declaredLength < 0 || declaredLength > 10 * 1024 * 1024)) {
      return jsonError("VALIDATION_FAILED", context, 400, { fieldErrors: [{ field: "Content-Length", code: "invalid", message: "Limited to 10 MiB" }] });
    }
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (bytes.byteLength > 10 * 1024 * 1024 || (declaredLength !== null && bytes.byteLength !== declaredLength)) {
      return jsonError("VALIDATION_FAILED", context, 400, { fieldErrors: [{ field: "body", code: "size_mismatch", message: "Attachment body size is invalid" }] });
    }
    const attachment = await storeIssueAttachmentContent({ workspaceId: scope.workspace_id, projectId: scope.project_id, attachmentId: id, bytes }, authenticated.session.principalId);
    return jsonSuccess(attachment, context);
  } catch (error) {
    if (error instanceof z.ZodError) return jsonError("VALIDATION_FAILED", context, 400, { fieldErrors: error.issues.map((issue) => ({ field: issue.path.join("."), code: issue.code, message: issue.message })) });
    if (error instanceof FoundationServiceError) return issueServiceError(error, context);
    return jsonError("OPERATION_FAILED", context, 500);
  }
}
