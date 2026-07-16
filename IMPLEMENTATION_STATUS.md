# Folio Implementation Status

Updated: 2026-07-13

## Active Folio foundation

Phase 0 implementation has started without removing the working legacy reader.

Delivered:

- PostgreSQL 16 in Docker Compose with a persistent volume and health-gated web/worker startup.
- Checksummed, advisory-locked SQL migration runner with modification detection.
- Initial users, external identities, principals, workspaces, memberships, projects, role templates, capability/object grants, confirmations, activity, outbox, idempotency, and durable jobs schema.
- Composite foreign keys preventing project-scoped rows from crossing workspace boundaries.
- Tenant-scoped idempotency and active-job deduplication constraints.
- UUIDv7 generation for new Folio entities while legacy IDs remain unchanged.
- Shared capability evaluator with explicit deny, object grant, GitHub/provider, agent-grant, and authorizer intersections.
- Shared strict API request/success/error contracts with safe public error conversion.
- GitHub webhook raw-byte HMAC verification, supported-event validation, and machine-readable boundary errors.
- PostgreSQL health reporting while the legacy SQLite reader remains available.
- Provider-neutral managed OIDC authorization-code flow with discovery validation, PKCE S256, signed short-lived state, nonce checks, remote JWKS signature verification, and atomic transaction consumption.
- Opaque database-backed sessions, secure host cookies, revocation, same-origin mutation enforcement, and append-only security events.
- Transactional OIDC human/principal provisioning plus idempotent workspace and project creation.
- Default Admin, Member, and Guest capability templates and automatic owner/Admin memberships.
- Authenticated `/api/v1/session`, `/api/v1/workspaces`, and `/api/v1/projects` endpoints using the shared success/error contracts.
- PostgreSQL transaction-local workspace/principal context, restricted runtime role, forced RLS policies, and project-command enforcement.

Verified in Docker on 2026-07-13:

- Production Next.js build and TypeScript compilation passed.
- ESLint passed with zero warnings.
- 60 unit/integration tests passed on a fresh isolated PostgreSQL database, including migration, RLS isolation, authenticated routes, OIDC/PKCE/replay controls, sessions, idempotent provisioning, cross-tenant rejection, append-only activity, capability, UUIDv7, API contract, and webhook security tests.
- PostgreSQL, web, and worker containers started healthy; migration replay reported the database up to date.
- Dependency audit reported zero known vulnerabilities.

Next work is connecting a real managed OIDC tenant in deployment, moving the remaining workspace-bootstrap/list paths onto dedicated least-privilege database functions, adding membership/invitation commands, and beginning the GitHub App installation/repository-selection slice.

## Legacy reader snapshot

This is a factual snapshot of the pre-cloud local reader. Its product scope, SQLite architecture, and former next steps are superseded by the canonical Folio specification in [README.md](README.md). Preserve it as migration evidence.

## Delivered slice

Phase 0 is complete for the current scope, and the essential Phase 1 repository-to-reader loop is operational.

### Runtime and data

- Next.js 16, React 19, TypeScript, and a separate TypeScript worker.
- SQLite in WAL mode with foreign keys, FTS5, Drizzle schema definitions, and idempotent startup migrations.
- Docker Compose services for the web process and worker, sharing only the application data volume and read-only repository mount.
- Loopback-only host port, health check, non-interactive Git, disabled hooks, bounded Git output, and configured repository roots.

### Product workflow

1. Connect an allowed local Git repository and explicit branch.
2. Queue a durable synchronization job.
3. Resolve the committed branch head and enumerate Markdown blobs without reading uncommitted files.
4. Parse headings and text, sanitize rendered HTML, and update FTS5.
5. Preserve unavailable document rows when a file disappears.
6. Browse or search the index, open a safe reader, and inspect branch, path, commit, and index time.
7. Review repository health and append-only synchronization activity.

### Verified on 2026-07-11

- `npm audit`: zero known dependency vulnerabilities.
- `npm run typecheck`: passed.
- `npm run lint`: passed with zero warnings.
- `npm run test`: 5 tests passed.
- `npm run build`: passed with all application routes compiled.
- Fresh `docker compose build`: passed.
- Fresh-volume `docker compose up -d`: web healthy and worker running.
- Demo sync: 3 added documents, 3 FTS rows, successful run.
- HTTP smoke tests: health, dashboard, ranked search, and document reader passed.
- Browser checks: desktop layout, search interaction, result highlighting, and 390×844 responsive layout passed.

## Historical next slice (superseded)

Before Folio was redefined as a multi-tenant product, the planned next reader work was:

- persist file-level warnings for size, encoding, and parse failures;
- apply configurable include/exclude rules rather than the current whole-repository Markdown rule;
- stage a sync snapshot so a fatal reconciliation failure cannot expose a partial new index;
- add integration fixtures for add/change/remove, hostile Markdown, interrupted jobs, and idempotent retries;
- add run-detail and retry UI, then remote bare mirrors.

These items are not the current execution order. The active roadmap is [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md), and legacy-reader handling is defined in [MIGRATION.md](MIGRATION.md).
