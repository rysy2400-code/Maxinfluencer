import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { COOKIE_NAME, verifyAdvertiserToken } from "../../lib/auth/advertiser-jwt.js";
import { getAdvertiserUserById } from "../../lib/db/tiktok-advertiser-dao.js";

export const metadata = {
  title: "Maxinfluencer 虚拟机运维",
  description: "Crawler 机器角色、真实任务执行健康、生产版本与运维操作",
};

export default async function CrawlerOpsLayout({ children }) {
  const token = cookies().get(COOKIE_NAME)?.value || null;
  const claims = await verifyAdvertiserToken(token);
  if (!claims?.advertiserUserId) redirect("/");
  const user = await getAdvertiserUserById(claims.advertiserUserId);
  if (!user?.is_active || !user?.is_admin) redirect("/");
  return (
    <div
      style={{
        minHeight: "100vh",
        margin: 0,
        background: "#F9FAFB",
        color: "#111827",
        fontFamily:
          "system-ui, -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'PingFang SC', sans-serif",
      }}
    >
      {children}
    </div>
  );
}
