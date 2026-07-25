const { spawnSync } = require("node:child_process");

const script = process.argv[2];
if (!script) {
  console.error("usage: node scripts/run-esm-script.cjs <script> [...args]");
  process.exit(2);
}

const major = Number(process.versions.node.split(".")[0]);
const args = major < 22
  ? ["--experimental-default-type=module", script, ...process.argv.slice(3)]
  : [script, ...process.argv.slice(3)];
const result = spawnSync(process.execPath, args, { stdio: "inherit" });

if (result.error) throw result.error;
process.exit(result.status ?? 1);
