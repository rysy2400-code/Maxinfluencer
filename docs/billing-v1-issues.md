# Billing v1 开发 Issue 清单

> 对应规格：`docs/billing-v1-spec.md`  
> 目标上线：**2026-08-01**  
> 复制到 GitHub：`gh issue create --title "..." --body-file ...`

---

## Epic

**Title:** Billing v1 — 账户账单、充值确认、月度 Statement、纯预付费

**Body:**

实现公司管理员账单中心、平台管理员充值入账、双 PDF 文档（Top-up Confirmation + Monthly Statement）、邮件通知。默认纯预付费（credit_limit=0，余额不足阻断扣款）。

**Labels:** `billing`, `epic`

**Milestone:** Billing v1 (2026-08-01)

---

## Sprint 1 — 数据层 & 扣款改造（7/7–7/11）

### Issue #1: DB migration — billing 表与 ledger 扩展

**Labels:** `billing`, `database`, `sprint-1`

**Tasks:**

- [ ] `tiktok_advertiser` 增加 `credit_limit DECIMAL(14,4) DEFAULT 0`
- [ ] `tiktok_advertiser_balance_ledger` 增加 `influencer_amount`, `platform_fee_amount`, `campaign_name`, `influencer_display_name`, `note`
- [ ] 创建 `tiktok_advertiser_billing_profile`
- [ ] 创建 `tiktok_advertiser_invoice`（含 `document_title`, `period_yyyymm`, `seq`, 唯一约束）
- [ ] 创建 `tiktok_advertiser_top_up`
- [ ] 创建 `tiktok_billing_notification_config`
- [ ] 编写 `scripts/setup-billing-v1.js` 迁移脚本

**Acceptance:**

- 迁移脚本可重复执行（idempotent）
- 本地/测试库执行无报错

---

### Issue #2: 同意报价扣款 — 红人费 + 5% 平台费 + 纯预付费校验

**Labels:** `billing`, `backend`, `sprint-1`

**Files:** `lib/billing/approve-quote-charge.js`

**Tasks:**

- [ ] `total_deduct = flat_fee + round(flat_fee * 0.05, 2)`
- [ ] 余额校验：`balance >= total_deduct`（credit_limit=0）
- [ ] ledger 写入拆分字段 + campaign_name + influencer_display_name
- [ ] 更新/新增集成测试 `scripts/test-approve-quote-balance-integration.mjs`

**Acceptance:**

- flat_fee=100 → 扣 105，ledger 记录 100 + 5
- balance=104 → 返回 `insufficient_balance`，不扣款
- commission_only 且 flat_fee=0 → 扣 0

---

### Issue #3: Billing ledger API（公司管理员）

**Labels:** `billing`, `api`, `sprint-1`

**Tasks:**

- [ ] `lib/billing/ledger-dao.js` — 分页查询、汇总
- [ ] `lib/auth/require-company-admin.js` 中间件
- [ ] `GET /api/billing/summary`
- [ ] `GET /api/billing/ledger?page&from&to&type`
- [ ] `GET /api/billing/ledger/export` → CSV

**Acceptance:**

- 非 company_admin 返回 403
- 明细列含：时间、类型、Campaign、红人、红人费、平台费、合计、余额
- 仅返回当前 `advertiser_id` 数据

---

## Sprint 2 — 嵌入公司管理员账户区（7/14–7/18）

### Issue #4: AccountBillingPanel — 账户概览 + 账单明细

**Labels:** `billing`, `frontend`, `sprint-2`

**Tasks:**

- [ ] 新建 `app/components/AccountBillingPanel.js`（Drawer/全屏面板，5 个 Tab）
- [ ] 扩展 `SidebarAccountMenu`：仅 `isCompanyAdmin` 显示「账户与账单」菜单项
- [ ] `page.js` 增加 `billingPanelOpen` 状态，点击菜单打开面板（**不新建 `/billing` 路由**）
- [ ] Tab「账户概览」：余额、累计充值/消费（红人费、平台费分列）、收款账户信息（GCG 银行信息）
- [ ] Tab「账单明细」：表格 + 日期筛选 + 分页 + CSV 下载
- [ ] 普通成员无「账户与账单」入口；直接调 API 仍返回 403

**Acceptance:**

- 与 spec §8 一致：功能在主工作台公司管理员账户内完成
- 收款信息只读展示 spec §2 内容

---

### Issue #5: 开票信息 + 通知设置

**Labels:** `billing`, `frontend`, `api`, `sprint-2`

**Tasks:**

- [ ] `GET/PUT /api/billing/profile`
- [ ] `GET/PUT /api/billing/notification-config`（`finance_notify_emails` JSON 数组）
- [ ] 在 `AccountBillingPanel` 内 Tab「开票信息」表单（DeepSeek 风格，必填校验）
- [ ] Tab「通知设置」— 财务邮箱（可多填，公司管理员自填）

**Acceptance:**

- 未填 profile 时「发票管理」Tab 显示引导，不可下载
- 邮箱格式校验

---

## Sprint 3 — Ops 充值 + 邮件（7/21–7/25）

### Issue #6: Ops 充值入账

**Labels:** `billing`, `ops`, `sprint-3`

**Tasks:**

- [ ] `app/ops/billing/page.js`
- [ ] `POST /api/ops/billing/top-up` — 事务：更新 balance + ledger(top_up) + top_up 记录
- [ ] 幂等：同 `bank_reference + advertiser_id` 拒绝重复
- [ ] 仅 `is_admin`

**Acceptance:**

- 充值 $1000 → balance +1000，ledger type=top_up amount=+1000
- 操作人 user id 记入 created_by

---

### Issue #7: 充值 PDF — Prepaid Top-up Confirmation

**Labels:** `billing`, `pdf`, `sprint-3`

**Dependencies:** `pdfkit`

**Tasks:**

- [ ] `lib/billing/pdf/top-up-confirmation.js` — 按 spec §4.3 生成
- [ ] `lib/billing/invoice-number.js` — `GCG-R-YYYYMM-NNNN`
- [ ] 入账成功后写 `tiktok_advertiser_invoice`（`document_title` = 固定标题）
- [ ] PDF 存 `storage/invoices/{advertiser_id}/{invoice_no}.pdf`
- [ ] billing profile 未填 → 跳过 PDF，返回 warn

**Acceptance:**

- PDF 标题为 **PREPAID TOP-UP CONFIRMATION (PROFORMA)**，无 Amount Due
- 含 Payment Status: PAID / SETTLED
- 编号符合 GCG-R-* 规则

---

### Issue #8: 充值确认邮件

**Labels:** `billing`, `email`, `sprint-3`

**Tasks:**

- [ ] `lib/billing/email/top-up-notification.js`
- [ ] 入账 + PDF 成功后发送至 `finance_notify_emails`
- [ ] Subject/正文按 spec §5.1
- [ ] PDF 附件

**Acceptance:**

- 无配置邮箱 → 入账成功但不发邮件，记日志
- `notification_sent_at` 回写 top_up 记录

---

## Sprint 4 — 月度 Statement + 发票 Tab + cron（7/28–8/1）

### Issue #9: 月度 Statement PDF + cron

**Labels:** `billing`, `pdf`, `cron`, `sprint-4`

**Tasks:**

- [ ] `lib/billing/pdf/monthly-statement.js` — 按 spec §4.4
- [ ] `lib/billing/generate-monthly-statement.js` — 汇总上月 ledger
- [ ] 交叉引用本期 `GCG-R-*`
- [ ] `Amount Due` 计算；`closing < 0` → 不生成 PDF，写 ops 告警
- [ ] `scripts/cron-generate-monthly-statements.js`（或 internal API + cron）
- [ ] 编号 `GCG-M-YYYYMM-NNNN`

**Acceptance:**

- 纯预付费账户 Amount Due 恒为 0
- 明细表含 Campaign / 红人 / 红人费 / 平台费
- Prepaid 抵扣块引用 GCG-R 编号

---

### Issue #10: 发票管理 Tab + 下载 API

**Labels:** `billing`, `frontend`, `api`, `sprint-4`

**Tasks:**

- [ ] `GET /api/billing/invoices` — 列表（类型、账期、金额、document_title、issued_at）
- [ ] `GET /api/billing/invoices/[id]/pdf` — 鉴权 + 文件流
- [ ] `AccountBillingPanel` Tab「发票管理」— 列表 + 下载按钮
- [ ] UI 区分 Top-up Confirmation vs Monthly Statement 标题

**Acceptance:**

- 客户可见两类文档，标题与 PDF 一致
- 无法跨 advertiser 下载

---

### Issue #11: 月度 Statement 邮件 + Ops 重发

**Labels:** `billing`, `email`, `ops`, `sprint-4`

**Tasks:**

- [ ] 月度 PDF 生成后自动发邮件（spec §5.2）
- [ ] `POST /api/ops/billing/invoices/[id]/resend`

**Acceptance:**

- Ops 可重发任意已签发 PDF 邮件

---

### Issue #12: E2E 联调 & 文档

**Labels:** `billing`, `qa`, `sprint-4`

**Tasks:**

- [ ] 端到端：Ops 充值 → PDF → 邮件 → 公司管理员在账户面板可见
- [ ] 端到端：quote_approve → 明细 → 月度 cron → Statement PDF
- [ ] 更新 `TESTING_GUIDE.md` billing 章节（简短）
- [ ] 客户对外话术（充值/月度双文档说明）写入 spec 附录或运营 doc

**Acceptance:**

- 全流程测试通过
- 无 company_admin 权限泄漏

---

## 依赖关系

```
#1 → #2, #3, #6, #7, #9
#2 → #9, #12
#3 → #4
#5 → #7, #9, #10
#6 → #7 → #8
#7, #9 → #10 → #11
```

---

## 可选：创建 GitHub Issues 命令

登录 `gh auth login` 后，可按 Epic 拆 issue；或批量：

```bash
# 示例
gh issue create --title "[Billing] DB migration — billing v1 tables" \
  --body-file docs/billing-v1-issues.md \
  --label billing
```

建议为每个 Issue 单独建 body 文件或使用 Project board 跟踪 Sprint。
