/**
 * 回归验证：用 process-influencer-email-events.js 里【商务档案与常住地增量】那段
 * 规则原文（运行时从源码切片，避免 prompt 漂移）+ 两封真实误判邮件，验证
 * 决策 LLM 不再把它们当成红人常住地。
 *
 *   node scripts/test-profile-delta-prompt.mjs
 *
 * 会真实调用一次 DeepSeek，仅用于人工回归，不进 CI。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { callDeepSeekLLM } from "../lib/utils/llm-client.js";
import { resolveResidenceCountryUpdate } from "../lib/influencer/country-reply-sync.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(__dirname, "process-influencer-email-events.js");

function extractProfileDeltaRules(source) {
  const start = source.indexOf("【商务档案与常住地增量 · profileDelta");
  if (start < 0) throw new Error("未找到 profileDelta 规则段落");
  const end = source.indexOf("- updates 会被写入", start);
  if (end < 0) throw new Error("未找到 profileDelta 规则段落结尾");
  return source.slice(start, end).trim();
}

const CASES = [
  {
    label: "9/6 「my ID: 7229...」",
    subject: "Re: Binfluencer x 神話ミステリー研究所 | Social Media Collaboration",
    bodyText: `hi  bin\r\n\r\nGood evening.\r\n\r\nI've logged in and obtained my ID.Here is my ID:\r\n\r\n722956040151179\r\n\r\nThank you, and best regards.\r\n\r\n神話ミステリー研究所`,
    expectIso: null,
  },
  {
    label: "9/13 「Greater China region」",
    subject: "Re: Binfluencer x 神話ミステリー研究所 | Social Media Collaboration",
    bodyText: `Hi Bin,\r\n\r\nI hope you’re doing well.\r\n\r\nI have a quick question regarding your agency:\r\nAm I correct in understanding that your company matches creators with\r\nvarious brand opportunities across diverse genres?\r\n\r\nAs your agency seems relatively new, do most of your current clients and\r\nprojects come from the Greater China region? Also, do you foresee expanding\r\nyour client base to Japan and other global markets in the near future?\r\n\r\nBest regards,\r\n神話ミステリー研究所`,
    expectIso: null,
  },
  {
    label: "真正常住地自述（应为 JP）",
    subject: "Re: Binfluencer x 神話ミステリー研究所 | Social Media Collaboration",
    bodyText: `Hi Bin,\r\n\r\nThanks for asking — I'm based in Osaka, Japan and I can receive samples here.\r\n\r\nBest regards,\r\n神話ミステリー研究所`,
    expectIso: "JP",
  },
];

const systemPrompt = `${extractProfileDeltaRules(
  fs.readFileSync(SRC, "utf-8")
)}

Return one JSON object only, with exactly this shape:
{"hasProfileUpdate":boolean,"residenceCountry":string|null,"residenceRelation":"self_residence|self_travel|other|quoted_history|unknown","residenceEvidenceQuote":string|null,"residenceConfidence":number,"facts":string[],"questions":string[],"doNotContact":boolean,"doNotContactReason":string|null}`;

let failed = 0;
for (const c of CASES) {
  const raw = await callDeepSeekLLM(
    [
      {
        role: "user",
        content: JSON.stringify({
          existingBusinessProfileMarkdown: null,
          currentEmail: { subject: c.subject, bodyText: c.bodyText },
          recentConversationHistory: [],
        }),
      },
    ],
    systemPrompt,
    { maxTokens: 4000, timeoutMs: 90_000 }
  );
  const match = String(raw).match(/\{[\s\S]*\}/);
  const delta = match ? JSON.parse(match[0]) : null;
  const resolved = resolveResidenceCountryUpdate(delta);
  const written = resolved.ok ? resolved.iso : null;
  const pass = written === c.expectIso;
  if (!pass) failed += 1;
  console.log(
    `${pass ? "PASS" : "FAIL"} | ${c.label} | relation=${delta?.residenceRelation} written=${written} expected=${c.expectIso}`
  );
  console.log(`      country=${delta?.residenceCountry} confidence=${delta?.residenceConfidence} evidence=${JSON.stringify(delta?.residenceEvidenceQuote)}`);
}

console.log(failed === 0 ? "profile delta prompt regression passed" : `${failed} case(s) failed`);
process.exit(failed === 0 ? 0 : 1);
