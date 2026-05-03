/**
 * 将爬虫 onStepUpdate 原始事件规范化为与 /api/chat SSE 相同的 thinking 片段，
 * 便于右侧「工作实况」与发布阶段红人画像使用同一套展示逻辑。
 */
import { updateSteps } from "./browser-steps.js";

/**
 * @param {(event: { type: string, data?: unknown }) => void} emit -  emit 对齐 chat：thinking | screenshot
 */
export function createWorkLiveStepBridge(emit) {
  let browserSteps = [];
  let screenshots = [];
  let influencerAnalyses = [];
  const MAX_SCREENSHOTS = 60;

  const sendThinking = (patch = {}) => {
    emit({
      type: "thinking",
      data: {
        browserSteps: [...browserSteps],
        screenshots: [...screenshots],
        influencerAnalyses: [...influencerAnalyses],
        ...patch,
      },
    });
  };

  return function onWorkLiveRawUpdate(raw) {
    if (!raw || typeof raw !== "object") return;

    if (raw.type === "screenshot" && raw.image) {
      const newShot = {
        stepId: raw.stepId,
        label: raw.label,
        image: raw.image,
        timestamp: raw.timestamp || new Date().toISOString(),
      };
      screenshots = [...screenshots, newShot].slice(-MAX_SCREENSHOTS);
      emit({ type: "screenshot", data: newShot });
      sendThinking();
      return;
    }

    if (raw.type === "step" && raw.step) {
      browserSteps = updateSteps(browserSteps, raw.step);
      sendThinking();
      return;
    }

    if (raw.type === "influencerAnalysis" && raw.influencer) {
      // 工作实况只保留「当前 1 位」完整分析，降低 SSE/前端压力（与截图策略一致）
      influencerAnalyses = [raw.influencer];
      sendThinking();
    }
  };
}
