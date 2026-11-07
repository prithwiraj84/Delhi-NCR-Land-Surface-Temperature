/**
 * NCR THERMAL/OPS v2 root component. The v2 shell is the default app (no ?v2 flag).
 * Providers that are app-wide but not data: the Radix tooltip provider (shared delays).
 * Data (DataProvider) and the top-level ErrorBoundary are mounted in main.jsx.
 */
import { TooltipProvider } from "./components/ui/InfoTip.jsx";
import { AppShell } from "./shell/AppShell.jsx";

export default function App() {
  return (
    <TooltipProvider delayDuration={200} skipDelayDuration={300}>
      <AppShell />
    </TooltipProvider>
  );
}
