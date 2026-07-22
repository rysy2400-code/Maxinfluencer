import { getAuthenticatedAdvertiserUser } from "./advertiser-auth-http.js";

export async function requireCrawlerOpsSuperAdmin(request) {
  const auth = await getAuthenticatedAdvertiserUser(request);
  if (!auth?.realUser?.isAdmin || !auth.realUser.advertiserUserId) return null;
  return auth;
}
