# Billing v1.2 — 消费发票（按红人）冻结版

> 状态：已确认，可开发

## 1. 产品决策

| 项 | 决定 |
|----|------|
| 开票方向 | 平台（Grace Capital / Maxin AI）开给广告主用户，与充值/月度发票同抬头 |
| 开票维度 | 每个红人 × 每个 campaign/合作（一条 `quote_approve` 明细）单独一张 |
| 金额口径 | 红人合作费（`influencer_amount`）+ 平台服务费（`platform_fee_amount`） |
| 发票类型代码 | `influencer_campaign`，前端展示「消费发票（按红人）」 |
| 编号 | `GCG-C-YYYYMM-NNNN`，序号按 advertiser + type + 开具月份递增 |
| 去重规则 | 同一 ledger 明细（红人×活动）只能开一次；同红人同月多次合作可开多张 |
| 收件邮箱 | 通知设置中的 `finance_notify_emails`（财务） |
| PDF | 复用现有 INVOICE 底稿，单行明细：Campaign / Influencer / Influencer Fee / Platform Fee / Total |

## 2. 申请规则

- 入口：广告主「账户与账单 → 发票管理 → 申请发票」，与充值发票、消费发票（按月）并列第三个 radio。
- 可选记录：该广告主全部未开票、未退款（排除 `system_quote_refund:*`）的 `quote_approve` 明细。
- 校验：开票抬头完整、通知邮箱已配置（沿用现有阻断条件）。
- 流程：校验 → 生成 PDF → 写入 `tiktok_advertiser_invoice`（`invoice_type=influencer_campaign`，`related_ledger_ids=[ledger_id]`）→ 发邮件。

## 3. 实现说明

- 无需新增表字段：去重复用 `related_ledger_ids`，红人/活动名存于 `line_items_json`。
- 已开票的红人合作记录在「可开票」下拉中排除。
- 发票记录列表对 `influencer_campaign` 展示红人名与活动名。
