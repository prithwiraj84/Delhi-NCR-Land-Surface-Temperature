/**
 * DOWNLOADS & CITATION (UI_SPEC §3.9): every file the manifest declares, linked from the
 * active bundle source (the in-memory fixture has nothing on disk and says so), plus a
 * copyable citation. Files are listed by their manifest key so a reader can map a panel to
 * the file behind it.
 */
import { useState } from "react";
import { Check, Copy, Download } from "lucide-react";
import { HudFrame } from "../../components/ui/HudFrame.jsx";
import { Button } from "../../components/ui/Button.jsx";
import { bundleFileUrl } from "../../data/bundle.js";
import { citationText, bundleFiles } from "./sourcesModel.js";

export function Downloads({ manifest, source }) {
  const [copied, setCopied] = useState(false);
  const files = bundleFiles(manifest);
  const inMemory = !source?.baseUrl || source?.id === "fixture";
  const cite = citationText(manifest);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(cite);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };
  return (
    <HudFrame solid title="Downloads & citation" className="min-w-0">
      {inMemory ? (
        <p className="mb-2 text-xs text-ink-muted">The in-memory synthetic fixture has no files on disk. Switch the bundle source to “data” or “demo” in Settings to download files.</p>
      ) : (
        <p className="mb-2 text-xs text-ink-muted">
          Files of the active bundle (<span className="font-mono">{source?.baseUrl}</span>). Binary cubes use the LSTB container (SPEC §5.1).
        </p>
      )}
      <ul className="scrollbar-thin grid max-h-[260px] gap-x-4 gap-y-0.5 overflow-auto text-xs sm:grid-cols-2">
        {files.map((f) => (
          <li key={f.file} className="flex min-w-0 items-center gap-1.5">
            <Download aria-hidden="true" className="size-3 shrink-0 text-ink-faint" />
            {inMemory ? (
              <span className="truncate font-mono text-ink-muted">{f.file}</span>
            ) : (
              <a href={bundleFileUrl(source.baseUrl, f.file)} download className="focus-ring truncate rounded font-mono text-ink hover:text-signal">
                {f.file}
              </a>
            )}
            <span className="truncate text-[10.5px] text-ink-faint">{f.key}</span>
          </li>
        ))}
      </ul>
      <div className="mt-3 space-y-1.5">
        <p className="micro-label">Cite</p>
        <p className="rounded-md border border-hairline bg-surface-3/40 p-2 text-xs leading-relaxed text-ink">{cite}</p>
        <Button size="xs" variant="secondary" onClick={copy} aria-live="polite">
          {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
          {copied ? "Copied" : "Copy citation"}
        </Button>
      </div>
    </HudFrame>
  );
}

export default Downloads;
