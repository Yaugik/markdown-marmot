# Folio Production Operations

## Deployment boundary

`compose.production.yaml` is a reference container deployment for the web and worker processes. Production PostgreSQL, object storage, identity, secrets/KMS, TLS termination, monitoring, and backup artifact retention are external managed services.

Use `.env.production.example` as a field inventory. Supply secrets through the deployment secret manager rather than committing a populated environment file.

Required production gates:

1. PostgreSQL uses TLS with a trusted CA and a dedicated application login that can assume only the migration-created runtime, worker, and webhook roles.
2. Object storage uses the S3 driver, private buckets, server-side encryption, blocked public access, versioning, lifecycle retention, and a credential/key reference recorded in the workspace storage policy.
3. OIDC, workspace invitation signing, GitHub App state signing, GitHub webhook verification, and metrics authentication use different random keys.
4. The GitHub App private key is mounted read-only and installation tokens are minted only at request time.
5. Web and worker containers run read-only, without Linux capabilities, with bounded temporary storage.

## Release procedure

1. Build an immutable image and record its digest.
2. Back up PostgreSQL with `npm run ops:backup` and retain the artifact checksum.
3. Run migrations in a single controlled release job:

   ```bash
   npm run db:migrate:folio
   ```

4. Deploy the worker and web image with the same digest.
5. Verify `/api/health`, authenticated `/api/v1/operational-readiness`, and bearer-authenticated `/api/metrics`.
6. Exercise OIDC login, invitation acceptance, GitHub installation, repository refresh, branch reconciliation, attachment upload/download, and one prepared pull-request write.
7. Keep the previous application image available until the compatibility window closes.

## Backup evidence

Run:

```bash
OPERATIONS_PRINCIPAL_ID=<owner-principal-uuid> \
BACKUP_DIR=/secure/backup/path \
npm run ops:backup
```

The command writes a PostgreSQL custom-format dump, calculates SHA-256, and records the artifact reference, checksum, size, environment, and completion state in `operational_drills`.

Store artifacts outside the application host with encryption, immutability/retention, and access logging. `BACKUP_RETENTION_DAYS` is documentation/readiness metadata; the storage lifecycle policy remains authoritative.

## Restore drill

Use an isolated PostgreSQL server or cluster role that can create a temporary database:

```bash
OPERATIONS_PRINCIPAL_ID=<owner-principal-uuid> \
DATABASE_ADMIN_URL=postgresql://restore-admin@isolated-postgres/postgres \
RESTORE_ARTIFACT=/secure/backup/path/folio-....dump \
npm run ops:restore-drill
```

The drill creates a randomly named database, restores with `--exit-on-error`, reads the latest migration and representative row counts, records the result, and drops the temporary database. It never restores over the live database.

A production workspace is not operationally ready when the most recent successful restore evidence is older than `RESTORE_DRILL_MAX_AGE_DAYS`.

## Migration rollback

Folio migrations are forward-only. Rollback means:

1. stop writes or place the service in maintenance mode;
2. restore the pre-release database backup into a new database;
3. point the previous application image at the restored database;
4. preserve the failed database and provider logs for diagnosis;
5. reconcile GitHub branches and external providers after service restoration.

Do not run ad hoc destructive down migrations against production. Add a new compatibility migration when the release can safely move forward.

## GitHub failure handling

- Webhook deliveries are deduplicated by GitHub delivery UUID and store only a reduced payload summary.
- Webhooks run under `folio_webhook`; provider work runs under `folio_worker`.
- Branch reconciliation stages an invisible candidate and publishes only after a second head check.
- The previous published snapshot remains readable if a candidate fails.
- Prepared writes record exact base head, base blobs, path-policy snapshot, target-ref state, actor, authorizer, risk, and confirmation.
- Content-addressed Git objects may be recreated after ambiguous responses. Ref changes are verified before retry. Pull-request retries search by head/base before creation.

Stable conflicts require a new preparation: `BASE_REF_CHANGED`, `BLOB_CHANGED`, `TARGET_REF_CHANGED`, `PATH_POLICY_CHANGED`, `GITHUB_PERMISSION_CHANGED`, and `BRANCH_PROTECTED`.

## Legacy migration

Enable `LEGACY_IMPORT_ENABLED` only for an observed migration window. The importer maps legacy repository/source metadata to already-authorized GitHub repository links and selected branches. It does not copy cached SQLite Markdown into authoritative PostgreSQL Git pages. Every cached document is recorded as skipped with `AUTHORITATIVE_GITHUB_REFETCH_REQUIRED`, and fresh reconciliation rebuilds content from GitHub.

Disable the flag after the import record and fresh snapshot counts are reviewed. Preserve the SQLite database and repository mount read-only until the rollback window closes.

## Alerting minimums

Alert on:

- failed or exhausted durable jobs;
- webhook age and repeated failed deliveries;
- reconciliation lag and stale published snapshots;
- GitHub rate-limit exhaustion and permission/revocation errors;
- prepared Git writes stuck in `executing`;
- failed reminders or audit exports;
- missing or stale backup/restore evidence;
- readiness changes from pass to warn/fail;
- object storage integrity failures;
- cross-tenant or RLS test failures in release validation.
