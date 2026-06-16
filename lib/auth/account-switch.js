/**
 * 账户切换权限：平台管理员（跨公司）与公司管理员（本公司普通成员）
 */

/** @param {{ isAdmin?: boolean, isCompanyAdmin?: boolean } | null | undefined} user */
export function canSwitchAccounts(user) {
  return !!(user?.isAdmin || user?.isCompanyAdmin);
}

/** @param {{ isAdmin?: boolean } | null | undefined} user */
export function isPlatformAdmin(user) {
  return !!user?.isAdmin;
}

/**
 * @param {{ isAdmin?: boolean, isCompanyAdmin?: boolean, advertiserId?: number } | null | undefined} realUser
 * @param {{ advertiser_id?: number, is_active?: number | boolean, is_admin?: number | boolean, is_company_admin?: number | boolean } | null | undefined} targetRow
 */
export function canSwitchToTarget(realUser, targetRow) {
  if (!realUser || !targetRow) return false;
  if (!targetRow.is_active) return false;

  if (realUser.isAdmin) return true;

  if (!realUser.isCompanyAdmin) return false;
  if (targetRow.advertiser_id !== realUser.advertiserId) return false;
  if (targetRow.is_admin || targetRow.is_company_admin) return false;

  return true;
}
