# Migration from the Local Repository Reader

## Starting point

The implementation recorded in `IMPLEMENTATION_STATUS.md` is a single-user Next.js application with SQLite, local repository paths, one worker, committed Markdown caches, FTS5, headings, synchronization runs, and simple activity events. It has no cloud identity, workspace/project boundary, GitHub App installation, write-back, native pages, issues, or capability authorization.

That implementation remains readable during migration but is not evolved into the cloud database in place. PostgreSQL receives data only through a versioned import contract.

## Migration principles

- Git remains the authority for Git-backed Markdown; cached Markdown, rendered HTML, extracted text, and FTS rows are never uploaded as authoritative content.
- Credentials, local paths, mirrors, environment variables, logs, fixtures, caches, databases, and generated output are excluded from version control and cloud import packages.
- Repository matching requires an explicit user decision and an authorized GitHub App installation.
- Local-only repositories are never silently converted. The user must push them to an authorized GitHub repository or explicitly import selected Markdown as native pages in Phase 2.
- Imports are dry-runnable, idempotent, resumable, report every record, and can be rolled back by archiving the imported project/workspace before cutover.

## Versioned export package

Add a read-only legacy exporter that produces a checksummed package containing:

- format/schema version, export ID/time, source application version, and record counts;
- sanitized repository display metadata and default branch, excluding local filesystem location and credentials from the portable payload;
- sync source branch names and selection rules;
- legacy document ID, source ID, normalized path, last observed commit/blob/hash, availability, and last-indexed time;
- heading IDs/text/slugs only when needed to map external relationships;
- relevant activity summaries with legacy actor/source attribution and timestamps;
- explicit exclusion and warning lists.

The package does not contain `markdown`, `rendered_html`, `extracted_text`, FTS data, repository contents, Git credentials, or raw errors. A separate local-only mapping aid may show remote URLs discovered from Git, but it must redact embedded credentials and requires user confirmation before export.

## Import workflow

1. Create or select the destination workspace and project using normal authorization.
2. Upload/validate the package; reject unknown versions, checksum failure, duplicate conflicting records, unsafe paths, or malformed object IDs.
3. Install/choose the GitHub App installation and explicitly map each legacy repository to an authorized GitHub repository or mark it skipped.
4. Map branch and scope rules, preview differences, and verify selected branches exist.
5. Create project repository links and selected branches in an archived/importing state.
6. Store legacy-to-Folio IDs in `import_identity_mappings` keyed by export/import ID, source type, and legacy ID. Preserve a legacy UUID only if valid and globally unused; otherwise generate UUIDv7 and retain the mapping.
7. Reconcile Markdown from GitHub at the selected current heads. Compare normalized path and available commit/blob evidence; never trust cached content.
8. Classify each legacy document as matched, moved with evidence, missing, branch unavailable, repository skipped, or ambiguous. Ambiguous records require user resolution and are not auto-merged.
9. Import eligible historical activity as `legacy.imported_activity` with original timestamps and clearly labeled legacy provenance; do not imply full cloud-era audit fidelity.
10. Produce a reconciliation report and activate the imported project only after acceptance. Activation is an explicit audited command.

## Rollback and cutover

- Before activation, rollback deletes only import-staging records and reconstructible snapshots.
- After activation, rollback archives the imported project/repository links and preserves audit/mapping records; permanent purge follows the future warned deletion policy.
- The legacy app and SQLite file remain untouched and readable until the user verifies counts, sampled pages, branches, provenance, and activity.
- Cutover documentation records destination workspace/project IDs, skipped repositories, unresolved records, snapshot heads, importer version, and report checksum.

## Migration acceptance criteria

- Dry run makes no destination mutations except an expiring import session and upload metadata.
- Repeating the same import key/package returns the same mappings and does not duplicate projects, links, or activity.
- A modified package with a reused idempotency key fails.
- No secret, local path, cached body, rendered HTML, FTS row, mirror, fixture, or raw database is present in the portable package.
- Every imported Git page is rehydrated from an authorized GitHub repository and has branch/path/commit/blob/snapshot provenance.
- Missing and ambiguous documents remain visible in the report and are never represented as successfully synchronized.
- Rollback and resume work after worker interruption at every import stage.

