## Getting started (local dev)

```bash
npm run dev
```

### Billing PDFs (Hebrew/RTL)

Billing PDFs default to the **HTML renderer** (Playwright Chromium) to better support Hebrew/RTL.

- **Local (recommended)**: put this in `.env.local`:

```env
BILLING_PDF_RENDERER=html
```

- **Debug-only (do not enable for normal runs)**:

```env
# BILLING_PDF_SKIP_CACHE=1
# BILLING_PDF_DEBUG_LOG=1
```

### Deployment environment variables

Set the following in your deployment environment (e.g. Vercel Project → Settings → Environment Variables):

```env
BILLING_PDF_RENDERER=html
```

Production **must** use the HTML renderer. `BILLING_PDF_RENDERER=pdfmake` is blocked when `NODE_ENV=production`.

For local troubleshooting only, you may set `BILLING_PDF_RENDERER=pdfmake` in development.
