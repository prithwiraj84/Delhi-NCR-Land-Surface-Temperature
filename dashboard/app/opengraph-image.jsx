/**
 * Social preview card (1200 x 630), generated at build time with the real 2025 daytime map
 * (public/media/hero-og.png, written by scripts/build-media.mjs) and the headline numbers.
 * Twitter / X reuses it (twitter-image.jsx).
 */
import fs from "node:fs";
import path from "node:path";
import { ImageResponse } from "next/og";
import { getFacts, signed } from "../lib/site/facts.js";

export const alt = "Delhi NCR Heat Atlas: land surface temperature 1990–2050, explained with AI";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default async function OpengraphImage() {
  const f = getFacts();
  let map = null;
  try {
    map = `data:image/png;base64,${fs.readFileSync(path.join(process.cwd(), "public", "media", "hero-og.png")).toString("base64")}`;
  } catch {
    map = null;
  }
  const stats = [
    [signed(f.day?.change, 1), `daytime warming ${f.day?.first?.year}–${f.day?.last?.year}`],
    [f.accuracy.day?.spatial ? `R² ${f.accuracy.day.spatial.r2.toFixed(2)}` : "", "spatial cross-validation"],
    [`${f.years.all[0]}–${f.years.all.at(-1)}`, "day and night, 3 SSPs"],
  ].filter(([v]) => v);

  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", background: "#08090D", color: "#F7F8FB", fontFamily: "sans-serif", position: "relative" }}>
        <div style={{ position: "absolute", inset: 0, display: "flex", background: "radial-gradient(60% 70% at 85% 10%, rgba(167,139,250,0.22), transparent), radial-gradient(50% 60% at 0% 100%, rgba(69,224,255,0.12), transparent)" }} />
        <div style={{ display: "flex", flexDirection: "column", justifyContent: "space-between", padding: "64px 0 64px 72px", width: 700 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
            <div style={{ width: 52, height: 52, borderRadius: 15, background: "linear-gradient(135deg, #A78BFA, #6D8DFF 50%, #45E0FF)", display: "flex" }} />
            <div style={{ fontSize: 30, fontWeight: 700, letterSpacing: -0.5 }}>Delhi NCR Heat Atlas</div>
          </div>
          <div style={{ display: "flex", flexDirection: "column" }}>
            <div style={{ fontSize: 64, fontWeight: 700, lineHeight: 1.04, letterSpacing: -2 }}>How hot is Delhi NCR getting, and why?</div>
            <div style={{ marginTop: 22, fontSize: 27, color: "#A7AEBC", lineHeight: 1.35 }}>Land surface temperature 1990–2050, explained with machine learning and SHAP.</div>
          </div>
          <div style={{ display: "flex", gap: 40 }}>
            {stats.map(([v, l]) => (
              <div key={l} style={{ display: "flex", flexDirection: "column" }}>
                <div style={{ fontSize: 36, fontWeight: 700 }}>{v}</div>
                <div style={{ fontSize: 19, color: "#8E95A4", marginTop: 4 }}>{l}</div>
              </div>
            ))}
          </div>
        </div>
        {map && (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 500, padding: "40px 48px 40px 0" }}>
            <img src={map} alt="" width={430} height={467} style={{ objectFit: "contain" }} />
          </div>
        )}
      </div>
    ),
    size,
  );
}
