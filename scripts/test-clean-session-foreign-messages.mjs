import assert from "node:assert/strict";
import test from "node:test";
import { findForeignBlockStart } from "../lib/chat/session-messages.js";

test("findForeignBlockStart locates ribbi block after hailuo messages", () => {
  const messages = [
    { role: "user", content: "https://hailuoai.video/" },
    { role: "assistant", content: "Hailuo AI 产品确认" },
    { role: "user", content: "执行进度问题" },
    { role: "assistant", content: "Hailuo 执行说明" },
    { role: "user", content: "https://ribbi.ai/" },
    { role: "assistant", content: "Ribbi 产品确认" },
  ];
  assert.equal(
    findForeignBlockStart(messages, {
      ownMarkers: ["hailuo", "hailuoai"],
      foreignMarker: "ribbi.ai",
    }),
    4
  );
});

test("findForeignBlockStart returns -1 when no foreign block", () => {
  const messages = [
    { role: "user", content: "https://hailuoai.video/" },
    { role: "assistant", content: "ok" },
  ];
  assert.equal(
    findForeignBlockStart(messages, {
      ownMarkers: ["hailuo"],
      foreignMarker: "ribbi.ai",
    }),
    -1
  );
});
