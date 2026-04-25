import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { queryTikTok } from "../lib/db/mysql-tiktok.js";
import { sendOutreach } from "../lib/agents/influencer-agent.js";
import {
  normalizeMessageIdForHeader,
} from "../lib/email/influencer-thread-mail.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(projectRoot, ".env") });
dotenv.config({ path: path.join(projectRoot, ".env.local") });

const TARGET_EMAIL = process.argv[2] || "rysy2400@gmail.com";

async function resolveCandidatePair(targetEmail) {
  const exact = await queryTikTok(
    `
    SELECT
      e.campaign_id,
      e.influencer_id
    FROM tiktok_campaign_execution e
    JOIN tiktok_influencer i ON i.influencer_id = e.influencer_id
    WHERE i.influencer_email = ?
      AND NOT EXISTS (
        SELECT 1
        FROM tiktok_influencer_conversation_messages m
        WHERE
          m.campaign_id = e.campaign_id
          AND m.influencer_id = e.influencer_id
          AND m.direction = 'bin'
          AND m.channel = 'email'
      )
    ORDER BY e.created_at DESC
    LIMIT 1
  `,
    [String(targetEmail).trim().toLowerCase()]
  );
  if (exact?.length) return exact[0];

  const fallback = await queryTikTok(
    `
    SELECT
      e.campaign_id,
      e.influencer_id
    FROM tiktok_campaign_execution e
    JOIN tiktok_influencer i ON i.influencer_id = e.influencer_id
    WHERE i.influencer_email = ?
    ORDER BY e.created_at DESC
    LIMIT 1
  `,
    [String(targetEmail).trim().toLowerCase()]
  );
  return fallback?.[0] || null;
}

async function main() {
  const pair = await resolveCandidatePair(TARGET_EMAIL);
  if (!pair) {
    throw new Error(
      `找不到包含邮箱 ${TARGET_EMAIL} 的 campaign/influencer 组合，请先准备测试数据`
    );
  }

  const campaignId = pair.campaign_id;
  const influencerId = pair.influencer_id;

  const beforeRows = await queryTikTok(
    `
    SELECT COALESCE(MAX(id), 0) AS max_id
    FROM tiktok_influencer_conversation_messages
    WHERE campaign_id = ? AND influencer_id = ?
  `,
    [campaignId, influencerId]
  );
  const beforeMaxId = Number(beforeRows?.[0]?.max_id || 0);

  console.log("[TEST] 使用组合:", { campaignId, influencerId, targetEmail: TARGET_EMAIL });
  console.log("[TEST] 发送第 1 封...");
  const first = await sendOutreach({ campaignId, influencerId, snapshot: null });
  console.log("[TEST] 发送第 2 封...");
  const second = await sendOutreach({ campaignId, influencerId, snapshot: null });

  const inserted = await queryTikTok(
    `
    SELECT
      id,
      from_email,
      to_email,
      subject,
      message_id,
      created_at,
      sent_at
    FROM tiktok_influencer_conversation_messages
    WHERE
      campaign_id = ?
      AND influencer_id = ?
      AND id > ?
      AND direction = 'bin'
      AND channel = 'email'
    ORDER BY id ASC
  `,
    [campaignId, influencerId, beforeMaxId]
  );

  if (!inserted || inserted.length < 2) {
    throw new Error(
      `[TEST] 未捕获到两条新发件记录（实际 ${inserted?.length || 0} 条）`
    );
  }

  const firstRow = inserted[0];
  const secondRow = inserted[1];
  const n1 = normalizeMessageIdForHeader(firstRow.message_id);
  const nReply = normalizeMessageIdForHeader(second?.headers?.["In-Reply-To"]);
  const nRef = String(second?.headers?.References || "").trim();
  const checks = {
    fromEmailFixed: firstRow.from_email === secondRow.from_email,
    firstSubjectCanonical:
      /^Binfluencer x .+ \| Social Media Collaboration$/i.test(
        String(firstRow.subject || "").replace(/^\s*Re:\s*/i, "")
      ),
    secondSubjectIsRe:
      /^Re:\s*Binfluencer x /i.test(String(secondRow.subject || "")),
    secondInReplyTo: second?.headers?.["In-Reply-To"] || null,
    secondReferences: second?.headers?.References || null,
    expectedRootMessageId: firstRow.message_id || null,
    inReplyToMatchesLatestParent: nReply && n1 && nReply === n1,
    referencesIncludesParent:
      Boolean(nRef) &&
      Boolean(n1) &&
      (nRef.includes(n1.replace(/^<|>$/g, "")) || nRef.includes(n1)),
  };

  console.log("[TEST] first result:", first);
  console.log("[TEST] second result:", second);
  console.log("[TEST] inserted rows:", inserted.slice(0, 2));
  console.log("[TEST] checks:", checks);
}

main()
  .then(() => {
    console.log("[TEST] 完成");
    process.exit(0);
  })
  .catch((err) => {
    console.error("[TEST] 失败:", err?.message || err);
    process.exit(1);
  });
