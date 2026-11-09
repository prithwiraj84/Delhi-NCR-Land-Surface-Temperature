import Link from "next/link";
import { BrandGlyph } from "../src/design/glyphs.jsx";

export const metadata = { title: "Page not found", robots: { index: false } };

/** 404: on brand, with the two most useful ways out. */
export default function NotFound() {
  return (
    <main className="grid min-h-dvh place-items-center px-5">
      <div className="text-center">
        <BrandGlyph size={44} className="mx-auto" />
        <p className="mt-8 font-mono text-[13px] text-ink-faint">404</p>
        <h1 className="mt-2 font-display text-[36px] font-semibold tracking-[-0.03em] text-ink-strong">This cell is outside the map</h1>
        <p className="mx-auto mt-3 max-w-md text-[16px] leading-relaxed text-ink-muted">The page you were looking for does not exist. The atlas and the explorer are one click away.</p>
        <div className="mt-8 flex flex-wrap justify-center gap-3">
          <Link href="/" className="btn btn-primary">
            Back to the atlas
          </Link>
          <Link href="/explore" className="btn btn-secondary">
            Open the explorer
          </Link>
        </div>
      </div>
    </main>
  );
}
