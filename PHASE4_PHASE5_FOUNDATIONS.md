# Phase 4 Scheduling and Phase 5 Foundations

Updated: 2026-07-16

## Status

The branch `agent/phase-4-scheduling-phase-5-foundations` contains the Phase 4 scheduling implementation candidate plus the deliberately limited Phase 5 foundations needed to operate it.

The branch remains a draft-review candidate. It has not received a complete developer-checkout migration, lint, typecheck, test, worker, or production-build run in this environment.

## Phase 4 delivered

### Lists and to-dos

- Private and project-visible to-do lists.
- Object-grant sharing for private lists without making them project-public.
- Nested to-dos with cycle prevention and active-parent lifecycle enforcement.
- Human and agent assignees restricted to active project principals.
- Structured bodies with bounded plain-text projection.
- Start/due times, time zones, rank, optimistic revisions, completion, cancellation, archive, and restore.
- Typed issue and page links with permission-filtered reads.

### Recurrence and reminders

- Daily, weekly, and monthly recurrence rules.
- Stable occurrence keys and idempotent occurrence persistence.
- Explicit DST gap-forward and overlap-earlier behavior.
- Bounded rolling-window expansion and idempotent materialization.
- Retryable reminders with leases, attempts, exponential backoff, deduplication, and in-app delivery.
- Email/provider reminder channels remain inactive until adapters are configured.

### Calendars

- Private and project-visible calendars.
- Manual, to-do-derived, and issue-derived calendar entries with source authorization.
- Entry update, archive, and restore.
- Mixed calendar projection over only the calendars, lists, and issues the principal can independently read.
- Permission-safe start/due projections for to-dos and issues.

### Agent scheduling

- Human-authored grants scoped to exactly one to-do list or calendar.
- Per-grant operation allowlists for create, reschedule, complete, cancel, and remind.
- Optional scheduling horizon and hour constraints.
- Reauthorization of both the agent and authorizing human at execution time.
- Agent commands cannot move outside the delegated object.
- All successful delegated mutations retain actor/authorizer provenance and redacted audit summaries.

### Browser workspace

- `/schedule` integrated into the Folio shell.
- Private/shared list creation and selection.
- To-do creation, completion, dates, details, and reminder controls.
- Mixed calendar mode and manual event creation.
- Visible realtime and provider-foundation status without implying unavailable providers are active.

## Limited Phase 5 foundations delivered

### Realtime and presence

- Append-only cursor event log mirrored from the transactional outbox.
- Permission checks against the actual page, issue, list, to-do, calendar, entry, reminder, grant, integration, or provider-operation target.
- Unknown aggregate types fail closed.
- Expiring presence heartbeat/list/leave for project, page, list, and calendar channels.

### Durable PostgreSQL jobs

- Dedicated `folio_worker` database role.
- Cross-tenant job claiming through a restricted security-definer function.
- Leases, `SKIP LOCKED`, attempt records, retry backoff, terminal failures, and metrics.
- PostgreSQL scheduling jobs run alongside the legacy SQLite source-sync worker.
- One bounded global recurrence sweep rather than unbounded per-to-do job chains.

### Provider-neutral calendar boundary

- Calendar provider adapter registry with discover/pull contracts.
- Secret-manager references rather than raw provider tokens.
- Owner-scoped connections and calendar bindings.
- External event ID/etag mapping for idempotent pull reconciliation.
- Per-provider-event savepoints and succeeded-with-warnings outcomes.
- Imported changes create redacted activity and outbox records.

## Explicit decision gates

The following are intentionally rejected rather than guessed:

- Two-way external calendar synchronization.
- Automatic `provider_wins` or `folio_wins` conflict policy.
- Push/reconcile/revoke provider operations in the public foundation.
- Email/provider reminder delivery without registered adapters.
- A production websocket/CRDT service.
- Automatic extraction to managed search, Redis, Kafka, or a hosted queue before measurements justify it.
- Enterprise SSO/SCIM, data residency, audit export, and administration surfaces.

## Migrations

- `0013_phase4_todos_scheduling.sql`
- `0014_phase5_foundations.sql`
- `0015_phase4_phase5_hardening.sql`
- `0016_phase5_calendar_event_mapping.sql`
- `0017_phase4_worker_bootstrap.sql`
- `0018_phase5_reminder_worker_policy.sql`
- `0019_phase5_least_privilege.sql`

## Acceptance candidates

- `src/services/recurrence.test.ts`
- `src/services/phase4.integration.test.ts`
- `src/services/phase5-foundations.integration.test.ts`
- `src/db/phase4-phase5-migrations.test.ts`
- extended assertions in `src/db/postgres-migrate.test.ts`

The committed tests cover recurrence dates and DST behavior, private-list and private-calendar isolation, object grants, human/agent assignment, hierarchy lifecycle, idempotent occurrence materialization, reminders, durable queue retries, provider pull mapping, presence, and permission-filtered realtime events.

## Known draft blockers

Two connector-level changes require confirmation or correction in a complete checkout before this draft can be considered executable:

1. `src/db/postgres-migrate.test.ts` was extended through `0017`; its exact migration-order array must be refreshed to include `0018_phase5_reminder_worker_policy.sql` and `0019_phase5_least_privilege.sql`.
2. `src/worker/schedule-worker.ts` still uses the earlier tenant-scoped reminder claim/finish path. It should be switched to `claimReminderForDelivery` and `finishReminderDelivery` from `src/services/reminder-worker.ts` so reminder delivery consistently runs under `folio_worker`.

These are documented merge blockers, not accepted production behavior.

## Verification gate

No GitHub Actions workflow is included, following the requested testing preference.

Run in a complete developer checkout with PostgreSQL:

1. `npm install`
2. Regenerate and commit the stale lockfile if dependency resolution changes.
3. `npm run db:migrate:folio`
4. `npm run lint`
5. `npm run typecheck`
6. `npm run test`
7. `npm run build`
8. Start the worker and verify recurrence, reminder, and provider job leasing/retry behavior.
9. Exercise `/schedule` with private/project lists, calendars, object grants, and an agent principal.

The repository's existing stale lockfile still prevents deterministic `npm ci` until its missing transitive records are regenerated.

## Remaining Phase 5 work

- Real provider adapters and OAuth/application installation flows.
- Product decisions and implementation for two-way calendar conflict handling.
- Production websocket transport and CRDT collaboration.
- Measured extraction of search, cache, and queue infrastructure.
- Enterprise SSO/SCIM, administration, audit export, retention, residency, and key-management work.
- Additional ecosystem integrations.
