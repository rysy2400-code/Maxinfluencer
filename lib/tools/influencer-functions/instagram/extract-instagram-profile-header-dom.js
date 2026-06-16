/**
 * Instagram Reels / 主页 header：DOM + 内嵌 JSON 轻量补全 bio / userId（不点 About）
 */

/**
 * @param {import('playwright').Page} page
 * @param {string} username
 * @returns {Promise<{ bio?: string, userId?: string, displayName?: string, source?: string }|null>}
 */
export async function extractInstagramProfileHeaderFromPage(page, username) {
  if (!page || typeof page.evaluate !== "function") return null;
  const handle = String(username || "").replace(/^@/, "").trim().toLowerCase();
  if (!handle) return null;

  try {
    return await page.evaluate((expectedHandle) => {
      /** @type {{ bio: string|null, userId: string|null, displayName: string|null, source: string|null }} */
      const result = {
        bio: null,
        userId: null,
        displayName: null,
        source: null,
      };

      const isUsernameLine = (text) =>
        String(text || "")
          .trim()
          .replace(/^@/, "")
          .toLowerCase() === expectedHandle;

      const isNoiseLine = (text) => {
        const t = String(text || "").trim();
        if (!t || t.length > 600) return true;
        const lower = t.toLowerCase();
        if (isUsernameLine(t)) return true;
        if (/^[\d,.]+[km]?$/.test(lower)) return true;
        if (/^(posts|post|followers|following|reels|tagged|帖子|粉丝|关注|已关注|关注者)$/i.test(t)) {
          return true;
        }
        if (/^(follow|message|发消息|分享|分享主页|联系|联系方式)$/i.test(t)) return true;
        if (t.length <= 2) return true;
        return false;
      };

      const walkJson = (obj, depth = 0) => {
        if (depth > 14 || !obj || typeof obj !== "object") return;
        if (Array.isArray(obj)) {
          for (const x of obj) walkJson(x, depth + 1);
          return;
        }
        const uname = obj.username ? String(obj.username).replace(/^@/, "").toLowerCase() : null;
        const matches =
          uname === expectedHandle ||
          (obj.pk && obj.biography != null) ||
          (obj.id && obj.biography != null);
        if (matches) {
          if (obj.biography && !result.bio) {
            result.bio = String(obj.biography).trim();
            result.source = "embedded_json";
          }
          const pk = obj.pk || obj.id;
          if (pk && !result.userId) result.userId = String(pk);
          if (obj.full_name && !result.displayName) {
            result.displayName = String(obj.full_name).trim();
          }
        }
        for (const v of Object.values(obj)) {
          if (typeof v === "object" && v) walkJson(v, depth + 1);
        }
      };

      for (const script of document.querySelectorAll('script[type="application/json"]')) {
        const text = script.textContent || "";
        if (!text.includes("biography") && !text.includes('"pk"') && !text.includes('"id"')) {
          continue;
        }
        try {
          walkJson(JSON.parse(text));
        } catch {
          /* ignore */
        }
      }

      const header = document.querySelector("header");
      if (header) {
        if (!result.userId) {
          const anchors = header.querySelectorAll(`a[href*="/${expectedHandle}/"]`);
          for (const a of anchors) {
            const href = a.getAttribute("href") || "";
            const m = href.match(/\/(\d+)\/?$/);
            if (m?.[1]) {
              result.userId = m[1];
              result.source = result.source || "header_link";
              break;
            }
          }
        }

        if (!result.bio) {
          const testBio = header.querySelector('[data-testid="user-bio"]');
          if (testBio) {
            const t = (testBio.innerText || testBio.textContent || "").trim();
            if (t && !isNoiseLine(t)) {
              result.bio = t;
              result.source = result.source || "header_dom";
            }
          }
        }

        if (!result.bio) {
          const sections = header.querySelectorAll("section");
          for (const section of sections) {
            const lines = (section.innerText || "")
              .split("\n")
              .map((l) => l.trim())
              .filter(Boolean);
            for (const line of lines) {
              if (isNoiseLine(line)) continue;
              if (
                line.includes("@") ||
                line.includes("http") ||
                line.split(/\s+/).length >= 2 ||
                /[^\u0000-\u007f]/.test(line)
              ) {
                result.bio = line;
                result.source = result.source || "header_dom";
                break;
              }
            }
            if (result.bio) break;
          }
        }
      }

      if (!result.bio && !result.userId) return null;
      return result;
    }, handle);
  } catch (e) {
    console.warn(
      `[extractInstagramProfileHeaderFromPage] @${handle}: ${e?.message || e}`
    );
    return null;
  }
}
