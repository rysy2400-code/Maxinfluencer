import assert from "node:assert/strict";
import test from "node:test";
import {
  isChatVisibleMessage,
  isThinkingOnlyAssistantPlaceholder,
  mergeSessionMessages,
  normalizeSessionMessagesForStorage,
  sanitizeMessageForStorage,
  sortSessionMessagesByTime,
  trimMessagesBeforeSessionCreated,
} from "../lib/chat/session-messages.js";

const placeholder = {
  role: "assistant",
  name: "Bin",
  content: "",
  thinking: {
    steps: [{ agent: "AgentRouter", action: "链式调用下一阶段" }],
  },
};

const completed = {
  role: "assistant",
  name: "Bin",
  content: "Campaign 已发布。",
  createdAt: "2026-06-16T09:23:58.323Z",
  thinking: {
    steps: [{ agent: "CampaignPublishAgent", action: "汇总并确认发布" }],
  },
};

test("thinking-only placeholder is visible in chat but not persisted", () => {
  assert.equal(isThinkingOnlyAssistantPlaceholder(placeholder), true);
  assert.equal(isChatVisibleMessage(placeholder), true);
  assert.equal(sanitizeMessageForStorage(placeholder), null);
  assert.deepEqual(normalizeSessionMessagesForStorage([placeholder]), []);
});

test("completed assistant keeps content and drops thinking.steps", () => {
  const stored = sanitizeMessageForStorage(completed);
  assert.equal(stored.content, completed.content);
  assert.equal(stored.thinking, undefined);
});

test("mergeSessionMessages does not duplicate empty assistant placeholders", () => {
  const remote = [completed, placeholder, placeholder, placeholder];
  const local = [completed, placeholder, placeholder];
  const merged = mergeSessionMessages(local, remote);
  const orphans = merged.filter(isThinkingOnlyAssistantPlaceholder);
  assert.equal(orphans.length, 0);
  assert.equal(merged.some((m) => m.content === completed.content), true);
});

test("merge self does not grow orphan count", () => {
  const msgs = [completed, placeholder, placeholder];
  const merged = mergeSessionMessages(msgs, msgs);
  assert.equal(
    merged.filter(isThinkingOnlyAssistantPlaceholder).length,
    0
  );
  assert.ok(merged.length <= msgs.length);
});

test("merge keeps repeated user commands with different createdAt", () => {
  const oldPause = {
    role: "user",
    content: "暂停",
    createdAt: "2026-06-16T09:00:00.000Z",
  };
  const resume = {
    role: "user",
    content: "恢复",
    createdAt: "2026-06-16T10:00:00.000Z",
  };
  const binResume = {
    role: "assistant",
    name: "Bin",
    content: "Campaign 状态已更新为「进行中」。",
    createdAt: "2026-06-16T10:00:01.000Z",
  };
  const newPause = {
    role: "user",
    content: "暂停",
    createdAt: "2026-06-16T10:05:00.000Z",
  };
  const binPause = {
    role: "assistant",
    name: "Bin",
    content: "Campaign 状态已更新为「已暂停」。",
    createdAt: "2026-06-16T10:05:01.000Z",
  };

  const remote = [oldPause, resume, binResume];
  const local = [oldPause, resume, binResume, newPause, binPause];
  const merged = mergeSessionMessages(local, remote);

  assert.equal(
    merged.filter((m) => m.role === "user" && m.content === "暂停").length,
    2
  );
  assert.ok(merged.some((m) => m.createdAt === newPause.createdAt));
});

test("sort: legacy (no createdAt) before timed; timed chronological at end", () => {
  const welcome = {
    role: "assistant",
    name: "Bin",
    content: "您好，我是Bin，告诉我您想推广的产品链接",
  };
  const legacyA = { role: "user", content: "确认发布" };
  const legacyB = {
    role: "assistant",
    name: "Bin",
    content: "Campaign 已发布。",
  };
  const timedOld = {
    role: "user",
    content: "暂停",
    createdAt: "2026-06-18T08:00:00.000Z",
  };
  const timedNew = {
    role: "assistant",
    name: "Bin",
    content: "已更新 Campaign 配置。",
    createdAt: "2026-06-18T08:30:59.348Z",
  };
  // 模拟旧 session 入库顺序：近期带时间戳在前、无时间戳历史在后（legacy 按原下标 2→3）
  const dbOrder = [timedNew, timedOld, legacyA, legacyB, welcome];
  const sorted = sortSessionMessagesByTime(dbOrder);

  assert.equal(sorted[0].content, welcome.content);
  assert.equal(sorted[1].content, legacyA.content);
  assert.equal(sorted[2].content, legacyB.content);
  assert.equal(sorted[3].content, timedOld.content);
  assert.equal(sorted[4].content, timedNew.content);
});

test("sort: new timed messages appear after legacy block (SHEGLAM-style)", () => {
  const legacy = [
    { role: "user", content: "帮我提升每日建联达人效率" },
    { role: "assistant", name: "Bin", content: "【执行进度汇报】日报" },
  ];
  const timed = [
    {
      role: "user",
      content: "画像更新",
      createdAt: "2026-06-18T08:30:48.864Z",
    },
    {
      role: "assistant",
      name: "Bin",
      content: "已更新 Campaign 配置。",
      createdAt: "2026-06-18T08:30:59.348Z",
    },
  ];
  const dbOrder = [...timed, ...legacy];
  const sorted = sortSessionMessagesByTime(dbOrder);
  assert.equal(sorted[0].content, legacy[0].content);
  assert.equal(sorted[1].content, legacy[1].content);
  assert.equal(sorted[2].content, timed[0].content);
  assert.equal(sorted[sorted.length - 1].content, timed[1].content);
});

test("merge with sessionCreatedAt blocks cross-campaign bulk contamination", () => {
  const welcome = {
    role: "assistant",
    name: "Bin",
    content: "您好，我是Bin，告诉我您想推广的产品链接",
  };
  const remote = [welcome];
  const hailuoBulk = Array.from({ length: 8 }, (_, i) => ({
    role: i % 2 === 0 ? "user" : "assistant",
    name: i % 2 === 0 ? undefined : "Bin",
    content: `hailuo history ${i}`,
    createdAt: `2026-06-11T10:0${i}:00.000Z`,
  }));
  const vastUser = {
    role: "user",
    content: "tripo3d.ai",
    createdAt: "2026-06-26T08:31:44.702Z",
  };
  const local = [welcome, ...hailuoBulk, vastUser];
  const merged = mergeSessionMessages(local, remote, {
    sessionCreatedAt: "2026-06-26T08:25:01.000Z",
  });
  assert.equal(merged.some((m) => String(m.content).startsWith("hailuo history")), false);
  assert.equal(merged.some((m) => m.content === vastUser.content), true);
});

test("trimMessagesBeforeSessionCreated removes pre-session foreign history", () => {
  const welcome = {
    role: "assistant",
    name: "Bin",
    content: "您好，我是Bin，告诉我您想推广的产品链接",
  };
  const foreign = {
    role: "user",
    content: "https://hailuoai.video/",
    createdAt: "2026-06-11T10:01:23.289Z",
  };
  const own = {
    role: "user",
    content: "tripo3d.ai",
    createdAt: "2026-06-26T08:31:44.702Z",
  };
  const trimmed = trimMessagesBeforeSessionCreated(
    [welcome, foreign, own],
    "2026-06-26T08:25:01.000Z"
  );
  assert.equal(trimmed.some((m) => m.content === foreign.content), false);
  assert.equal(trimmed.some((m) => m.content === own.content), true);
  assert.equal(trimmed.some((m) => m.content === welcome.content), true);
});

test("sort: all-timestamp session stays chronological", () => {
  const a = { role: "user", content: "a", createdAt: "2026-06-18T10:00:00.000Z" };
  const b = {
    role: "assistant",
    name: "Bin",
    content: "b",
    createdAt: "2026-06-18T10:00:05.000Z",
  };
  const sorted = sortSessionMessagesByTime([b, a]);
  assert.deepEqual(
    sorted.map((m) => m.content),
    ["a", "b"]
  );
});
