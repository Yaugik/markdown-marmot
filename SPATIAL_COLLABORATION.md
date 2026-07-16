# Spatial Knowledge Graph and Collaborative Canvas

## Status and intent

This is a strategic direction for **Phase 6**, after Folio's core page, issue, to-do, calendar, agent, and real-time collaboration domains are stable. It is explicitly outside the current development cycle. Current phases should preserve the extension points described here without building speculative canvas infrastructure.

The capability combines an Obsidian-like connected-knowledge graph with a Miro-like collaborative whiteboard without copying either product's branding, visual design, assets, or proprietary behavior. Folio calls the resulting product surface **Canvas**.

## Product capability

Humans and agents will be able to explore and spatially organize relationships among:

- Git-backed and native pages;
- issues, sub-issues, milestones, cycles, and roadmap items;
- personal or shared to-dos and calendar entries where permission allows;
- repositories, selected branches, commits, and pull requests;
- human members and project agents;
- canvas-native stickies, shapes, text, drawings, images, frames, and connectors.

Canvas supports brainstorming, planning, discussion, workshops, voting, presentations, and visual synthesis. Entity-backed cards remain live views of Folio entities rather than copied records.

## Three-layer architecture

### Canonical relationship graph

The graph is a permission-filtered set of stable Folio entity IDs and typed relationships. It distinguishes:

- `explicit`: a user or agent deliberately created a domain relationship;
- `derived`: Folio observed a link, mention, assignment, Git provenance, hierarchy, or other authoritative fact;
- `suggested`: a search/index/agent inference awaiting acceptance;
- `canvas_only`: a visual connector with no domain meaning outside its canvas.

Every graph edge records type, direction, source provenance, creator/deriver, revision, confidence where relevant, lifecycle, and authorization scope. Derived edges point to the source revision or provider observation that produced them and are rebuildable. Explicit edges are authoritative Folio data and use normal lifecycle/audit rules.

### Graph explorer

The graph explorer is a generated, read-oriented visualization. Users and agents can search, expand neighbors, filter by entity/edge type, cluster, traverse, and save graph queries. Automatic layout is presentation state, not domain authority.

The explorer never reveals hidden nodes or their metadata. Permission changes can remove nodes/edges from a result without changing the underlying authorized graph.

### Collaborative Canvas

A canvas is a persistent, project-owned scene graph with an infinite coordinate space. It owns presentation and facilitation state:

- element position, size, rotation, style, z-order, grouping, frames, and layout locks;
- canvas-native stickies, text, shapes, connectors, drawings, images, embeds, voting, timers, and presentation regions;
- entity-backed cards referencing one stable Folio entity ID and a display configuration;
- threads, mentions, reactions, cursors/presence, selections, and revision/collaboration state.

Canvas does not own page content, issue status, to-do scheduling, Git provenance, membership, or canonical domain relationships.

## Editing semantics

- Moving, resizing, styling, framing, or grouping an entity card changes the canvas only.
- Editing an entity-backed field invokes that entity's ordinary command with the same capability, validation, revision, idempotency, activity, and confirmation rules as every other surface.
- Drawing a connector creates `canvas_only` visual state by default.
- Promoting a connector requires an explicit relationship type such as `related_to`, `depends_on`, `references`, `parent_of`, or another supported domain relation.
- Converting a sticky to a page, issue, or to-do is an explicit previewed command. The sticky may remain linked to the created entity for provenance.
- Removing an entity card from a canvas never archives or deletes the entity.
- Archiving an entity leaves a historical/redacted card state according to permission and retention policy; Canvas never resurrects it implicitly.

## Mermaid and diagram formats

Mermaid is supported as:

- an embedded diagram element;
- an agent-generated technical diagram format;
- an import/export or text representation for compatible graph subsets;
- an optional way to create a new canvas region from declarative syntax.

Mermaid is **not** the Canvas persistence, rendering, collaboration, or interaction substrate. A text-to-layout DSL cannot safely model durable manual coordinates, freehand content, rich objects, presence, partial edits, permissions, or collaborative scene mutations. Canvas persists a versioned structured scene graph; compatible regions may round-trip to Mermaid only when the conversion is demonstrably lossless.

## Authorization and privacy

Canvas authorization composes project membership, canvas grants, element operation capability, and referenced-entity permission.

- Access to a canvas does not grant access to every referenced entity.
- Unauthorized entity cards render as a non-identifying redacted placeholder or are omitted according to policy; titles, types, connections, previews, and counts must not leak hidden metadata.
- A connector between two entities is visible only when the viewer may observe the relationship and the required endpoints.
- Private to-dos cannot be exposed by placing them on a shared canvas without an explicit sharing action.
- Entity mutations from Canvas re-authorize against current entity policy immediately before effect.
- Export, public sharing, bulk conversion, graph rewrites, and facilitation actions with broad effects use the standard risk and confirmation model.

## Agent-native interaction

Agents consume a bounded structured scene/graph, never UI screenshots. Context includes canvas ID/revision, selected or visible-region element IDs, entity references, typed edges, permissions, provenance, and compact geometry.

Future tools include:

- `search_graph`, `expand_graph`, `read_graph_neighbors`, and `save_graph_view`;
- `create_canvas`, `read_canvas`, and `read_canvas_region`;
- `add_entity_to_canvas`, `create_sticky`, `create_shape`, `create_frame`, and `connect_canvas_nodes`;
- `move_canvas_elements`, `group_canvas_elements`, and `organize_canvas_region`;
- `promote_connector_to_relationship` and `remove_explicit_relationship`;
- `convert_sticky_to_page`, `convert_sticky_to_issue`, and `convert_sticky_to_todo`;
- `summarize_canvas_region` and `prepare_workshop_output`.

Layout-only mutations are normally R1. Creation or modification of authoritative entities/relationships uses the target domain's risk. Bulk conversion, graph rewrites, exports, public sharing, or broad rearrangement are R2/R3 according to scope and policy.

## Data and event boundaries

The future Relationship Graph context owns explicit edge records and derived/suggested projections. The Spatial Collaboration context owns canvases and scene elements. Domain aggregates continue owning their content and lifecycle.

Planned records include:

- `entity_relationships`: typed explicit edges with source/target entity references, provenance, revision, and lifecycle;
- `derived_relationships`: rebuildable source-revision/provider observations;
- `graph_views`: saved permission-filtered queries, filters, and layout preferences;
- `canvases`: project, title, grants, collaboration mode, current revision, archive state;
- `canvas_revisions` or CRDT snapshots/update references;
- `canvas_elements`: typed scene nodes with geometry/style and optional entity reference;
- `canvas_connectors`: endpoints, routing/style, and optional promoted relationship ID;
- `canvas_threads`, `canvas_mentions`, `canvas_votes`, and presence projections.

Representative events include `relationship.created`, `relationship.removed`, `canvas.created`, `canvas.revised`, `canvas.element_added`, `canvas.connector_promoted`, and `canvas.sticky_converted`. High-frequency cursor and transient presence updates are ephemeral collaboration traffic, not audit events.

## Phase 6 delivery sequence

1. Canonical typed relationship service and provenance model.
2. Permission-filtered read-only graph explorer and saved graph views.
3. Persistent canvases with entity cards, stickies, shapes, frames, and connectors.
4. Explicit graph editing and sticky/entity conversion workflows.
5. Real-time collaborative whiteboarding, presence, comments, voting, and facilitation.
6. Agent-assisted organization, synthesis, workshop preparation, and compatible Mermaid import/export.

Acceptance requires authorization/redaction tests, graph provenance and rebuild tests, scene revision/conflict tests, large-canvas performance, accessibility alternatives to spatial-only information, real-time convergence, export safety, and complete actor/authorizer audit for domain mutations.

## Extension points required now

Earlier phases must provide stable entity IDs, typed relationship interfaces, permission-filtered search, provenance, revisions, outbox events, and common agent/service authorization. They should not add canvas tables, a CRDT service, spatial indexes, or a rendering engine until Phase 6 is approved for active development.

