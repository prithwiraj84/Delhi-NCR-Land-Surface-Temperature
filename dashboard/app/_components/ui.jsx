/**
 * Layout primitives of the content pages (server components).
 *   <PageIntro>  sub-page hero: eyebrow, H1, lead paragraph (one entrance, CSS, once)
 *   <Section>    titled section; its header reveals on scroll
 *   <Eyebrow>    small label above a heading (brand-gradient dot)
 */
import { Reveal } from "./Reveal.jsx";

export function Eyebrow({ children, className = "" }) {
  return (
    <p className={`inline-flex items-center gap-2 text-[13px] font-medium text-ink-muted ${className}`}>
      <span aria-hidden="true" className="size-1.5 rounded-full bg-[image:var(--brand-gradient)]" />
      {children}
    </p>
  );
}

export function PageIntro({ eyebrow, title, lead, children }) {
  return (
    <section className="relative overflow-hidden">
      <div aria-hidden="true" className="bg-grid pointer-events-none absolute inset-0 -top-16" />
      <div aria-hidden="true" className="pointer-events-none absolute -top-40 left-1/2 h-80 w-[48rem] -translate-x-1/2 rounded-full bg-[radial-gradient(closest-side,rgba(109,141,255,0.16),transparent)]" />
      <div className="relative mx-auto max-w-6xl px-5 pb-12 pt-16 sm:px-8 sm:pt-24">
        {eyebrow && (
          <div className="hero-fade" style={{ "--d": "0ms" }}>
            <Eyebrow>{eyebrow}</Eyebrow>
          </div>
        )}
        <h1 className="hero-rise mt-4 max-w-3xl font-display text-[40px] font-semibold leading-[1.05] tracking-[-0.035em] text-ink-strong sm:text-[56px]" style={{ "--rise": "16px" }}>
          {title}
        </h1>
        {lead && (
          <p className="hero-rise mt-6 max-w-2xl text-[17px] leading-relaxed text-ink-muted sm:text-[19px]" style={{ "--d": "100ms", "--rise": "10px" }}>
            {lead}
          </p>
        )}
        {children && (
          <div className="hero-in mt-8" style={{ "--d": "180ms", "--rise": "8px" }}>
            {children}
          </div>
        )}
      </div>
    </section>
  );
}

export function Section({ id, eyebrow, title, intro, children, className = "" }) {
  return (
    <section id={id} aria-labelledby={id ? `${id}-title` : undefined} className={`mx-auto max-w-6xl scroll-mt-24 px-5 py-14 sm:px-8 sm:py-20 ${className}`}>
      {(eyebrow || title || intro) && (
        <Reveal className="mb-10 max-w-2xl">
          {eyebrow && <Eyebrow>{eyebrow}</Eyebrow>}
          {title && (
            <h2 id={id ? `${id}-title` : undefined} className="mt-3 font-display text-[30px] font-semibold leading-tight tracking-[-0.025em] text-ink-strong sm:text-[38px]">
              {title}
            </h2>
          )}
          {intro && <p className="mt-4 text-[16px] leading-relaxed text-ink-muted sm:text-[17px]">{intro}</p>}
        </Reveal>
      )}
      {children}
    </section>
  );
}
