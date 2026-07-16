# Phase 6 Collaboration and Agent Depth

## Status

This branch completes the next decision-safe Phase 6 layer on top of `agent/phase-5-scale-phase-6-foundations`.

It does **not** invent a Phase 7. The implementation plan ends at Phase 6, so this branch deepens the existing Graph and Canvas foundations with authoritative promotions, bounded spatial reads, facilitation outputs, structured agent tools, rebuildable derived relationships, and explicit human/agent permission intersections.

The branch is a review candidate. Its migrations, lint, typecheck, tests, worker behavior, browser workflows, and production build have not been executed in this environment.

## Delivered

### Authoritative Canvas actions

Canvas layout remains revisioned Canvas state. Operations that create or change authoritative project entities now use explicit previews:

- promote a visible Canvas connector into an explicit typed relationship
- convert one visible sticky into a native page, issue, or to-do
- optionally add an entity card for the converted sticky
- organize a bounded set of visible spatial elements
- preserve source element revisions, scene revision, action digest, actor, authorizer, risk, expiry, and results

Connector promotion creates or reuses an explicit accepted relationship and records the promoted relationship on the connector. PostgreSQL verifies that:

- both connector endpoints are active entity cards on the same Canvas
- the promoted relationship is active, explicit, and accepted
- relationship and connector endpoints match
- reverse endpoint matching is accepted only for symmetric relationship types
- archived connectors do not retain promoted relationship references

Sticky conversion is recoverable across partial success:

- target entity creation is idempotent
- the created entity ID is persisted on the preview before Canvas mutation
- retry links the original sticky instead of creating a second entity
- optional entity-card creation is also idempotent

Region organization is one PostgreSQL transaction:

- confirmation consumption
- Canvas and element locking
- element revision validation
- geometry changes
- immutable scene revision
- append-only Canvas command
- preview completion
- activity and outbox records

### Risk and confirmation model

- connector promotion: R1 preview
- one sticky conversion: R1 preview
- organizing 1–10 elements: R1 preview
- organizing more than 10 elements: R2 preview

R2 actions create an action confirmation bound to:

- exact operation
- exact action digest
- actor principal
- human authorizer
- project and Canvas snapshot
- short expiry

The authorizer may read and approve the preview, but the actor chain and preview definition are immutable. Execution consumes the confirmation atomically with the Canvas change.

### Bounded spatial reads and accessibility

The Canvas read layer now supports bounded rectangular regions with:

- validated finite coordinates
- a maximum visible-element budget
- permission-filtered entity cards
- connector inclusion only when both endpoints remain visible
- comment and vote inclusion only when their target remains visible
- deterministic z-order
- a keyboard/screen-reader-friendly linear outline
- explicit truncation without hidden-object counts

Accessible export supports Markdown and JSON, optionally scoped to a region. Exports are permission-filtered and limited to two MiB.

Workshop synthesis produces deterministic visible-only output:

- topics
- decisions
- action candidates
- notes
- visible vote totals
- linear accessible outline
- Markdown summary

### Graph clustering

Permission-filtered graph traversal now supports deterministic clustering by:

- connected component
- entity type

The result includes only visible nodes and edges, plus deterministic layout coordinates. Clusters never include hidden IDs, hidden titles, placeholder nodes, or hidden counts.

### Derived relationships

Derived edges are now rebuildable projections with explicit provenance:

- exact source entity
- exact source revision
- source kind
- rebuild key
- payload hash
- derivation run
- relationship count
- succeeded, failed, or superseded state

A rebuild archives only prior derived relationships from the same rebuild key. Explicit, suggested, and Canvas-only relationships are not replaced.

Existing derived edges are backfilled with legacy derivation-run provenance before the new consistency constraint is enabled.

Principal-kind enforcement is in PostgreSQL:

- `agent_synthesis` requires an agent principal
- page, issue, to-do, calendar, and provider rebuilds require a system principal

The public rebuild API is agent-only and requires a distinct authenticated human authorizer.

### Structured agent Graph and Canvas tools

The public spatial agent endpoint accepts a fixed discriminated tool catalog:

- `expand_graph`
- `read_canvas_region`
- `create_canvas`
- `add_entity_to_canvas`
- `create_sticky`
- `connect_canvas_nodes`
- `organize_canvas_region`
- `promote_connector_to_relationship`
- `convert_sticky`
- `execute_canvas_action`
- `prepare_workshop_output`

It does not accept arbitrary tool names, SQL, shell commands, filesystem paths, URLs, provider credentials, or network targets.

Every call requires:

- an active agent principal
- a distinct active human authorizer
- `agent.invoke` for the human authorizer
- the relevant capability for both principals
- object-level access for both principals where applicable
- selected-element visibility for both principals
- referenced-entity visibility for both principals
- private to-do-list edit access for both principals when converting to a to-do

Prompt-like content stored in a sticky remains data. It cannot change the tool catalog, capabilities, selected-element visibility, confirmation requirements, or actor/authorizer provenance.

Delegated agent Canvas creation is project-visible. PostgreSQL rejects private Canvases owned solely by an agent.

### Realtime delivery

Realtime visibility now includes the new domains without broadening permissions:

- Canvas action previews are visible only to their actor or human authorizer after Canvas read authorization
- derivation runs require relationship read plus source-entity read
- Canvas events strip element IDs/counts that are unnecessary to consumers
- broad organization events are routed to the actual Canvas aggregate in PostgreSQL
- unknown aggregate types continue to fail closed

## Migrations

- `0026_phase6_authoritative_actions.sql`
- `0027_phase6_authoritative_action_hardening.sql`
- `0028_phase6_agent_preview_access.sql`
- `0029_phase6_preview_approval_hardening.sql`

Migration coverage verifies deterministic ordering through `0029` and asserts:

- legacy derived-edge backfill
- derived-run consistency
- preview element scope
- promoted connector endpoint validation
- derivation actor principal kinds
- immutable actor chains
- project-visible delegated Canvas creation boundary
- Canvas outbox aggregate normalization

## API surface

### Human and application APIs

- `POST /api/v1/graph-clusters`
- `POST /api/v1/canvases/:canvasId/region`
- `POST /api/v1/canvases/:canvasId/export`
- `POST /api/v1/canvases/:canvasId/workshop-output`
- `POST /api/v1/canvas-actions/previews`
- `GET /api/v1/canvas-actions/previews/:previewId`
- `POST /api/v1/canvas-actions/previews/:previewId/approve`
- `POST /api/v1/canvas-actions/previews/:previewId/execute`
- `GET /api/v1/relationship-derivations`
- `POST /api/v1/relationship-derivations`

### Agent API

- `POST /api/v1/agent-tools/spatial`

All mutations retain request IDs, trace IDs, idempotency keys, actor/authorizer provenance, activity records, and outbox records.

## Browser workspace

`/map` now exposes reviewable workflows for:

- connected-component and entity-type graph clustering
- accessible Canvas region outlines
- permission-filtered Markdown export
- workshop synthesis
- organization preview
- R2 approval and execution
- sticky-to-page conversion
- existing Mermaid preview/import

## Tests committed

### `phase6-authoritative-actions.integration.test.ts`

Covers:

- connector promotion and Canvas provenance
- R2 organization rejection before approval
- approval and single-use confirmation consumption
- immutable scene creation after organization
- sticky-to-page conversion
- converted entity-card creation
- revision-bound derived relationship replacement
- explicit relationship preservation
- previous derivation-run superseding

### `phase6-agent-spatial.integration.test.ts`

Uses an agent with broader visibility than its human authorizer and verifies:

- hidden graph nodes, edges, IDs, and titles are omitted
- hidden Canvas entity cards are omitted
- connectors dependent on hidden cards are omitted
- connector creation with a hidden endpoint is denied
- organization including a hidden element is denied
- private-list to-do conversion is denied when only the agent has list access
- prompt-like sticky content does not change the permission boundary

### Migration assertions

- `postgres-migrate.test.ts`
- `phase6-depth-migrations.test.ts`

## Verification boundary

No GitHub Actions workflow is included.

Before merge, run from a complete developer checkout with PostgreSQL:

1. `npm install`
2. regenerate the stale lockfile if required
3. `npm run db:migrate:folio`
4. `npm run lint`
5. `npm run typecheck`
6. `npm run test`
7. `npm run build`
8. exercise R2 preview approval, expiry, consumption, replay, and stale-element conflicts
9. exercise connector-promotion response-loss recovery
10. exercise sticky-conversion response-loss recovery for pages, issues, and to-dos
11. verify agent/human permission intersections with project and object grants
12. smoke-test `/map` with keyboard and screen-reader navigation
13. profile region reads, graph clustering, organization, export, and workshop synthesis at configured limits
14. verify realtime delivery for preview actor, authorizer, unrelated member, and hidden source entities

## Explicitly not claimed complete

The following remain decision-gated runtime work:

- production websocket or CRDT transport
- offline convergence and reconnect conflict semantics
- selection of a Canvas rendering or whiteboard library
- full large-scene rendering and interaction performance validation
- production image/PDF/SVG Canvas export pipeline
- arbitrary autonomous agent tools
- agent execution of unapproved R2 or any R3 action
- arbitrary code execution, filesystem access, provider access, or network access through spatial tools
- fully autonomous workshop facilitation
- production-grade semantic clustering beyond deterministic connected-component and entity-type modes
