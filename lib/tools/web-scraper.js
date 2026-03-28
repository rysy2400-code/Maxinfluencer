// 联网搜索工具：爬取产品 HTML 并提取信息
// 注意：cheerio 只在服务端使用，使用动态导入

/**
 * 爬取网页 HTML 内容（带重试机制）
 */
async function fetchHTML(url, retries = 2) {
  const isTikTok = url.includes('tiktok.com') || url.includes('shop.tiktok.com');
  
  // TikTok Shop 需要更长的超时时间
  const timeout = isTikTok ? 30000 : 15000; // TikTok 30秒，其他 15秒
  
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeout);

      // 根据网站类型使用不同的请求头
      const headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
        "Accept-Language": isTikTok ? "en-US,en;q=0.9" : "zh-CN,zh;q=0.9,en;q=0.8",
        "Accept-Encoding": "gzip, deflate, br",
        "Cache-Control": "no-cache",
        "Pragma": "no-cache",
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "none",
        "Sec-Fetch-User": "?1",
        "Upgrade-Insecure-Requests": "1",
      };

      // TikTok Shop 需要额外的请求头
      if (isTikTok) {
        headers["Referer"] = "https://www.tiktok.com/";
        headers["Origin"] = "https://www.tiktok.com";
      }

      const response = await fetch(url, {
        headers,
        signal: controller.signal,
        redirect: "follow", // 跟随重定向
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const html = await response.text();
      console.log(`[WebScraper] HTML 爬取成功 (尝试 ${attempt + 1}/${retries + 1}): ${html.length} 字符`);
      return html;

    } catch (error) {
      const isLastAttempt = attempt === retries;
      
      if (error.name === 'AbortError') {
        console.warn(`[WebScraper] 请求超时 (尝试 ${attempt + 1}/${retries + 1}): ${url}`);
      } else {
        console.warn(`[WebScraper] 请求失败 (尝试 ${attempt + 1}/${retries + 1}): ${error.message}`);
      }

      if (isLastAttempt) {
        throw new Error(`无法访问该链接（已重试 ${retries + 1} 次）: ${error.message}`);
      }

      // 等待后重试（指数退避）
      const delay = Math.min(1000 * Math.pow(2, attempt), 5000);
      console.log(`[WebScraper] ${delay}ms 后重试...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

/**
 * 检测网站类型
 */
function detectWebsiteType(url) {
  if (url.includes('amazon.com') || url.includes('amazon.cn')) {
    return 'amazon';
  }
  if (url.includes('tiktok.com') || url.includes('shop.tiktok.com')) {
    return 'tiktok';
  }
  return 'standalone';
}

/**
 * 提取 JSON-LD 结构化数据
 */
function extractJSONLD($) {
  const jsonLdData = [];
  $('script[type="application/ld+json"]').each((i, el) => {
    try {
      const content = $(el).html();
      if (content) {
        jsonLdData.push(JSON.parse(content));
      }
    } catch (e) {
      // 忽略解析错误
    }
  });
  return jsonLdData;
}

/**
 * 提取 meta 标签信息
 */
function extractMetaTags($) {
  return {
    title: $("title").text() || "",
    description: $('meta[name="description"]').attr("content") || "",
    ogTitle: $('meta[property="og:title"]').attr("content") || "",
    ogImage: $('meta[property="og:image"]').attr("content") || "",
    ogDescription: $('meta[property="og:description"]').attr("content") || "",
  };
}

/**
 * 提取 Amazon 特定信息
 */
function extractAmazonInfo($) {
  return {
    productTitle: $('#productTitle').text().trim() || 
                  $('h1.a-size-large').text().trim() || "",
    brandName: $('#bylineInfo').text().trim() || 
               $('a#brand').text().trim() || "",
    productImage: $('#landingImage').attr('src') || 
                  $('#main-image').attr('src') || "",
    description: $('#productDescription').text().trim().substring(0, 200) || "",
  };
}

/**
 * 提取 TikTok Shop 特定信息
 */
function extractTikTokInfo($) {
  // 根据实际网页内容提取
  // 产品标题通常在 h1 或特定选择器中
  const productTitle = 
    $('h1').first().text().trim() ||
    $('[data-e2e="product-title"]').text().trim() ||
    $('.product-title').text().trim() ||
    "";

  // 品牌名通常在 "Sold by" 或店铺名称中
  const brandName = 
    $('a[href*="/shop/"]').first().text().trim() ||
    $('.shop-name').text().trim() ||
    $('[data-e2e="shop-name"]').text().trim() ||
    // 尝试从页面文本中提取 "Sold by" 后的品牌名
    (() => {
      const bodyText = $('body').text();
      const match = bodyText.match(/Sold by\s+([^\n]+)/i);
      if (match) {
        // 提取品牌名（可能包含 "Store" 等后缀）
        const brand = match[1].trim().split(/\s+/)[0];
        return brand;
      }
      return "";
    })() ||
    "";

  // 产品图片（优先选择产品主图）
  const productImage = (() => {
    // 1. 优先：og:image meta 标签（最可靠的产品主图）
    const ogImage = $('meta[property="og:image"]').attr('content');
    if (ogImage && ogImage.startsWith('http')) {
      return ogImage;
    }

    // 2. 优先：产品图片轮播的第一张图片（通常是主图）
    const carouselFirstImg = 
      $('.product-carousel img').first().attr('src') ||
      $('.image-carousel img').first().attr('src') ||
      $('[class*="carousel"] img').first().attr('src') ||
      $('[class*="gallery"] img').first().attr('src') ||
      "";
    if (carouselFirstImg && carouselFirstImg.startsWith('http')) {
      return carouselFirstImg;
    }

    // 3. 优先：特定的 data-e2e 属性（TikTok Shop 常用）
    const dataE2eImg = $('[data-e2e*="image" i]').first().attr('src') ||
                       $('[data-e2e*="product-image" i]').attr('src') ||
                       "";
    if (dataE2eImg && dataE2eImg.startsWith('http')) {
      return dataE2eImg;
    }

    // 4. 优先：产品图片容器中的第一张图片
    const productImageContainer = 
      $('.product-image img').first().attr('src') ||
      $('.product-photo img').first().attr('src') ||
      $('[class*="product-image" i] img').first().attr('src') ||
      "";
    if (productImageContainer && productImageContainer.startsWith('http')) {
      return productImageContainer;
    }

    // 5. 备选：选择最大的图片（通常是产品主图，排除小图标）
    let largestImg = "";
    let maxSize = 0;
    $('img').each((i, el) => {
      const $img = $(el);
      const src = $img.attr('src') || $img.attr('data-src') || $img.attr('data-lazy-src');
      
      if (!src || !src.startsWith('http')) return;
      
      // 排除明显不是产品主图的图片（小图标、logo等）
      const alt = ($img.attr('alt') || '').toLowerCase();
      const srcLower = src.toLowerCase();
      if (alt.includes('icon') || alt.includes('logo') || 
          srcLower.includes('icon') || srcLower.includes('logo') ||
          srcLower.includes('avatar') || srcLower.includes('profile')) {
        return;
      }

      // 计算图片大小（优先使用实际尺寸，其次使用属性）
      let width = parseInt($img.attr('width')) || 
                  parseInt($img.css('width')) || 
                  parseInt($img.attr('data-width')) || 0;
      let height = parseInt($img.attr('height')) || 
                   parseInt($img.css('height')) || 
                   parseInt($img.attr('data-height')) || 0;
      
      // 如果无法获取尺寸，使用默认值（假设是较大的图片）
      if (width === 0 && height === 0) {
        width = 500; // 假设是中等大小的图片
        height = 500;
      }

      const size = width * height;
      
      // 只考虑较大的图片（至少 200x200，排除小图标）
      if (size > maxSize && width >= 200 && height >= 200) {
        maxSize = size;
        largestImg = src;
      }
    });
    
    if (largestImg) {
      return largestImg;
    }

    // 6. 最后备选：任何包含产品相关关键词的图片
    return $('img[alt*="product" i]').first().attr('src') ||
           $('img[src*="product" i]').first().attr('src') ||
           "";
  })();

  // 产品描述
  const description = 
    $('.product-description').text().trim() ||
    $('[data-e2e="product-description"]').text().trim() ||
    $('.about-this-product').text().trim() ||
    "";

  return {
    productTitle,
    brandName,
    productImage,
    description: description.substring(0, 300),
  };
}

/**
 * 提取独立站特定信息
 */
function extractStandaloneInfo($) {
  // 尝试提取主要产品区域
  const mainContent = $("main").text() || 
                      $("article").text() || 
                      $(".product-detail").text() ||
                      $(".product-info").text() ||
                      "";
  
  // 提取产品图片（多种选择器）
  const productImage = 
    $('meta[property="og:image"]').attr('content') ||
    $('img[alt*="product" i]').first().attr('src') ||
    $('.product-image img').first().attr('src') ||
    $('.product-photo img').first().attr('src') ||
    $('.product-gallery img').first().attr('src') ||
    $('img[class*="product" i]').first().attr('src') ||
    "";
  
  return {
    mainContent: mainContent.replace(/\s+/g, " ").trim().substring(0, 300),
    productImage: productImage,
  };
}

/**
 * 根据网站类型提取特定信息
 */
function extractWebsiteSpecificInfo($, websiteType) {
  switch (websiteType) {
    case 'amazon':
      return extractAmazonInfo($);
    case 'tiktok':
      return extractTikTokInfo($);
    default:
      return extractStandaloneInfo($);
  }
}

/**
 * 构建精简的 LLM Prompt
 */
function buildLLMPrompt(structuredData, metaTags, websiteInfo, websiteType) {
  let prompt = "从以下网页信息中提取产品信息：\n\n";

  // 1. 结构化数据（最准确）
  const productJsonLd = structuredData.find(item => 
    item['@type'] === 'Product' || item['@type'] === 'http://schema.org/Product'
  );
  if (productJsonLd) {
    prompt += `结构化数据 (JSON-LD):\n${JSON.stringify({
      name: productJsonLd.name,
      brand: productJsonLd.brand,
      image: productJsonLd.image,
      description: productJsonLd.description
    }, null, 2)}\n\n`;
  }

  // 2. Meta 标签
  prompt += `网页标题: ${metaTags.ogTitle || metaTags.title}\n`;
  prompt += `描述: ${metaTags.ogDescription || metaTags.description}\n`;
  if (metaTags.ogImage) {
    prompt += `图片: ${metaTags.ogImage}\n`;
  }

  // 3. 网站特定信息
  if (websiteType === 'amazon' && websiteInfo.productTitle) {
    prompt += `\nAmazon 产品信息:\n`;
    prompt += `- 产品标题: ${websiteInfo.productTitle}\n`;
    if (websiteInfo.brandName) prompt += `- 品牌: ${websiteInfo.brandName}\n`;
    if (websiteInfo.productImage) prompt += `- 图片: ${websiteInfo.productImage}\n`;
    if (websiteInfo.description) prompt += `- 描述: ${websiteInfo.description}\n`;
  } else if (websiteType === 'tiktok' && websiteInfo.productTitle) {
    prompt += `\nTikTok Shop 产品信息:\n`;
    prompt += `- 产品标题: ${websiteInfo.productTitle}\n`;
    if (websiteInfo.brandName) prompt += `- 品牌: ${websiteInfo.brandName}\n`;
    if (websiteInfo.productImage) prompt += `- 图片: ${websiteInfo.productImage}\n`;
  } else if (websiteInfo.mainContent) {
    prompt += `\n主要内容: ${websiteInfo.mainContent}\n`;
    if (websiteInfo.productImage) {
      prompt += `- 图片: ${websiteInfo.productImage}\n`;
    }
  }

  prompt += `\n请提取以下信息（如果无法确定，使用"未知"）：\n`;
  prompt += `1. 品牌名\n`;
  prompt += `2. 产品名\n`;
  prompt += `3. 产品图片 URL（必须是完整的 HTTP/HTTPS URL）\n`;
  prompt += `4. 产品类型（电商、游戏、应用，三选一）\n`;
  prompt += `5. 是否寄样（true/false）\n`;
  prompt += `   重要规则：\n`;
  prompt += `   - 如果产品类型是"电商"，则 needSample 必须为 true（电商产品需要寄样给红人）\n`;
  prompt += `   - 如果产品类型是"游戏"或"应用"，则 needSample 必须为 false（数字产品不需要寄样）\n\n`;
  prompt += `只返回 JSON 格式：\n`;
  prompt += `{"brandName":"","productName":"","productImage":"","productType":"电商/游戏/应用","needSample":true/false}`;

  return prompt;
}

/**
 * 从提取结果中补充信息（优先使用结构化数据）
 */
function enrichProductInfo(productInfo, structuredData, metaTags, websiteInfo, websiteType) {
  // 从 JSON-LD 补充
  const productJsonLd = structuredData.find(item => 
    item['@type'] === 'Product' || item['@type'] === 'http://schema.org/Product'
  );
  
  if (productJsonLd) {
    if ((!productInfo.brandName || productInfo.brandName === "未知") && productJsonLd.brand) {
      productInfo.brandName = typeof productJsonLd.brand === 'string' 
        ? productJsonLd.brand 
        : productJsonLd.brand.name || productJsonLd.brand;
    }
    if ((!productInfo.productName || productInfo.productName === "未知") && productJsonLd.name) {
      productInfo.productName = productJsonLd.name;
    }
    if ((!productInfo.productImage || productInfo.productImage === "未知") && productJsonLd.image) {
      productInfo.productImage = Array.isArray(productJsonLd.image) 
        ? productJsonLd.image[0] 
        : productJsonLd.image;
    }
  }

  // 从网站特定信息补充
  if (websiteInfo.productTitle && (!productInfo.productName || productInfo.productName === "未知")) {
    productInfo.productName = websiteInfo.productTitle;
  }
  if (websiteInfo.brandName && (!productInfo.brandName || productInfo.brandName === "未知")) {
    productInfo.brandName = websiteInfo.brandName;
  }
  if (websiteInfo.productImage && (!productInfo.productImage || productInfo.productImage === "未知" || !productInfo.productImage)) {
    productInfo.productImage = websiteInfo.productImage;
  }

  // 从 meta 标签补充
  if ((!productInfo.productImage || productInfo.productImage === "未知" || !productInfo.productImage) && metaTags.ogImage) {
    productInfo.productImage = metaTags.ogImage;
  }
  if ((!productInfo.productName || productInfo.productName === "未知") && metaTags.ogTitle) {
    productInfo.productName = metaTags.ogTitle;
  }

  // 修复图片 URL（确保是绝对路径，并转换为 HTTPS）
  if (productInfo.productImage && productInfo.productImage !== "未知" && productInfo.productImage.trim()) {
    let imageUrl = productInfo.productImage.trim();
    
    // 如果是相对路径，转换为绝对路径
    if (!imageUrl.startsWith("http://") && !imageUrl.startsWith("https://")) {
      try {
        // 尝试从原始 URL 构建绝对路径
        const baseUrl = new URL(url);
        imageUrl = new URL(imageUrl, baseUrl.origin).href;
        console.log(`[WebScraper] 图片 URL 已转换为绝对路径: ${imageUrl}`);
      } catch (e) {
        console.warn(`[WebScraper] 图片 URL 转换失败: ${imageUrl}`, e);
        // 如果转换失败，尝试使用原始 URL 的域名
        try {
          const baseUrl = new URL(url);
          imageUrl = `${baseUrl.origin}${imageUrl.startsWith('/') ? '' : '/'}${imageUrl}`;
        } catch (e2) {
          console.warn(`[WebScraper] 图片 URL 修复失败: ${imageUrl}`);
          productInfo.productImage = "";
          return productInfo;
        }
      }
    }
    
    // 验证 URL 格式
    try {
      const urlObj = new URL(imageUrl);
      
      // 关键修复：将 HTTP 转换为 HTTPS（解决混合内容问题）
      if (urlObj.protocol === "http:") {
        urlObj.protocol = "https:";
        imageUrl = urlObj.href;
        console.log(`[WebScraper] 图片 URL 已从 HTTP 转换为 HTTPS: ${imageUrl}`);
      }
      
      productInfo.productImage = imageUrl;
    } catch (e) {
      console.warn(`[WebScraper] 图片 URL 格式无效: ${imageUrl}`, e);
      productInfo.productImage = "";
    }
  } else {
    productInfo.productImage = "";
  }

  // 业务规则：根据产品类型判断是否需要寄样（覆盖 LLM 的判断）
  if (productInfo.productType === "电商") {
    productInfo.needSample = true; // 电商产品默认需要寄样
    console.log(`[WebScraper] 应用业务规则：电商产品 → needSample = true`);
  } else if (productInfo.productType === "游戏" || productInfo.productType === "应用") {
    productInfo.needSample = false; // 游戏和应用不需要寄样
    console.log(`[WebScraper] 应用业务规则：${productInfo.productType} → needSample = false`);
  }

  return productInfo;
}

/**
 * 爬取产品信息（主函数）
 */
export async function scrapeProductInfo(url, llmExtract) {
  try {
    if (!url || !url.startsWith("http")) {
      throw new Error("无效的产品链接");
    }

    console.log(`[WebScraper] 开始爬取: ${url}`);

    // 1. 爬取 HTML
    const html = await fetchHTML(url);
    console.log(`[WebScraper] HTML 长度: ${html.length} 字符`);

    // 2. 解析 HTML
    const cheerio = await import("cheerio");
    const $ = cheerio.load(html);

    // 3. 检测网站类型
    const websiteType = detectWebsiteType(url);
    console.log(`[WebScraper] 网站类型: ${websiteType}`);

    // 4. 提取结构化数据
    const structuredData = extractJSONLD($);
    console.log(`[WebScraper] 找到 ${structuredData.length} 个 JSON-LD 数据`);

    // 5. 提取 meta 标签
    const metaTags = extractMetaTags($);

    // 6. 提取网站特定信息
    const websiteInfo = extractWebsiteSpecificInfo($, websiteType);
    console.log(`[WebScraper] 网站特定信息:`, websiteInfo);

    // 7. 构建精简的 LLM Prompt
    const prompt = buildLLMPrompt(structuredData, metaTags, websiteInfo, websiteType);
    console.log(`[WebScraper] Prompt 长度: ${prompt.length} 字符`);

    // 8. 调用 LLM 提取
    const extractedInfo = await llmExtract(prompt);
    console.log(`[WebScraper] LLM 返回: ${extractedInfo.substring(0, 200)}`);

    // 9. 解析 JSON
    let productInfo;
    try {
      productInfo = JSON.parse(extractedInfo);
    } catch (e) {
      const jsonMatch = extractedInfo.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        productInfo = JSON.parse(jsonMatch[0]);
      } else {
        throw new Error("无法解析 LLM 返回的 JSON");
      }
    }

    // 10. 补充信息
    productInfo.productLink = url;
    productInfo = enrichProductInfo(productInfo, structuredData, metaTags, websiteInfo, websiteType);

    console.log(`[WebScraper] 最终结果:`, productInfo);
    return productInfo;

  } catch (error) {
    console.error("[WebScraper] 爬取失败:", error);
    throw error;
  }
}
