# Phase 0 and Phase 1 Completion Record

Updated: 2026-07-16

## Status

This branch closes the remaining code and operational-contract gaps from Phase 0 and Phase 1 on top of the Phase 2–6 stack. It is a review candidate, not a verified production release. Provider credentials, migrations, tests, browser workflows, backup/restore drills, and the production build have not been executed in this environment.

## Phase 0 production closure

Delivered:

- S3-compatible object storage with SigV4 requests, strict integrity checks, optional SSE-S3/SSE-KMS, and production rejection of filesystem storage.
- Workspace storage policy records containing only bucket/region/endpoint and secret/key references.
- One-time, email-bound, signed workspace invitations whose plaintext tokens are not persisted in idempotency records.
- Owner-only member, invitation, suspension, removal, role, and project-assignment administration with last-owner protection.
- Operational readiness checks for migration state, OIDC, object storage, GitHub App, workspace storage policy, backup/restore evidence, and metrics authentication.
- Bearer-authenticated operational metrics.
- PostgreSQL backup evidence and isolated restore-drill scripts with checksums and representative row-count verification.
- A read-only production container reference deployment and environment inventory.
- A resumable legacy metadata importer that refuses to make cached SQLite Markdown authoritative and forces fresh GitHub reconciliation.

## Phase 1 GitHub collaboration closure

Delivered:

- GitHub App JWT signing and just-in-time installation tokens.
- Signed, single-use installation setup state and callback completion.
- Installation suspension/revocation state, repository discovery, permission metadata, and provider rate-limit observations.
- Raw-body webhook HMAC verification, delivery UUID deduplication, reduced payload storage, isolated `folio_webhook` database role, and durable targeted jobs.
- Project repository links with multiple branches, include/exclude Markdown scope, and `disabled` / `pull_request_only` / `direct_allowed` write policies.
- Truncated-tree fallback traversal, bounded UTF-8 Markdown retrieval, immutable candidate snapshots, second-head verification, atomic publication, and previous-snapshot preservation.
- Permission-filtered Git-backed page reads with repository, branch, path, snapshot, head, blob, and hash provenance.
- Prepared Git writes with exact heads/blobs, path-policy and provider-permission snapshots, bounded diffs, actor/authorizer intersection, R1/R2 risk, and digest-bound confirmation.
- Durable blob/tree/commit/ref/pull-request execution with provider-step records and response-loss recovery.
- Stable conflict errors for changed heads, blobs, target refs, policies, permissions, and protected branches.
- `/settings/integrations` browser administration for readiness, invitations, storage, GitHub installation, repository linking, branch selection, and reconciliation.

## Database changes

- `0030_phase0_production_closure.sql`
- `0031_phase1_github_installations_snapshots.sql`
- `0032_phase1_github_writeback.sql`
- `0033_phase0_phase1_security_hardening.sql`
- `0034_phase0_phase1_final_hardening.sql`
- `0035_phase1_git_write_hardening.sql`

The migrations add invitation/storage/operations/legacy records, GitHub installation and repository state, branch snapshots and Git pages, prepared writes and provider steps, strict immutability, active-snapshot validation, secret-reference checks, a dedicated webhook role, narrow invitation lookup, and immutable policy/target-ref snapshots.

## Tests committed

- deterministic migration ordering and invariant assertions through `0035`;
- Git path, branch, include/exclude, and Markdown-scope tests;
- signed invitation replay without plaintext-token persistence;
- one-time invitation acceptance and project membership assignment;
- immutable snapshot files and published snapshot counts;
- immutable prepared Git definitions;
- denial of unrelated tables under the webhook role.

## Verification gate

Run on a complete checkout with PostgreSQL and provider test configuration:

```bash
npm install
npm run db:migrate:folio
npm run lint
npm run typecheck
npm run test
npm run build
```

Then perform:

1. fresh production-like OIDC login and workspace creation;
2. invitation create/replay/accept/revoke, last-owner, suspension, and removal tests;
3. S3 upload/download/delete integrity and KMS policy checks;
4. backup and isolated restore drills;
5. GitHub App install/reinstall/suspend/revoke and repository removal tests;
6. webhook replay, reordering, invalid signature, delayed delivery, and rate-limit tests;
7. truncated-tree, force-push, head-change, failed candidate, and previous-snapshot tests;
8. human and agent branch-and-PR writes with base/blob/ref/policy/permission conflicts;
9. branch protection and ambiguous provider response recovery;
10. UI/API/search/event/agent authorization tests for Admin, Member, and Guest;
11. legacy metadata import followed by fresh snapshot count/hash verification;
12. `/settings/integrations`, `/pages`, and write-preview browser/accessibility smoke tests.

## External configuration still required

The implementation cannot create or own deployment credentials. A release operator must provide and validate:

- managed PostgreSQL, TLS trust, backups, and restore permissions;
- managed OIDC tenant and client configuration;
- private S3-compatible bucket, lifecycle, encryption/KMS, and credentials;
- GitHub App registration, permissions, events, callback, webhook secret, and private key;
- reverse proxy/TLS, DNS, secret manager, metrics scraper, alerts, and artifact retention.

Those are deployment inputs and acceptance exercises, not remaining application-code phases.
