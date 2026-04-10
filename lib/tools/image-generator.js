// 图片生成工具：调用图片生成 API 或返回占位图

/**
 * 生成可视化图片（使用第三方 API 或占位符）
 * @param {Object} options - 生成选项
 * @param {string} options.prompt - 图片生成描述（必填）
 * @param {string} [options.productImage] - 产品图片 URL（可选，用作占位或参考）
 * @returns {Promise<Object>} - 图片信息 { imageUrl, status, message? }
 */
export async function generateImage(options = {}) {
  const { prompt, productImage } = options;

  if (!prompt || typeof prompt !== "string") {
    return {
      imageUrl: "",
      status: "error",
      message: "缺少图片生成 prompt。",
    };
  }

  const imageApiKey = process.env.IMAGE_API_KEY;
  const imageApiUrl = process.env.IMAGE_API_URL;

  // 未配置图片生成 API 时，返回占位结果（使用产品图或空字符串）
  if (!imageApiKey || !imageApiUrl) {
    console.log("[ImageGenerator] 未配置图片生成 API");
    return {
      imageUrl: "",
      status: "error",
      message:
        "图片生成功能需要配置 IMAGE_API_URL/IMAGE_API_KEY。",
    };
  }

  try {
    // 针对 ToAPIs Gemini 文生图接口做适配（https://toapis.com/v1/images/generations）
    if (imageApiUrl.includes("toapis.com") && imageApiUrl.includes("/v1/images/generations")) {
      const safePrompt = prompt.length > 1000 ? prompt.slice(0, 1000) : prompt;
      if (safePrompt.length !== prompt.length) {
        console.log("[ImageGenerator] Gemini prompt 超长，已截断", {
          rawLength: prompt.length,
          finalLength: safePrompt.length,
        });
      }

      const geminiBody = {
        model: "gemini-2.5-flash-image-preview",
        prompt: safePrompt,
        size: "9:16", // 与原来 MiniMax 的竖屏比例保持一致
        n: 1,
      };

      if (productImage) {
        geminiBody.image_urls = [productImage];
      }

      console.log("[ImageGenerator] 调用 ToAPIs Gemini 文生图 API", {
        url: imageApiUrl,
        hasPrompt: !!prompt,
        promptLength: prompt.length,
        body: { ...geminiBody, prompt: `[len=${prompt.length}]` },
      });

      const taskResp = await fetch(imageApiUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${imageApiKey}`,
        },
        body: JSON.stringify(geminiBody),
      });

      if (!taskResp.ok) {
        const text = await taskResp.text().catch(() => "");
        throw new Error(`Gemini 任务创建失败: ${taskResp.status} ${taskResp.statusText} ${text}`);
      }

      const taskData = await taskResp.json();
      const taskId =
        taskData?.id ||
        taskData?.task_id ||
        taskData?.taskId ||
        null;

      if (!taskId) {
        throw new Error("Gemini 响应中未找到任务 ID");
      }

      console.log("[ImageGenerator] Gemini 任务已创建", {
        taskId,
        status: taskData.status,
      });

      // 轮询任务状态，直到拿到图片 URL 或超时
      // 说明：部分模型/高峰期可能超过 120s，这里允许通过环境变量调大超时时间
      const startTime = Date.now();
      const maxWaitMs = Number(process.env.IMAGE_TASK_MAX_WAIT_MS || 300_000);
      const baseIntervalMs = Number(process.env.IMAGE_TASK_POLL_INTERVAL_MS || 3_000);

      const baseStatusUrl = imageApiUrl.replace(/\/$/, "");
      let lastStatus = null;

      let attempts = 0;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        if (Date.now() - startTime > maxWaitMs) {
          throw new Error("Gemini 图片生成任务超时");
        }

        const statusResp = await fetch(`${baseStatusUrl}/${taskId}`, {
          method: "GET",
          headers: {
            Authorization: `Bearer ${imageApiKey}`,
          },
        });

        if (!statusResp.ok) {
          const text = await statusResp.text().catch(() => "");
          throw new Error(`Gemini 任务查询失败: ${statusResp.status} ${statusResp.statusText} ${text}`);
        }

        const statusData = await statusResp.json();
        lastStatus = statusData.status;

        console.log("[ImageGenerator] Gemini 任务轮询状态", {
          taskId,
          status: statusData.status,
          progress: statusData.progress,
        });

        if (statusData.status === "completed") {
          const urlFromResult =
            statusData?.result?.data?.[0]?.url ||
            statusData?.url ||
            "";

          if (!urlFromResult) {
            throw new Error("Gemini 任务完成但未返回图片 URL");
          }

          return {
            imageUrl: urlFromResult,
            status: "succeeded",
            message: "",
          };
        }

        if (statusData.status === "failed") {
          const errMsg =
            statusData?.error?.message ||
            statusData?.error?.code ||
            "未知错误";
          throw new Error(`Gemini 图片生成失败: ${errMsg}`);
        }

        attempts += 1;
        const intervalMs = attempts >= 10 ? Math.min(baseIntervalMs * 2, 10_000) : baseIntervalMs;
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
      }
    }

    // 针对 MiniMax 文生图接口做适配
    if (imageApiUrl.includes("minimaxi.com") || imageApiUrl.includes("minimax")) {
      const safePrompt = prompt.length > 1490 ? prompt.slice(0, 1490) : prompt;
      if (safePrompt.length !== prompt.length) {
        console.log("[ImageGenerator] prompt 超长，已截断", {
          rawLength: prompt.length,
          finalLength: safePrompt.length,
        });
      }
      const minimaxBody = {
        model: "image-01",
        prompt: safePrompt,
        n: 1,
        // 竖屏更贴近短视频分镜参考图
        aspect_ratio: "9:16",
        response_format: "url",
      };

      console.log("[ImageGenerator] 调用 MiniMax 文生图 API", {
        url: imageApiUrl,
        hasPrompt: !!prompt,
        promptLength: prompt.length,
        body: { ...minimaxBody, prompt: `[len=${prompt.length}]` },
      });

      const response = await fetch(imageApiUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${imageApiKey}`,
        },
        body: JSON.stringify(minimaxBody),
      });

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(`MiniMax API 错误: ${response.status} ${response.statusText} ${text}`);
      }

      const rawText = await response.text().catch(() => "");
      let data = null;
      try {
        data = rawText ? JSON.parse(rawText) : null;
      } catch {
        data = null;
      }

      console.log("[ImageGenerator] MiniMax 原始响应（截断）:", rawText ? rawText.slice(0, 1200) : "");

      // MiniMax 常见：HTTP 200 但通过 base_resp/status_code 表达业务错误
      const baseStatusCode =
        data?.base_resp?.status_code ??
        data?.baseResp?.statusCode ??
        data?.base_resp?.statusCode ??
        null;
      const baseStatusMsg =
        data?.base_resp?.status_msg ??
        data?.baseResp?.statusMsg ??
        data?.base_resp?.statusMsg ??
        null;
      if (baseStatusCode != null && Number(baseStatusCode) !== 0) {
        throw new Error(`MiniMax base_resp 错误: ${baseStatusCode} ${baseStatusMsg || ""}`.trim());
      }

      // 官方文档常见结构：{ data: { image_url: [ ... ] } }（url 模式）
      // 兼容一些可能的历史/变体字段
      const urlFromData =
        // 你当前实际返回：{ data: { image_urls: [...] } }
        (Array.isArray(data?.data?.image_urls) ? data.data.image_urls[0] : null) ||
        (Array.isArray(data?.data?.imageUrls) ? data.data.imageUrls[0] : null) ||
        (Array.isArray(data?.data?.image_url) ? data.data.image_url[0] : null) ||
        (Array.isArray(data?.data?.imageUrl) ? data.data.imageUrl[0] : null) ||
        data?.data?.image_urls ||
        data?.data?.imageUrls ||
        data?.data?.image_url ||
        data?.data?.imageUrl ||
        data?.data?.[0]?.url ||
        data?.data?.[0]?.image_url ||
        data?.imageUrl ||
        data?.image_url ||
        "";

      console.log("[ImageGenerator] MiniMax 返回数据概要", {
        hasDataUrl: !!urlFromData,
        keys: data ? Object.keys(data) : null,
        dataKeys: data?.data ? Object.keys(data.data) : null,
      });

      // 如果 MiniMax 响应里没有图片 URL，视为错误（不再退回到 productImage）
      if (!urlFromData) {
        throw new Error(`MiniMax 响应中未找到图片 URL，响应 dataKeys=${JSON.stringify(data?.data ? Object.keys(data.data) : null)}`);
      }

      return {
        imageUrl: urlFromData,
        status: data?.status || "succeeded",
        message: data?.message || "",
      };
    }

    // 默认通用 HTTP 接口
    console.log("[ImageGenerator] 调用通用图片生成 API", {
      url: imageApiUrl,
      hasPrompt: !!prompt,
    });

    const response = await fetch(imageApiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${imageApiKey}`,
      },
      body: JSON.stringify({
        prompt,
        referenceImage: productImage || null,
      }),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`图片生成 API 错误: ${response.status} ${response.statusText} ${text}`);
    }

    const data = await response.json();
    return {
      imageUrl: data.imageUrl || data.image_url || "",
      status: data.status || "succeeded",
      message: data.message || "",
    };
  } catch (error) {
    console.error("[ImageGenerator] 图片生成失败:", error);
    // 降级：不再强制回退到 productImage，只返回错误状态
    return {
      imageUrl: "",
      status: "error",
      message: `图片生成失败: ${error.message}`,
    };
  }
}

