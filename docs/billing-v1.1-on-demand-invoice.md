# Billing v1.1 — 按需开票（冻结版）

> 状态：已确认，可开发  
> 替代 v1 中「充值/月度自动开票 + cron」部分

## 1. 产品决策

| 项 | 决定 |
|----|------|
| 开票模式 | **仅按需申请**，无自动 cron、无充值自动开票 |
| 发票类型 | ① 充值发票 `recharge` ② 消费发票 `monthly_consumption` |
| PDF 标题 | **INVOICE**（v1 不做 Tax Invoice） |
| 发件邮箱 | `maxin@binfluencer.online`（`op_contacts` 固定） |
| 收件人 | 「通知设置」中的 `finance_notify_emails` |
| 邮件 | 英文 Subject + 正文 |
| PDF 技术 | **PDF 底稿（Source A）+ pdf-lib 动态写入**；我方信息与签名固化在 `invoice-base.pdf` |

## 2. Tab 结构

| Tab | 内容 |
|-----|------|
| 账户概览 | 余额、对公转账 |
| 账单明细 | ledger |
| **发票管理** | 合并：通知设置 + 开票抬头 + 申请发票 + 历史列表/下载 |

## 3. 申请规则

### 3.1 充值发票（GCG-R-YYYYMM-NNNN）

- 按 **单笔** ledger `type=top_up` 申请
- 禁止重复（同一 ledger_id 已关联 invoice 则不可再申请）
- 允许历史数据（含导入）

### 3.2 消费发票（GCG-M-YYYYMM-NNNN）

- 按 **自然月** `YYYY-MM` 申请
- 汇总该月全部 `quote_approve`
- 禁止重复（同一 advertiser + period_yyyymm + monthly_consumption）
- 金额口径：红人费 + 平台费（分行展示）

### 3.3 阻断条件

- 开票抬头不完整（法定名称、地址、联系人、联系邮箱）
- 通知邮箱未配置
- 权限：`is_company_admin` 或平台管理员

### 3.4 流程

即时：校验 → 生成 PDF → 写入 `tiktok_advertiser_invoice` → 发邮件  
发信失败：PDF 仍保留，发票管理可下载，界面提示重试

## 4. PDF 表格列（消费）

| Name of creator | Description | Influencer Fee (USD) | Platform Fee (USD) | Quantity | Total (USD) |

改为与账单明细一致（英文 PDF）：

| Campaign | Influencer | Influencer Fee (USD) | Platform Fee (USD) | Total (USD) |

- 去掉 Qty（账单明细无此列，每笔消费一行）
- 不纳入：时间、类型、余额（发票场景不需要）

### 充值（单行）

| Campaign | Influencer | Influencer Fee (USD) | Platform Fee (USD) | Total (USD) |
| Prepaid top-up | — | — | — | 充值金额 |

## 5. Issuer（我方）

```
Company Name: Grace Capital Group Limited
Company Address: （暂空）
Product Name: Maxin AI
From 展示: 公司名 + Maxin AI（两行）

Account Holder: Grace Capital Group Limited
Bank Name: OCBC Bank Hong Kong
Bank Address: 161 Queen's Road, Central, Hong Kong
Bank Account No.: 038524-831
SWIFT Code: OCBCHKHH
```

## 6. 编号与日期

- Invoice Number: `GCG-R-YYYYMM-NNNN` / `GCG-M-YYYYMM-NNNN`
- Invoice Date: 申请日（UTC+8）

## 7. 邮件

- From: `maxin@binfluencer.online`
- Subject: `[Maxin AI] Invoice {invoice_no} – USD {amount} – {company_name}`
- 正文：英文，附 PDF

## 8. PDF 底稿（Source A）

1. 设计定稿 PDF 放入 `lib/billing/templates/invoice-base.pdf`
2. 动态字段坐标见 `lib/billing/invoice-pdf-layout.js`（定稿后校准）
3. 本地测试：`node scripts/generate-invoice-base-dev.mjs`

## 9. API（新增）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/billing/invoices/eligible` | 可申请的充值笔 + 可开票的月份 |
| POST | `/api/billing/invoices/request` | 提交申请 |
| GET | `/api/billing/invoices/[id]/pdf` | 下载 PDF |
