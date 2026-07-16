import { Search } from "lucide-react";

export function SearchBox({ defaultValue = "" }: { defaultValue?: string }) {
  return (
    <form className="search-box" action="/search">
      <button type="submit" aria-label="Submit search"><Search size={18} /></button>
      <input name="q" defaultValue={defaultValue} placeholder="Search every note, heading, and path…" aria-label="Search documents" />
      <kbd>⌘ K</kbd>
    </form>
  );
}
