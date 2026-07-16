import { z } from "zod";
import { authenticatedRequest, jsonError, jsonSuccess, requestContext } from "@/api";
import { FoundationServiceError } from "@/services/foundation";
import { readRelationshipDerivationRuns, rebuildDerivedRelationships } from "@/services/derived-relationships";
import { ecosystemServiceError, mutationEnvelope } from "../ecosystem/response";

const entityType = z.enum(["page","issue","todo","calendar_entry","canvas"]);
const readSchema = z.object({
  workspace_id: z.string().uuid(),
  project_id: z.string().uuid(),
  source_type: entityType,
  source_id: z.string().uuid(),
  limit: z.coerce.number().int().positive().max(200).optional(),
}).strict();
const rebuildSchema = z.object({
  workspace_id: z.string().uuid(),
  project_id: z.string().uuid(),
  agent_principal_id: z.string().uuid(),
  source: z.object({ type: entityType, id: z.string().uuid(), revision: z.string().trim().min(1).max(180) }).strict(),
  rebuild_key: z.string().trim().min(1).max(240),
  candidates: z.array(z.object({
    relationship_type_id: z.string().uuid(),
    target: z.object({ type: entityType, id: z.string().uuid() }).strict(),
    confidence: z.number().min(0).max(1).nullable().optional(),
    metadata: z.record(z.unknown()).optional(),
  }).strict()).min(1).max(500),
}).strict();

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const context = requestContext(request);
  const authenticated = await authenticatedRequest(request, context);
  if (!authenticated.ok) return authenticated.response;
  try {
    const url = new URL(request.url);
    const input = readSchema.parse({
      workspace_id: url.searchParams.get("workspace_id"),
      project_id: url.searchParams.get("project_id"),
      source_type: url.searchParams.get("source_type"),
      source_id: url.searchParams.get("source_id"),
      limit: url.searchParams.get("limit") ?? undefined,
    });
    const data = await readRelationshipDerivationRuns({
      workspaceId: input.workspace_id,
      projectId: input.project_id,
      sourceType: input.source_type,
      sourceId: input.source_id,
      limit: input.limit,
    }, authenticated.session.principalId);
    return jsonSuccess(data, context);
  } catch (error) {
    if (error instanceof z.ZodError) return jsonError("VALIDATION_FAILED", context, 400);
    if (error instanceof FoundationServiceError) return ecosystemServiceError(error, context);
    return jsonError("OPERATION_FAILED", context, 500);
  }
}

export async function POST(request: Request) {
  const context = requestContext(request);
  const authenticated = await authenticatedRequest(request, context);
  if (!authenticated.ok) return authenticated.response;
  const key = request.headers.get("idempotency-key")?.trim();
  if (!key) return jsonError("VALIDATION_FAILED", context, 400);
  try {
    const input = rebuildSchema.parse(await request.json());
    const result = await rebuildDerivedRelationships({
      workspaceId: input.workspace_id,
      projectId: input.project_id,
      sourceKind: "agent_synthesis",
      source: input.source,
      rebuildKey: input.rebuild_key,
      candidates: input.candidates.map((candidate) => ({
        relationshipTypeId: candidate.relationship_type_id,
        target: candidate.target,
        confidence: candidate.confidence,
        metadata: candidate.metadata,
      })),
    }, {
      actorPrincipalId: input.agent_principal_id,
      authorizingPrincipalId: authenticated.session.principalId,
      requestId: context.requestId,
      traceId: context.traceId,
      idempotencyKey: key,
      source: "agent",
    });
    return jsonSuccess(mutationEnvelope("derivation_run", result), context, result.replayed ? 200 : 201);
  } catch (error) {
    if (error instanceof z.ZodError) return jsonError("VALIDATION_FAILED", context, 400);
    if (error instanceof FoundationServiceError) return ecosystemServiceError(error, context);
    return jsonError("OPERATION_FAILED", context, 500);
  }
}
