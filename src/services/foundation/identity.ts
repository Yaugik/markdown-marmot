import type { Pool } from "pg";
import { postgresPool } from "@/db/postgres";
import { newFolioId } from "@/lib/folio-ids";
import { FoundationServiceError } from "./errors";
import { inTransaction } from "./internal";
import type { AuthenticatedPrincipal } from "./types";

export type ProvisionHumanInput = {
  issuer: string;
  subject: string;
  email: string;
  displayName: string;
  claimsSummary?: Record<string, unknown>;
};

type IdentityRow = {
  user_id: string;
  principal_id: string;
  display_name: string;
  primary_email: string;
  revision: string;
};

function validateInput(input: ProvisionHumanInput): ProvisionHumanInput {
  const normalized = {
    ...input,
    issuer: input.issuer.trim(),
    subject: input.subject.trim(),
    email: input.email.trim().toLowerCase(),
    displayName: input.displayName.trim(),
  };
  if (!normalized.issuer || !normalized.subject || !normalized.email.includes("@")) {
    throw new FoundationServiceError("VALIDATION_FAILED", "OIDC issuer, subject, and email are required.");
  }
  if (!normalized.displayName || normalized.displayName.length > 120) {
    throw new FoundationServiceError("VALIDATION_FAILED", "Display name must contain 1 to 120 characters.");
  }
  return normalized;
}

function mapRow(row: IdentityRow): AuthenticatedPrincipal {
  return {
    userId: row.user_id,
    principalId: row.principal_id,
    displayName: row.display_name,
    primaryEmail: row.primary_email,
    revision: Number(row.revision),
  };
}

/**
 * Bootstraps a human principal from a validated OIDC identity. The external
 * identity uniqueness constraint and an advisory transaction lock make this
 * naturally idempotent, including concurrent first-login requests.
 *
 * This bootstrap cannot write an idempotency/activity/outbox row because the
 * foundation schema requires those records to reference a workspace, and the
 * user does not necessarily belong to one yet.
 */
export async function provisionAuthenticatedHuman(
  rawInput: ProvisionHumanInput,
  pool: Pool = postgresPool(),
): Promise<AuthenticatedPrincipal> {
  const input = validateInput(rawInput);
  return inTransaction(pool, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
      `${input.issuer}:${input.subject}`,
    ]);
    const existing = await client.query<IdentityRow>(`
      SELECT u.id user_id, p.id principal_id, u.display_name, u.primary_email, u.revision
      FROM external_identities e
      JOIN users u ON u.id = e.user_id
      JOIN principals p ON p.user_id = u.id AND p.kind = 'human'
      WHERE e.provider = $1 AND e.provider_subject = $2
    `, [input.issuer, input.subject]);
    if (existing.rows[0]) {
      await client.query(`
        UPDATE external_identities
        SET last_authenticated_at = now(), updated_at = now()
        WHERE provider = $1 AND provider_subject = $2
      `, [input.issuer, input.subject]);
      return mapRow(existing.rows[0]);
    }

    const emailOwner = await client.query<{ id: string }>(
      "SELECT id FROM users WHERE primary_email = $1",
      [input.email],
    );
    if (emailOwner.rows[0]) {
      throw new FoundationServiceError(
        "CONFLICT",
        "The email is already associated with another identity.",
        { email: input.email },
      );
    }

    const userId = newFolioId();
    const principalId = newFolioId();
    await client.query(`
      INSERT INTO users (id, display_name, primary_email)
      VALUES ($1, $2, $3)
    `, [userId, input.displayName, input.email]);
    await client.query(`
      INSERT INTO external_identities (
        id, user_id, provider, provider_subject, verified_email,
        claims_summary, last_authenticated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, now())
    `, [newFolioId(), userId, input.issuer, input.subject, input.email, input.claimsSummary ?? {}]);
    await client.query(`
      INSERT INTO principals (id, kind, user_id, display_name)
      VALUES ($1, 'human', $2, $3)
    `, [principalId, userId, input.displayName]);
    return {
      userId,
      principalId,
      displayName: input.displayName,
      primaryEmail: input.email,
      revision: 1,
    };
  });
}
