# Billing v1 规格说明（冻结版）

> 状态：已定稿，可排期开发  
> 策略：**方案 1（双文档 + 抵扣引用）** + **默认纯预付费（余额不足阻断扣款）**  
> 法律主体：**Grace Capital Group Limited**（香港）  
> 产品品牌：**Maxin AI Platform**  
> v1 PDF：**文字抬头**（无 Logo）

---

## 1. 业务规则

### 1.1 默认纯预付费

- `credit_limit` 默认为 `0`。
- 同意报价扣款时：`current_balance >= total_deduct`，否则返回 `insufficient_balance`，**不允许负余额**。
- 月度 Statement 在纯预付费下：`Amount Due` 恒为 `0`；Closing Balance ≥ 0。
- 预留 `credit_limit` 字段与校验逻辑，供后续签约大客户启用（v1 不开放 Ops 配置 UI）。

### 1.2 扣款拆分

```
influencer_amount  = flat_fee
platform_fee       = round(flat_fee × 0.05, 2)
total_deduct       = influencer_amount + platform_fee
ledger.amount      = -total_deduct
```

### 1.3 双文档职责（方案 1）

| 文档 | 编号前缀 | 标题（PDF） | 金额含义 | 是否请求付款 |
|------|----------|-------------|----------|--------------|
| 充值确认 | `GCG-R-YYYYMM-NNNN` | **Prepaid Top-up Confirmation (Proforma)** | 实际到账 USD | **否**（标 Paid / Settled） |
| 月度对账 | `GCG-M-YYYYMM-NNNN` | **Monthly Statement of Account & Service Summary (Proforma)** | 消费明细 + 抵扣 | **仅 Amount Due 行**（纯预付费下为 0） |

**禁止**：两张文档均不得把全额写成「请于本票支付」。

### 1.4 交叉引用

- 月度 Statement 的 `Prepaid Credit Applied` 必须引用本期使用的 `GCG-R-*` 编号（可多条）。
- 充值 Confirmation 的 `Related Statement` 可留空（充值时月度票尚未生成）；月度票生成时反向写入关联。

### 1.5 权限

- `/billing`：仅 `is_company_admin = 1`。
- `/ops/billing`：仅 `is_admin = 1`。
- 币种：USD only。
- 历史数据：不补录。

---

## 2. issuer 固定信息

```
Grace Capital Group Limited
Maxin AI Platform

Bank: OCBC Bank Hong Kong
Bank Address: 161 Queen's Road, Central, Hong Kong
Account No.: 038524-831 (USD)
```

---

## 3. 发票编号规则

格式：`GCG-{TYPE}-{PERIOD}-{SEQ}`

| TYPE | 含义 | PERIOD |
|------|------|--------|
| `R` | 充值确认 | 开具月份 YYYYMM |
| `M` | 月度对账 | 消费所属月份 YYYYMM |

- 序号：按 `advertiser_id + type + period` 从 `0001` 递增。
- 数据库唯一约束：`(advertiser_id, invoice_type, period_yyyymm, seq)`。

---

## 4. PDF 模板规格

> 技术：服务端 `pdfkit` 生成 A4 纵向 PDF，v1 文字抬头。

### 4.1 通用 Header

```
Grace Capital Group Limited
Maxin AI Platform
────────────────────────────────────────
Document No.: {document_no}
Issue Date:   {issue_date} (UTC+8 显示)
Currency:     USD
```

### 4.2 通用 Bill To 区块

来自 `tiktok_advertiser_billing_profile`（客户自填）：

```
Bill To:
{company_legal_name}
{company_address}
Contact: {contact_name} <{contact_email}>
Tax ID / VAT: {tax_id or "N/A"}
```

未填写 billing profile 时：Ops 仍可入账充值，但**不生成 PDF**；月度 cron 跳过并记 warn 日志。

### 4.3 充值 PDF — Prepaid Top-up Confirmation (Proforma)

**触发**：Ops 录入充值成功后。

**标题（居中加粗）**：

```
PREPAID TOP-UP CONFIRMATION (PROFORMA)
```

**正文表格**：

| Description | Amount (USD) |
|-------------|--------------|
| Prepaid Credit Top-up | {amount} |
| **Amount Received** | **{amount}** |

**状态行（加粗）**：

```
Payment Status: PAID / SETTLED
Bank Reference: {bank_reference}
Received Date: {received_at}
```

**说明段落**：

```
This document confirms receipt of prepaid credit for Maxin AI Platform services.
This credit will be applied against future service consumption.
This is not a tax invoice unless separately issued.
```

**Footer**：

```
Grace Capital Group Limited · Maxin AI Platform
This is a proforma document for payment confirmation and account reconciliation only.
```

**不得出现**：Amount Due、Please remit、Invoice Total payable。

---

### 4.4 月度 PDF — Monthly Statement (Proforma)

**触发**：每月 1 日 02:00 HKT cron，生成**上一自然月**消费汇总。

**标题（居中加粗）**：

```
MONTHLY STATEMENT OF ACCOUNT & SERVICE SUMMARY (PROFORMA)
```

**账期行**：

```
Billing Period: {period_start} – {period_end}
```

**账户汇总块**：

```
Opening Balance:              USD {opening}
+ Prepaid Top-ups (Note 1):   USD {topups}
- Service Consumption:        USD {consumption}
= Closing Balance:              USD {closing}
```

Note 1 脚注：`See Prepaid Top-up Confirmation(s): GCG-R-202606-0001, ...`

**纯预付费校验**：`closing >= 0` 且 `Amount Due = 0`。若 cron 算出 `closing < 0`，**不签发 PDF**，写 ops 告警（数据异常）。

**消费明细表**：

| Date | Campaign | Influencer | Influencer Fee | Platform Fee (5%) | Total |
|------|----------|------------|----------------|-------------------|-------|
| ... | ... | ... | ... | ... | ... |
| **Subtotal** | | | **{sum_inf}** | **{sum_pf}** | **{consumption}** |

**Prepaid 抵扣块**（本期有充值时显示）：

```
Less: Prepaid Credit Applied (Ref: GCG-R-...):    (USD {topups_applied})
Amount Due:                                        USD {amount_due}
```

纯预付费下：`topups_applied = topups`，`amount_due = 0`。

**说明段落**：

```
Total Service Consumption reflects services delivered in the billing period.
Prepaid credits are not invoiced twice. Only the Amount Due line, if any, represents
outstanding payment obligation. In prepaid accounts, Amount Due is zero when the
closing balance is non-negative.
This is not a tax invoice unless separately issued.
```

**Footer**：同充值 PDF。

---

## 5. 邮件模板

### 5.1 充值确认邮件

- **To**：`finance_notify_emails`（公司管理员在 `/billing` 配置）
- **Subject**：`[Maxin AI] Prepaid Top-up Confirmation – USD {amount} – {company_name}`
- **附件**：充值 PDF
- **正文要点**：到账金额、日期、流水号、充值后余额、账单中心链接

### 5.2 月度 Statement 邮件（v1 一并实现）

- **Subject**：`[Maxin AI] Monthly Statement – {YYYY-MM} – {company_name}`
- **附件**：月度 PDF
- **正文要点**：账期、消费总额、Closing Balance、明细链接

---

## 6. 数据模型（摘要）

### 6.1 ledger 扩展

`tiktok_advertiser_balance_ledger` 增列：

- `influencer_amount DECIMAL(14,4)`
- `platform_fee_amount DECIMAL(14,4)`
- `campaign_name VARCHAR(255)`
- `influencer_display_name VARCHAR(255)`
- `note TEXT`

`type` 枚举：`top_up` | `quote_approve` | `adjustment`

### 6.2 新表

- `tiktok_advertiser_billing_profile`
- `tiktok_advertiser_invoice`（`invoice_type`: `recharge` | `monthly_consumption`；`document_title` 存 PDF 标题）
- `tiktok_advertiser_top_up`
- `tiktok_billing_notification_config`

### 6.3 advertiser 扩展

- `credit_limit DECIMAL(14,4) NOT NULL DEFAULT 0`

---

## 7. API（摘要）

| 方法 | 路径 | 权限 |
|------|------|------|
| GET | `/api/billing/summary` | company_admin |
| GET | `/api/billing/ledger` | company_admin |
| GET | `/api/billing/ledger/export` | company_admin |
| GET/PUT | `/api/billing/profile` | company_admin |
| GET/PUT | `/api/billing/notification-config` | company_admin（在账户面板「通知设置」Tab 填写财务邮箱） |
| GET | `/api/billing/invoices` | company_admin |
| GET | `/api/billing/invoices/[id]/pdf` | company_admin |
| POST | `/api/ops/billing/top-up` | platform_admin |
| POST | `/api/ops/billing/invoices/[id]/resend` | platform_admin |

---

## 8. 页面与入口（嵌入公司管理员账户）

**原则：不做独立 `/billing` 路由。** 账单能力直接做在现有主工作台 `app/page.js` 的**公司管理员账户区**，与侧栏底部账户菜单（`SidebarAccountMenu`）同一上下文。

### 8.1 角色可见性

| 功能 | 普通成员 | 公司管理员 `isCompanyAdmin` | 平台管理员 `isAdmin` |
|------|----------|---------------------------|----------------------|
| 侧栏显示余额 | ✅ | ✅ | ✅ |
| 充值指引 | ✅ | ✅ | ✅ |
| **账户与账单**（明细/发票/开票信息） | ❌ | ✅ | ✅（切换至某公司上下文后等同该公司管理员） |
| Ops 充值入账 | ❌ | ❌ | ✅ `/ops/billing` |

### 8.2 公司管理员入口（主工作台内）

在 `SidebarAccountMenu` 中，**仅 `isCompanyAdmin`** 增加菜单项：

```
账户余额          $1,234.56
─────────────────
账户与账单    →   打开账户面板（主内容区或全屏 Drawer）
切换账户          （已有）
充值              （已有，可并入面板「充值指引」Tab）
退出登录
```

点击 **「账户与账单」** 后，在主界面打开 **AccountBillingPanel**（与 Campaign 工作台同页，不跳转新 URL）：

Tabs：**账户概览** | **账单明细** | **开票信息** | **发票管理** | **通知设置**

关闭面板回到 Campaign 工作台。

> 实现建议：抽 `app/components/AccountBillingPanel.js`，状态 `billingPanelOpen` 由 `page.js` 管理；API 路径仍为 `/api/billing/*`，仅前端无独立页面路由。

### 8.3 平台管理员 Ops（仍独立）

`/ops/billing` — 充值入账 | 发票重发 | 按公司查看 ledger（仅 `isAdmin`）

---

## 9. 上线承诺

- 目标日期：**2026-08-01**
- 上线前：人工 Excel 月度对账；充值手工邮件 + PDF（系统上线后自动化）

---

## 10. 后续 v1.1（不在 v1 范围）

- Ops 配置 `credit_limit` + Amount Due > 0 流程
- Logo PDF 页眉
- 对象存储迁移（当前 v1 本地 `storage/invoices/`）
