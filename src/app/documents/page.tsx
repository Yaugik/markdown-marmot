import { SearchBox } from "@/components/search-box";
import { DocumentCard } from "@/components/document-card";
import { getDashboardData } from "@/services/queries";

export const dynamic = "force-dynamic";

export default function DocumentsPage() {
  const { documents, stats } = getDashboardData();
  return <>
    <header className="topbar"><SearchBox /></header>
    <div className="page list-page">
      <div className="page-title"><span className="eyebrow">Library</span><h1>All documents</h1><p>{stats.documents} committed Markdown files across your connected repositories.</p></div>
      <div className="document-grid wide">{documents.map((document) => <DocumentCard document={document} key={document.id} />)}</div>
    </div>
  </>;
}
