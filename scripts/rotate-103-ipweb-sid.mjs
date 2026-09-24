/**
 * Rotate the IPWEB dynamic-residential session by changing the SID segment of the
 * username (last 8 chars), then restart the 7896 mihomo so the new IP takes effect.
 * Username format: B_<account>_<country>[_<state>_<city>]_<ttlMinutes>_<SID8>
 *
 * Usage: node scripts/rotate-103-ipweb-sid.mjs [--check]
 *   --check  only print current exit IP, no rotation
 */
import fs from "node:fs";
import { execFileSync } from "node:child_process";

const CFG = "C:\\maxinfluencer\\config\\tiktok-ipweb-7896.yaml";
const PROXY = "http://127.0.0.1:7896";
const checkOnly = process.argv.includes("--check");

function exitIp() {
  try {
    const out = execFileSync("curl.exe", ["-s", "-m", "40", "-x", PROXY, "https://ipwho.is/"], {
      encoding: "utf8",
    });
    const j = JSON.parse(out);
    return `${j.ip} ${j.country_code || ""} ${j.city || ""}`.trim();
  } catch (e) {
    return `(probe failed: ${String(e.message).slice(0, 60)})`;
  }
}

let text = fs.readFileSync(CFG, "utf8");
const m = text.match(/username:\s*(\S+)/);
if (!m) {
  console.error("username not found in config");
  process.exit(1);
}
const user = m[1];
console.log(`current exit = ${exitIp()}`);
if (checkOnly) process.exit(0);

const parts = user.split("_");
const sid = parts[parts.length - 1];
const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
let newSid = "";
for (let i = 0; i < (sid.length || 8); i += 1) {
  newSid += chars[Math.floor(Math.random() * chars.length)];
}
parts[parts.length - 1] = newSid;
const newUser = parts.join("_");
fs.writeFileSync(CFG + ".bak-sid", text, "utf8");
fs.writeFileSync(CFG, text.replace(user, newUser), "utf8");
console.log(`rotated SID: ...${sid} -> ...${newSid}`);

// kill mihomo 7896 (the guard task restarts it with the new config)
try {
  execFileSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-Command",
      "Get-CimInstance Win32_Process -Filter \"Name='verge-mihomo.exe'\" | Where-Object { [string]$_.CommandLine -like '*tiktok-ipweb-7896*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }",
    ],
    { encoding: "utf8" }
  );
} catch {}

// wait for the guard to bring it back
await new Promise((r) => setTimeout(r, 30000));
console.log(`new exit     = ${exitIp()}`);
