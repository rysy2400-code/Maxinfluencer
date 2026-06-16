import assert from "node:assert/strict";
import test from "node:test";
import {
  isChatVisibleMessage,
  isThinkingOnlyAssistantPlaceholder,
  mergeSessionMessages,
  normalizeSessionMessagesForStorage,
  sanitizeMessageForStorage,
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
