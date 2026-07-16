import Link from "next/link";

export default function NotFound() {
  return <div className="not-found"><span className="eyebrow">404</span><h1>That page drifted away.</h1><p>The source may have moved, or this link is no longer available.</p><Link href="/" className="primary-button">Return home</Link></div>;
}
