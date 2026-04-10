// 子 Agent 4: 确认内容要求 Agent
import { BaseAgent } from "./base-agent.js";
import { callDeepSeekLLM } from "../utils/llm-client.js";
import { generateImage } from "../tools/image-generator.js";

export class ContentRequirementAgent extends BaseAgent {
  constructor() {
    const systemPrompt = `你是内容创作专家。你的任务是基于产品信息、Campaign 信息和红人画像，生成给红人参考的内容脚本要求。

工作流程：
1. 分析产品信息（品牌、产品名、类型、特点等）
2. 分析 Campaign 信息（投放平台、地区、发布时间段、预算、佣金）
3. 分析红人画像要求（粉丝量、播放量、账户类型）
4. 基于以上信息，生成适合的内容脚本要求（包括标题、脚本正文、关键要点、时长建议）
5. 调用视频生成 API 生成参考视频（可选）
6. 将脚本要求和视频提供给客户确认

内容脚本要求：
- 标题要吸引人，符合目标平台的调性（TikTok 或 Instagram）
- 脚本要突出产品卖点，符合目标地区用户习惯
- 关键要点要清晰明确，便于红人理解和执行
- 时长建议要符合平台特点（TikTok 通常 15-60秒，Instagram 通常 30-90秒）
- 风格要符合推荐的红人画像类型

回复要专业、清晰，用中文与客户沟通。`;

    super("ContentRequirementAgent", systemPrompt);
  }

  /**
   * 生成内容脚本要求（文字脚本 + 可视化脚本）
   * @param {Array} messages - 消息历史
   * @param {Object} context - 上下文（包含 productInfo、campaignInfo、influencerProfile）
   * @param {Function} [onProgress] - 可选；长耗时阶段回调，用于向前端 SSE 推送进度/心跳，避免反向代理空闲超时断开。
   * @returns {Promise<Object>} - { reply: string, contentScript: Object, video: Object, isConfirmed: boolean }
   */
  async generateContent(messages, context = {}, onProgress = null) {
    const productInfo = context.productInfo || {};
    const campaignInfo = context.campaignInfo || {};
    const influencerProfile = context.influencerProfile || null;
    const previousContentScript = context.contentScript || null;

    console.log("[ContentRequirementAgent] 开始生成内容脚本", {
      hasProductInfo: !!productInfo?.productName,
      hasCampaignInfo: !!campaignInfo?.platform,
      productName: productInfo?.productName || null,
      platform: campaignInfo?.platform || null,
      region: campaignInfo?.region || null,
    });

    // 验证必要信息
    if (!productInfo || !productInfo.productName) {
      const reply = {
        reply: "抱歉，我需要先获取产品信息才能生成内容脚本。请先提供产品链接。",
        contentScript: null,
        isConfirmed: false,
      };
      console.log("[ContentRequirementAgent] 中断：缺少产品信息", { productInfo });
      return reply;
    }

    if (!campaignInfo || !campaignInfo.platform) {
      const reply = {
        reply: "抱歉，我需要 Campaign 信息（特别是投放平台）才能生成适合的内容脚本。请先完成 Campaign 信息确认。",
        contentScript: null,
        isConfirmed: false,
      };
      console.log("[ContentRequirementAgent] 中断：缺少 Campaign 信息", { campaignInfo });
      return reply;
    }

    try {
      onProgress?.({ phase: "start" });

      // 构建平台信息
      const platforms = Array.isArray(campaignInfo.platform) 
        ? campaignInfo.platform 
        : [campaignInfo.platform];
      const platformText = platforms.map(p => p === "Ins" ? "Instagram" : p).join("、");
      
      // 构建地区信息
      const regions = Array.isArray(campaignInfo.region) 
        ? campaignInfo.region 
        : [campaignInfo.region];
      const regionText = regions.join("、");

      // 构建红人画像信息
      let influencerProfileText = "未指定";
      if (influencerProfile) {
        const followerRange = influencerProfile.followerRange || "未指定";
        const viewRange = influencerProfile.viewRange || "未指定";
        const accountType = influencerProfile.accountType || "未指定";
        influencerProfileText = `粉丝量：${followerRange}，播放量：${viewRange}，账户类型：${accountType}`;
      }

      const lastUserMessage =
        messages
          .filter((m) => m.role === "user")
          .slice(-1)[0]?.content || "";

      // 使用 LLM 生成或「修改」内容脚本（文字部分）
      let scriptPrompt;

      if (previousContentScript && previousContentScript.script) {
        // 存在上一版脚本时，优先走「基于用户反馈的小幅修改」模式
        scriptPrompt = `你是短视频内容脚本编辑专家，负责在不打乱整体结构的前提下，根据客户的追加反馈「微调」现有脚本。

当前已有的脚本信息如下（请视为上一版定稿，只在必要处做修改）：
标题：${previousContentScript.title || "未命名脚本"}
脚本：
${previousContentScript.script}
要点：
${Array.isArray(previousContentScript.keyPoints) ? previousContentScript.keyPoints.map((p, i) => `${i + 1}. ${p}`).join("\n") : ""}
时长建议：${previousContentScript.duration || "未指定"}

最新一轮对话中，用户给出的补充或修改要求（尤其要重点关注用户的最后一句话）：
${lastUserMessage}

产品 & Campaign 背景信息（供你理解语境，不要推翻结构重写整篇，除非用户明确要求「重写」或「重新来一版」）：

产品信息：
- 品牌：${productInfo.brandName || "未知"}
- 产品：${productInfo.productName || "未知"}
- 类型：${productInfo.productType || "未知"}
- 描述：${productInfo.description || "无"}

Campaign 信息：
- 投放平台：${platformText}
- 投放地区：${regionText}
- 发布时间段：${campaignInfo.publishTimeRange || "未指定"}
- 预算：${campaignInfo.budget ? `$${campaignInfo.budget.toLocaleString()} USD` : "未指定"}
- 佣金：${campaignInfo.commission ? `${campaignInfo.commission}%` : "未指定"}

编辑原则（非常重要，请严格遵守）：
1. 如果用户只提到修改「某一段/某一个场景/最后一个镜头/结尾文案」等局部，请尽量只改相关部分，其他段落和镜头内容保持不变或只做轻微措辞优化。
2. 保留原脚本的整体结构和大部分信息，只在必要位置插入或替换句子，让新的脚本尽量是「上一版的自然升级版」，而不是完全不同的一套。
3. 如果用户的需求是新增信息（例如“结尾要强调注册送15美元免费额度”），可以在结尾镜头中加入/替换一句话，但不要删掉原有的行动号召逻辑。
4. 只有当用户明确说出「这版不行」「重写一个」「我要完全不一样的脚本」时，才考虑大幅改写。
5. 注意输出格式：每一行只能有一个「场景X：」前缀，禁止出现「场景1：场景1：……」这类重复。

请在遵守以上原则的前提下，输出一版新的脚本要求，重点按照「场景+画面+台词」的结构重写脚本部分，方便红人逐场景拍摄。

标题：[标题内容]
脚本：
场景1：画面【用一句话描述画面和镜头，例如“创作者本人对着镜头、表情困惑或疲惫”】；台词【对应这一镜头要说的话】
场景2：画面【...】；台词【...】
场景3：画面【...】；台词【...】
（依此类推，覆盖完整视频流程，首次生成时尽量控制在 3-5 个场景；如果用户后续明确要求增减场景，再按用户要求调整）
要点：
1. [要点1]
2. [要点2]
3. [要点3]
时长建议：[时长建议]`;
      } else {
        // 首次生成脚本：3-5 个场景，结构为 Hook + 核心卖点 + CTA
        scriptPrompt = `基于以下信息，生成一个适合的内容脚本要求：

产品信息：
- 品牌：${productInfo.brandName || "未知"}
- 产品：${productInfo.productName || "未知"}
- 类型：${productInfo.productType || "未知"}
- 描述：${productInfo.description || "无"}

Campaign 信息：
- 投放平台：${platformText}
- 投放地区：${regionText}
- 发布时间段：${campaignInfo.publishTimeRange || "未指定"}
- 预算：${campaignInfo.budget ? `$${campaignInfo.budget.toLocaleString()} USD` : "未指定"}
- 佣金：${campaignInfo.commission ? `${campaignInfo.commission}%` : "未指定"}

红人画像要求：
${influencerProfileText}

请生成：
1. 视频标题（吸引人、符合${platformText}平台调性，不超过30字）
2. 完整脚本文本：按照「场景+画面+台词」的结构输出，方便红人逐场景拍摄。每个场景一行，包含画面描述和对应台词，整体控制在 3-5 个场景，结构为：
   - 场景1：Hook 场景（痛点或吸引眼球的开头），例如：画面【创作者本人面对镜头，表情困惑或疲惫】；台词【天啊，又要做视频了...写脚本、拍、剪辑，头都大了！】
   - 场景2-3：核心卖点场景（展示产品/工具如何解决问题，突出 1-2 个最重要的卖点）
   - 场景4-5：CTA 场景（展示结果/好处，并给出明确的行动号召）
   如果确实需要更多细节，可以增加到最多 5 个场景；如果信息足够，用 3 个场景也可以。
   输出时每一行只能有一个「场景X：」前缀，禁止出现「场景1：场景1：……」这类重复。

用中文回复，格式如下：
标题：[标题内容]
脚本：
场景1：画面【...】；台词【...】
场景2：画面【...】；台词【...】
场景3：画面【...】；台词【...】
（如果需要，可继续到场景4、场景5，但总数不超过5）
时长建议：[时长建议]`;
      }

      onProgress?.({ phase: "script_llm" });
      const scriptResponse = await callDeepSeekLLM(
        [{ role: "user", content: scriptPrompt }],
        "你是一个内容创作专家，擅长基于产品、Campaign 和红人画像信息生成内容脚本要求。用中文回复，格式清晰。"
      );
      onProgress?.({ phase: "script_done" });
      
      console.log("[ContentRequirementAgent] LLM 脚本生成完成，前 200 字:", scriptResponse.substring(0, 200));

      // 解析脚本响应，提取标题、脚本和要点
      const titleMatch = scriptResponse.match(/标题[：:]\s*(.+?)(?:\n|$)/);
      const scriptMatch = scriptResponse.match(/脚本[：:]\s*([\s\S]+?)(?=要点|时长建议|$)/);
      const pointsMatch = scriptResponse.match(/要点[：:]\s*([\s\S]+?)(?=时长建议|$)/);
      const durationMatch = scriptResponse.match(/时长建议[：:]\s*(.+?)(?:\n|$)/);

      const title = titleMatch ? titleMatch[1].trim() : `${productInfo.productName || "产品"} - ${platformText} 新品种草推荐`;
      const script = scriptMatch ? scriptMatch[1].trim() : scriptResponse;
      const keyPoints = pointsMatch
        ? pointsMatch[1]
            .split(/\n/)
            .map((p) => p.replace(/^\d+[\.、]\s*/, "").trim())
            .filter((p) => p.length > 0)
            .slice(0, 4) // 关键要点最多保留 4 条
        : ["产品核心卖点", "使用场景"];
      const duration = durationMatch ? durationMatch[1].trim() : (platforms.includes("TikTok") ? "15-60秒" : "30-90秒");

      // 基于整段文字脚本生成「一张」可视化脚本示意图（包含多个场景）
      // 这张图用于给红人/创作者看，帮助理解全片结构和每个镜头要拍什么
      let visualImage = null;
      try {
        const compositePrompt = `You are designing a single vertical "visual script" image for a short-form social media video. The goal is to help creators quickly understand what to shoot and what to say for each scene.

The video script (Chinese) is structured as multiple lines, each like:
场景1：画面【...】；台词【...】
场景2：画面【...】；台词【...】
Use these lines as the canonical source of truth for both visuals and text.

Full script:
${script}

Product name: ${productInfo.productName || "unknown"}
Platform: ${platformText} (e.g. TikTok means vertical, fast-paced, authentic; Instagram means high-quality aesthetic reels)
Region: ${regionText}

TOP-TO-BOTTOM LAYOUT for the visual script image:
1) Header area:
   - Large title text: "<Brand> <Product> Visual Script" (in English, using the actual brand and product names where possible).
   - Below the title, a short line labeled "Copy:" that summarizes the main video copy in 1 sentence (English).
   - Below that, a line labeled "Tags:" that shows the video hashtags (e.g. #HeyGen#FreeAIVideoGenerator#AItools).

2) Script area (main body), directly below the header:
   - Create 3-5 rows, each row corresponding to one scene line from the script (场景1, 场景2, 场景3 ...). The number of rows should match the number of script scenes as closely as possible (usually 3-5).
   - For each row i:
     - On the LEFT: draw a photo-realistic frame that visually matches the "画面" description from scene i (camera angle, setting, emotion), in a modern TikTok/Reels style (no sketches or line art).
     - On the RIGHT: place clear English text that paraphrases the "台词" from scene i. It should be 1-2 short sentences (around 15-25 words total), easy for creators to read and say out loud. The wording must be derived from the original 台词, not random slogans or nonsense words.

3) Key takeaways area at the bottom:
   - A small section labeled "Key points:" followed by 2-4 numbered bullet points in English.
   - Each bullet should summarize one of the key points from the script (e.g. pain point, core benefit, CTA). These bullets must be consistent with the script content above.

General style requirements:
- Vertical 9:16 canvas suitable for mobile screen.
- Match the style of ${platformText} content (for TikTok: vertical smartphone footage, energetic, casual; for Instagram: visually polished reels, good lighting and composition).
- Use high contrast, clearly visible colors and clean sans-serif typography so that every header, row label and text block is easy to read on a phone screen (avoid very light, faded sketches, noisy backgrounds, or distorted letters).
- Make sure the product ${productInfo.productName || "the product"} is clearly visible in all relevant frames where the script talks about the product or results, with appearance and colors consistent with the original product photos on the e-commerce page.

Now, craft a single detailed English prompt for an image generation model (such as DALL·E or MiniMax) to generate this ONE vertical "visual script" image with the exact layout and behavior described above.
Constraints:
- The returned prompt MUST be under 1200 characters.
- Use a single paragraph (no line breaks).

Return ONLY the prompt text, no extra explanation.`;

        console.log("[ContentRequirementAgent] 准备为可视化脚本生成英文图片提示词（prompt）");
        onProgress?.({ phase: "visual_prompt_llm" });

        const visualPromptResponse = await callDeepSeekLLM(
          [{ role: "user", content: compositePrompt }],
          "You are an expert storyboard visual designer. Return ONLY one detailed English prompt for an image generation model."
        );
        onProgress?.({ phase: "visual_prompt_done" });

        const rawPrompt =
          (visualPromptResponse || "")
            .toString()
            .replace(/\s+/g, " ")
            .trim() ||
          `Vertical storyboard composite image, 4 panels top-to-bottom, ${platformText} style vertical smartphone footage, captions per panel, product ${productInfo.productName || "a product"} visible.`;

        const finalImagePrompt =
          rawPrompt.length > 1400 ? rawPrompt.slice(0, 1400) : rawPrompt;

        if (rawPrompt.length !== finalImagePrompt.length) {
          console.log("[ContentRequirementAgent] 英文 prompt 已截断以满足长度限制", {
            rawLength: rawPrompt.length,
            finalLength: finalImagePrompt.length,
          });
        }

        console.log("[ContentRequirementAgent] 可视化脚本最终英文 prompt:", finalImagePrompt);

        onProgress?.({ phase: "image_gen_start" });
        // 文生图（尤其 ToAPIs Gemini 异步轮询）可能持续 1–5 分钟，期间若 SSE 无任何字节，
        // 常见 Nginx / 负载均衡会在 60s 空闲断开，导致前端永远收不到 complete。
        let imageHeartbeat = null;
        if (typeof onProgress === "function") {
          imageHeartbeat = setInterval(() => {
            onProgress({ phase: "image_gen_heartbeat" });
          }, 12000);
        }
        let imgResult;
        try {
          imgResult = await generateImage({
            prompt: finalImagePrompt,
            productImage: productInfo.productImage || "",
          });
        } finally {
          if (imageHeartbeat) clearInterval(imageHeartbeat);
        }
        onProgress?.({ phase: "image_gen_done" });

        console.log("[ContentRequirementAgent] 图片生成结果:", {
          status: imgResult?.status,
          imageUrl: imgResult?.imageUrl,
          message: imgResult?.message,
        });

        if (!imgResult?.imageUrl || imgResult?.status === "error") {
          throw new Error(imgResult?.message || "图片生成失败：未返回 imageUrl");
        }

        visualImage = {
          prompt: finalImagePrompt,
          imageUrl: imgResult.imageUrl,
          status: imgResult.status || "succeeded",
          message: imgResult.message || "",
        };
      } catch (visualError) {
        console.warn("[ContentRequirementAgent] 生成可视化脚本示意图失败:", visualError);
        visualImage = {
          prompt: "",
          imageUrl: "",
          status: "error",
          message: visualError.message || "可视化脚本示意图生成失败，已使用占位图。",
        };
      }

      const contentScript = {
        title,
        script,
        keyPoints,
        duration,
        platform: platformText,
        region: regionText,
        // 新增：可视化脚本示意图（单张合成图）
        visualImage,
      };

      console.log("[ContentRequirementAgent] 内容脚本结构:", {
        title: contentScript.title,
        duration: contentScript.duration,
        platform: contentScript.platform,
        hasVisualImage: !!contentScript.visualImage?.imageUrl,
      });

      // 构建回复（结构化：品牌 + 文案+标签 + 场景脚本 + 要点 + 图片）
      const brandLine = `${productInfo.brandName || ""}${productInfo.productName ? ` · ${productInfo.productName}` : ""}`.trim() || (productInfo.productName || "本次 Campaign");

      // 使用 LLM 基于产品信息生成 3-5 个视频标签（而不是硬编码规则）
      let hashtags = "";
      try {
        const tagPrompt = `基于下面的产品信息，生成一行适合短视频脚本使用的「视频标签」，总共 3-5 个标签，用 # 开头连写在一起。

产品信息：
- 品牌：${productInfo.brandName || "未知"}
- 产品：${productInfo.productName || "未知"}
- 品类/类型：${productInfo.productType || productInfo.category || "未知"}

只输出这一行标签字符串，不要任何解释。`;

        const tagResp = await callDeepSeekLLM(
          [{ role: "user", content: tagPrompt }],
          "你是短视频营销文案专家，只返回一行标签字符串。"
        );
        hashtags = (tagResp || "").split("\n")[0].trim();
      } catch (e) {
        console.warn("[ContentRequirementAgent] 生成视频标签失败，使用兜底规则:", e);
        const categoryTag = productInfo.productType || productInfo.category || "";
        hashtags = [
          productInfo.brandName ? `#${productInfo.brandName}` : "",
          productInfo.productName ? `#${productInfo.productName}` : "",
          categoryTag ? `#${categoryTag}` : "",
        ]
          .filter(Boolean)
          .join("");
      }

      // 将脚本按行拆成「场景」方便红人逐段阅读（场景数量由脚本本身决定）
      const scriptScenes = contentScript.script
        .split("\n")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);

      let reply = `我已经为你生成了内容脚本要求：

**品牌与产品**: ${brandLine}
**视频文案**: ${contentScript.title}
**视频标签**: ${hashtags || "#campaign"}

**脚本：**`;

      if (scriptScenes.length) {
        // 这里的每一行脚本本身已经包含「场景X：画面【...】；台词【...】」前缀和结构
        // 展示时直接使用原行，避免出现「场景1：场景1：...」这样的重复前缀
        reply += "\n" + scriptScenes.join("\n");
      } else {
        reply += `\n${contentScript.script}`;
      }

      reply += `\n\n**关键要点：**\n${contentScript.keyPoints
        .map((p, i) => `${i + 1}. ${p}`)
        .join("\n")}`;

      if (contentScript.visualImage && contentScript.visualImage.imageUrl) {
        reply += `\n\n以下是给红人看的可视化脚本，方便红人理解每个场景要拍什么、说什么：\n`;
        // 在前端消息中嵌入图片（使用自定义 [IMAGE:url] 标记渲染）
        reply += `\n[IMAGE:${contentScript.visualImage.imageUrl}]`;
      }

      reply += `\n\n你可以直接告诉我：\n- 想修改哪一段文案或要点\n- 哪个分镜的画面不合适、想怎么调整\n我会根据你的反馈重新生成对应的脚本和可视化分镜。确认无误后，我们进入下一阶段。`;

      // 判断用户是否确认内容要求
      const isConfirmed = await this.detectConfirmation(messages, {
        ...context,
        contentScript,
      });

      console.log("[ContentRequirementAgent] 内容生成完成，是否判断为已确认:", isConfirmed);

      return {
        reply,
        contentScript,
        video: null,
        isConfirmed,
      };
    } catch (error) {
      console.error("[ContentRequirementAgent] 生成内容失败:", error);
      return {
        reply: `抱歉，生成内容脚本时出现错误：${error.message}。请稍后再试。`,
        contentScript: null,
        video: null,
        isConfirmed: false,
      };
    }
  }

  /**
   * 检测用户是否确认内容要求
   * @param {Array} messages - 消息历史
   * @param {Object} context - 上下文（包含 contentScript）
   * @returns {Promise<boolean>} - 是否确认
   */
  async detectConfirmation(messages, context = {}) {
    const lastMessage = messages[messages.length - 1]?.content || "";
    const contentScript = context.contentScript;
    const conversationHistory = messages.slice(-3).map(m => `${m.role}: ${m.content}`).join("\n");

    // 如果没有内容脚本，不需要判断确认
    if (!contentScript) {
      return false;
    }

    const prompt = `判断用户是否确认了内容脚本要求。

对话历史：
${conversationHistory}

内容脚本信息：
- 标题：${contentScript.title || "未指定"}
- 平台：${contentScript.platform || "未指定"}
- 时长建议：${contentScript.duration || "未指定"}

如果用户确认内容脚本（如"确认"、"正确"、"无误"、"可以"、"好的"、"行"、"没问题"、"继续"、"下一步"、"无需调整"、"不需要调整"等），返回 true。
如果用户要求调整脚本，返回 false。
如果消息不明确或只是询问，返回 false。

只返回 JSON 格式：
{
  "confirmed": true | false
}`;

    try {
      const llmResponse = await callDeepSeekLLM(
        [{ role: "user", content: prompt }],
        "你是一个意图识别专家，擅长判断用户是否确认信息。只返回 JSON 格式，不要其他文字。"
      );

      try {
        const result = JSON.parse(llmResponse);
        return result.confirmed === true;
      } catch (e) {
        const jsonMatch = llmResponse.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const result = JSON.parse(jsonMatch[0]);
          return result.confirmed === true;
        }
        return false;
      }
    } catch (error) {
      console.warn("[ContentRequirementAgent] 判断确认失败:", error);
      return false;
    }
  }
}

