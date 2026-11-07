/**
 * Screen-reader live regions (UI_SPEC §12). Messages arrive through `announce()` in
 * announcer.js (debounced 500 ms, suppressed during playback). Two visually hidden regions:
 * polite (state changes, scenario results) and assertive (errors only).
 */
import { useAnnouncerStore } from "./announcer.js";

export function LiveAnnouncer() {
  const polite = useAnnouncerStore((s) => s.polite);
  const assertive = useAnnouncerStore((s) => s.assertive);
  return (
    <>
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true" data-testid="live-polite">
        {polite}
      </div>
      <div className="sr-only" role="alert" aria-live="assertive" aria-atomic="true" data-testid="live-assertive">
        {assertive}
      </div>
    </>
  );
}

export default LiveAnnouncer;
