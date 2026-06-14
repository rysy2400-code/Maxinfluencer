#!/usr/bin/env node
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: path.join(root, ".env") });

const username = process.argv[2] || "devdoesreviews";
const endpoint = process.env.CDP_ENDPOINT_ENRICH || "http://127.0.0.1:9223";

const { acquireTiktokApiSession, fetchUserDetail, fetchPostItemList, resolveVideoLocationCreated } =
  await import("../lib/tools/influencer-functions/tiktok/tiktok-direct-fetch.js");

const session = await acquireTiktokApiSession(null, { endpointKey: endpoint });
const { page } = session;

try {
  const detail = await fetchUserDetail(page, username, {});
  console.log("[probe] detail keys=", detail ? Object.keys(detail) : null);
  console.log("[probe] detail preview=", JSON.stringify(detail).slice(0, 400));
  const user = detail?.userInfo?.user || detail?.userInfo || detail?.user;
  const secUid = user?.secUid || user?.sec_uid;
  console.log("[probe] user/detail secUid=", secUid ? "yes" : "no", "keys=", user ? Object.keys(user).slice(0, 15) : []);

  if (secUid) {
    const listJson = await fetchPostItemList(page, {
      secUid,
      count: 10,
      referer: `https://www.tiktok.com/@${username}`,
    });
    const items = listJson?.itemList || listJson?.item_list || [];
    console.log("[probe] item_list count=", items.length);
    for (const it of items.slice(0, 3)) {
      console.log("  video", it.id, "locationCreated=", it.locationCreated ?? "null");
    }
    if (items[0]?.id) {
      const loc = await resolveVideoLocationCreated(page, {
        username,
        secUid,
        videoId: items[0].id,
      });
      console.log("[probe] resolveVideoLocationCreated=", loc);
    }
  }
} finally {
  await session.dispose();
}
