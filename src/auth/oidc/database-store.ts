import { postgresPool } from "@/db/postgres";
import type { AuthTransaction, AuthTransactionStore } from "./transaction";

type TransactionRow = {
  id: string;
  nonce: string;
  pkce_verifier: string;
  return_to: string;
  created_at: Date;
  expires_at: Date;
  consumed_at: Date | null;
};

function mapTransaction(row: TransactionRow): AuthTransaction {
  return {
    id: row.id,
    nonce: row.nonce,
    pkceVerifier: row.pkce_verifier,
    returnTo: row.return_to,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    consumedAt: row.consumed_at,
  };
}

export class PostgresAuthTransactionStore implements AuthTransactionStore {
  async save(transaction: AuthTransaction): Promise<void> {
    await postgresPool().query(`
      INSERT INTO oidc_auth_transactions (
        id, nonce, pkce_verifier, return_to, expires_at, consumed_at, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)
    `, [
      transaction.id,
      transaction.nonce,
      transaction.pkceVerifier,
      transaction.returnTo,
      transaction.expiresAt,
      transaction.consumedAt,
      transaction.createdAt,
    ]);
  }

  async consume(id: string, now: Date): Promise<AuthTransaction | null> {
    const result = await postgresPool().query<TransactionRow>(`
      UPDATE oidc_auth_transactions
      SET consumed_at = $2
      WHERE id = $1 AND consumed_at IS NULL AND expires_at > $2
      RETURNING id, nonce, pkce_verifier, return_to, created_at, expires_at, consumed_at
    `, [id, now]);
    return result.rows[0] ? mapTransaction(result.rows[0]) : null;
  }
}
