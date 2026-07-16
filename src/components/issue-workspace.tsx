"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Archive,
  CalendarDays,
  CheckCircle2,
  ChevronRight,
  Columns3,
  Flag,
  GitPullRequestArrow,
  LayoutList,
  MessageSquare,
  Milestone,
  Paperclip,
  Plus,
  RefreshCw,
  Route,
  Save,
  Search,
  Send,
  Timeline,
  Upload,
} from "lucide-react";
import styles from "@/app/issues/issues.module.css";

type IssuePriority = "no_priority" | "urgent" | "high" | "medium" | "low";
type ProjectionKind = "list" | "board" | "timeline" | "calendar";
type Issue = {
  id: string;
  issue_number: number;
  identifier: string;
  workflow_id: string;
  status: { id: string; name: string; category: string; color_key: string };
  parent_issue_id: string | null;
  milestone_id: string | null;
  cycle_id: string | null;
  title: string;
  description: Record<string, unknown>;
  plain_text: string;
  priority: IssuePriority;
  estimate_points: number | null;
  start_on: string | null;
  due_on: string | null;
  rank: number;
  lifecycle: "active" | "archived";
  revision: number;
  assignees: Array<{ principal_id: string; display_name: string; kind: string }>;
  labels: Array<{ id: string; name: string; color_key: string }>;
  dependencies: Array<{ id: string; source_issue_id: string; target_issue_id: string; relation_kind: string }>;
  created_at: string;
  updated_at: string;
};
type Workflow = {
  id: string;
  name: string;
  is_default: boolean;
  statuses: Array<{ id: string; name: string; category: string; color_key: string; rank: number }>;
  transitions: Array<{ id: string; from_status_id: string; to_status_id: string; name: string; requires_comment: boolean }>;
};
type Portfolio = {
  labels: Array<{ id: string; name: string; color_key: string }>;
  milestones: Array<{ id: string; name: string; target_on: string | null; state: string }>;
  cycles: Array<{ id: string; name: string; starts_on: string; ends_on: string; state: string }>;
  roadmaps: Array<{ id: string; name: string; visibility: string; items: Array<{ issue_id: string }> }>;
};
type SavedView = {
  id: string;
  name: string;
  visibility: "private" | "project";
  projection: ProjectionKind;
  filters: Record<string, unknown>;
  grouping: Record<string, unknown>;
  ordering: Array<Record<string, unknown>>;
  revision: number;
};
type Projection = {
  kind: ProjectionKind;
  view_id: string | null;
  total: number;
  issues: Issue[];
  groups: Array<{ key: string; label: string; issueIds: string[] }>;
  timeline: Array<{ issue_id: string; start_on: string | null; due_on: string | null }>;
  calendar: Array<{ date: string; starts: string[]; due: string[] }>;
};
type Comment = {
  id: string;
  plain_text: string;
  author_display_name: string;
  created_at: string;
};
type Attachment = {
  id: string;
  file_name: string;
  mime_type: string;
  size_bytes: number;
  storage_state: string;
  scan_state: string;
};
type BulkPreview = {
  id: string;
  operation: string;
  issue_ids: string[];
  action_digest: string;
  risk_level: "R1" | "R2";
  state: string;
  confirmation_id: string | null;
  revision: number;
  impact: {
    target_count: number;
    accessible_count: number;
    unavailable_count: number;
    blocked_count: number;
    warnings: string[];
  };
  result: null | {
    succeeded: Array<{ issue_id: string; revision: number }>;
    failed: Array<{ issue_id: string; code: string; message: string }>;
  };
};
type Envelope<T> = { data: T; error?: { message?: string } };

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...init });
  const payload = await response.json().catch(() => ({})) as Envelope<T>;
  if (!response.ok) {
    throw new Error(payload.error?.message ?? `Request failed (${response.status})`);
  }
  return payload.data;
}

function key(prefix: string) {
  return `${prefix}-${crypto.randomUUID()}`;
}

function doc(text: string) {
  return {
    type: "doc",
    content: text.trim()
      ? [{ type: "paragraph", content: [{ type: "text", text: text.trim() }] }]
      : [],
  };
}

function priorityLabel(priority: IssuePriority) {
  return priority === "no_priority" ? "No priority" : priority[0]!.toUpperCase() + priority.slice(1);
}

export function IssueWorkspace({ workspaceId, projectId }: { workspaceId?: string; projectId?: string }) {
  const [projectionKind, setProjectionKind] = useState<ProjectionKind>("list");
  const [projection, setProjection] = useState<Projection | null>(null);
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [portfolio, setPortfolio] = useState<Portfolio>({ labels: [], milestones: [], cycles: [], roadmaps: [] });
  const [views, setViews] = useState<SavedView[]>([]);
  const [selectedIssueId, setSelectedIssueId] = useState<string | null>(null);
  const [selectedIssue, setSelectedIssue] = useState<Issue | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [comments, setComments] = useState<Comment[]>([]);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [newTitle, setNewTitle] = useState("");
  const [newDescription, setNewDescription] = useState("");
  const [newPriority, setNewPriority] = useState<IssuePriority>("no_priority");
  const [comment, setComment] = useState("");
  const [viewName, setViewName] = useState("");
  const [bulkPreview, setBulkPreview] = useState<BulkPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const scope = useMemo(() => workspaceId && projectId
    ? `workspace_id=${encodeURIComponent(workspaceId)}&project_id=${encodeURIComponent(projectId)}`
    : null, [workspaceId, projectId]);

  const issuesById = useMemo(() => new Map((projection?.issues ?? []).map((issue) => [issue.id, issue])), [projection]);
  const selectedWorkflow = workflows.find((workflow) => workflow.id === selectedIssue?.workflow_id);
  const availableTransitions = selectedWorkflow?.transitions.filter((transition) => transition.from_status_id === selectedIssue?.status.id) ?? [];

  const loadProjection = useCallback(async (viewId?: string) => {
    if (!workspaceId || !projectId) return;
    const data = await api<Projection>("/api/v1/issue-projections", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workspace_id: workspaceId,
        project_id: projectId,
        ...(viewId ? { view_id: viewId } : {
          projection: projectionKind,
          filters: { query: searchQuery.trim() || undefined },
          grouping: { field: projectionKind === "board" ? "status" : "none" },
          ordering: [{ field: "rank", direction: "asc" }],
        }),
      }),
    });
    setProjection(data);
    if (!selectedIssueId && data.issues[0]) setSelectedIssueId(data.issues[0].id);
  }, [workspaceId, projectId, projectionKind, searchQuery, selectedIssueId]);

  const loadWorkspace = useCallback(async () => {
    if (!scope) return;
    setBusy(true);
    setError(null);
    try {
      const [workflowData, portfolioData, viewData] = await Promise.all([
        api<Workflow[]>(`/api/v1/issue-workflows?${scope}`),
        api<Portfolio>(`/api/v1/issue-portfolio?${scope}`),
        api<SavedView[]>(`/api/v1/issue-views?${scope}`),
      ]);
      setWorkflows(workflowData);
      setPortfolio(portfolioData);
      setViews(viewData);
      await loadProjection();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load work management data");
    } finally {
      setBusy(false);
    }
  }, [scope, loadProjection]);

  const loadSelected = useCallback(async () => {
    if (!scope || !selectedIssueId) {
      setSelectedIssue(null);
      setComments([]);
      setAttachments([]);
      return;
    }
    try {
      const [issue, issueComments, issueAttachments] = await Promise.all([
        api<Issue>(`/api/v1/issues/${selectedIssueId}?${scope}`),
        api<Comment[]>(`/api/v1/issues/${selectedIssueId}/comments?${scope}`),
        api<Attachment[]>(`/api/v1/issues/${selectedIssueId}/attachments?${scope}`),
      ]);
      setSelectedIssue(issue);
      setComments(issueComments);
      setAttachments(issueAttachments);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load issue details");
    }
  }, [scope, selectedIssueId]);

  useEffect(() => { void loadWorkspace(); }, [loadWorkspace]);
  useEffect(() => { void loadSelected(); }, [loadSelected]);

  async function createIssue(event: React.FormEvent) {
    event.preventDefault();
    if (!workspaceId || !projectId || !newTitle.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api<{ issue: Issue }>("/api/v1/issues", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": key("issue") },
        body: JSON.stringify({
          workspace_id: workspaceId,
          project_id: projectId,
          title: newTitle,
          description: doc(newDescription),
          priority: newPriority,
        }),
      });
      setNewTitle("");
      setNewDescription("");
      setNewPriority("no_priority");
      setSelectedIssueId(result.issue.id);
      await loadProjection();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not create issue");
    } finally {
      setBusy(false);
    }
  }

  async function transition(targetStatusId: string) {
    if (!workspaceId || !projectId || !selectedIssue) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api<{ issue: Issue }>(`/api/v1/issues/${selectedIssue.id}/transition`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": key("transition") },
        body: JSON.stringify({
          workspace_id: workspaceId,
          project_id: projectId,
          expected_revision: selectedIssue.revision,
          target_status_id: targetStatusId,
        }),
      });
      setSelectedIssue(result.issue);
      await loadProjection();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not transition issue");
    } finally {
      setBusy(false);
    }
  }

  async function addComment(event: React.FormEvent) {
    event.preventDefault();
    if (!workspaceId || !projectId || !selectedIssue || !comment.trim()) return;
    try {
      await api(`/api/v1/issues/${selectedIssue.id}/comments`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": key("issue-comment") },
        body: JSON.stringify({ workspace_id: workspaceId, project_id: projectId, body: doc(comment) }),
      });
      setComment("");
      await loadSelected();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not add comment");
    }
  }

  async function saveView(event: React.FormEvent) {
    event.preventDefault();
    if (!workspaceId || !projectId || !viewName.trim()) return;
    try {
      await api("/api/v1/issue-views", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": key("view") },
        body: JSON.stringify({
          workspace_id: workspaceId,
          project_id: projectId,
          name: viewName,
          visibility: "private",
          projection: projectionKind,
          filters: { query: searchQuery.trim() || undefined },
          grouping: { field: projectionKind === "board" ? "status" : "none" },
          ordering: [{ field: "rank", direction: "asc" }],
        }),
      });
      setViewName("");
      setViews(await api<SavedView[]>(`/api/v1/issue-views?${scope}`));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save view");
    }
  }

  async function prepareBulkArchive() {
    if (!workspaceId || !projectId || selectedIds.size === 0) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api<{ preview: BulkPreview }>("/api/v1/issue-bulk", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": key("bulk-preview") },
        body: JSON.stringify({
          workspace_id: workspaceId,
          project_id: projectId,
          issue_ids: [...selectedIds],
          request: { operation: "archive" },
        }),
      });
      setBulkPreview(result.preview);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not prepare bulk operation");
    } finally {
      setBusy(false);
    }
  }

  async function approveBulk() {
    if (!workspaceId || !projectId || !bulkPreview?.confirmation_id) return;
    try {
      await api(`/api/v1/issue-bulk/confirmations/${bulkPreview.confirmation_id}/approve`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": key("bulk-approve") },
        body: JSON.stringify({
          workspace_id: workspaceId,
          project_id: projectId,
          action_digest: bulkPreview.action_digest,
          expected_revision: 1,
        }),
      });
      await executeBulk();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not approve bulk operation");
    }
  }

  async function executeBulk() {
    if (!workspaceId || !projectId || !bulkPreview) return;
    setBusy(true);
    try {
      const result = await api<{ preview: BulkPreview }>(`/api/v1/issue-bulk/${bulkPreview.id}/execute`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": key("bulk-execute") },
        body: JSON.stringify({ workspace_id: workspaceId, project_id: projectId, expected_revision: bulkPreview.revision }),
      });
      setBulkPreview(result.preview);
      setSelectedIds(new Set());
      await loadProjection();
      await loadSelected();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not execute bulk operation");
    } finally {
      setBusy(false);
    }
  }

  async function uploadAttachment(file: File | undefined) {
    if (!file || !workspaceId || !projectId || !selectedIssue) return;
    setBusy(true);
    setError(null);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)))
        .map((value) => value.toString(16).padStart(2, "0")).join("");
      const prepared = await api<{ attachment: Attachment; upload_url: string }>(`/api/v1/issues/${selectedIssue.id}/attachments`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": key("issue-attachment") },
        body: JSON.stringify({
          workspace_id: workspaceId,
          project_id: projectId,
          file_name: file.name,
          mime_type: file.type || "application/octet-stream",
          size_bytes: bytes.byteLength,
          sha256: hash,
        }),
      });
      await api(prepared.upload_url, {
        method: "PUT",
        headers: { "content-type": file.type || "application/octet-stream" },
        body: bytes,
      });
      await loadSelected();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not upload attachment");
    } finally {
      setBusy(false);
    }
  }

  function toggleSelection(issueId: string) {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(issueId)) next.delete(issueId);
      else next.add(issueId);
      return next;
    });
  }

  if (!workspaceId || !projectId) {
    return <div className={styles.setup}>
      <span className={styles.eyebrow}>Phase 3 work management</span>
      <h1>Choose a cloud project</h1>
      <p>Open this screen with <code>?workspace_id=&lt;uuid&gt;&amp;project_id=&lt;uuid&gt;</code> to manage workflows, issues, saved views, roadmaps, and bulk operations.</p>
      <form onSubmit={(event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        window.location.href = `/issues?workspace_id=${encodeURIComponent(String(form.get("workspace")))}&project_id=${encodeURIComponent(String(form.get("project")))}`;
      }}>
        <input name="workspace" placeholder="Workspace UUID" required />
        <input name="project" placeholder="Project UUID" required />
        <button type="submit">Open project</button>
      </form>
    </div>;
  }

  const renderIssueCard = (issue: Issue) => <article
    className={`${styles.issueCard} ${selectedIssueId === issue.id ? styles.selectedCard : ""}`}
    key={issue.id}
  >
    <label className={styles.checkbox}>
      <input type="checkbox" checked={selectedIds.has(issue.id)} onChange={() => toggleSelection(issue.id)} />
      <span />
    </label>
    <button type="button" onClick={() => setSelectedIssueId(issue.id)}>
      <div className={styles.cardTop}>
        <small>{issue.identifier}</small>
        <span className={`${styles.priority} ${styles[issue.priority]}`}>{priorityLabel(issue.priority)}</span>
      </div>
      <strong>{issue.title}</strong>
      <p>{issue.plain_text || "No description"}</p>
      <div className={styles.cardMeta}>
        <span><i data-color={issue.status.color_key} />{issue.status.name}</span>
        {issue.estimate_points !== null && <span>{issue.estimate_points} pts</span>}
        {issue.due_on && <span><CalendarDays size={13} />{issue.due_on}</span>}
      </div>
    </button>
  </article>;

  return <div className={styles.workspace}>
    <header className={styles.header}>
      <div><span className={styles.eyebrow}>Project work</span><h1>Work management</h1><p>{projection?.total ?? 0} visible issues · {workflows.length} workflows</p></div>
      <button className={styles.refresh} type="button" onClick={() => void loadWorkspace()} disabled={busy}><RefreshCw size={16} /> Refresh</button>
    </header>
    {error && <div className={styles.error}>{error}</div>}

    <section className={styles.toolbar}>
      <form onSubmit={(event) => { event.preventDefault(); void loadProjection(); }}>
        <Search size={17} />
        <input value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} placeholder="Search issues" />
        <button type="submit">Apply</button>
      </form>
      <div className={styles.projectionTabs}>
        {([
          ["list", LayoutList, "List"],
          ["board", Columns3, "Board"],
          ["timeline", Timeline, "Timeline"],
          ["calendar", CalendarDays, "Calendar"],
        ] as const).map(([kind, Icon, label]) => <button key={kind} type="button" className={projectionKind === kind ? styles.activeTab : ""} onClick={() => setProjectionKind(kind)}><Icon size={15} />{label}</button>)}
      </div>
      {selectedIds.size > 0 && <button className={styles.bulkButton} type="button" onClick={() => void prepareBulkArchive()}><Archive size={15} /> Preview archive ({selectedIds.size})</button>}
    </section>

    <section className={styles.savedViews}>
      <span>Saved views</span>
      {views.map((view) => <button type="button" key={view.id} onClick={() => { setProjectionKind(view.projection); void loadProjection(view.id); }}>{view.name}<small>{view.projection}</small></button>)}
      <form onSubmit={saveView}>
        <input value={viewName} onChange={(event) => setViewName(event.target.value)} placeholder="Save current view" />
        <button type="submit"><Save size={14} /></button>
      </form>
    </section>

    {bulkPreview && <section className={styles.bulkPreview}>
      <div><strong>Bulk {bulkPreview.operation} preview</strong><span>{bulkPreview.impact.accessible_count} accessible · {bulkPreview.impact.blocked_count} blocked · {bulkPreview.impact.unavailable_count} unavailable</span></div>
      {bulkPreview.impact.warnings.map((warning) => <p key={warning}>{warning}</p>)}
      {bulkPreview.state === "prepared" && <button type="button" onClick={() => void (bulkPreview.risk_level === "R2" ? approveBulk() : executeBulk())}>{bulkPreview.risk_level === "R2" ? "Approve and execute" : "Execute"}</button>}
      {bulkPreview.result && <div className={styles.bulkResult}><span>{bulkPreview.result.succeeded.length} succeeded</span><span>{bulkPreview.result.failed.length} failed</span></div>}
    </section>}

    <div className={styles.columns}>
      <aside className={styles.leftPanel}>
        <form className={styles.createIssue} onSubmit={createIssue}>
          <h2><Plus size={17} /> New issue</h2>
          <input value={newTitle} onChange={(event) => setNewTitle(event.target.value)} placeholder="Issue title" required />
          <textarea value={newDescription} onChange={(event) => setNewDescription(event.target.value)} placeholder="Description" rows={4} />
          <select value={newPriority} onChange={(event) => setNewPriority(event.target.value as IssuePriority)}>
            {(["no_priority", "urgent", "high", "medium", "low"] as IssuePriority[]).map((priority) => <option key={priority} value={priority}>{priorityLabel(priority)}</option>)}
          </select>
          <button type="submit" disabled={busy}>Create issue</button>
        </form>
        <div className={styles.portfolio}>
          <h3><Milestone size={16} /> Portfolio</h3>
          <span>{portfolio.milestones.length} milestones</span>
          <span>{portfolio.cycles.length} cycles</span>
          <span>{portfolio.roadmaps.length} roadmaps</span>
          <span>{portfolio.labels.length} labels</span>
        </div>
      </aside>

      <main className={styles.projectionPanel}>
        {projectionKind === "board" ? <div className={styles.board}>
          {(projection?.groups ?? []).map((group) => <section key={group.key}>
            <header><strong>{group.label}</strong><span>{group.issueIds.length}</span></header>
            <div>{group.issueIds.map((issueId) => issuesById.get(issueId)).filter(Boolean).map((issue) => renderIssueCard(issue!))}</div>
          </section>)}
        </div> : projectionKind === "timeline" ? <div className={styles.timelineList}>
          {(projection?.timeline ?? []).map((item) => {
            const issue = issuesById.get(item.issue_id);
            return issue ? <button type="button" key={item.issue_id} onClick={() => setSelectedIssueId(item.issue_id)}><strong>{issue.identifier} · {issue.title}</strong><span>{item.start_on ?? "Unscheduled"}<ChevronRight size={14} />{item.due_on ?? "Open ended"}</span></button> : null;
          })}
        </div> : projectionKind === "calendar" ? <div className={styles.calendarGrid}>
          {(projection?.calendar ?? []).map((day) => <section key={day.date}><header>{day.date}</header>{day.starts.map((id) => <button type="button" key={`start-${id}`} onClick={() => setSelectedIssueId(id)}>Starts · {issuesById.get(id)?.identifier}</button>)}{day.due.map((id) => <button type="button" key={`due-${id}`} onClick={() => setSelectedIssueId(id)}>Due · {issuesById.get(id)?.identifier}</button>)}</section>)}
        </div> : <div className={styles.issueList}>{(projection?.issues ?? []).map(renderIssueCard)}</div>}
        {!projection?.issues.length && <div className={styles.empty}><GitPullRequestArrow size={24} /><h3>No issues in this projection</h3><p>Create an issue or adjust the search and saved-view filters.</p></div>}
      </main>

      <aside className={styles.detailPanel}>
        {selectedIssue ? <>
          <div className={styles.detailTitle}><small>{selectedIssue.identifier}</small><h2>{selectedIssue.title}</h2><span>{selectedIssue.status.name} · r{selectedIssue.revision}</span></div>
          <p className={styles.description}>{selectedIssue.plain_text || "No description yet."}</p>
          <div className={styles.detailGrid}>
            <span><Flag size={14} />{priorityLabel(selectedIssue.priority)}</span>
            <span><Route size={14} />{selectedIssue.dependencies.length} relationships</span>
            <span><Milestone size={14} />{selectedIssue.milestone_id ? "Milestone assigned" : "No milestone"}</span>
            <span><CalendarDays size={14} />{selectedIssue.due_on ?? "No due date"}</span>
          </div>
          <section className={styles.transitions}>
            <h3>Workflow transitions</h3>
            {availableTransitions.length ? availableTransitions.map((transitionItem) => <button type="button" key={transitionItem.id} onClick={() => void transition(transitionItem.to_status_id)} disabled={busy}>{transitionItem.name}<ChevronRight size={14} /></button>) : <p>No transitions available.</p>}
          </section>
          <section className={styles.comments}>
            <h3><MessageSquare size={15} /> Comments</h3>
            {comments.map((item) => <article key={item.id}><strong>{item.author_display_name}</strong><p>{item.plain_text}</p><small>{new Date(item.created_at).toLocaleString()}</small></article>)}
            <form onSubmit={addComment}><textarea value={comment} onChange={(event) => setComment(event.target.value)} placeholder="Add a comment" rows={3} /><button type="submit"><Send size={14} /> Send</button></form>
          </section>
          <section className={styles.attachments}>
            <h3><Paperclip size={15} /> Attachments</h3>
            {attachments.map((attachment) => <a key={attachment.id} href={`/api/v1/issue-attachments/${attachment.id}/content?${scope}`}><span>{attachment.file_name}</span><small>{Math.ceil(attachment.size_bytes / 1024)} KB · {attachment.storage_state}</small></a>)}
            <label><Upload size={14} /> Upload<input type="file" onChange={(event) => void uploadAttachment(event.target.files?.[0])} /></label>
          </section>
        </> : <div className={styles.emptyDetail}><CheckCircle2 size={25} /><h3>Select an issue</h3><p>Inspect workflow state, dates, relationships, comments, and attachments.</p></div>}
      </aside>
    </div>
  </div>;
}
