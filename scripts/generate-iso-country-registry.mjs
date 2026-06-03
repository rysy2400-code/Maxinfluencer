#!/usr/bin/env node
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const regionChunk = path.join(
  __dirname,
  "../.affiliate-partner-profile/Extensions/lghnjiiijkmgpgafgehpahncpcpfmkbp/3.5.2_0/chunks/region-q7g8iUWX.js"
);

const text = fs.readFileSync(regionChunk, "utf8");
const zhMatch = text.match(/const countries = (\{[^}]+\})/);
const enMatch = text.match(/const countries\$1 = (\{[\s\S]*?\});\s*const en/);
if (!zhMatch || !enMatch) {
  console.error("parse fail");
  process.exit(1);
}

// eslint-disable-next-line no-eval
const zh = eval("(" + zhMatch[1] + ")");
// eslint-disable-next-line no-eval
const en = eval("(" + enMatch[1] + ")");

const EXTRA_ZH = {
  美國: "US",
  德國: "DE",
  英國: "GB",
  法國: "FR",
  印尼: "ID",
  印度尼西亚: "ID",
  澳大利亚: "AU",
  澳洲: "AU",
};

const aliases = {
  US: ["usa", "u.s.a.", "u.s.", "united states", "united states of america", "america"],
  GB: ["uk", "u.k.", "united kingdom", "great britain", "england"],
  AE: ["uae", "united arab emirates"],
  KR: ["south korea", "republic of korea", "korea, republic of"],
  CN: ["china", "people's republic of china", "prc"],
  TW: ["taiwan", "taiwan, province of china"],
  HK: ["hong kong", "hong kong sar"],
  MO: ["macao", "macau"],
  RU: ["russia", "russian federation"],
  CZ: ["czechia", "czech republic"],
  TR: ["turkey", "türkiye", "turkiye"],
  VN: ["vietnam", "viet nam"],
  NL: ["the netherlands", "holland"],
  CI: ["ivory coast", "cote d'ivoire", "côte d'ivoire"],
  CD: ["democratic republic of the congo", "dr congo"],
  CG: ["republic of the congo", "congo"],
  LA: ["laos", "lao people's democratic republic"],
  PS: ["palestine", "state of palestine"],
  MK: ["north macedonia", "macedonia"],
};

const labelToIso = { ...EXTRA_ZH };

for (const [iso, zhLabel] of Object.entries(zh)) {
  labelToIso[zhLabel] = iso;
  labelToIso[zhLabel.toLowerCase()] = iso;
}

for (const [iso, enVal] of Object.entries(en)) {
  const names = Array.isArray(enVal) ? enVal : [enVal];
  for (const n of names) {
    labelToIso[n] = iso;
    labelToIso[String(n).toLowerCase()] = iso;
  }
  labelToIso[iso] = iso;
  labelToIso[iso.toLowerCase()] = iso;
  if (aliases[iso]) {
    for (const a of aliases[iso]) labelToIso[a] = iso;
  }
}

const outPath = path.join(__dirname, "../lib/influencer/iso-country-registry.js");
const out = `/**
 * ISO 3166-1 alpha-2 ↔ 中文/英文展示名
 * 由 scripts/generate-iso-country-registry.mjs 生成，勿手改。
 */
export const ISO_TO_ZH_LABEL = ${JSON.stringify(zh, null, 2)};

/** @type {Record<string, string>} 国家名/别名（小写或原文）→ ISO 2 */
export const LABEL_TO_ISO = ${JSON.stringify(labelToIso, null, 2)};
`;

fs.writeFileSync(outPath, out);
console.log(
  "written",
  Object.keys(zh).length,
  "iso codes,",
  Object.keys(labelToIso).length,
  "label keys ->",
  outPath
);
