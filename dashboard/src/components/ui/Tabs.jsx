import { forwardRef } from "react";
import * as TabsPrimitive from "@radix-ui/react-tabs";
import { cn } from "../../lib/cn.js";

/** Radix tabs (roving focus, arrow-key navigation, correct ARIA roles). */
export const Tabs = TabsPrimitive.Root;

export const TabsList = forwardRef(function TabsList({ className, ...props }, ref) {
  return (
    <TabsPrimitive.List
      ref={ref}
      className={cn("inline-flex items-center gap-1 rounded-md border border-hairline bg-surface-2 p-1", className)}
      {...props}
    />
  );
});

/** Active tab = signal underline bar + ink-strong text (state never by tint alone). */
export const TabsTrigger = forwardRef(function TabsTrigger({ className, ...props }, ref) {
  return (
    <TabsPrimitive.Trigger
      ref={ref}
      className={cn(
        "focus-ring relative inline-flex min-h-7 items-center justify-center gap-1.5 whitespace-nowrap rounded px-3 py-1.5",
        "text-xs font-medium text-ink-muted transition-colors duration-instant hover:text-ink",
        "disabled:pointer-events-none disabled:opacity-45 [&_svg]:size-3.5",
        "data-[state=active]:bg-surface-3 data-[state=active]:text-ink-strong",
        "data-[state=active]:shadow-[inset_0_-2px_0_0_var(--signal)]",
        className,
      )}
      {...props}
    />
  );
});

export const TabsContent = forwardRef(function TabsContent({ className, ...props }, ref) {
  return <TabsPrimitive.Content ref={ref} className={cn("focus-ring mt-3 rounded-md data-[state=inactive]:hidden", className)} {...props} />;
});
