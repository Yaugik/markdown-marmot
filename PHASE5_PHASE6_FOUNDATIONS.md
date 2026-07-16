# Phase 5 Delivery and Phase 6 Foundation Record

Updated: 2026-07-16

## Status

This branch is a stacked implementation candidate based on the corrected Phase 4 scheduling and Phase 5 enabling-foundation branch.

It delivers the Phase 5 product and governance controls that can be implemented without choosing speculative infrastructure, together with the Phase 6 canonical relationship, graph, and revisioned Canvas foundations.

The branch remains a draft-review candidate until a complete checkout is run against PostgreSQL with migrations, lint, typecheck, tests, worker execution, and a production build.

## Phase 5 delivered

### Native-page realtime collaboration

- One active server-sequenced collaboration room per native page.
- Rooms are bound to the current immutable native-page revision.
- Bounded full-document collaboration operations with stable client and server sequence numbers.
- Client-sequence idempotency that rejects a mismatched-content retry.
- Immutable operation log and checkpoint history.
- Stale sequence and external native-page revision rejection.
- Explicit commit into ordinary immutable native-page history.
- Recoverable room closure when the canonical page revision is committed before the room-close transaction completes.
- Exactly-once response replay for a successfully committed room.

This is a revision-safe collaboration protocol and event contract. Production websocket transport, offline convergence, and CRDT adoption remain explicit runtime decisions.

### Measured scale governance

- Search, queue, realtime, database, and object-storage measurements.
- Bounded percentile and sample metadata.
- Explicit keep/evaluate/approve/reject extraction decisions.
- Current-decision uniqueness and supersession history.
- Extraction approval requires at least three same-project, same-component measurements.
- PostgreSQL remains the default until an explicit evidence-backed decision changes it.

### Enterprise identity and residency controls

- Workspace-owner-managed OIDC and SAML configuration metadata.
- Secret-manager references instead of embedded credentials.
- Allowed-domain and attribute-mapping configuration.
- Revision-checked identity lifecycle.
- Workspace region allowlists, primary/export regions, and customer-managed-key references.
- Revision-checked residency policy updates.

Provider-specific SAML/SCIM activation and deployment-region enforcement require explicit provider and deployment decisions.

### Audit exports

- Workspace or project-scoped JSONL/CSV export requests.
- Bounded action, target-type, date, and row filters.
- PostgreSQL worker execution with isolated activity-read permission.
- Existing redacted activity summaries only; full entity bodies are not copied into exports.
- Local private export storage, SHA-256 integrity checks, expiration, and authenticated no-store delivery.
- Recoverable completion activity and outbox event.

Production object storage, retention guarantees, legal hold, and export-region routing remain deployment decisions.

### Support access

- Active workspace-owner approval.
- Unexpired R3 confirmation for the exact support-access operation.
- Single-use confirmation consumption.
- Eight-hour maximum duration.
- Narrow read-only support capability allowlist.
- Explicit revoke and expiry lifecycle.
- Confirmation provenance recorded on activity.

No ambient support role or unrestricted cross-tenant access is introduced.

### Realtime event composition

- Existing outbox cursor remains the event source.
- Page collaboration, relationships, graph views, Canvas, scale, and audit-export events are permission filtered.
- Unknown aggregate types fail closed.
- Canvas event payloads do not reveal hidden element counts.

## Phase 6 foundations delivered

### Canonical typed relationships

- Project-scoped relationship type registry.
- Source and target entity-type allowlists.
- Page, issue, to-do, calendar-entry, and Canvas endpoints.
- Explicit, derived, suggested, and Canvas-only provenance.
- Symmetric-edge normalization.
- Database endpoint-existence and type validation.
- Independent authorization of both endpoints before write or read.
- Suggested-edge acceptance/rejection and relationship archival.
- Hidden endpoint IDs, titles, edges, and counts are omitted.

### Permission-filtered graph explorer

- Private and project-visible saved graph views.
- Object-grant discovery and execution for private views.
- Hidden roots are removed from discovery.
- Bounded depth, node, and edge budgets.
- Relationship-type and provenance filters.
- Permission evaluation for every node and both sides of every edge.
- No hidden-node placeholders or omitted-count metadata.

### Revisioned Canvas scenes

- Private and project-visible Canvases with object-grant access.
- Immutable scene revisions and append-only command log.
- Optimistic Canvas and element revisions.
- Entity cards, stickies, text, shapes, frames, connectors, drawings, comments, votes, presentation regions, and Mermaid elements.
- Bounded geometry, content, scene, and command payloads.
- Entity-card existence and authorization validation.
- Permission-filtered Canvas reads that omit unauthorized cards.
- Connectors, comments, and votes targeting omitted elements are also omitted.
- Canvas layout does not mutate authoritative entity content.
- `/map` browser workspace for graph traversal, Canvas creation, sticky commands, and Mermaid preview/import.

Production multi-user Canvas convergence, offline support, drawing compression, large-scene level of detail, voting workflows, presentation playback, and agent Canvas tools remain later runtime work.

### Mermaid interchange

- Bounded Mermaid flowchart import subset.
- Explicit warnings for unsupported directives.
- Explicit loss records for unsupported edge styles or Canvas elements.
- Fifteen-minute import/export previews.
- Import execution through ordinary revisioned Canvas commands.
- Export uses the permission-filtered Canvas scene and cannot include hidden entity cards.

## Migrations

- `0020_phase5_scale_ecosystem.sql`
- `0021_phase6_graph_canvas_foundations.sql`
- `0022_phase5_phase6_hardening.sql`
- `0023_phase5_audit_export_worker.sql`
- `0024_phase5_phase6_final_security.sql`
- `0025_phase5_phase6_role_capabilities.sql`

The final migration upgrades existing system Admin and Member role templates so previously created workspaces receive the intended capabilities.

## API additions

### Collaboration

- `POST /api/v1/page-collaboration/rooms`
- `GET /api/v1/page-collaboration/rooms/{roomId}`
- `POST /api/v1/page-collaboration/rooms/{roomId}/operations`
- `POST /api/v1/page-collaboration/rooms/{roomId}/commit`

### Scale and enterprise

- `GET|POST /api/v1/scale-governance`
- `GET|POST /api/v1/enterprise/identity`
- `PATCH /api/v1/enterprise/identity/{configId}`
- `GET|PUT /api/v1/enterprise/residency`
- `GET|POST /api/v1/enterprise/support-access`
- `POST /api/v1/enterprise/support-access/{grantId}/revoke`
- `GET|POST /api/v1/audit-exports`
- `GET /api/v1/audit-exports/{exportId}`
- `GET /api/v1/audit-exports/{exportId}/content`

### Relationships and graph

- `GET|POST /api/v1/relationship-types`
- `GET|POST /api/v1/relationships`
- `PATCH /api/v1/relationships/{relationshipId}`
- `GET|POST /api/v1/graph-views`
- `POST /api/v1/graph-traversal`

### Canvas and Mermaid

- `GET|POST /api/v1/canvases`
- `GET /api/v1/canvases/{canvasId}`
- `POST /api/v1/canvases/{canvasId}/commands`
- `POST /api/v1/canvases/{canvasId}/archive`
- `POST /api/v1/mermaid-interchange/previews`
- `POST /api/v1/mermaid-interchange/previews/{previewId}/execute`

The existing realtime-events endpoint now uses the composed Phase 5/6 authorization policy.

## Acceptance coverage committed

### Phase 5

`src/services/phase5-scale-ecosystem.integration.test.ts` covers:

- collaboration sequence application and checkpoint reads;
- same-sequence retry replay and mismatched-content rejection;
- native-page collaboration commit;
- three-window extraction approval requirement;
- identity and residency configuration;
- single-use R3 support confirmation and activity provenance;
- integrity-checked audit export and secret-reference exclusion;
- audit-export worker completion activity.

### Phase 6

`src/services/phase6-graph-canvas.integration.test.ts` covers:

- a restricted principal with one page and one private Canvas grant;
- hidden relationship-target omission;
- hidden graph node, edge, ID, title, and count omission;
- hidden Canvas entity-card omission;
- connector omission when one endpoint is hidden;
- permission-filtered Mermaid export;
- Mermaid import warning/loss previews and revisioned execution.

Migration assertions cover deterministic ordering through `0025_phase5_phase6_role_capabilities.sql` and verify the new append-only, R3 confirmation, entity validation, role-upgrade, and worker boundaries.

## Verification boundary

No GitHub Actions workflow is included, following the requested testing preference.

This environment cannot materialize the complete branch into a local checkout. The migrations, lint, typecheck, tests, worker execution, browser workflows, and production build have not been executed here.

Before merge, run:

1. `npm install`
2. regenerate and commit the stale lockfile if needed
3. `npm run db:migrate:folio`
4. `npm run lint`
5. `npm run typecheck`
6. `npm run test`
7. `npm run build`
8. run the worker and exercise audit-export recovery
9. exercise collaboration response loss/retry and external page-edit conflict
10. smoke-test `/map` with private, project-visible, and object-granted access
11. profile synthetic graph and Canvas data against explicit budgets

## Explicitly not claimed complete

- production websocket or managed realtime transport;
- CRDT/offline native-page or Canvas convergence;
- dedicated queue or search extraction without measured approval;
- a selected SAML/SCIM provider or production identity activation;
- deployment-enforced data residency and customer-managed-key integration;
- production audit-export object storage and legal-hold semantics;
- complete external-calendar provider portfolio and two-way conflict behavior;
- full large-scene Canvas performance and accessibility validation;
- autonomous agent graph/Canvas command tools;
- every Phase 6 facilitation and presentation interaction.
