/**
 * Content-page chrome: sticky header, main landmark, footer. The explorer (/explore) sits
 * outside this route group and has its own full-screen shell.
 */
import { SiteFooter } from "../_components/SiteFooter.jsx";
import { SiteHeader } from "../_components/SiteHeader.jsx";
import { getFacts } from "../../lib/site/facts.js";

export default function SiteLayout({ children }) {
  const facts = getFacts();
  return (
    <div className="relative min-h-dvh overflow-x-clip">
      <SiteHeader />
      <main id="main" tabIndex={-1} className="outline-none">
        {children}
      </main>
      <SiteFooter generatedAt={facts.generatedAt} />
    </div>
  );
}
