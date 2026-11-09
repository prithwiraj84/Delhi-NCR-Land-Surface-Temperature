/**
 * Build-time environment for the dashboard, in the shape the code used under Vite
 * (`import.meta.env`): `{ BASE_URL, VITE_DATA_BASE_URL, DEV, MODE }`.
 *
 * Next.js inlines `process.env.NEXT_PUBLIC_*` and `process.env.NODE_ENV` at build time (in
 * workers too), but only when the name is written out literally, so each is read by its full
 * name here. Vitest runs this module in Node, where `process.env` is the real environment.
 *   NEXT_PUBLIC_BASE_PATH       sub-path the site is served under ("" on Vercel)
 *   NEXT_PUBLIC_DATA_BASE_URL   web bundle hosted elsewhere (CORS); empty = "<base>/data"
 */
const nodeEnv = process.env.NODE_ENV;
const basePath = process.env.NEXT_PUBLIC_BASE_PATH || "";
const dataBase = process.env.NEXT_PUBLIC_DATA_BASE_URL || "";

export const appEnv = Object.freeze({
  BASE_URL: `${basePath.replace(/\/+$/, "")}/`,
  VITE_DATA_BASE_URL: dataBase,
  DEV: nodeEnv === "development",
  MODE: nodeEnv === "test" ? "test" : nodeEnv === "development" ? "development" : "production",
});

export default appEnv;
