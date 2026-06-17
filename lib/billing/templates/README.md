# Invoice PDF base template (Source A)

Place the final design PDF here:

```
lib/billing/templates/invoice-base.pdf
```

## Requirements

- A4 portrait
- Static content baked in: **INVOICE** title, From (Grace Capital + Maxin AI + bank block), table column headers, Bin Duan signature
- **No Paypal** section
- Leave clear space for dynamic overlay (see `invoice-pdf-layout.js`)

## Dynamic fields (written by code)

| Field | Content |
|-------|---------|
| Invoice Number | `GCG-R-YYYYMM-NNNN` or `GCG-M-YYYYMM-NNNN` |
| Invoice Date | Application date (Asia/Hong_Kong) |
| To block | Customer legal name, address, contact |
| Details | `<Customer legal name>` |
| Table rows | Per influencer or single recharge row |
| Grand Total | Sum of line totals |

## After dropping `invoice-base.pdf`

1. Run `node scripts/calibrate-invoice-pdf-layout.mjs` (optional helper) to preview overlay boxes
2. Adjust coordinates in `lib/billing/invoice-pdf-layout.js` until text aligns

## Dev placeholder

Until the final PDF is ready:

```bash
node scripts/generate-invoice-base.mjs
node scripts/generate-invoice-base.mjs --preview   # optional filled sample for review
```

This writes `invoice-base.pdf` (static base) and optionally `invoice-base-preview.pdf` (sample data).
