# Phase 2 Completion Record

Updated: 2026-07-16

## Status

The Phase 2 implementation is complete on `agent/phase-2-native-pages` as a review candidate. The pull request remains draft for code review and a full developer-machine application smoke test; verification for the high-risk Phase 2 Markdown and PostgreSQL behavior was performed locally outside GitHub Actions.

## Delivered

### Native pages and immutable history

- Stable project-scoped page identities with explicit `source_type`.
- ProseMirror-compatible native content with bounded validation.
- Immutable native revisions, parent revision provenance, content hashes, and plain-text projections.
- Optimistic edit concurrency through `expected_revision` and `REVISION_CONFLICT`.
- Revision history listing and individual historical revision reads.
- Archive and restore without deleting content or history.

### Project page tree

- Folders, primary page placements, and aliases.
- Multiple placements through aliases without changing source authority.
- Reparenting, title overrides, deterministic rank ordering, and optimistic batch reorder.
- Placement archive/restore and recursive folder archive.
- Service and PostgreSQL checks for valid parents, active target pages, non-negative ranks, and cycles.
- Permission-filtered tree projections that retain ancestors of visible pages.

### Collaboration

- Revision-aware comment threads and replies.
- Resolved/reopened thread lifecycle.
- Explicit anchor states: `current`, `moved`, and `stale`.
- New native revisions visibly stale old anchors; re-anchor commands recover them without rewriting comments.
- Project-member mentions, personal mention inbox, and read/dismiss state.

### Attachments

- Bounded 10 MiB attachment preparation.
- Exact size and SHA-256 verification before publication.
- Authenticated upload and download with private/no-store delivery and safe content disposition.
- Page and optional comment ownership.
- Development object-store adapter under `.local-data`; production S3-compatible storage remains a Phase 0 deployment concern, not a Phase 2 domain gap.

### Links, backlinks, search, and grants

- Explicit page/external link projection with source revision provenance and stale state.
- Automatic native-page link extraction from structured link nodes/marks.
- Permission-filtered backlinks.
- PostgreSQL full-text search over native pages and an indexing boundary for Git-backed pages.
- Native/Git source badges in unified search results.
- Enforceable page-level object grants for read, edit, comment, and archive operations.
- Grants are applied consistently to native reads/edits/history/lifecycle, tree visibility, comments, attachments, backlinks, search, Markdown analysis, and conversion workflows.

### Rich Markdown safety gate

- Exact source hashing and stale-base rejection.
- Supported GFM block analysis.
- Protected raw slices for front matter, raw HTML, MDX/JSX, directives, reference definitions, and unparsed source.
- Rich block proposals cannot mutate protected slices.
- Candidate Markdown is reparsed and protected-source hashes are compared before acceptance.
- Sanitized render previews and changed-block hashes are returned for diff review.
- Native sources are rejected at the Git Markdown mutation boundary.

### Import, export, and conversion

- Git-to-native preview and execution from an exact Markdown snapshot.
- Native-to-Git Markdown proposal generation with source revision and content-hash provenance.
- Explicit conversion previews with warnings, target authority, expiry, and relationship impact.
- Optional tree-placement and incoming-link reassignment for conversion.
- Git proposals deliberately return `requiresGitOperation: true`; commit/push/pull-request execution remains owned by the Phase 1 Git operation service.

### User interface

- A project Pages workspace under `/pages`.
- Project tree navigation and native-page creation.
- Unified search with visible Native/Git source badges.
- Native page reading, comments, anchor state, backlinks, attachments, revision/status metadata.
- Responsive project workspace styling integrated into the existing Folio shell.

## Acceptance coverage

- Supported GFM structures.
- Front matter and protected raw HTML.
- MDX/JSX and custom directives.
- Malformed fenced Markdown.
- Unicode import/export.
- Protected-node preservation.
- Source-specific mutation boundaries.
- Page grants and permission-filtered tree/search/backlinks.
- Comments, mentions, stale anchors, re-anchoring, and resolution.
- Attachment integrity and authenticated delivery.
- Git-to-native import and native-to-Git proposal workflows.

## Dependency boundary

Phase 2 does not duplicate unfinished Phase 1 provider execution. A native-to-Git export is complete when it produces a validated Markdown proposal with provenance and relationship impact. Turning that proposal into a Git commit or pull request requires the Phase 1 GitHub App, repository-link, prepared-change, and Git-operation services.

## Local verification

Verification was performed in an isolated container without GitHub Actions.

### Exact-source Markdown harness

The committed `markdown-roundtrip.ts` and `markdown-roundtrip.test.ts` blobs were mirrored locally and verified by Git blob SHA before execution.

- Strict TypeScript compilation passed.
- 7 rich-Markdown acceptance tests passed.
- Covered supported GFM, protected front matter/HTML, MDX/directives, malformed fences, stale hashes, protected-block mutation rejection, Unicode, and native/Git mutation boundaries.

### Embedded PostgreSQL migration harness

The committed migration blobs `0005` through `0009` were mirrored locally and verified by Git blob SHA. They were applied in order to an embedded PostgreSQL runtime with the required foundation tables, role, schema, and tenant function.

- All five Phase 2 migrations applied successfully.
- Immutable native revision updates were rejected.
- New revisions marked old comment anchors and links stale.
- Native search projections refreshed to the latest content/revision.
- Active tree placements for archived pages were rejected.
- Polymorphic source/current revision columns were confirmed as `text`.
- Executed conversion previews without `executed_at` were rejected.

The first local migration run exposed a UUID/text comparison bug in the stale-link and search-refresh triggers after polymorphic revision conversion. Migration `0009` now replaces both trigger functions with explicit `NEW.id::text` casts, and a regression assertion was added to `postgres-migrate.test.ts`.

## Remaining review gate

Before merging, run the full repository commands on a developer machine with the complete source checkout and PostgreSQL service:

1. `npm install`
2. `npm run db:migrate:folio`
3. `npm run lint`
4. `npm run typecheck`
5. `npm run test`
6. `npm run build`

The current container cannot clone the complete GitHub repository because outbound GitHub DNS is unavailable, and the legacy `better-sqlite3` native build requires external Node headers. Those environment limits do not affect the exact-source Phase 2 Markdown or embedded-PostgreSQL checks documented above.
