import { z } from "zod";
import { authenticatedRequest, jsonError, jsonSuccess, requestContext } from "@/api";
import { postgresPool } from "@/db/postgres";
import { establishTenantContext } from "@/db/tenant";
import { FoundationServiceError } from "@/services/foundation";
import { inTransaction } from "@/services/foundation/internal";
import { analyzeMarkdown, prepareRichMarkdownEdit } from "@/services/markdown-roundtrip";
import { authorizePageCapability } from "@/services/page-access";
import { pageServiceError } from "../../pages/response";

const baseSchema = z.object({
  workspace_id: z.string().uuid(),
  project_id: z.string().uuid(),
  page_id: z.string().uuid(),
  source_type: z.literal("git"),
  base_markdown: z.string().max(2 * 1024 * 1024),
});
const schema = z.discriminatedUnion("action", [
  baseSchema.extend({ action: z.literal("analyze") }).strict(),
  baseSchema.extend({
    action: z.literal("prepare"),
    expected_base_hash: z.string().regex(/^[a-f0-9]{64}$/),
    block_edits: z.array(z.object({
      block_index: z.number().int().nonnegative(),
      replacement_markdown: z.string().max(2 * 1024 * 1024),
    }).strict()).max(500),
  }).strict(),
]);
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const context = requestContext(request);
  const authenticated = await authenticatedRequest(request, context);
  if (!authenticated.ok) return authenticated.response;
  try {
    const input = schema.parse(await request.json());
    await inTransaction(postgresPool(), async (client) => {
      await establishTenantContext(client, input.workspace_id, authenticated.session.principalId);
      await authorizePageCapability(client, {
        workspaceId: input.workspace_id,
        projectId: input.project_id,
        principalId: authenticated.session.principalId,
        capability: input.action === "prepare" ? "page.edit" : "page.read",
        pageId: input.page_id,
      });
      const page = await client.query<{ source_type: string }>(`
        SELECT source_type FROM pages
        WHERE workspace_id = $1 AND project_id = $2 AND id = $3
      `, [input.workspace_id, input.project_id, input.page_id]);
      if (!page.rows[0]) throw new FoundationServiceError("NOT_FOUND", "Page was not found.");
      if (page.rows[0].source_type !== "git") {
        throw new FoundationServiceError("CONFLICT", "Rich Markdown operations only accept Git-backed pages.");
      }
    });
    if (input.action === "analyze") {
      return jsonSuccess(analyzeMarkdown(input.base_markdown), context);
    }
    return jsonSuccess(prepareRichMarkdownEdit({
      sourceType: input.source_type,
      baseMarkdown: input.base_markdown,
      expectedBaseHash: input.expected_base_hash,
      blockEdits: input.block_edits.map((edit) => ({
        blockIndex: edit.block_index,
        replacementMarkdown: edit.replacement_markdown,
      })),
    }), context);
  } catch (error) {
    if (error instanceof z.ZodError) return jsonError("VALIDATION_FAILED", context, 400, {
      fieldErrors: error.issues.map((issue) => ({ field: issue.path.join("."), code: issue.code, message: issue.message })),
    });
    if (error instanceof FoundationServiceError) return pageServiceError(error, context);
    return jsonError("OPERATION_FAILED", context, 500);
  }
}
