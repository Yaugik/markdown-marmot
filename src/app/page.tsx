import Link from "next/link";
import { ArrowRight, GitBranch, Layers3, MoreHorizontal, RefreshCw, ShieldCheck } from "lucide-react";
import { SearchBox } from "@/components/search-box";
import { DocumentCard } from "@/components/document-card";
import { AddRepository, SyncButton } from "@/components/repository-actions";
import { getDashboardData } from "@/services/queries";

export const dynamic = "force-dynamic";

export default function Home() {
  const data = getDashboardData();
  return <>
    <header className="topbar"><SearchBox /><AddRepository /></header>
    <div className="page dashboard-page">
      <section className="hero">
        <div>
          <span className="eyebrow">Your knowledge, in one place</span>
          <h1>Good morning, Prateek.</h1>
          <p>Your workspace is calm and up to date. Pick up where you left off, or find something new.</p>
        </div>
        <div className="hero-signal"><span className="signal-dot" /><div><strong>{data.stats.indexed_count} documents indexed</strong><small>Local search is ready</small></div></div>
      </section>

      <section className="stat-strip" aria-label="Workspace overview">
        <div><span className="stat-icon violet"><Layers3 size={18} /></span><p><strong>{data.stats.documents}</strong><small>Available notes</small></p></div>
        <div><span className="stat-icon mint"><GitBranch size={18} /></span><p><strong>{data.stats.repositories}</strong><small>Git repositories</small></p></div>
        <div><span className="stat-icon amber"><RefreshCw size={18} /></span><p><strong>{data.repositories.filter((r) => r.sync_status === "succeeded").length}</strong><small>Healthy sources</small></p></div>
        <div><span className="stat-icon blue"><ShieldCheck size={18} /></span><p><strong>Local</strong><small>Private by default</small></p></div>
      </section>

      <section className="section-block">
        <div className="section-heading"><div><span className="eyebrow">Continue exploring</span><h2>Recently synchronized</h2></div><Link href="/documents">View all <ArrowRight size={15} /></Link></div>
        {data.documents.length ? <div className="document-grid">{data.documents.slice(0, 6).map((document) => <DocumentCard document={document} key={document.id} />)}</div> : <div className="empty-state"><RefreshCw size={22} /><h3>Your first sync is on its way</h3><p>The worker is indexing the demo notes. Refresh in a moment.</p></div>}
      </section>

      <div className="lower-grid">
        <section className="panel">
          <div className="section-heading compact"><div><span className="eyebrow">Sources</span><h2>Repositories</h2></div><Link href="/repositories">Manage</Link></div>
          <div className="repo-list">{data.repositories.map((repository) => <div className="repo-row" key={repository.id}>
            <span className="repo-mark"><GitBranch size={17} /></span>
            <div className="repo-name"><strong>{repository.display_name}</strong><small>{repository.default_branch} · {repository.document_count} notes</small></div>
            <span className={`status ${repository.sync_status === "succeeded" ? "healthy" : "waiting"}`}><i />{repository.sync_status === "succeeded" ? "Synced" : "Queued"}</span>
            <SyncButton sourceId={repository.source_id} />
          </div>)}</div>
        </section>
        <section className="panel activity-panel">
          <div className="section-heading compact"><div><span className="eyebrow">Observable by design</span><h2>Activity</h2></div><button className="ghost-icon"><MoreHorizontal size={19} /></button></div>
          {data.activity.length ? <div className="timeline">{data.activity.map((event) => <div key={event.id}><span /><p><strong>{event.summary}</strong><small>{new Date(event.created_at).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}</small></p></div>)}</div> : <p className="quiet-copy">Sync activity will appear here.</p>}
        </section>
      </div>
    </div>
  </>;
}
