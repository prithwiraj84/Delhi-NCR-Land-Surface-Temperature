import { forwardRef } from "react";
import * as TabsPrimitive from "@radix-ui/react-tabs";
import { cn } from "../../lib/cn.js";

/** Radix tabs (roving focus, arrow-key navigation, correct ARIA roles). */
export const Tabs = TabsPrimitive.Root;

export const TabsList = forwardRef(function TabsList({ className, ...props }, ref) {
  return (
    <TabsPrimitive.List
      ref={ref}
      className={cn(
        "inline-flex items-center gap-1 rounded-xl border border-panel-border bg-bg-raised/70 p-1 backdrop-blur",
        className,
      )}
      {...props}
    />
  );
});

export const TabsTrigger = forwardRef(function TabsTrigger({ className, ...props }, ref) {
  return (
    <TabsPrimitive.Trigger
      ref={ref}
      className={cn(
        "focus-ring inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-lg px-3 py-1.5",
        "text-xs font-medium text-ink-muted transition-colors duration-150 hover:text-ink",
        "disabled:pointer-events-none disabled:opacity-45 [&_svg]:size-3.5",
        "data-[state=active]:bg-cyan/15 data-[state=active]:text-cyan-soft data-[state=active]:shadow-[inset_0_0_0_1px_rgba(34,211,238,0.35)]",
        className,
      )}
      {...props}
    />
  );
});

export const TabsContent = forwardRef(function TabsContent({ className, ...props }, ref) {
  return (
    <TabsPrimitive.Content
      ref={ref}
      className={cn("focus-ring mt-3 rounded-lg data-[state=inactive]:hidden", className)}
      {...props}
    />
  );
});
