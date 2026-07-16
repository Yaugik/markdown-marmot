import { SearchBox } from "@/components/search-box";
import { DocumentCard } from "@/components/document-card";
import { searchDocuments } from "@/services/queries";

export const dynamic = "force-dynamic";

export default async function SearchPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const { q = "" } = await searchParams;
  const results = searchDocuments(q);
  return <>
    <header className="topbar search-topbar"><SearchBox defaultValue={q} /></header>
    <div className="page list-page">
      <div className="page-title"><span className="eyebrow">Full-text search</span><h1>{q ? `Results for “${q}”` : "Find anything"}</h1><p>{q ? `${results.length} matching documents, ranked across titles, paths, headings, and body.` : "Search across every synchronized Markdown document."}</p></div>
      {results.length ? <div className="document-grid wide">{results.map((document) => <DocumentCard document={document} key={document.id} />)}</div> : q ? <div className="empty-state"><h3>No matches yet</h3><p>Try a broader term or a source path.</p></div> : null}
    </div>
  </>;
}
