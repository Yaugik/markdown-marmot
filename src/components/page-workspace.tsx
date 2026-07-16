"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Archive,
  FilePlus2,
  FileText,
  Folder,
  GitBranch,
  Link2,
  MessageSquare,
  Paperclip,
  RefreshCw,
  Search,
  Send,
  Upload,
} from "lucide-react";
import styles from "@/app/pages/pages.module.css";

type NativePage = {
  id: string;
  title: string;
  status: "active" | "archived" | "unavailable";
  revision: number;
  current_revision: { id: string; sequence: number; plain_text: string; content: Record<string, unknown> };
};
type TreeNode = {
  id: string;
  parent_node_id: string | null;
  node_kind: "folder" | "page" | "alias";
  page_id: string | null;
  rank: number;
  display_title: string | null;
  archived_at: string | null;
};
type SearchResult = {
  pageId: string;
  sourceType: "git" | "native";
  title: string;
  snippet: string;
  score: number;
  status: string;
};
type CommentThread = {
  id: string;
  anchorState: "current" | "moved" | "stale";
  status: "open" | "resolved";
  revision: number;
  comments: Array<{ id: string; plainText: string; authorPrincipalId: string; createdAt: string }>;
};
type PageLink = {
  id: string;
  sourcePageId: string;
  targetPageId: string | null;
  externalUrl: string | null;
  label: string | null;
  state: string;
};
type Attachment = {
  id: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  storageState: string;
  scanState: string;
};
type Envelope<T> = { data: T; error?: { message?: string } };

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...init });
  const payload = await response.json().catch(() => ({})) as Envelope<T>;
  if (!response.ok) {
    const message = (payload as { error?: { message?: string } }).error?.message ?? `Request failed (${response.status})`;
    throw new Error(message);
  }
  return payload.data;
}

function idempotencyKey(prefix: string) {
  return `${prefix}-${crypto.randomUUID()}`;
}

export function PageWorkspace({ workspaceId, projectId }: { workspaceId?: string; projectId?: string }) {
  const [pages, setPages] = useState<NativePage[]>([]);
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [selectedPageId, setSelectedPageId] = useState<string | null>(null);
  const [selectedPage, setSelectedPage] = useState<NativePage | null>(null);
  const [comments, setComments] = useState<CommentThread[]>([]);
  const [backlinks, setBacklinks] = useState<PageLink[]>([]);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [newTitle, setNewTitle] = useState("");
  const [newBody, setNewBody] = useState("");
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const scope = useMemo(() => workspaceId && projectId
    ? `workspace_id=${encodeURIComponent(workspaceId)}&project_id=${encodeURIComponent(projectId)}`
    : null, [workspaceId, projectId]);

  const loadWorkspace = useCallback(async () => {
    if (!scope) return;
    setBusy(true);
    setError(null);
    try {
      const [pageData, treeData] = await Promise.all([
        api<NativePage[]>(`/api/v1/pages?${scope}`),
        api<TreeNode[]>(`/api/v1/page-tree?${scope}`),
      ]);
      setPages(pageData);
      setTree(treeData);
      if (!selectedPageId && pageData[0]) setSelectedPageId(pageData[0].id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load pages");
    } finally {
      setBusy(false);
    }
  }, [scope, selectedPageId]);

  const loadSelected = useCallback(async () => {
    if (!scope || !selectedPageId) {
      setSelectedPage(null);
      return;
    }
    try {
      const [page, threadData, backlinkData, attachmentData] = await Promise.all([
        api<NativePage>(`/api/v1/pages/${selectedPageId}?${scope}`),
        api<CommentThread[]>(`/api/v1/pages/${selectedPageId}/comments?${scope}&include_resolved=true`),
        api<PageLink[]>(`/api/v1/pages/${selectedPageId}/backlinks?${scope}`),
        api<Attachment[]>(`/api/v1/pages/${selectedPageId}/attachments?${scope}`),
      ]);
      setSelectedPage(page);
      setComments(threadData);
      setBacklinks(backlinkData);
      setAttachments(attachmentData);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load page details");
    }
  }, [scope, selectedPageId]);

  useEffect(() => { void loadWorkspace(); }, [loadWorkspace]);
  useEffect(() => { void loadSelected(); }, [loadSelected]);

  async function createPage(event: React.FormEvent) {
    event.preventDefault();
    if (!scope || !workspaceId || !projectId || !newTitle.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api<{ page: NativePage }>("/api/v1/pages", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": idempotencyKey("page") },
        body: JSON.stringify({
          workspace_id: workspaceId,
          project_id: projectId,
          title: newTitle,
          content: {
            type: "doc",
            content: [{ type: "paragraph", content: newBody ? [{ type: "text", text: newBody }] : [] }],
          },
        }),
      });
      setNewTitle("");
      setNewBody("");
      setSelectedPageId(result.page.id);
      await loadWorkspace();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not create page");
    } finally {
      setBusy(false);
    }
  }

  async function runSearch(event: React.FormEvent) {
    event.preventDefault();
    if (!scope || !searchQuery.trim()) return;
    setError(null);
    try {
      setSearchResults(await api<SearchResult[]>(`/api/v1/page-search?${scope}&q=${encodeURIComponent(searchQuery)}`));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Search failed");
    }
  }

  async function addComment(event: React.FormEvent) {
    event.preventDefault();
    if (!workspaceId || !projectId || !selectedPage || !comment.trim()) return;
    try {
      await api(`/api/v1/pages/${selectedPage.id}/comments`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": idempotencyKey("comment") },
        body: JSON.stringify({
          workspace_id: workspaceId,
          project_id: projectId,
          page_revision_id: selectedPage.current_revision.id,
          anchor: {},
          body: { text: comment },
        }),
      });
      setComment("");
      await loadSelected();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not add comment");
    }
  }

  async function uploadAttachment(file: File | undefined) {
    if (!file || !workspaceId || !projectId || !selectedPage || !scope) return;
    setBusy(true);
    setError(null);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)))
        .map((value) => value.toString(16).padStart(2, "0")).join("");
      const prepared = await api<{ attachment: Attachment; upload_path: string }>(`/api/v1/pages/${selectedPage.id}/attachments`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": idempotencyKey("attachment") },
        body: JSON.stringify({
          workspace_id: workspaceId,
          project_id: projectId,
          file_name: file.name,
          mime_type: file.type || "application/octet-stream",
          size_bytes: bytes.byteLength,
          sha256: hash,
        }),
      });
      await api(`${prepared.upload_path}?${scope}`, {
        method: "PUT",
        headers: { "content-length": String(bytes.byteLength), "content-type": file.type || "application/octet-stream" },
        body: bytes,
      });
      await loadSelected();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not upload attachment");
    } finally {
      setBusy(false);
    }
  }

  if (!workspaceId || !projectId) {
    return <div className={styles.setup}>
      <span className={styles.eyebrow}>Phase 2 page workspace</span>
      <h1>Choose a cloud project</h1>
      <p>Open this screen with <code>?workspace_id=&lt;uuid&gt;&amp;project_id=&lt;uuid&gt;</code> to use native pages, unified search, comments, backlinks, and attachments.</p>
      <form onSubmit={(event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        window.location.href = `/pages?workspace_id=${encodeURIComponent(String(form.get("workspace")))}&project_id=${encodeURIComponent(String(form.get("project")))}`;
      }}>
        <input name="workspace" placeholder="Workspace UUID" required />
        <input name="project" placeholder="Project UUID" required />
        <button type="submit">Open project</button>
      </form>
    </div>;
  }

  const pagesById = new Map(pages.map((page) => [page.id, page]));
  const rootNodes = tree.filter((node) => node.parent_node_id === null);
  const renderTree = (nodes: TreeNode[], depth = 0): React.ReactNode => nodes.map((node) => {
    const page = node.page_id ? pagesById.get(node.page_id) : undefined;
    const label = node.display_title || page?.title || (node.node_kind === "folder" ? "Folder" : "Page");
    const children = tree.filter((child) => child.parent_node_id === node.id);
    return <div key={node.id}>
      <button
        className={`${styles.treeRow} ${node.page_id === selectedPageId ? styles.selected : ""}`}
        style={{ paddingLeft: 10 + depth * 18 }}
        onClick={() => node.page_id && setSelectedPageId(node.page_id)}
        type="button"
      >
        {node.node_kind === "folder" ? <Folder size={15} /> : node.node_kind === "alias" ? <Link2 size={15} /> : <FileText size={15} />}
        <span>{label}</span>
        {page && <em>Native</em>}
      </button>
      {children.length > 0 && renderTree(children, depth + 1)}
    </div>;
  });

  return <div className={styles.workspace}>
    <header className={styles.header}>
      <div><span className={styles.eyebrow}>Project pages</span><h1>Knowledge workspace</h1></div>
      <button className={styles.iconButton} type="button" onClick={() => void loadWorkspace()} disabled={busy}><RefreshCw size={17} /> Refresh</button>
    </header>
    {error && <div className={styles.error}>{error}</div>}
    <form className={styles.search} onSubmit={runSearch}>
      <Search size={18} />
      <input value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} placeholder="Search native and Git-backed pages" />
      <button type="submit">Search</button>
    </form>
    {searchResults.length > 0 && <section className={styles.results}>
      {searchResults.map((result) => <button key={result.pageId} type="button" onClick={() => result.sourceType === "native" && setSelectedPageId(result.pageId)}>
        <span className={`${styles.badge} ${result.sourceType === "git" ? styles.git : styles.native}`}>
          {result.sourceType === "git" ? <GitBranch size={13} /> : <FileText size={13} />}{result.sourceType}
        </span>
        <strong>{result.title}</strong>
        <span dangerouslySetInnerHTML={{ __html: result.snippet }} />
      </button>)}
    </section>}
    <div className={styles.columns}>
      <aside className={styles.treePanel}>
        <div className={styles.panelTitle}><span>Page tree</span><small>{pages.length} native</small></div>
        <div className={styles.tree}>{rootNodes.length ? renderTree(rootNodes) : <p>No pages yet.</p>}</div>
        <form className={styles.create} onSubmit={createPage}>
          <h3><FilePlus2 size={16} /> New native page</h3>
          <input value={newTitle} onChange={(event) => setNewTitle(event.target.value)} placeholder="Page title" required />
          <textarea value={newBody} onChange={(event) => setNewBody(event.target.value)} placeholder="Start writing…" rows={4} />
          <button type="submit" disabled={busy}>Create page</button>
        </form>
      </aside>
      <main className={styles.pagePanel}>
        {selectedPage ? <>
          <div className={styles.pageTitle}>
            <div><span className={`${styles.badge} ${styles.native}`}><FileText size={13} />Native</span><h2>{selectedPage.title}</h2></div>
            <span className={styles.revision}>r{selectedPage.revision} · content {selectedPage.current_revision.sequence}</span>
          </div>
          <article className={styles.content}>{selectedPage.current_revision.plain_text || <em>Empty page</em>}</article>
          <div className={styles.metaGrid}>
            <div><Link2 size={16} /><strong>{backlinks.length}</strong><span>Backlinks</span></div>
            <div><MessageSquare size={16} /><strong>{comments.length}</strong><span>Threads</span></div>
            <div><Paperclip size={16} /><strong>{attachments.length}</strong><span>Attachments</span></div>
            <div><Archive size={16} /><strong>{selectedPage.status}</strong><span>Status</span></div>
          </div>
          <section className={styles.section}>
            <h3>Comments</h3>
            {comments.map((thread) => <div className={styles.thread} key={thread.id}>
              <span className={`${styles.anchor} ${styles[thread.anchorState]}`}>{thread.anchorState}</span>
              {thread.comments.map((item) => <p key={item.id}>{item.plainText}<small>{new Date(item.createdAt).toLocaleString()}</small></p>)}
            </div>)}
            <form className={styles.commentForm} onSubmit={addComment}>
              <input value={comment} onChange={(event) => setComment(event.target.value)} placeholder="Add a comment" />
              <button type="submit" aria-label="Send comment"><Send size={16} /></button>
            </form>
          </section>
          <section className={styles.section}>
            <div className={styles.sectionHeader}><h3>Attachments</h3><label><Upload size={15} /> Upload<input type="file" onChange={(event) => void uploadAttachment(event.target.files?.[0])} /></label></div>
            {attachments.map((attachment) => <a key={attachment.id} href={`/api/v1/attachments/${attachment.id}/content?${scope}`}>
              <Paperclip size={15} /><span>{attachment.fileName}</span><small>{Math.ceil(attachment.sizeBytes / 1024)} KB</small>
            </a>)}
          </section>
        </> : <div className={styles.empty}><FileText size={32} /><h2>Select a page</h2><p>Choose a page from the project tree or create a native page.</p></div>}
      </main>
      <aside className={styles.sidePanel}>
        <div className={styles.panelTitle}><span>Backlinks</span><small>{backlinks.length}</small></div>
        {backlinks.length ? backlinks.map((link) => <button key={link.id} type="button" onClick={() => setSelectedPageId(link.sourcePageId)}>
          <Link2 size={15} /><span>{pagesById.get(link.sourcePageId)?.title || link.label || "Linked page"}</span>
        </button>) : <p>No pages link here yet.</p>}
      </aside>
    </div>
  </div>;
}
