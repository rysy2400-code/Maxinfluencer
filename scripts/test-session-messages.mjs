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
