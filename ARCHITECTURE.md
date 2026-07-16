# Folio Architecture

## Architecture style

Folio begins as a multi-tenant modular monolith with independently scalable web and worker roles. This keeps authorization, transactions, schemas, and developer setup cohesive while preserving bounded-context interfaces that can later become services.

```text
Browser / Agent client
        |
  HTTPS REST/JSON
        |
Next.js web/API ---- managed OIDC
        |
application commands and queries
        |
PostgreSQL ---- transactional outbox ---- worker pool ---- GitHub API
     |                   |                    |       ---- model providers
     |                   |                    |       ---- mail/reminders
     |                   +---- event consumers/search indexers
     +---- S3-compatible object storage references
```

Local development uses Docker Compose for web, worker, PostgreSQL, and an S3-compatible object store. Production uses containerized web/worker processes, managed PostgreSQL, managed object storage, KMS/secrets, load balancing, and autoscaling. PostgreSQL-backed jobs are the initial durable queue; the job interface permits a managed queue later.

## Bounded contexts and ownership

| Context | Owns | Does not own |
|---|---|---|
| Identity and tenancy | users, identities, sessions, workspaces, invitations | GitHub installations, project grants |
| Projects and authorization | projects, memberships, role templates, capability/object grants | provider permissions |
| GitHub integration | installations, repositories, selected branches, policies, webhooks, reconciliation, prepared Git operations | Markdown authority |
| Knowledge | page identities, native content/revisions, Git page observations, tree nodes, links, comments, mentions | Git refs and commits |
| Issues and planning | workflows, statuses, issues, hierarchy, dependencies, milestones, cycles, roadmaps, views | personal to-do lifecycle |
| To-dos and calendar | lists, to-dos, recurrence, reminders, calendar entries | issue workflow state |
| Agents and confirmations | agents, grants, sessions, tool calls, automation grants, confirmations | bypass authorization |
| Activity and audit | immutable mutation facts and exportable audit records | reconstructible search caches |
| Search | permission-filtered indexes and query projections | source content authority |
| Jobs and integration | leases, attempts, outbox delivery, provider requests | business authorization decisions |
| Relationship graph (Phase 6) | explicit typed edges and derived/suggested relationship projections | source entity content or canvas layout |
| Spatial collaboration (Phase 6) | canvases, scene elements, geometry, facilitation state, presence projections | referenced entity authority or canonical relationships |

Contexts communicate through typed application services inside the monolith and versioned domain events across asynchronous boundaries. A module may read another module only through its query interface; cross-context mutations use commands and transactional orchestration.

## Authority boundaries

- GitHub owns repository selection availability, Git refs, blobs, commits, pull requests, branch protection, and Git-backed Markdown.
- Folio owns tenants, project structure, native pages, page-tree placement, issues, to-dos, calendars, permissions, agents, confirmations, and audit.
- In Phase 6, Folio owns explicit graph relationships and Canvas scene state; each referenced domain continues to own its entity content and lifecycle.
- Git-backed content stored in PostgreSQL is an immutable observation/cache associated with a published synchronization snapshot.
- Search documents, render caches, extracted links, and provider projections are rebuildable.
- Object storage owns attachment bytes; PostgreSQL owns attachment identity, authorization, checksum, scan state, and retention metadata.

## Application layers

1. **Adapters:** HTTP routes, UI actions, agent tool adapters, workers, and webhooks authenticate inputs and translate them into commands/queries.
2. **Policy and validation:** one service resolves principal chains, capabilities, grants, revisions, risk, confirmation, idempotency, and domain validation.
3. **Domain services:** bounded contexts enforce lifecycle invariants and produce mutations plus activity/outbox records.
4. **Persistence/integrations:** PostgreSQL repositories, object storage, GitHub client, identity provider, model provider, and notification providers.

No adapter may directly mutate tables or call GitHub for a business operation. Workers re-authorize durable commands against a captured principal chain and current policy when they begin consequential work.

## Multi-tenancy and isolation

- Every workspace-owned row contains `workspace_id`; project-owned rows also contain `project_id`.
- Foreign keys and composite unique constraints include the owning boundary where practical.
- Repository methods require a scope object rather than accepting unscoped identifiers.
- PostgreSQL row-level security is defense in depth for request paths; application capability checks remain authoritative and are also used by workers.
- Cache keys, object keys, search documents, job deduplication keys, and rate-limit keys include workspace/project scope.
- Support tooling requires explicit audited impersonation and cannot silently cross tenants.

## Runtime and deployment

- **Web/API:** stateless Next.js containers; signed secure sessions; no durable local disk.
- **Workers:** separate pools for reconciliation, Git write operations, indexing, notifications, imports, and maintenance. Pools may share an image but use distinct job kinds and concurrency limits.
- **PostgreSQL:** primary transactional store, FTS/trigram search initially, advisory/row locks, outbox, and job leases using `FOR UPDATE SKIP LOCKED`.
- **Object storage:** S3-compatible attachments, exports, and large generated diffs; private buckets and short-lived signed URLs.
- **Secrets:** managed secret store and KMS envelope encryption; no tokens in application logs or ordinary database fields.
- **Observability:** OpenTelemetry traces, structured redacted logs, service/job metrics, dead-letter views, provider rate-limit metrics, and audit exports.

## Reliability and consistency

- Commands modify an aggregate, append activity, and enqueue outbox events in one PostgreSQL transaction.
- Consumers are at-least-once and idempotent. Event delivery is not used as evidence that a transaction committed unless the outbox row exists.
- GitHub webhooks are hints and can be duplicated, reordered, delayed, or absent. Periodic reconciliation is the convergence mechanism.
- Synchronization candidates are invisible until atomically published. A failure preserves the previous active snapshot.
- Long operations return operation/job IDs. APIs never hold a request open for repository reconciliation or provider retries.
- Provider circuit breakers, bounded exponential backoff with jitter, per-installation rate budgets, and dead-letter triage prevent retry storms.

## Security boundaries

- Repository data is untrusted content, never executable instruction. Raw HTML is disabled or sanitized; links and attachments are policy checked.
- Agents receive typed tools only—no shell, database, arbitrary filesystem, secrets, or unrestricted network access.
- Provider credentials are decrypted only in the integration boundary and never passed to clients or models.
- Externally visible operations re-evaluate authorization, policy, provider capability, confirmation, and base revision immediately before effect.
- Audit payloads contain redacted summaries and references, not secrets or full page bodies.

## Extension points

- Replace PostgreSQL job claiming with a managed queue behind the job interface.
- Add a dedicated search engine from outbox events without changing authoritative records.
- Add CRDT native-page updates behind page revisions and snapshots.
- Add the Relationship Graph as a permission-filtered projection/explicit-edge service and Spatial Collaboration as a separate structured scene-graph context. Canvas rendering and CRDT infrastructure are deferred until Phase 6.
- Add additional Git providers behind a forge adapter only after GitHub semantics are stable.
- Extract high-load bounded contexts only when operational evidence warrants independent deployment.
