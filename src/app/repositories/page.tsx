import { FolderGit2, GitBranch } from "lucide-react";
import { AddRepository, SyncButton } from "@/components/repository-actions";
import { SearchBox } from "@/components/search-box";
import { getDashboardData } from "@/services/queries";

export const dynamic = "force-dynamic";

export default function RepositoriesPage() {
  const { repositories } = getDashboardData();
  return <>
    <header className="topbar"><SearchBox /><AddRepository /></header>
    <div className="page list-page">
      <div className="page-title"><span className="eyebrow">Sources</span><h1>Repositories</h1><p>Committed Markdown flows into Folio. Your working trees remain untouched.</p></div>
      <div className="repository-grid">{repositories.map((repository) => <article className="repository-card" key={repository.id}>
        <div className="repository-card-head"><span className="repo-mark large"><FolderGit2 size={22} /></span><SyncButton sourceId={repository.source_id} /></div>
        <h2>{repository.display_name}</h2>
        <code className="path-pill">{repository.location}</code>
        <div className="repository-meta"><span><GitBranch size={15} /> {repository.default_branch}</span><span>{repository.document_count} documents</span></div>
        <footer><span className={`status ${repository.sync_status === "succeeded" ? "healthy" : "waiting"}`}><i />{repository.sync_status ?? "Queued"}</span><time>{repository.last_successful_sync_at ? new Date(repository.last_successful_sync_at).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" }) : "Waiting for first sync"}</time></footer>
      </article>)}</div>
    </div>
  </>;
}
