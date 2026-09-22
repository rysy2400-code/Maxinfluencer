/**
 * 评论数据分析：采集近 N 条视频的「视频文案 + 基础数据 + 评论文案样本」，
 * 交 LLM 做语义分析，产出：
 *   - 高质量评论占比
 *   - 购买意向评论占比（TikTok 优先用官方 is_high_purchase_intent，缺失时用 LLM）
 *   - 受众语言分布（TikTok 优先用官方 comment_language，缺失时用 LLM）
 *   - 评论内容方向 / 粉丝粘性 / 分析摘要
 *
 * 两项「官方优先、缺失回落 LLM」的字段都会在结果里标记 source。
 */

import { parseFirstJsonObject } from "../utils/extract-json-object.js";

const TT_ITEM_LIST = "https://www.tiktok.com/api/post/item_list/";
const TT_COMMENT_LIST = "https://www.tiktok.com/api/comment/list/";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function normalizeHandle(u) {
  return String(u || "").replace(/^@/, "").trim();
}

// ---------------- 采集 ----------------

/**
 * TikTok：近 N 条视频 + 每条视频首屏评论（count=50 实测可拿约 43 条）
 */
export async function collectTikTokSample(opts) {
  const { tiktokMakeRequest } = await import(
    "../tools/influencer-functions/tiktok/tiktok-api-client.js"
  );
  const { page, secUid } = opts;
  const handle = normalizeHandle(opts.username);
  const maxVideos = Math.max(1, Number(opts.maxVideos || 10));
  const perVideo = Math.min(Math.max(Number(opts.commentsPerVideo || 50), 1), 50);
  const gapMs = Number(opts.gapMs ?? 400);

  const videos = [];
  let cursor = 0;
  for (let i = 0; i < Math.ceil(maxVideos / 20); i += 1) {
    let json;
    try {
      json = await tiktokMakeRequest(
        page,
        TT_ITEM_LIST,
        { secUid, count: "20", cursor: String(cursor) },
        { referer: "https://www.tiktok.com/", retries: 1 }
      );
    } catch {
      break;
    }
    for (const it of json?.itemList || []) {
      videos.push({
        videoId: String(it.id || ""),
        desc: String(it.desc || ""),
        createTime: Number(it.createTime || 0) || null,
        views: Number(it?.stats?.playCount || 0) || 0,
        likes: Number(it?.stats?.diggCount || 0) || 0,
        comments: Number(it?.stats?.commentCount || 0) || 0,
        shares: Number(it?.stats?.shareCount || 0) || 0,
      });
    }
    const next = json?.cursor ?? json?.nextCursor;
    const hasMore = !!(json?.hasMore ?? json?.has_more);
    if (!hasMore || !next || next === cursor) break;
    cursor = next;
    if (i < 1) await sleep(gapMs);
  }
  videos.sort((a, b) => b.comments - a.comments);
  const picked = videos.slice(0, maxVideos);

  const comments = [];
  for (const v of picked) {
    if (v.comments === 0) continue;
    try {
      const j = await tiktokMakeRequest(
        page,
        TT_COMMENT_LIST,
        { aweme_id: v.videoId, count: String(perVideo), cursor: "0" },
        { referer: `https://www.tiktok.com/@${handle}/video/${v.videoId}`, retries: 1 }
      );
      for (const c of j?.comments || []) {
        comments.push({
          videoId: v.videoId,
          text: String(c.text || ""),
          diggCount: Number(c.digg_count || 0) || 0,
          replyCount: Number(c.reply_comment_total || 0) || 0,
          createTime: Number(c.create_time || 0) || null,
          language: c.comment_language ? String(c.comment_language) : null,
          highPurchaseIntent:
            typeof c.is_high_purchase_intent === "boolean"
              ? c.is_high_purchase_intent
              : null,
          authorLiked: !!c.is_author_digged,
        });
      }
    } catch {
      /* 单条视频失败跳过 */
    }
    if (gapMs > 0) await sleep(gapMs);
  }
  return { videos: picked, comments };
}

/**
 * Instagram：近 N 条 Reels + 文案（/info/）+ 首屏评论（实测约 15 条/条）
 */
export async function collectInstagramSample(opts) {
  const ig = await import(
    "../tools/influencer-functions/instagram/instagram-direct-fetch.js"
  );
  const igc = await import("./instagram-comments.js");
  const { page } = opts;
  const handle = normalizeHandle(opts.username);
  const maxVideos = Math.max(1, Number(opts.maxVideos || 10));
  const gapMs = Number(opts.gapMs ?? 400);

  const { pk } = await igc.resolveIgUserId(page, handle);
  if (!pk) return { videos: [], comments: [], error: "pk_unresolved" };
  const { media } = await igc.fetchRecentMedia(page, pk, { maxVideos, username: handle });

  const videos = [];
  const comments = [];
  for (const m of media) {
    let caption = "";
    try {
      const info = await ig.igApiFetch(page, `/api/v1/media/${m.mediaId}/info/`, {
        referer: `https://www.instagram.com/p/${m.shortcode}/`,
      });
      caption = String(info?.items?.[0]?.caption?.text || "");
    } catch {
      /* 文案拿不到不影响评论采集 */
    }
    videos.push({
      videoId: m.mediaId,
      shortcode: m.shortcode,
      desc: caption,
      createTime: m.createTime || null,
      views: m.views || 0,
      likes: m.likes || 0,
      comments: m.comments || 0,
    });
    if (m.comments > 0) {
      const r = await igc.fetchMediaComments(page, { mediaId: m.mediaId, maxPages: 1 });
      for (const c of r.comments || []) {
        comments.push({
          videoId: m.mediaId,
          text: c.text,
          diggCount: c.diggCount,
          replyCount: c.replyCount,
          createTime: c.createTime,
          language: null,
          highPurchaseIntent: null,
          authorLiked: false,
        });
      }
    }
    if (gapMs > 0) await sleep(gapMs);
  }
  return { videos, comments };
}

// ---------------- 官方字段聚合 ----------------

/**
 * 官方字段覆盖率与聚合值；覆盖率低于阈值视为「官方字段缺失」，回落 LLM。
 */
export function aggregateOfficialFields(comments, { minCoverage = 0.8 } = {}) {
  const list = comments || [];
  const total = list.length;
  if (!total) {
    return {
      language: { source: "llm", coverage: 0, mix: null },
      purchaseIntent: { source: "llm", coverage: 0, ratio: null },
    };
  }
  const langTagged = list.filter((c) => c.language != null && String(c.language) !== "");
  const langCoverage = langTagged.length / total;
  let langMix = null;
  if (langCoverage >= minCoverage) {
    const m = new Map();
    for (const c of langTagged) {
      const k = String(c.language);
      m.set(k, (m.get(k) || 0) + 1);
    }
    langMix = {};
    for (const [k, v] of [...m.entries()].sort((a, b) => b[1] - a[1])) {
      langMix[k] = +(v / langTagged.length).toFixed(4);
    }
  }
  const piTagged = list.filter((c) => typeof c.highPurchaseIntent === "boolean");
  const piCoverage = piTagged.length / total;
  const piRatio =
    piCoverage >= minCoverage && piTagged.length
      ? +(piTagged.filter((c) => c.highPurchaseIntent).length / piTagged.length).toFixed(4)
      : null;

  return {
    language: {
      source: langMix ? "official" : "llm",
      coverage: +langCoverage.toFixed(4),
      mix: langMix,
    },
    purchaseIntent: {
      source: piRatio != null ? "official" : "llm",
      coverage: +piCoverage.toFixed(4),
      ratio: piRatio,
    },
  };
}

// ---------------- LLM ----------------

const MAX_LLM_COMMENTS = Math.min(
  Math.max(Number(process.env.COMMENT_ANALYSIS_LLM_SAMPLE || 220), 40),
  500
);

/** 实际送进 LLM 的评论样本（与 prompt 中声明的条数保持一致） */
export function llmSampleComments(comments) {
  return (comments || [])
    .filter((c) => String(c.text || "").trim().length > 1)
    .sort((a, b) => (b.diggCount || 0) - (a.diggCount || 0))
    .slice(0, MAX_LLM_COMMENTS);
}

const PROMPT_RULES = [
  "高质量评论 = 有实质信息 / 提问 / 具体观点；排除纯表情、纯夸赞（nice/love it/好棒）、模板化复制。",
  "即使内容简短，只要是具体提问或具体观点也算高质量。",
  "购买意向评论 = 问价格 / 问购买渠道 / 问功能对比 / 求链接 / 问怎么用、在哪下载。",
].join("");

/** 语言统计：LLM 最容易出错的一步，用计数+示例+自检强约束 */
function buildLanguageRules(sampleSize) {
  return [
    `下面一共给你 ${sampleSize} 条评论。你要**逐条**判断语言，再统计条数。`,
    "",
    "判定规则（按顺序执行）：",
    "1. 去掉 emoji、表情符号、标点、数字后，如果剩下没有任何文字（例：「😍😍」「🔥🔥🔥」「🙌」「❤️❤️❤️」「💍🩵」）→ 记为 un。**这类评论绝不要记为 en。**",
    "2. 只要有拉丁字母，判断它到底是哪种语言，不要一律当成英语：",
    "   · 印地语/乌尔都语用拉丁字母写的（Hinglish，如 'link do bhai'、'bhai cap cut ka link dedo'、'ye sab free hai'）→ hi（乌尔都语倾向记 ur）",
    "   · 印尼语（如 'bagus banget'、'kok bisa'）→ id；马来语（如 'cantiknya'、'macam mana'）→ ms",
    "   · 越南语（如 'hay quá'）→ vi；土耳其语（如 'çok güzel'）→ tr",
    "   · 西班牙语 → es；葡萄牙语 → pt；法语 → fr；德语 → de；阿拉伯语 → ar；日语 → ja；韩语 → ko；中文 → zh；泰语 → th",
    "3. 其余标准英语（如 'love this'、'batteries included?'、'i wonder why the sales jumped up'）→ en。",
    "",
    `自检：languageCounts 的各项加起来必须正好等于 ${sampleSize}；languageMix 的每一项 = 该项条数 ÷ ${sampleSize}，所有项加起来必须等于 1。`,
    "如果数字对不上，重新数一遍再输出。",
    "languageMix 按占比从高到低排列。",
  ].join("\n");
}

export function buildAnalysisPrompt(payload) {
  const { platform, username, videos, comments, stats, official } = payload;
  const videoLines = (videos || [])
    .slice(0, 12)
    .map(
      (v, i) =>
        `${i + 1}. 播放=${v.views} 点赞=${v.likes} 评论=${v.comments} | 文案：${String(
          v.desc || ""
        )
          .replace(/\s+/g, " ")
          .slice(0, 300)}`
    )
    .join("\n");

  const picked = llmSampleComments(comments);
  const commentLines = picked
    .map(
      (c, i) =>
        `${i + 1}. 「${String(c.text)
          .replace(/\s+/g, " ")
          .slice(0, 160)}」 赞${c.diggCount} 回复${c.replyCount}${
          c.authorLiked ? " 作者点赞" : ""
        }`
    )
    .join("\n");

  const platformName = platform === "tiktok" ? "TikTok" : "Instagram";
  // 平台官方口径（存在时必须以此为准，避免与卡片数字矛盾）
  const officialLines = [];
  if (official?.purchaseIntent?.ratio != null) {
    officialLines.push(
      `- 购买意图：平台官方字段 is_high_purchase_intent 标记为 true 的占 ${(
        official.purchaseIntent.ratio * 100
      ).toFixed(1)}%（官网口径，卡片展示用这个数字）`
    );
  }
  if (official?.language?.mix) {
    officialLines.push(
      `- 受众语言：平台官方字段统计为 ${Object.entries(official.language.mix)
        .slice(0, 5)
        .map(([k, v]) => `${k} ${(v * 100).toFixed(0)}%`)
        .join("，")}（卡片展示用这个）`
    );
  }
  return [
    `请分析这个 ${platformName} 红人的评论区数据。`,
    "",
    "## 红人",
    `@${username}`,
    "",
    `## 近 ${(videos || []).length} 条视频（播放/点赞/评论 + 文案）`,
    videoLines,
    "",
    `## 评论区样本（共采集 ${(comments || []).length} 条，下面按点赞量取前 ${picked.length} 条）`,
    commentLines,
    "",
    "## 补充统计",
    `- 样本视频总播放：${stats.totalViews}，总点赞：${stats.totalLikes}`,
    `- 平均评论点赞：${stats.avgDigg}，带回复的评论占比：${stats.replyRate}`,
    "",
    "## 判定标准（必须严格按此标准）",
    PROMPT_RULES,
    ...(officialLines.length
      ? [
          "",
          "## 平台官方口径（重要：卡片会展示这些数字，你的结论必须与它们自洽，不能互相矛盾）",
          ...officialLines,
          "官方「购买意图」字段的口径通常比「问价/求链接」更宽（常包含评论者自述职业、收入、招揽生意等商业内容）。",
          "因此：如果官方比例明显高于你按上述标准判定的比例，不要直接说「0%」或「没有购买意向」，而要说明「官方口径 N% 主要是 X 类内容，按问价/求链接口径实际为 M%」。",
        ]
      : []),
    "",
    "## 语言统计（最容易出错，务必逐条计数）",
    buildLanguageRules(picked.length),
    "",
    "## 输出要求",
    "只输出一个 JSON 对象，不要任何解释文字、不要 markdown 代码块：",
    "{",
    '  "qualityCommentRatio": 0.0,',
    '  "qualityCommentReason": "一句话说明高/低的原因",',
    '  "purchaseIntentRatio": 0.0,',
    '  "languageCounts": { "en": 0 },',
    '  "languageMix": { "en": 0.0 },',
    '  "contentDirections": [{ "label": "内容方向(中文，不超过8字)", "ratio": 0.0 }],',
    '  "fanLoyalty": { "score": 0, "summary": "一句话" },',
    '  "summary": "四行纯文本，每行以「质量：」「购买意向：」「内容方向：」「粉丝粘性：」开头"',
    "}",
    "languageMix 的 key 用 ISO 639-1 小写代码（如 en/zh/ja/es/hi/id），无法判定用 un。",
    "fanLoyalty.score 与 fanLoyalty.summary 的结论必须一致：score<40 不得描述为「中等以上/较强」，score>=70 不得描述为「较弱」。",
    "contentDirections 至少给出 2 项、最多 5 项，占比之和不超过 1。",
    "",
    "summary 必须是且仅是下面四行（不要用 ## 标题、不要列表符号、不要代码块、不要额外的总结段），每行一句话、总长 160 字以内：",
    "质量：<高质量占比 + 一句话说明评论区以什么内容为主>，例：约48.8%为高质量评论，大量用户分享真实职业/收入/创业经验，也有具体提问。",
    "购买意向：<按「问价/求链接/问渠道」口径的比例 + 一句说明>；若官方比例更高，须按官方口径那一节的要求解释差异。",
    "内容方向：<占比最高的 2-4 个方向及各自占比，用顿号分隔>，例：赞美鼓励44.1%，职业收入分享32.3%，提问求教11.0%。",
    "粉丝粘性：<结论 + 依据>，例：作者点赞多、互动积极，忠诚度中上；但短赞美多，核心铁粉不算极强。",
    "只输出这四行，不要复述字段名清单，不要再加别的段落。",
  ].join("\n");
}

export async function analyzeSampleWithLLM(payload, options = {}) {
  const { callDeepSeekLLM } = await import("../utils/llm-client.js");
  const system =
    "你是社媒红人评论区分析师。只输出调用方要求的 JSON 对象，禁止输出解释文字或代码块。所有比例的取值范围是 0 到 1。";
  const prompt = buildAnalysisPrompt(payload);
  const attempts = Math.max(1, Number(options.attempts || 2));
  let lastError = null;
  for (let i = 0; i < attempts; i += 1) {
    try {
      const content = await callDeepSeekLLM([{ role: "user", content: prompt }], system, {
        maxTokens: Number(options.maxTokens || 2048),
        timeoutMs: Number(options.timeoutMs || 240_000),
        // 评论分析是「读文本→给结论」的抽取式任务，不需要思维链；
        // 实测关掉思考可提速约 43%（174s → 99s）且输出质量一致。
        enableThinking: options.enableThinking === true ? true : false,
        // 判定类任务用低温度，避免同一红人两次跑出差别很大的占比（实测 49% vs 35%）
        temperature: Number.isFinite(Number(options.temperature))
          ? Number(options.temperature)
          : 0.2,
      });
      const parsed = parseFirstJsonObject(content);
      if (parsed && typeof parsed === "object") return parsed;
      lastError = new Error("llm_parse_empty");
    } catch (e) {
      lastError = e;
    }
    if (i < attempts - 1) await sleep(3000 * (i + 1));
  }
  throw lastError || new Error("llm_failed");
}

function ratioOf(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  const r = n > 1 ? n / 100 : n;
  return +Math.max(0, Math.min(1, r)).toFixed(4);
}

export function normalizeLlmResult(raw) {
  if (!raw) return null;
  const langMix = {};
  for (const [k, v] of Object.entries(raw.languageMix || {})) {
    const r = ratioOf(v);
    if (r != null && r > 0) langMix[String(k).toLowerCase()] = r;
  }
  const directions = (Array.isArray(raw.contentDirections) ? raw.contentDirections : [])
    .map((d) => ({ label: String(d?.label || "").slice(0, 20), ratio: ratioOf(d?.ratio) }))
    .filter((d) => d.label && d.ratio != null)
    .sort((a, b) => b.ratio - a.ratio)
    .slice(0, 5);
  const loyaltyScore = Number(raw?.fanLoyalty?.score);
  const counts = {};
  for (const [k, v] of Object.entries(raw.languageCounts || {})) {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) counts[String(k).toLowerCase()] = Math.round(n);
  }
  return {
    qualityCommentRatio: ratioOf(raw.qualityCommentRatio),
    qualityCommentReason: String(raw.qualityCommentReason || "").slice(0, 200),
    purchaseIntentRatio: ratioOf(raw.purchaseIntentRatio),
    languageCounts: Object.keys(counts).length ? counts : null,
    languageMix: Object.keys(langMix).length ? langMix : null,
    contentDirections: directions,
    fanLoyalty: {
      score: Number.isFinite(loyaltyScore)
        ? Math.max(0, Math.min(100, Math.round(loyaltyScore)))
        : null,
      summary: String(raw?.fanLoyalty?.summary || "").slice(0, 200),
    },
    summary: String(raw.summary || "").slice(0, 2000),
  };
}

export function computeSampleStats(videos, comments) {
  const vids = videos || [];
  const list = comments || [];
  const totalViews = vids.reduce((s, v) => s + (Number(v.views) || 0), 0);
  const totalLikes = vids.reduce((s, v) => s + (Number(v.likes) || 0), 0);
  const avgDigg = list.length
    ? +(list.reduce((s, c) => s + (Number(c.diggCount) || 0), 0) / list.length).toFixed(2)
    : null;
  const replyRate = list.length
    ? +(list.filter((c) => (Number(c.replyCount) || 0) > 0).length / list.length).toFixed(4)
    : null;
  return { totalViews, totalLikes, avgDigg, replyRate };
}
