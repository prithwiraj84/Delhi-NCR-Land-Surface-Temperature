import { DatabaseZap, FolderInput, Terminal } from "lucide-react";
import { cn } from "../../lib/cn.js";
import { getDataBaseUrl } from "../../lib/data.js";
import { Button } from "../ui/Button.jsx";

/**
 * Generic empty state: icon, title, explanation and optional actions / extra content.
 * @param {{title: React.ReactNode, description?: React.ReactNode, icon?: React.ComponentType,
 *          actions?: React.ReactNode, compact?: boolean, className?: string}} props
 */
export function EmptyState({ title, description, icon: Icon = DatabaseZap, actions, compact = false, children, className }) {
  return (
    <div
      role="status"
      className={cn(
        "flex w-full flex-col items-center justify-center text-center",
        compact ? "gap-2 p-6" : "gap-4 px-6 py-14",
        className,
      )}
    >
      <div className="grid size-12 place-items-center rounded-2xl border border-cyan/30 bg-cyan/10 text-cyan shadow-glow-cyan">
        <Icon aria-hidden="true" className="size-6" />
      </div>
      <div className="max-w-xl">
        <h2 className={cn("font-display font-semibold text-ink-strong", compact ? "text-base" : "text-xl")}>{title}</h2>
        {description && <p className="mt-2 text-sm leading-relaxed text-ink-muted">{description}</p>}
      </div>
      {children}
      {actions && <div className="flex flex-wrap items-center justify-center gap-2">{actions}</div>}
    </div>
  );
}

const STEPS = [
  {
    icon: Terminal,
    title: "Run the pipeline",
    body: (
      <>
        Execute <code>delhi_ncr_lst_pipeline.ipynb</code> on Kaggle (2× T4) or locally with{" "}
        <code>python notebook/run_local.py</code> (synthetic mode works offline).
      </>
    ),
  },
  {
    icon: FolderInput,
    title: "Install the web bundle",
    body: (
      <>
        Copy <code>outputs/web/*</code> (or unzip <code>web_bundle.zip</code>) into <code>dashboard/public/data/</code>,
        or point <code>VITE_DATA_BASE_URL</code> at a hosted copy.
      </>
    ),
  },
];

/** Instructive state shown when manifest.json is missing (SPEC §5). */
export function MissingBundleState({ onRetry }) {
  const manifestUrl = `${getDataBaseUrl()}/manifest.json`;
  return (
    <EmptyState
      title="No thermal data bundle installed yet"
      description={
        <>
          The dashboard looked for <code className="text-cyan-soft">{manifestUrl}</code> and did not find it. It renders the
          web bundle exported by the notebook: per-epoch LST grids with TreeSHAP attributions, the compact XGBoost
          surrogate, thresholds, governance zones and validation metrics.
        </>
      }
      actions={
        onRetry && (
          <Button variant="primary" onClick={onRetry}>
            Check again
          </Button>
        )
      }
    >
      <ol className="grid w-full max-w-2xl gap-3 text-left sm:grid-cols-2">
        {STEPS.map(({ icon: Icon, title, body }, i) => (
          <li key={title} className="glass rounded-xl border p-4">
            <p className="mb-1.5 flex items-center gap-2 font-display text-sm font-semibold text-ink-strong">
              <span className="grid size-6 place-items-center rounded-md bg-violet/15 font-mono text-xs text-violet-soft">
                {i + 1}
              </span>
              <Icon aria-hidden="true" className="size-4 text-violet" />
              {title}
            </p>
            <p className="prose-code text-sm leading-relaxed text-ink-muted">{body}</p>
          </li>
        ))}
      </ol>
    </EmptyState>
  );
}
