// 联网搜索工具：爬取产品 HTML 并提取信息
// 注意：cheerio 只在服务端使用，使用动态导入

/**
 * 爬取网页 HTML 内容（带重试机制）
 */
async function fetchHTML(url, retries = 2) {
  const isTikTok = url.includes('tiktok.com') || url.includes('shop.tiktok.com');
  const isAmazon = url.includes('amazon.com') || url.includes('amazon.cn');
  
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
        "Accept-Language":
          isTikTok || isAmazon ? "en-US,en;q=0.9" : "zh-CN,zh;q=0.9,en;q=0.8",
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

function decodeBasicHtmlEntities(str) {
  if (!str || typeof str !== "string") return "";
  return str
    .replace(/&#x27;/gi, "'")
    .replace(/&#39;/g, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

/** Amazon 列表页标题：去掉「Amazon.com :」前缀与末尾「 : 类目」等 */
function normalizeAmazonListingTitle(raw) {
  if (!raw) return "";
  let t = decodeBasicHtmlEntities(String(raw)).trim();
  t = t.replace(/^Amazon\.(?:com|co\.[a-z.]+|cn)\s*:\s*/i, "");
  const idx = t.lastIndexOf(" : ");
  if (idx > 0) {
    const tail = t.slice(idx + 3).trim();
    if (tail.length <= 120 && tail.length >= 3 && !/\d{4,}/.test(tail)) {
      t = t.slice(0, idx).trim();
    }
  }
  t = t.replace(/^Amazon\.(?:com|co\.[a-z.]+|cn)\s*$/i, "").trim();
  return t;
}

function cleanAmazonBylineBrand(raw) {
  if (!raw) return "";
  const s = decodeBasicHtmlEntities(String(raw)).replace(/\s+/g, " ").trim();
  const m = s.match(/Visit the\s+(.+?)\s+Store\b/i);
  if (m) return m[1].trim();
  return s.replace(/^by\s+/i, "").trim();
}

/** 标准商品 URL：/…/dp/ASIN/ 中 slug 的第一段常为品牌（如 Anker-Portable-…） */
function parseAmazonDpSlug(pageUrl) {
  try {
    const path = new URL(pageUrl).pathname;
    const m = path.match(/\/([^/]+)\/dp\/([A-Z0-9]{10})(?:\/|$)/i);
    if (!m) return null;
    return { slug: m[1], asin: m[2] };
  } catch {
    return null;
  }
}

function inferAmazonBrandFromProductUrl(pageUrl) {
  const p = parseAmazonDpSlug(pageUrl);
  if (!p) return "";
  const first = p.slug.split("-")[0] || "";
  if (/^[A-Za-z][A-Za-z0-9+]*$/i.test(first) && first.length >= 2) return first;
  return "";
}

function productTitleHintFromAmazonProductUrl(pageUrl) {
  const p = parseAmazonDpSlug(pageUrl);
  if (!p) return "";
  return p.slug.replace(/-/g, " ").replace(/\s+/g, " ").trim();
}

function amazonSlugHintForPrompt(pageUrl) {
  return productTitleHintFromAmazonProductUrl(pageUrl);
}

/**
 * Amazon：服务端常被挡成验证码页，cheerio 无 #productTitle；用正则从原始 HTML 抓 meta/title/Visit the X Store
 */
function extractAmazonHtmlStringFallbacks(html) {
  const out = { productTitle: "", brandName: "", productImage: "" };
  if (!html || typeof html !== "string") return out;

  let ogTitle = "";
  const mOg1 = html.match(/property=["']og:title["'][^>]*content=["']([^"']+)["']/i);
  const mOg2 = html.match(/content=["']([^"']+)["'][^>]*property=["']og:title["']/i);
  if (mOg1) ogTitle = mOg1[1].trim();
  else if (mOg2) ogTitle = mOg2[1].trim();

  const mTitle = html.match(/<title[^>]*>([^<]{1,800})<\/title>/i);
  const titleText = mTitle ? mTitle[1].replace(/\s+/g, " ").trim() : "";

  const primary = normalizeAmazonListingTitle(ogTitle || titleText);
  if (primary) out.productTitle = primary;

  const mVisit = html.match(/Visit the\s+([^<]{1,120}?)\s+Store\b/i);
  if (mVisit) {
    out.brandName = decodeBasicHtmlEntities(mVisit[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
  }

  const mImg1 = html.match(/property=["']og:image["'][^>]*content=["']([^"']+)["']/i);
  const mImg2 = html.match(/content=["']([^"']+)["'][^>]*property=["']og:image["']/i);
  const ogImg = mImg1 ? mImg1[1] : mImg2 ? mImg2[1] : "";
  if (ogImg && /^https?:\/\//i.test(ogImg)) out.productImage = ogImg;

  return out;
}

/**
 * TikTok Shop 页面多为 CSR：服务端 fetch 常拿到壳 HTML，cheerio 选不到节点。
 * 用正则从原始 HTML 抓 og:title / og:image / <title> / Sold by，不依赖完整 DOM。
 */
function extractTikTokHtmlStringFallbacks(html) {
  const out = { productTitle: "", brandName: "", productImage: "", soldByStoreMatch: false };
  if (!html || typeof html !== "string") return out;

  let ogTitle = "";
  const mOg1 = html.match(/property=["']og:title["'][^>]*content=["']([^"']+)["']/i);
  const mOg2 = html.match(/content=["']([^"']+)["'][^>]*property=["']og:title["']/i);
  if (mOg1) ogTitle = mOg1[1].trim();
  else if (mOg2) ogTitle = mOg2[1].trim();

  const mTitle = html.match(/<title[^>]*>([^<]{1,500})<\/title>/i);
  const titleText = mTitle ? mTitle[1].replace(/\s+/g, " ").trim() : "";

  let primary = decodeBasicHtmlEntities(ogTitle || titleText);
  primary = primary.replace(/\s*-\s*TikTok\s*Shop\s*$/i, "").trim();
  if (primary) out.productTitle = primary;

  // 页面内可能出现多处 "Sold by"，优先取「… Store」形态的店铺名（PDP 卖家）
  const soldMatches = [...html.matchAll(/Sold\s+by\s+([^<\n\r]{1,120})/gi)];
  for (const m of soldMatches) {
    const raw = decodeBasicHtmlEntities(m[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
    if (!raw) continue;
    if (/\bStore\b/i.test(raw)) {
      out.brandName = raw.replace(/\s+Store\s*$/i, "").trim();
      out.soldByStoreMatch = true;
      break;
    }
  }
  if (!out.brandName && soldMatches.length > 0) {
    const raw = decodeBasicHtmlEntities(
      soldMatches[0][1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()
    );
    if (raw.split(/\s+/).length <= 5 && raw.length <= 60) out.brandName = raw.replace(/\s+Store\s*$/i, "").trim();
  }

  const mImg1 = html.match(/property=["']og:image["'][^>]*content=["']([^"']+)["']/i);
  const mImg2 = html.match(/content=["']([^"']+)["'][^>]*property=["']og:image["']/i);
  const ogImg = mImg1 ? mImg1[1] : mImg2 ? mImg2[1] : "";
  if (ogImg && /^https?:\/\//i.test(ogImg)) out.productImage = ogImg;

  return out;
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

  // 品牌名：不用任意首个 /shop/ 链接（常为推荐位误匹配），优先专用节点再 Sold by 文本
  const brandName =
    $('[data-e2e="shop-name"]').text().trim() ||
    $('.shop-name').text().trim() ||
    (() => {
      const bodyText = $('body').text();
      const matches = [...bodyText.matchAll(/Sold\s+by\s+([^\n]+)/gi)];
      for (const m of matches) {
        const seg = m[1].trim();
        if (/\bStore\b/i.test(seg)) {
          return seg.replace(/\s+Store\s*$/i, "").trim();
        }
      }
      const first = matches[0];
      if (first) return first[1].trim().split(/\s+/)[0] || "";
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
function buildLLMPrompt(structuredData, metaTags, websiteInfo, websiteType, pageUrl = "") {
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
  if (websiteType === "amazon") {
    const hasAmz =
      websiteInfo.productTitle ||
      websiteInfo.brandName ||
      websiteInfo.productImage ||
      metaTags.ogTitle ||
      metaTags.title ||
      metaTags.description;
    const slugHint = pageUrl ? amazonSlugHintForPrompt(pageUrl) : "";
    if (hasAmz || slugHint) {
      prompt += `\nAmazon 产品信息（可能来自页面 DOM、meta、正则回退或 URL 路径）:\n`;
      prompt += `- 产品标题: ${websiteInfo.productTitle || normalizeAmazonListingTitle(metaTags.ogTitle || metaTags.title) || "(无)"}\n`;
      prompt += `- 品牌/卖家行: ${websiteInfo.brandName || "(无)"}\n`;
      prompt += `- 图片: ${websiteInfo.productImage || metaTags.ogImage || "(无)"}\n`;
      if (websiteInfo.description) prompt += `- 描述摘录: ${websiteInfo.description}\n`;
      if (slugHint) prompt += `- URL 中的商品关键词（slug，可作补充）: ${slugHint}\n`;
    }
  } else if (websiteType === 'tiktok') {
    // TikTok：即使 DOM 为空，也可能只有 meta/正则回退，仍要把片段交给 LLM
    const hasTik =
      websiteInfo.productTitle ||
      websiteInfo.brandName ||
      websiteInfo.productImage ||
      metaTags.ogTitle ||
      metaTags.title;
    if (hasTik) {
      prompt += `\nTikTok Shop 产品信息（可能来自页面 meta 或正则回退）:\n`;
      prompt += `- 产品标题: ${websiteInfo.productTitle || metaTags.ogTitle || metaTags.title || "(无)"}\n`;
      prompt += `- 品牌/店铺: ${websiteInfo.brandName || "(无)"}\n`;
      prompt += `- 图片: ${websiteInfo.productImage || metaTags.ogImage || "(无)"}\n`;
    }
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
function enrichProductInfo(productInfo, structuredData, metaTags, websiteInfo, websiteType, pageUrl) {
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
    productInfo.productName =
      websiteType === "amazon"
        ? normalizeAmazonListingTitle(websiteInfo.productTitle)
        : websiteInfo.productTitle;
  }
  if (websiteInfo.brandName && (!productInfo.brandName || productInfo.brandName === "未知")) {
    productInfo.brandName =
      websiteType === "amazon" ? cleanAmazonBylineBrand(websiteInfo.brandName) : websiteInfo.brandName;
  }
  if (websiteInfo.productImage && (!productInfo.productImage || productInfo.productImage === "未知" || !productInfo.productImage)) {
    productInfo.productImage = websiteInfo.productImage;
  }

  // 从 meta 标签补充
  if ((!productInfo.productImage || productInfo.productImage === "未知" || !productInfo.productImage) && metaTags.ogImage) {
    productInfo.productImage = metaTags.ogImage;
  }
  if ((!productInfo.productName || productInfo.productName === "未知") && metaTags.ogTitle) {
    if (websiteType === "amazon") {
      productInfo.productName = normalizeAmazonListingTitle(decodeBasicHtmlEntities(metaTags.ogTitle));
    } else {
      productInfo.productName = decodeBasicHtmlEntities(metaTags.ogTitle)
        .replace(/\s*-\s*TikTok\s*Shop\s*$/i, "")
        .trim();
    }
  }
  if (
    websiteType === "amazon" &&
    (!productInfo.productName || productInfo.productName === "未知") &&
    metaTags.title
  ) {
    const t = normalizeAmazonListingTitle(decodeBasicHtmlEntities(metaTags.title));
    if (t && t.length > 3) productInfo.productName = t;
  }

  // TikTok：标题多为「品牌 + 产品描述」，LLM 仍可能漏填品牌（取首个英文/数字品牌词，含 G4Free 这类）
  if (websiteType === "tiktok" && (!productInfo.brandName || productInfo.brandName === "未知")) {
    const pn = productInfo.productName;
    if (pn && pn !== "未知") {
      const m = pn.match(/^([A-Za-z0-9]+(?:\+[A-Za-z0-9]+)*)\b/);
      if (m && m[1].length >= 2) productInfo.brandName = m[1];
    }
  }

  // Amazon：机房 IP 常被验证码页拦截，meta/DOM 为空时用 /slug/dp/ASIN 回退
  if (websiteType === "amazon" && pageUrl) {
    if (!productInfo.productName || productInfo.productName === "未知") {
      const hint = productTitleHintFromAmazonProductUrl(pageUrl);
      if (hint) productInfo.productName = hint;
    }
    if (!productInfo.brandName || productInfo.brandName === "未知") {
      const fromUrl = inferAmazonBrandFromProductUrl(pageUrl);
      if (fromUrl) productInfo.brandName = fromUrl;
      else {
        const pn = productInfo.productName;
        if (pn && pn !== "未知") {
          const m = pn.match(/^([A-Za-z0-9]+(?:\+[A-Za-z0-9]+)*)\b/);
          if (m && m[1].length >= 2) productInfo.brandName = m[1];
        }
      }
    }
  }

  // 修复图片 URL（确保是绝对路径，并转换为 HTTPS）
  if (productInfo.productImage && productInfo.productImage !== "未知" && productInfo.productImage.trim()) {
    let imageUrl = productInfo.productImage.trim();
    
    // 如果是相对路径，转换为绝对路径
    if (!imageUrl.startsWith("http://") && !imageUrl.startsWith("https://")) {
      try {
        if (!pageUrl) throw new Error("missing pageUrl");
        const baseUrl = new URL(pageUrl);
        imageUrl = new URL(imageUrl, baseUrl.origin).href;
        console.log(`[WebScraper] 图片 URL 已转换为绝对路径: ${imageUrl}`);
      } catch (e) {
        console.warn(`[WebScraper] 图片 URL 转换失败: ${imageUrl}`, e);
        try {
          if (!pageUrl) throw new Error("missing pageUrl");
          const baseUrl = new URL(pageUrl);
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
    let websiteInfo = extractWebsiteSpecificInfo($, websiteType);
    if (websiteType === "tiktok") {
      const fb = extractTikTokHtmlStringFallbacks(html);
      if (!websiteInfo.productTitle && fb.productTitle) websiteInfo = { ...websiteInfo, productTitle: fb.productTitle };
      if (fb.brandName && (fb.soldByStoreMatch || !websiteInfo.brandName)) {
        websiteInfo = { ...websiteInfo, brandName: fb.brandName };
      }
      if (!websiteInfo.productImage && fb.productImage) websiteInfo = { ...websiteInfo, productImage: fb.productImage };
      if (!metaTags.ogTitle && fb.productTitle) metaTags.ogTitle = fb.productTitle;
      if (!metaTags.ogImage && fb.productImage) metaTags.ogImage = fb.productImage;
    }
    if (websiteType === "amazon") {
      const fb = extractAmazonHtmlStringFallbacks(html);
      if (!websiteInfo.productTitle && fb.productTitle) websiteInfo = { ...websiteInfo, productTitle: fb.productTitle };
      if (!websiteInfo.brandName && fb.brandName) websiteInfo = { ...websiteInfo, brandName: fb.brandName };
      if (!websiteInfo.productImage && fb.productImage) websiteInfo = { ...websiteInfo, productImage: fb.productImage };
      if (!metaTags.ogTitle && fb.productTitle) metaTags.ogTitle = fb.productTitle;
      if (!metaTags.ogImage && fb.productImage) metaTags.ogImage = fb.productImage;
    }
    console.log(`[WebScraper] 网站特定信息:`, websiteInfo);

    // 7. 构建精简的 LLM Prompt
    const prompt = buildLLMPrompt(structuredData, metaTags, websiteInfo, websiteType, url);
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
    productInfo = enrichProductInfo(productInfo, structuredData, metaTags, websiteInfo, websiteType, url);

    console.log(`[WebScraper] 最终结果:`, productInfo);
    return productInfo;

  } catch (error) {
    console.error("[WebScraper] 爬取失败:", error);
    throw error;
  }
}
