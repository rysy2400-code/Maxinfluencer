// 视频生成工具：调用视频生成 API

/**
 * 生成视频（使用第三方 API 或占位符）
 * @param {Object} options - 生成选项
 * @param {string} options.script - 内容脚本
 * @param {string} options.productName - 产品名
 * @param {string} options.productImage - 产品图片 URL（可选）
 * @returns {Promise<Object>} - 视频信息 { videoUrl, thumbnailUrl, status }
 */
export async function generateVideo(options = {}) {
  const { script, productName, productImage } = options;

  // 检查环境变量中是否配置了视频生成 API
  const videoApiKey = process.env.VIDEO_API_KEY;
  const videoApiUrl = process.env.VIDEO_API_URL;

  // 如果没有配置 API，返回占位符
  if (!videoApiKey || !videoApiUrl) {
    console.log("[VideoGenerator] 未配置视频生成 API，返回占位符");
    return {
      videoUrl: "",
      thumbnailUrl: productImage || "",
      status: "pending",
      message: "视频生成功能需要配置 API。当前返回占位符，实际部署时需要集成 Runway/Pika 等视频生成服务。",
    };
  }

  try {
    // 这里可以集成不同的视频生成 API
    // 示例：Runway API
    if (videoApiUrl.includes("runway")) {
      return await generateWithRunway(script, productImage, videoApiKey);
    }

    // 示例：Pika API
    if (videoApiUrl.includes("pika")) {
      return await generateWithPika(script, productImage, videoApiKey);
    }

    // 通用 API 调用
    return await generateWithGenericAPI(script, productImage, videoApiUrl, videoApiKey);
  } catch (error) {
    console.error("[VideoGenerator] 视频生成失败:", error);
    // 降级：返回占位符
    return {
      videoUrl: "",
      thumbnailUrl: productImage || "",
      status: "error",
      message: `视频生成失败: ${error.message}`,
    };
  }
}

/**
 * 使用 Runway API 生成视频
 */
async function generateWithRunway(script, productImage, apiKey) {
  // TODO: 实现 Runway API 调用
  // 参考: https://docs.runwayml.com/
  // Next.js 18+ 内置 fetch，无需导入
  const response = await fetch("https://api.runwayml.com/v1/generate", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      prompt: script.substring(0, 500), // 截取前 500 字符
      image: productImage,
      duration: 5, // 5秒
    }),
  });

  if (!response.ok) {
    throw new Error(`Runway API 错误: ${response.statusText}`);
  }

  const data = await response.json();
  return {
    videoUrl: data.video_url || "",
    thumbnailUrl: data.thumbnail_url || productImage || "",
    status: data.status || "pending",
    taskId: data.task_id,
  };
}

/**
 * 使用 Pika API 生成视频
 */
async function generateWithPika(script, productImage, apiKey) {
  // TODO: 实现 Pika API 调用
  // 参考: https://docs.pika.art/
  // Next.js 18+ 内置 fetch，无需导入
  const response = await fetch("https://api.pika.art/v1/generate", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      prompt: script.substring(0, 500),
      image: productImage,
    }),
  });

  if (!response.ok) {
    throw new Error(`Pika API 错误: ${response.statusText}`);
  }

  const data = await response.json();
  return {
    videoUrl: data.video_url || "",
    thumbnailUrl: data.thumbnail_url || productImage || "",
    status: data.status || "pending",
    taskId: data.task_id,
  };
}

/**
 * 通用 API 调用（自定义视频生成服务）
 */
async function generateWithGenericAPI(script, productImage, apiUrl, apiKey) {
  // Next.js 18+ 内置 fetch，无需导入
  const response = await fetch(apiUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      script: script.substring(0, 1000),
      image: productImage,
      duration: 30, // 30秒
    }),
  });

  if (!response.ok) {
    throw new Error(`视频生成 API 错误: ${response.statusText}`);
  }

  const data = await response.json();
  return {
    videoUrl: data.videoUrl || data.video_url || "",
    thumbnailUrl: data.thumbnailUrl || data.thumbnail_url || productImage || "",
    status: data.status || "pending",
    taskId: data.taskId || data.task_id,
  };
}

