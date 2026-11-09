"use client";
/**
 * Loads the WebGL explorer in the browser only (deck.gl / MapLibre / workers cannot render on
 * the server). The splash matches the explorer's first frame so the swap is seamless.
 */
import dynamic from "next/dynamic";

function ExploreSplash() {
  return (
    <div className="fixed inset-0 grid place-items-center bg-bg" role="status" aria-live="polite">
      <div className="flex flex-col items-center gap-4">
        <span aria-hidden="true" className="relative block size-10">
          <span className="absolute inset-0 rounded-full border border-hairline-strong" />
          <span className="absolute inset-0 animate-[ring-spin_900ms_linear_infinite] rounded-full border-2 border-transparent border-t-brand-c" />
        </span>
        <p className="text-sm text-ink-muted">Loading the heat atlas…</p>
      </div>
    </div>
  );
}

const ExploreApp = dynamic(() => import("../../src/ExploreApp.jsx"), { ssr: false, loading: ExploreSplash });

export default function ExploreLoader() {
  return <ExploreApp />;
}
