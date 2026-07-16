# Folio Decision Log

## Accepted decisions

### 2026-07-13 — Folio is an independent multi-tenant product

Folio targets small technical teams and does not inherit scope or architecture from sibling projects. Workspaces contain projects; projects are the primary collaboration and authorization boundary.

### 2026-07-13 — Portable managed cloud, locally reproducible

Use a TypeScript/Next.js modular monolith with separate workers, PostgreSQL in all active environments, S3-compatible object storage, PostgreSQL-backed durable jobs initially, managed OIDC, and container deployment. Local Docker Compose runs equivalent core services.

### 2026-07-13 — GitHub App is the Git authority boundary

Use GitHub App installations for repository access. GitHub owns Git-backed Markdown, refs, commits, pull requests, repository permission, and branch protection. Folio uses atomic reconciliation snapshots and stores no persistent working trees.

### 2026-07-13 — Git pages are branch-scoped

The same path on two selected branches produces distinct page identities. This makes provenance and editing targets unambiguous.

### 2026-07-13 — Git write policy is project/repository configurable

Support `disabled`, `pull_request_only`, and `direct_allowed` from the first Git write slice. The recommended/default template is branch plus pull request. Direct operations remain constrained by Folio capability, path/branch policy, risk confirmation, and GitHub authorization.

### 2026-07-13 — Native pages use structured revisions first

Store versioned structured editor content with immutable revisions and optimistic concurrency. Real-time CRDT collaboration is an extension, not a first-release dependency.

### 2026-07-13 — Capability authorization and project agents

Admin, Member, and Guest are capability templates. Guests combine restricted project membership with object grants. Agents are project principals whose effective permission is intersected with the authorizing human or automation grant.

### 2026-07-13 — Issues and to-dos are separate aggregates

Issues model shared project workflow; to-dos model personal/shared scheduling. Typed relationships connect them without forcing incompatible lifecycle and privacy rules into one table.

### 2026-07-13 — Existing reader is a migration source

The current SQLite reader remains factual legacy evidence. It will export configuration and provenance into a versioned importer; caches and credentials are not migrated.

### 2026-07-13 — Phase 6 adds a relationship graph and collaborative Canvas

Folio will eventually combine a permission-filtered connected-knowledge graph with a Miro-like collaborative Canvas for entity cards, brainstorming, discussion, planning, facilitation, and agent-assisted synthesis. The canonical relationship graph, graph explorer, and Canvas scene graph remain separate layers. This direction is outside the current development cycle.

### 2026-07-13 — Mermaid is an embedded/interchange format, not the Canvas substrate

Mermaid remains valuable for technical diagrams and compatible agent-generated import/export. The Canvas persists a structured scene graph because durable manual geometry, free-form elements, permissions, rich interaction, and real-time collaboration do not fit a text-to-layout DSL.

## Rejected alternatives

- **Extend the single-user SQLite schema into production multi-tenancy:** rejected because concurrency, isolation, job leasing, cloud operations, and migration safety would diverge from production PostgreSQL semantics.
- **Treat Git-backed Markdown as Folio-owned editable content:** rejected because it breaks Git authority and obscures commits/conflicts.
- **One logical page with transparent branch variants:** rejected because links and edits would have an ambiguous branch target.
- **Always direct-push or always require PR:** rejected because repository policies differ; explicit project configuration plus GitHub enforcement is safer and more useful.
- **Agent inherits only its creator's permanent role:** rejected because project agents need explicit administration and auditable delegation per execution.
- **Independent service-principal agents without an authorizing chain:** rejected for initial releases because accountability and permission capping would be weaker.
- **Build real-time collaboration before revisioned native pages:** rejected as unnecessary infrastructure before native-page workflows are validated.
- **Microservices from the start:** rejected because a modular monolith offers safer transactions and faster evolution at initial team scale.
- **Webhooks as complete synchronization:** rejected because GitHub deliveries are not guaranteed complete or ordered.
- **Persist full repository working copies:** rejected because Folio needs only selected committed Markdown and Git object operations.
- **Build the Miro-like Canvas as a highly extended Mermaid renderer:** rejected because it would couple free-form collaboration and persistent geometry to a declarative automatic-layout syntax not designed for them.
- **Treat the Canvas as the canonical entity/relationship database:** rejected because presentation state would bypass domain lifecycle, authorization, concurrency, provenance, and audit rules.

## Principal risks and mitigations

| Risk | Consequence | Planned mitigation |
|---|---|---|
| Authorization complexity creates tenant leakage | Severe confidentiality breach | Capability service, scoped repositories, defense-in-depth RLS, exhaustive matrix/negative tests, audited support access |
| GitHub webhook gaps or API truncation expose stale/partial state | Incorrect documentation and decisions | Periodic reconciliation, bounded subtree traversal, immutable candidates, atomic publication, visible snapshot age |
| Rich editing damages Markdown extensions | Repository churn or content loss | Lossless source mode, supported AST profile, protected raw nodes, round-trip gate, mandatory diff |
| Concurrent Git/native edits overwrite work | Data loss | Revision/base-blob/ref preconditions, structured conflicts, no silent merge |
| Agent delegation or prompt injection exceeds intent | Unauthorized internal/external changes | Grant intersection, untrusted-content boundary, typed tools, risk confirmation, reauthorization before effect |
| Provider outage/rate limits block core work | Failed sync/write workflows | Last-good readable snapshots, durable jobs, rate budgets, backoff, actionable operation states |
| Append-only audit leaks sensitive content | Privacy/security exposure | Redacted summaries, referenced content, retention controls, restricted exports |
| Modular monolith boundaries erode | Slow unsafe evolution | Module-owned schemas/services, command/query interfaces, contract tests, outbox boundaries |
| Legacy import misidentifies repositories/pages | Missing or falsely matched content | Explicit repository mapping, GitHub rehydration, dry run, ambiguity report, idempotent mappings, archive rollback |
| Early infrastructure exceeds team capacity | Delivery delay | PostgreSQL-backed jobs/search first; extract queue/search/services only from measured load |
| Canvas access leaks hidden entity metadata | Cross-project/private-data disclosure | Compose Canvas and entity authorization, redact/omit unauthorized cards and edges, test titles/types/counts/previews |
| Spatial presentation becomes a second source of truth | Divergent pages/issues/to-dos/relationships | Scene graph owns layout only; entity and relationship mutations use ordinary typed commands |
| Large canvases or graph traversals degrade collaboration | Unusable workspace and excessive context | Region-bounded reads, level-of-detail rendering, query budgets, pagination, spatial indexes only when Phase 6 begins |

## Open decisions

- Billing, metering, quotas, and free/trial boundaries.
- Exact production reference provider and managed OIDC vendor.
- Retention durations, audit export guarantees, and permanent deletion/legal-hold semantics.
- Whether direct-push agent actions may ever execute as R2 without fresh confirmation.
- External calendar provider/order and two-way conflict behavior.
- Enterprise SAML/SCIM, data residency, customer-managed keys, and support-access policy.
- CRDT/offline collaboration trigger criteria and implementation.
- Dedicated queue/search adoption thresholds based on measured load.
- Canvas rendering/collaboration library, CRDT representation, spatial storage/indexing, and offline behavior.
- Relationship taxonomy governance, suggested-edge acceptance rules, and derived-edge retention.
- Supported Mermaid import/export subset and how lossy conversions are surfaced.
