/**
 * @deprecated 请用 test-ig-about-country.mjs
 * 用法: CDP_ENDPOINT=http://127.0.0.1:9222 node scripts/test-ig-about-account-only.mjs thejunglebadger
 */
import { spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const child = spawn(
  process.execPath,
  [path.join(__dirname, "test-ig-about-country.mjs"), ...process.argv.slice(2)],
  { stdio: "inherit", env: process.env }
);
child.on("exit", (code) => process.exit(code ?? 1));
