# Page Coexistence and Editing

## Unified page abstraction

`Page` is the stable Folio identity used by trees, links, backlinks, permissions, comments, mentions, search, issues, and agents. It has exactly one source subtype:

- **Git-backed:** source authority is one GitHub repository, selected branch, and Markdown path. Content changes only through Git operations.
- **Native:** source authority is Folio's immutable structured-content revisions.

Every UI and tool response exposes `source_type` and a source descriptor. Operations are source-specific: `edit_native_page` cannot accept a Git page, and `edit_markdown_file` cannot accept a native page.

## Project page tree

Folio owns tree nodes, parentage, rank, folders, aliases, and display-title overrides. A page may appear in multiple tree locations. Reordering, nesting, or aliasing changes Folio metadata only. It never moves or rewrites a Git file.

For Git files, creating, renaming, moving, or deleting the source is an explicit Git file operation with a diff and repository policy. A resulting reconciliation updates or relates the page identity according to rename evidence.

## Common behavior

Both page types support:

- permission-filtered read, search, links, backlinks, comments, mentions, attachments, and entity relationships;
- stable IDs and integer Folio revisions;
- source and revision provenance;
- archived/unavailable state without routine hard deletion;
- structured agent reads and mutations appropriate to source type.

Comments anchor to a page plus source revision and a resilient text/block locator. When content changes, an anchor can be `current`, `moved`, or `stale`; Folio does not pretend an unresolved anchor is current.

## Native page editing

Native content uses a versioned ProseMirror-compatible JSON document schema. Every accepted edit creates an immutable revision and advances the page's integer revision. Commands require `expected_revision`; stale edits return `REVISION_CONFLICT` with the current revision and optional merge inputs.

The initial native-page release supports revisioned single-writer-at-a-time editing, comments, and history. The revision/event boundary is compatible with a later CRDT update log and presence service, but CRDT infrastructure is not built before validated demand.

## Git-backed source and rich editing

Source mode is the universal, lossless editing surface and preserves the user's exact Markdown input. Rich mode is available only when the document parses into the supported GFM-compatible AST profile:

- headings, paragraphs, emphasis/strong/strikethrough, links, images, lists, task lists, block quotes, thematic breaks;
- fenced/indented code, inline code, tables, and ordinary escaped text;
- YAML front matter retained as a protected source block initially;
- unsupported directives, MDX/JSX, raw HTML, custom extensions, ambiguous reference constructs, and parser errors remain protected raw blocks or force source-only mode.

Rich editing operates on an AST, not rendered HTML. Untouched nodes retain their original source slices where possible. Changed supported nodes use a deterministic Markdown serializer. Protected nodes cannot be accidentally rewritten from rich mode.

## Round-trip gate

Before a rich edit can be prepared:

1. Parse the base Markdown with source positions and extension profile.
2. Apply structured edits while preserving protected nodes.
3. Serialize supported changed nodes and splice preserved source slices.
4. Parse the result again and compare semantic ASTs after documented normalization.
5. Reject on syntax loss, protected-node change, unexpected front-matter change, or unresolved parser warning.
6. Show the exact Markdown diff and resulting render before commit preparation.

The gate promises valid, semantically equivalent Markdown for untouched content; it does not promise that deliberately changed supported nodes retain every whitespace preference. Source mode remains available when exact formatting is required.

## Links, assets, and rendering

- Relative links resolve against repository/branch/path for Git pages and page identity for native pages.
- Links to known pages use stable Folio targets while retaining original source text/provenance.
- Raw HTML is disabled by default; permitted output is sanitized with a strict allowlist and safe link attributes.
- Repository images are fetched only through authorized, bounded provider reads or an image proxy; local file URLs and traversal are forbidden.
- Attachments use scanned private object storage and signed delivery URLs.
- Search indexes title, headings, body, path, repository, branch, labels, and relationships only after the source revision/snapshot is publishable.

## Import, export, and conversion

These are distinct, previewed operations:

- **Import Git to native:** copies a selected Git revision into a new native page, records source provenance, and leaves the Git page unchanged.
- **Export native to Git:** creates a Markdown proposal for a permitted repository/branch/path, runs round-trip and diff checks, then uses the Git workflow.
- **Convert:** performs import/export plus an explicit tree/link reassignment plan; it never changes authority in place.
- **Move:** changes a tree node only unless the user explicitly selects a Git file move or native-to-Git export.

Previews name the new authority, target, relationships affected, unsupported-content warnings, and rollback behavior. Completion records both source and destination IDs in activity.

## Future graph and Canvas representation

Pages may appear as entity-backed cards in the Phase 6 graph explorer and Canvas. The card references the stable Folio page ID and current permitted projection; it never copies or becomes authoritative for page content. Moving, resizing, framing, or removing the card changes Canvas presentation only.

A Canvas connector is visual-only by default. Promoting it to a page relationship is an explicit command through the common relationship service, with type, direction, revision, authorization, and activity. Git-backed page edits still use Git operations and native-page edits still create native revisions even when initiated from Canvas.
