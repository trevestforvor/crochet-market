# Olares Models

A curated marketplace of LLM inference apps optimized for **Olares One** hardware.

## Market Source URL

```
https://olares-models.<your-account>.workers.dev
```

> After first deploy, replace `<your-account>` with your actual Cloudflare Workers subdomain.

## Setup

1. Open **Olares Market** on your Olares One device
2. Go to **Settings** > **Custom Sources**
3. Paste the Market Source URL above
4. Apps will appear within 5 minutes

## Device Target

All apps are optimized for Olares One:
- **GPU**: RTX 5090M (24GB GDDR7, 896 GB/s)
- **RAM**: 96GB DDR5
- **CPU**: 24-core Intel Core Ultra 9

## Available Models

| App | Backend | Model Size | Quant | Expected Speed | GPU |
|-----|---------|-----------|-------|---------------|-----|
| *No models yet — use `/deploy-model` to add your first!* | | | | | |

## Adding Models

Use the `/deploy-model` Claude Code skill:

1. Run `/deploy-model` in Claude Code
2. Provide a HuggingFace model URL
3. Claude auto-optimizes config for your hardware
4. Approve the proposal
5. App is generated, packaged, and published

## Development

```bash
npm install          # Install dependencies
npm run dev          # Local dev server (localhost:8787)
npm run deploy       # Deploy to Cloudflare Workers
```

## License

MIT
