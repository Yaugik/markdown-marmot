# Folio

Folio is an independent cloud-hosted collaboration workspace for small technical teams. It combines project and issue management, GitHub-backed Markdown, application-native knowledge pages, personal and shared to-dos, calendars, and permission-controlled AI agents.

This directory is the complete source of truth for Folio. It does not inherit requirements, architecture, or product boundaries from parent or sibling projects. Read [AGENTS.md](AGENTS.md) before changing the project.

## Canonical specification

Read these documents in order:

1. [Product definition](PRODUCT_DEFINITION.md) — vision, personas, assumptions, success measures, and open decisions.
2. [Scope and requirements](SCOPE.md) — bounded functional, non-functional, security, and first-slice requirements.
3. [User stories and workflows](USER_STORIES_AND_WORKFLOWS.md) — critical human and agent journeys.
4. [Architecture](ARCHITECTURE.md) — runtime shape, bounded contexts, ownership, and system boundaries.
5. [Database model](DATABASE_MODEL.md) — entity relationship model, persistence conventions, and aggregate schemas.
6. [Authorization](AUTHORIZATION.md) — capability model and authorization matrices.
7. [GitHub synchronization](GIT_SYNCHRONIZATION.md) — GitHub App, reconciliation, write-back, and conflicts.
8. [Page model and editing](PAGE_MODEL_AND_EDITING.md) — Git/native coexistence and Markdown round trips.
9. [Agent tools and safety](AGENT_TOOLS_AND_SAFETY.md) — tool contracts, risk levels, delegation, and confirmation.
10. [API and events](API_AND_EVENTS.md) — public contracts, service boundaries, jobs, and events.
11. [Spatial knowledge and Canvas](SPATIAL_COLLABORATION.md) — future graph explorer and collaborative whiteboard direction.
12. [Implementation plan](IMPLEMENTATION_PLAN.md) — phased vertical slices and acceptance gates.
13. [Legacy migration](MIGRATION.md) — migration from the existing local repository reader.
14. [Decision log](DECISIONS.md) — accepted choices and unresolved decisions.

[Implementation status](IMPLEMENTATION_STATUS.md) tracks the active PostgreSQL foundation and preserves the existing SQLite repository reader as migration evidence.

## Product invariants

1. Projects are the primary collaboration and authorization boundary.
2. GitHub owns Git-backed Markdown; Folio owns native pages and workspace metadata.
3. UI, API, worker, and agent mutations use the same authorization and validation services.
4. Synchronization publishes only complete, reconciled snapshots and never hides conflicts.
5. Normal removal archives data; permanent deletion is a separate warned workflow.
6. Every mutation has a principal, authorizing principal, revision precondition, idempotency semantics, and audit record.
7. Development remains locally runnable while production uses the same PostgreSQL semantics.

## Current implementation

Phase 0 has started with a PostgreSQL tenant/project foundation, shared capability evaluation, API/error contracts, GitHub webhook verification, UUIDv7 IDs, append-only activity, outbox, confirmations, idempotency, and durable job tables. The existing single-user SQLite reader remains operational beside it until the migration phases replace it.

Managed OIDC and authenticated workspace/project provisioning are now implemented. Configure the optional OIDC variables in [.env.example](.env.example); without them, the legacy reader remains available and the health endpoint reports managed authentication as `not_configured`.

## Docker development

Docker is the canonical development and test environment. The host does not need Node.js or PostgreSQL.

```bash
docker compose up -d --build
docker compose ps
curl --fail http://127.0.0.1:3000/api/health
```

Run checks inside the built Node 20 image while the Compose PostgreSQL service is running:

```bash
docker compose run --rm --no-deps --entrypoint npm web run test
docker compose run --rm --no-deps --entrypoint npm web run typecheck
docker compose run --rm --no-deps --entrypoint npm web run lint
docker compose build web worker
```

`docker compose down` preserves the PostgreSQL and legacy-reader volumes. `docker compose down -v` intentionally deletes local Folio data.
