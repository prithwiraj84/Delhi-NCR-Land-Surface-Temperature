"use client";
/**
 * Sticky site header: brand, primary navigation, "Open explorer" call to action, and a mobile
 * menu. The bar gains a hairline and a blurred backdrop once the page scrolls (state, not
 * scroll-linked animation). The mobile panel is the only animated element: it opens 200 ms
 * ease-out from the top edge it is attached to, and closes faster (150 ms).
 */
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { ArrowUpRight, Menu, X } from "lucide-react";
import { BrandGlyph } from "../../src/design/glyphs.jsx";
import { NAV } from "../../lib/site/config.js";

export function SiteHeader() {
  const pathname = usePathname();
  const [scrolled, setScrolled] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // Close the mobile menu on navigation and on Escape.
  useEffect(() => setOpen(false), [pathname]);
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <header
      className="sticky top-0 z-50 border-b transition-[background-color,border-color] duration-200"
      style={{
        backgroundColor: scrolled || open ? "rgba(8, 9, 13, 0.78)" : "transparent",
        borderColor: scrolled || open ? "var(--hairline)" : "transparent",
        backdropFilter: scrolled || open ? "blur(16px) saturate(140%)" : "none",
        WebkitBackdropFilter: scrolled || open ? "blur(16px) saturate(140%)" : "none",
      }}
    >
      <a href="#main" className="sr-only-focusable absolute left-4 top-3 z-10 rounded-lg bg-ink-strong px-3 py-2 text-sm font-medium text-[#0A0B10]">
        Skip to content
      </a>
      <div className="mx-auto flex h-16 max-w-6xl items-center gap-6 px-5 sm:px-8">
        <Link href="/" className="focus-ring -m-1 flex items-center gap-2.5 rounded-lg p-1" aria-label="Delhi NCR Heat Atlas home">
          <BrandGlyph size={28} />
          <span className="font-display text-[15px] font-semibold tracking-[-0.01em] text-ink-strong">
            Delhi NCR <span className="text-ink-muted">Heat Atlas</span>
          </span>
        </Link>

        <nav aria-label="Primary" className="ml-auto hidden items-center gap-1 md:flex">
          {NAV.map((item) => {
            const active = pathname === item.href;
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={`focus-ring rounded-full px-3.5 py-2 text-[14px] font-medium transition-colors duration-200 ${
                  active ? "bg-white/[0.07] text-ink-strong" : "text-ink-muted hover:text-ink-strong"
                }`}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>

        <Link href="/explore" className="btn btn-primary ml-auto hidden h-10 px-4 text-[14px] sm:inline-flex md:ml-2">
          Open explorer
          <ArrowUpRight aria-hidden="true" className="size-4" strokeWidth={2} />
        </Link>

        <button
          type="button"
          className="focus-ring ml-auto grid size-10 place-items-center rounded-full text-ink md:hidden"
          aria-expanded={open}
          aria-controls="mobile-nav"
          aria-label={open ? "Close menu" : "Open menu"}
          onClick={() => setOpen((v) => !v)}
        >
          {open ? <X aria-hidden="true" className="size-5" /> : <Menu aria-hidden="true" className="size-5" />}
        </button>
      </div>

      <div
        id="mobile-nav"
        className="grid border-t border-hairline md:hidden"
        style={{
          gridTemplateRows: open ? "1fr" : "0fr",
          opacity: open ? 1 : 0,
          transition: open
            ? "grid-template-rows 200ms var(--ease-out), opacity 200ms var(--ease-out)"
            : "grid-template-rows 150ms var(--ease-out), opacity 150ms var(--ease-out)",
          borderTopColor: open ? "var(--hairline)" : "transparent",
        }}
        inert={!open || undefined}
      >
        <nav aria-label="Mobile" className="overflow-hidden">
          <ul className="mx-auto flex max-w-6xl flex-col gap-1 px-5 py-4">
            {NAV.map((item) => (
              <li key={item.href}>
                <Link
                  href={item.href}
                  aria-current={pathname === item.href ? "page" : undefined}
                  className="focus-ring block rounded-xl px-3 py-3 text-[16px] font-medium text-ink hover:bg-white/[0.04]"
                >
                  {item.label}
                </Link>
              </li>
            ))}
            <li className="pt-2">
              <Link href="/explore" className="btn btn-primary w-full">
                Open explorer
                <ArrowUpRight aria-hidden="true" className="size-4" strokeWidth={2} />
              </Link>
            </li>
          </ul>
        </nav>
      </div>
    </header>
  );
}
