/**
 * Writes src/design/tokens.css from the JS tokens (run with `npm run tokens`).
 * Exit code 1 with `--check` when the file on disk is out of date.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderTokensCss } from "./tokensCss.js";

const target = fileURLToPath(new URL("./tokens.css", import.meta.url));
const next = renderTokensCss();

if (process.argv.includes("--check")) {
  let current = "";
  try {
    current = readFileSync(target, "utf8").replace(/\r\n/g, "\n");
  } catch (error) {
    console.error(`tokens.css missing: ${error.message}`);
    process.exit(1);
  }
  if (current !== next) {
    console.error("tokens.css is out of date - run `npm run tokens`.");
    process.exit(1);
  }
  console.log("tokens.css is up to date.");
} else {
  writeFileSync(target, next, "utf8");
  console.log(`wrote ${target}`);
}
