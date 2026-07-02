/** Lite 模式 page.goto 计数（CDP 真实导航，不含 fetch/HTML） */

const stats = {
  count: 0,
  urls: [],
};

export function resetLitePageNavStats() {
  stats.count = 0;
  stats.urls = [];
}

export function getLitePageNavStats() {
  return { count: stats.count, urls: [...stats.urls] };
}

export function attachLitePageNavTracker(page) {
  if (!page || page._ttLiteNavTracked || typeof page.goto !== "function") return;
  page._ttLiteNavTracked = true;
  const origGoto = page.goto.bind(page);
  page.goto = async (url, opts) => {
    stats.count += 1;
    const u = String(url || "");
    stats.urls.push(u);
    console.log(`[lite-page-nav] #${stats.count} ${u.slice(0, 160)}`);
    return origGoto(url, opts);
  };
}
