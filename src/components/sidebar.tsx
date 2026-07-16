"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  BookOpen,
  Boxes,
  CalendarDays,
  CircleCheck,
  FileText,
  Files,
  FolderGit2,
  Home,
  Search,
  Settings2,
  Sparkles,
} from "lucide-react";

const items = [
  { href: "/", label: "Home", icon: Home },
  { href: "/search", label: "Search", icon: Search },
  { href: "/pages", label: "Pages", icon: Files },
  { href: "/issues", label: "Issues", icon: CircleCheck },
  { href: "/repositories", label: "Repositories", icon: FolderGit2 },
  { href: "/documents", label: "All documents", icon: FileText },
];

export function Sidebar() {
  const pathname = usePathname();
  return (
    <aside className="sidebar">
      <Link className="brand" href="/" aria-label="Folio home">
        <span className="brand-mark"><BookOpen size={19} strokeWidth={2.2} /></span>
        <span>Folio</span>
      </Link>
      <nav className="primary-nav" aria-label="Workspace">
        <p className="nav-label">Workspace</p>
        {items.map(({ href, label, icon: Icon }) => (
          <Link className={`nav-item ${pathname === href ? "active" : ""}`} href={href} key={href}>
            <Icon size={17} /><span>{label}</span>
          </Link>
        ))}
        <p className="nav-label nav-spacer">Organize</p>
        <span className="nav-item muted"><Boxes size={17} /><span>Collections</span><em>Soon</em></span>
        <span className="nav-item muted"><CalendarDays size={17} /><span>Daily view</span><em>Soon</em></span>
      </nav>
      <div className="sidebar-bottom">
        <div className="agent-card">
          <Sparkles size={16} />
          <div><strong>Agent-ready</strong><span>Bounded tools, coming next</span></div>
        </div>
        <button className="profile-row" type="button">
          <span className="avatar">PG</span><span><strong>Personal workspace</strong><small>Local only</small></span><Settings2 size={16} />
        </button>
      </div>
    </aside>
  );
}
