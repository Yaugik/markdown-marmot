import { z } from "zod";

const UUID_V7_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const uuidV7Schema = z
  .string()
  .regex(UUID_V7_PATTERN, "Expected a UUIDv7 identifier");

export const revisionSchema = z.number().int().nonnegative();

export const requestMetadataSchema = z
  .object({
    request_id: uuidV7Schema,
  })
  .strict();

export const mutationRequestMetadataSchema = requestMetadataSchema
  .extend({
    idempotency_key: z.string().trim().min(1).max(255),
    expected_revision: revisionSchema.optional(),
  })
  .strict();

export const opaqueCursorSchema = z.string().min(1).max(4096);

export const cursorPaginationSchema = z
  .object({
    cursor: opaqueCursorSchema.optional(),
    limit: z.number().int().min(1).max(100).default(50),
  })
  .strict();

export const responseMetadataSchema = z
  .object({
    request_id: uuidV7Schema,
    trace_id: z.string().min(1).max(255),
    next_cursor: opaqueCursorSchema.nullable().optional(),
  })
  .strict();

export const provenanceSchema = z
  .object({
    source_type: z.string().min(1).max(100),
    source_id: z.string().min(1).max(255).optional(),
    revision: z.union([revisionSchema, z.string().min(1).max(255)]).optional(),
  })
  .catchall(z.unknown());

export const mutationMetadataSchema = z
  .object({
    activity_id: uuidV7Schema,
    operation_id: uuidV7Schema.nullable().optional(),
    revision: revisionSchema.optional(),
    warnings: z.array(z.string().min(1).max(1000)).default([]),
    effective_permissions: z.array(z.string().min(1).max(255)).default([]),
    provenance: provenanceSchema.optional(),
    suggested_next_actions: z.array(z.string().min(1).max(255)).default([]),
  })
  .strict();

export function successEnvelopeSchema<T extends z.ZodTypeAny>(dataSchema: T) {
  return z
    .object({
      data: dataSchema,
      meta: responseMetadataSchema,
    })
    .strict();
}

export type RequestMetadata = z.infer<typeof requestMetadataSchema>;
export type MutationRequestMetadata = z.infer<
  typeof mutationRequestMetadataSchema
>;
export type CursorPagination = z.infer<typeof cursorPaginationSchema>;
export type ResponseMetadata = z.infer<typeof responseMetadataSchema>;
export type MutationMetadata = z.infer<typeof mutationMetadataSchema>;
export type Provenance = z.infer<typeof provenanceSchema>;
