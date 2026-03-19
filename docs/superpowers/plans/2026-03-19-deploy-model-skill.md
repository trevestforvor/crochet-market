# `/deploy-model` Skill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Claude Code skill and Cloudflare Workers marketplace that lets users provide a model URL, auto-optimize for Olares One hardware, and generate + publish a complete Olares app package.

**Architecture:** The Olares-Models repo contains three layers: (1) a Cloudflare Worker serving the Market Source API, (2) a build script that compiles app charts/icons into static JSON catalogs, and (3) a `/deploy-model` Claude Code skill that interactively generates model app packages. The skill produces Helm charts following two proven patterns — vLLM (two-tier chart with client proxy) and llama.cpp (single chart with inline ConfigMap).

**Tech Stack:** Cloudflare Workers (TypeScript), Helm Charts, Kubernetes YAML, Claude Code Skills (Markdown)

**Spec:** `docs/superpowers/specs/2026-03-18-deploy-model-skill-design.md`

**Prerequisites:** Helm CLI must be installed (`helm version`). Node.js 18+. Git.

**Scaling Note:** The Cloudflare Worker embeds base64-encoded chart tarballs in the script bundle. Workers have a 10MB compressed / 25MB uncompressed limit. This supports ~50-100 model apps comfortably. If the marketplace grows beyond that, migrate chart storage to Cloudflare R2.

**Deferred:** `.github/workflows/` CI pipeline (lint + auto-deploy) — add after initial deployment is validated.

---

## File Map

### Repository Infrastructure
| File | Responsibility |
|------|---------------|
| `package.json` | npm deps (js-yaml, wrangler, @cloudflare/workers-types) |
| `tsconfig.json` | TypeScript config for Worker |
| `wrangler.toml` | Cloudflare Worker deployment config |
| `.gitignore` | Ignore node_modules, dist, .wrangler |
| `README.md` | Market source URL, setup instructions, model catalog |

### Marketplace Worker
| File | Responsibility |
|------|---------------|
| `src/index.ts` | Cloudflare Worker — routes API requests, serves charts/icons/catalog |
| `scripts/build-catalog.js` | Pre-build step — reads app dirs, packages into catalog.json, icons.json, charts.json |

### Skill
| File | Responsibility |
|------|---------------|
| `skills/deploy-model.md` | Claude Code skill — interactive flow, optimization engine, template generation |

### Directories (created empty with .gitkeep)
| Directory | Purpose |
|-----------|---------|
| `charts/` | Packaged .tgz Helm charts |
| `icons/` | App icons (256x256 PNG) |

---

## Task 1: Repository Scaffolding

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `wrangler.toml`
- Create: `.gitignore`
- Create: `charts/.gitkeep`
- Create: `icons/.gitkeep`

- [ ] **Step 1: Create package.json**

```json
{
  "name": "olares-models",
  "version": "1.0.0",
  "private": true,
  "scripts": {
    "build:catalog": "node scripts/build-catalog.js",
    "dev": "npm run build:catalog && wrangler dev",
    "deploy": "npm run build:catalog && wrangler deploy",
    "build": "npm run build:catalog"
  },
  "dependencies": {
    "js-yaml": "^4.1.0"
  },
  "devDependencies": {
    "@cloudflare/workers-types": "^4.20241230.0",
    "wrangler": "^3.99.0"
  }
}
```

- [ ] **Step 2: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler",
    "lib": ["ES2022"],
    "types": ["@cloudflare/workers-types"],
    "resolveJsonModule": true,
    "allowJs": true,
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "skipLibCheck": true
  },
  "include": ["src/**/*"]
}
```

- [ ] **Step 3: Create wrangler.toml**

```toml
name = "olares-models"
main = "src/index.ts"
compatibility_date = "2024-12-01"

[build]
command = "npm run build:catalog"
```

Note: The worker name determines the URL: `https://olares-models.<account>.workers.dev`

- [ ] **Step 4: Create .gitignore**

```
node_modules/
dist/
.wrangler/
src/catalog.json
src/icons.json
src/charts.json
*.tgz
.DS_Store
```

- [ ] **Step 5: Create empty directories**

```bash
mkdir -p charts icons
touch charts/.gitkeep icons/.gitkeep
```

- [ ] **Step 6: Verify prerequisites**

```bash
helm version
node --version
```

Expected: Helm v3.x, Node.js 18+. If helm is missing, install via `winget install Helm.Helm` or `choco install kubernetes-helm`.

- [ ] **Step 7: Install dependencies**

```bash
cd C:/Users/treve/Olares-Models && npm install
```

Expected: `node_modules/` created with js-yaml, wrangler, @cloudflare/workers-types

- [ ] **Step 8: Commit**

```bash
git add package.json tsconfig.json wrangler.toml .gitignore charts/.gitkeep icons/.gitkeep
git commit -m "chore: scaffold Olares-Models repo with Worker infrastructure"
```

---

## Task 2: Build Catalog Script

**Files:**
- Create: `scripts/build-catalog.js`

This script reads all app directories (those containing `Chart.yaml`), parses their OlaresManifest.yaml and i18n files, packages icons as base64, reads pre-built .tgz chart packages from `charts/`, and outputs three JSON files consumed by the Worker.

- [ ] **Step 1: Create scripts/ directory**

```bash
mkdir -p scripts
```

- [ ] **Step 2: Write build-catalog.js**

```javascript
#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const ROOT = path.resolve(__dirname, '..');
const CHARTS_DIR = path.join(ROOT, 'charts');
const ICONS_DIR = path.join(ROOT, 'icons');
const SRC_DIR = path.join(ROOT, 'src');

function findAppDirs() {
  return fs.readdirSync(ROOT).filter(name => {
    const chartPath = path.join(ROOT, name, 'Chart.yaml');
    return fs.existsSync(chartPath) && fs.statSync(path.join(ROOT, name)).isDirectory();
  });
}

function readYaml(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return yaml.load(fs.readFileSync(filePath, 'utf8'));
}

function buildCatalog() {
  const appDirs = findAppDirs();
  const catalog = { apps: [], version: Date.now().toString() };
  const icons = {};
  const charts = {};

  for (const appName of appDirs) {
    const appDir = path.join(ROOT, appName);
    const chart = readYaml(path.join(appDir, 'Chart.yaml'));
    const manifest = readYaml(path.join(appDir, 'OlaresManifest.yaml'));
    const i18nEn = readYaml(path.join(appDir, 'i18n', 'en-US', 'OlaresManifest.yaml'));

    if (!chart || !manifest) {
      console.warn(`Skipping ${appName}: missing Chart.yaml or OlaresManifest.yaml`);
      continue;
    }

    // Build app entry from manifest
    const appEntry = {
      name: appName,
      chartName: chart.name,
      version: chart.version,
      appVersion: chart.appVersion,
      title: (i18nEn && i18nEn.metadata && i18nEn.metadata.title) || manifest.metadata.title,
      description: (i18nEn && i18nEn.metadata && i18nEn.metadata.description) || manifest.metadata.description,
      icon: manifest.metadata.icon || '',
      category: (manifest.spec && manifest.spec.category) || 'AI',
      versionName: (manifest.spec && manifest.spec.versionName) || chart.version,
      fullDescription: (i18nEn && i18nEn.spec && i18nEn.spec.fullDescription) ||
                       (manifest.spec && manifest.spec.fullDescription) || '',
      developer: (manifest.spec && manifest.spec.developer) || '',
      license: manifest.spec && manifest.spec.license,
      requiredGpu: manifest.spec && manifest.spec.requiredGpu,
      limitedGpu: manifest.spec && manifest.spec.limitedGpu,
      requiredMemory: manifest.spec && manifest.spec.requiredMemory,
      limitedMemory: manifest.spec && manifest.spec.limitedMemory,
      supportArch: (manifest.spec && manifest.spec.supportArch) || ['amd64'],
    };

    catalog.apps.push(appEntry);

    // Read icon if exists
    const iconPath = path.join(ICONS_DIR, `${appName}.png`);
    if (fs.existsSync(iconPath)) {
      icons[appName] = fs.readFileSync(iconPath).toString('base64');
    }

    // Read chart .tgz if exists
    const tgzPattern = `${appName}-`;
    const chartFiles = fs.readdirSync(CHARTS_DIR).filter(f => f.startsWith(tgzPattern) && f.endsWith('.tgz'));
    if (chartFiles.length > 0) {
      // Use the latest version
      const latestChart = chartFiles.sort().pop();
      charts[appName] = fs.readFileSync(path.join(CHARTS_DIR, latestChart)).toString('base64');
    }
  }

  // Write outputs to src/ for Worker import
  fs.mkdirSync(SRC_DIR, { recursive: true });
  fs.writeFileSync(path.join(SRC_DIR, 'catalog.json'), JSON.stringify(catalog, null, 2));
  fs.writeFileSync(path.join(SRC_DIR, 'icons.json'), JSON.stringify(icons));
  fs.writeFileSync(path.join(SRC_DIR, 'charts.json'), JSON.stringify(charts));

  console.log(`Built catalog: ${catalog.apps.length} apps, ${Object.keys(icons).length} icons, ${Object.keys(charts).length} charts`);
}

buildCatalog();
```

- [ ] **Step 3: Test the build script with no apps**

Run: `cd C:/Users/treve/Olares-Models && node scripts/build-catalog.js`

Expected: `Built catalog: 0 apps, 0 icons, 0 charts` and three JSON files in `src/`

- [ ] **Step 4: Verify output files exist**

Run: `ls src/catalog.json src/icons.json src/charts.json`

Expected: All three files present

- [ ] **Step 5: Commit**

```bash
git add scripts/build-catalog.js
git commit -m "feat: add build-catalog script for marketplace index generation"
```

---

## Task 3: Cloudflare Worker

**Files:**
- Create: `src/index.ts`

Adapts the orales-one-market Worker pattern. Routes API requests for the Market Source protocol.

- [ ] **Step 1: Write src/index.ts**

```typescript
import catalog from './catalog.json';
import icons from './icons.json';
import charts from './charts.json';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

function handleHash(): Response {
  return jsonResponse({
    hash: catalog.version,
    version: catalog.version,
  });
}

function handleInfo(): Response {
  const apps = (catalog as any).apps.map((app: any) => ({
    name: app.name,
    chartName: app.chartName,
    version: app.version,
    title: app.title,
    description: app.description,
    icon: app.icon,
    category: app.category,
    versionName: app.versionName,
    developer: app.developer,
    requiredGpu: app.requiredGpu,
    limitedGpu: app.limitedGpu,
    requiredMemory: app.requiredMemory,
    limitedMemory: app.limitedMemory,
    supportArch: app.supportArch,
  }));

  return jsonResponse({
    apps,
    recommendApps: apps.map((a: any) => a.name),
    categories: ['AI'],
    tags: ['LLM', 'vLLM', 'llama.cpp', 'inference'],
    totalCount: apps.length,
  });
}

async function handleDetail(request: Request): Promise<Response> {
  const body = await request.json() as { names?: string[] };
  const names = body.names || [];
  const results = (catalog as any).apps.filter((app: any) => names.includes(app.name));
  return jsonResponse({ apps: results });
}

function handleChart(appName: string): Response {
  const chartData = (charts as Record<string, string>)[appName];
  if (!chartData) {
    return new Response('Chart not found', { status: 404, headers: CORS_HEADERS });
  }
  const buffer = Uint8Array.from(atob(chartData), c => c.charCodeAt(0));
  return new Response(buffer, {
    headers: {
      'Content-Type': 'application/gzip',
      'Content-Disposition': `attachment; filename="${appName}.tgz"`,
      ...CORS_HEADERS,
    },
  });
}

function handleIcon(iconName: string): Response {
  const name = iconName.replace(/\.png$/, '');
  const iconData = (icons as Record<string, string>)[name];
  if (!iconData) {
    return new Response('Icon not found', { status: 404, headers: CORS_HEADERS });
  }
  const buffer = Uint8Array.from(atob(iconData), c => c.charCodeAt(0));
  return new Response(buffer, {
    headers: { 'Content-Type': 'image/png', ...CORS_HEADERS },
  });
}

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    // Health check
    if (pathname === '/' || pathname === '/health') {
      return jsonResponse({ status: 'ok', apps: (catalog as any).apps.length });
    }

    // Market Source API
    if (pathname === '/api/v1/appstore/hash') return handleHash();
    if (pathname === '/api/v1/appstore/info') return handleInfo();
    if (pathname === '/api/v1/applications/info' && request.method === 'POST') {
      return handleDetail(request);
    }

    // Chart download: /api/v1/applications/{name}/chart
    const chartMatch = pathname.match(/^\/api\/v1\/applications\/([^/]+)\/chart$/);
    if (chartMatch) return handleChart(chartMatch[1]);

    // Icon download: /icons/{name}
    const iconMatch = pathname.match(/^\/icons\/([^/]+)$/);
    if (iconMatch) return handleIcon(iconMatch[1]);

    return new Response('Not found', { status: 404, headers: CORS_HEADERS });
  },
};
```

- [ ] **Step 2: Run build-catalog to generate prerequisite JSON files (depends on Task 2), then start dev server**

Run: `cd C:/Users/treve/Olares-Models && npm run dev`

Expected: Wrangler starts local dev server. Visit `http://localhost:8787/health` and see `{"status":"ok","apps":0}`

- [ ] **Step 3: Test API endpoints locally**

```bash
curl http://localhost:8787/api/v1/appstore/hash
curl http://localhost:8787/api/v1/appstore/info
```

Expected: JSON responses with empty app lists

- [ ] **Step 4: Commit**

```bash
git add src/index.ts
git commit -m "feat: add Cloudflare Worker serving Market Source API"
```

---

## Task 4: README

**Files:**
- Create: `README.md`

- [ ] **Step 1: Write README.md**

```markdown
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
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: add README with market source URL and setup instructions"
```

---

## Task 5: The `/deploy-model` Skill

**Files:**
- Create: `skills/deploy-model.md`

This is the core deliverable — the Claude Code skill file that drives the entire interactive flow. It contains the optimization engine logic, template patterns, and packaging pipeline as instructions for Claude.

- [ ] **Step 1: Create skills directory**

```bash
mkdir -p skills
```

- [ ] **Step 2: Write skill preamble and Steps 1-5 (metadata fetch, variant selection, backend selection, optimization engine, config proposal)**

Create `skills/deploy-model.md`. This is a large file — write it in stages. Start with the YAML frontmatter and Steps 1-5 (everything up to and including the config proposal).

- [ ] **Step 3: Write skill Step 6-7 vLLM template section**

Append to `skills/deploy-model.md`: Step 6 (app name generation) and the vLLM portion of Step 7 (all vLLM chart files: Chart.yaml, OlaresManifest.yaml, .helmignore, values.yaml, owners, i18n, templates/keep, clientproxy.yaml, server Chart.yaml, _helpers.tpl, deployment.yaml).

- [ ] **Step 4: Write skill Step 7 llama.cpp template section**

Append to `skills/deploy-model.md`: the llama.cpp portion of Step 7 (all llama.cpp chart files).

- [ ] **Step 5: Write skill Steps 8-9 (packaging, publishing, post-deploy summary)**

Append to `skills/deploy-model.md`: Steps 8-9 (helm package, icon, catalog build, git commit, deploy prompt, summary).

- [ ] **Step 6: Verify skill file has valid YAML frontmatter**

Run: `head -5 skills/deploy-model.md`
Expected: Valid `---` delimited YAML with `name: deploy-model` and `description:` fields.

The complete skill file content follows. Write it across Steps 2-5 above.

```markdown
---
name: deploy-model
description: Deploy an LLM model as an Olares app — provide a HuggingFace URL, auto-optimize for Olares One hardware, generate Helm chart, package, and publish to marketplace
---

# Deploy Model to Olares Marketplace

You are deploying an LLM model as an Olares app package. Follow this flow exactly.

## Prerequisites

- Working directory must be the `Olares-Models` repo
- `npm install` has been run (node_modules exists)
- Helm CLI is available (`helm version`)

## Step 1: Get Model URL

Ask the user for a HuggingFace model URL. If they haven't provided one, ask:

> "What model would you like to deploy? Provide a HuggingFace URL (e.g., https://huggingface.co/Qwen/Qwen3-30B-A3B)"

## Step 2: Fetch Model Metadata

Use WebFetch to pull the model's metadata:

1. Fetch `https://huggingface.co/api/models/<org>/<model>` to get:
   - `config.architectures` — model architecture
   - `config.num_hidden_layers` — layer count
   - `config.num_key_value_heads` — KV head count
   - `config.hidden_size` — hidden dimension
   - `config.head_dim` — head dimension (or compute from hidden_size / num_attention_heads)
   - `config.max_position_embeddings` — native context length
   - `safetensors.total` — total parameter count
   - `siblings` — list of files (to detect format: .gguf, .safetensors, etc.)
   - Model card text — for description, license, MoE detection

2. Determine if the model is **MoE**: check for `num_local_experts` in config or "MoE"/"Mixture of Experts" in model card. If MoE, also get `num_experts_per_tok` for active parameter estimation.

3. Determine **model format** from files:
   - `.safetensors` files → safetensors format (vLLM compatible)
   - `.gguf` files → GGUF format (llama.cpp)
   - Check for AWQ/GPTQ in model name or config

## Step 3: Find Optimal Variant (if generic model)

If the URL points to a base model (no quantization), search for the best quantized variant:

1. Search HuggingFace for quantized versions:
   - WebFetch `https://huggingface.co/api/models?search=<model-name>&author=bartowski`
   - Also search authors: `TheBloke`, `casperhansen`, `turboderp`, `Unsloth`
   - Look for AWQ, GPTQ, and GGUF variants

2. Evaluate each variant against the Olares One device (24GB VRAM, 96GB RAM):
   - Calculate weight size from file sizes in model siblings
   - Check: does it fit fully in 22GB VRAM (with 2GB headroom)?
   - Rank by: quality (higher quant bits = better) > speed (full GPU > partial) > format (AWQ for vLLM > GGUF)

3. Present the recommendation:
   > "Found N variants of [Model]. Recommending `[variant]` — [quant type], [size]GB, [fits/doesn't fit] fully in VRAM. [Backend] optimized. ~[speed] t/s expected."

If the URL is already a specific quantized model, skip this step.

## Step 4: Select Backend

Apply these rules in order:
1. Model has safetensors/AWQ/GPTQ AND fits in VRAM → **vLLM** (preferred)
2. Model is GGUF-only → **llama.cpp**
3. Model needs partial CPU offload (doesn't fit in VRAM) → **llama.cpp**
4. Both formats available → **vLLM** (preferred for throughput)

## Step 5: Compute Optimal Configuration

### Device Profile
- VRAM: 24GB (RTX 5090M)
- VRAM bandwidth: 896 GB/s
- RAM: 96GB DDR5
- RAM bandwidth: ~80 GB/s
- CPU: 24 cores
- VRAM budget: 22GB (2GB headroom for system)

### Calculations

**Model weight size**: sum of all weight files (safetensors or GGUF), or estimate from param count × bytes per param for the quantization level.

**KV cache per token per layer**: `2 × num_kv_heads × head_dim × 2 bytes` (K and V, FP16)

**KV cache for context**: `kv_per_token_per_layer × num_layers × context_length`

**Total VRAM**: `model_weight_size + kv_cache`

**Fitting logic**:
- If total < 22GB → full GPU, use model's native context length
- If total > 22GB but weights alone < 22GB → full GPU, reduce context until it fits
- If weights alone > 22GB → partial offload (llama.cpp) or more aggressive quantization

**GPU layers (llama.cpp partial offload)**:
- `layer_size = model_weight_size / num_layers`
- `available_vram = 22GB - kv_cache_estimate`
- `max_gpu_layers = floor(available_vram / layer_size)`
- CRITICAL: if this would overflow into shared VRAM, reduce layers further
- If < 20% of layers fit → recommend full CPU instead

**Context length**:
- Start from model's native max context
- If doesn't fit: binary search down until `weights + kv_cache(ctx) < 22GB`
- Minimum: 2048 tokens

**Concurrent users (vLLM)**:
- `per_request_kv = kv_per_token_per_layer × num_layers × avg_context_per_request`
- Assume avg_context_per_request = context_length / 2
- `max_num_seqs = floor((22GB - model_weights) / per_request_kv)`
- Minimum: 1, cap at 64

**Speed estimate** (use sweet spot table as primary reference):

| Model Size | Full GPU Speed |
|------------|---------------|
| Up to 14B | 80-130 t/s |
| 30-35B dense | 45-65 t/s |
| 30B MoE (3B active) | 200+ t/s |
| 70B+ partial offload | 3-5 t/s |

For models between these ranges, interpolate. For MoE, use active params for speed lookup.

### Present Proposal

```
Based on [Model Name] ([params], [quant], [weight_size]GB) on Olares One:
- Backend: [vLLM / llama.cpp]
- GPU allocation: [X]GB VRAM
- Offloading: [Full GPU / Partial (N GPU layers, M CPU layers) / Full CPU]
- Context length: [N] tokens
- Concurrent users: [N]
- Estimated speed: ~[N] t/s

Approve or adjust?
```

Wait for user approval. If they adjust values, recalculate dependent values (e.g., changing context length affects KV cache and concurrent users).

## Step 6: Generate App Name

Construct the appid:
- Backend prefix: `vllm` or `llamacpp`
- Model name: lowercase, remove special chars, no hyphens
- Example: Qwen3.5 30B-A3B → `vllmqwen3530ba3b`

Verify the name doesn't already exist as a directory in the repo. If it does, ask user: update existing or create new with suffix?

## Step 7: Generate App Files

### For vLLM backend — generate two-tier chart:

**`<appname>/Chart.yaml`**:
```yaml
apiVersion: v2
appVersion: '<huggingface-model-id>'
description: '<model display name> served via vLLM — optimized for Olares One'
name: <appname>
type: application
version: '1.0.0'
```

**`<appname>/OlaresManifest.yaml`**: Generate following the spec's OlaresManifest template (see spec section "OlaresManifest.yaml Spec"). Fill in:
- appid, title, icon, description from model metadata
- version: 1.0.0, versionName: '1.0.0'
- entrances: port 8080, authLevel private
- Resource specs from computed config (use low `required*` values for scheduling, computed values for `limited*`)
- `requiredDisk`: model weight size + 5GB buffer (e.g., 35Gi for a 30GB model)
- `limitedDisk`: model weight size + 15GB buffer (e.g., 50Gi)
- `permission: appData: true`
- `middleware: {}`
- developer from model card, website as HuggingFace URL
- license from model card
- category: AI
- supportArch: [amd64]
- `options.dependencies`: olares >=1.12.3-0

**`<appname>/.helmignore`**:
```
.DS_Store
docker/
*.tgz
```

**`<appname>/values.yaml`**:
```yaml
admin: ""
bfl:
  username: ""
userspace:
  appData: ""
  appCache: ""
  userData: ""
```

**`<appname>/owners`**:
```yaml
owners:
- 'trevestforvor'
```

**`<appname>/i18n/en-US/OlaresManifest.yaml`**: Generate with:
- metadata.title: human-friendly display name (e.g., "Qwen 3.5 30B-A3B (vLLM)")
- metadata.description: one-line summary
- spec.fullDescription: detailed description with hardware target, performance expectations, model capabilities

**`<appname>/i18n/zh-CN/OlaresManifest.yaml`**: Translate the en-US version to Chinese.

**`<appname>/templates/keep`**: Empty file (git placeholder for top-level templates dir).

**`<appname>/<appname>/templates/clientproxy.yaml`**: Generate nginx reverse proxy ConfigMap + Deployment + Service following the vLLM reference pattern:
- Nginx ConfigMap: proxy to `download-svc.<appname>server-shared:8090`, 1800s timeout, WebSocket support, CORS headers
- Deployment: `docker.io/beclab/aboveos-bitnami-openresty:1.25.3-2`, 500m CPU / 500Mi memory limits, readiness/liveness probes on `/ping`
- Service: `vllmclient` on port 8080
- Hardcode `<appname>` for deployment/service/label names (Olares linter requires name = appid, NOT `{{ .Release.Name }}`). Use `{{ .Release.Namespace }}` for namespace only.

**`<appname>/<appname>server/Chart.yaml`**:
```yaml
apiVersion: v2
appVersion: '<huggingface-model-id>'
description: '<model display name> server'
name: <appname>server
type: application
version: '1.0.0'
```

**`<appname>/<appname>server/templates/_helpers.tpl`**: GPU detection helper — define `GPU.getGPUInfo` template that reads node GPU info and detects hardware type (isSparkDGX flag). Copy the pattern from the vLLM reference exactly.

**`<appname>/<appname>server/templates/deployment.yaml`**: Generate the vLLM deployment following the reference pattern:
- vLLM container:
  - Image: `vllm/vllm-openai:v0.17.1-cu130`
  - Command: wait for model download completion flag, then start `vllm serve`
  - Args: `--model /models/<model-id> --gpu-memory-utilization <computed> --max-model-len <computed_context> --max-num-seqs <computed_concurrency> --port 8000`
  - Resources: requests `<requiredCpu>` CPU / `<requiredMemory>` RAM, limits `<limitedCpu>` / `<limitedMemory>`
  - GPU resource limit: `nvidia.com/gpu: 1`
  - Env: `HF_TOKEN`, `VLLM_WORKER_MULTIPROC_METHOD=spawn`, timezone
  - Volume mount: `/models` from hostPath to `{{ .Values.userspace.appData }}/models`
  - Startup probe: HTTP GET `/health` port 8000, initialDelaySeconds 300, periodSeconds 15, failureThreshold 40
  - Liveness probe: HTTP GET `/health` port 8000, periodSeconds 60
- Download container (sidecar):
  - Image: `docker.io/beclab/harveyff-hf-downloader:v0.1.0`
  - Port 8090
  - Env: `MODEL_ID=<huggingface-model-id>`, `HF_HOME=/models`
  - Resources: 100m/500Mi request, 1/1Gi limit
  - Startup probe: `/ping` port 8090, 10s interval
  - Liveness probe: `/ping` port 8090, 60s interval, 10 failures
  - Same volume mount for models
- Services: download-svc on 8090, shared entrance service
- Volume: hostPath to `{{ .Values.userspace.appData }}/models`, type DirectoryOrCreate

### For llama.cpp backend — generate single chart:

**`<appname>/Chart.yaml`**: Same pattern as vLLM but with llama.cpp description.

**`<appname>/OlaresManifest.yaml`**: Same structure as vLLM manifest. Adjust entrances port to 8080 direct.

**`<appname>/.helmignore`**, **`values.yaml`**, **`owners`**, **`i18n/`**: Same as vLLM pattern.

**`<appname>/templates/deployment.yaml`**: Generate following the llama.cpp reference pattern:
- Inline ConfigMap (`llamacpp-env`):
  - `MODEL_URL`: direct download URL for the GGUF file
  - `MODEL_FILE`: GGUF filename
  - `MODEL_ALIAS`: model alias for API
  - `CONTEXT_SIZE`: computed context length as string
  - `N_GPU_LAYERS`: computed GPU layers as string (or "99" for full GPU)
  - `THREADS`: "16"
- Init container:
  - Image: `docker.io/alpine:3.20`
  - Command: `wget -q` to download model if not present
  - Volume mount: `/models`
- Main container:
  - Image: `ghcr.io/ggml-org/llama.cpp:server-cuda-b8234`
  - Port: 8080
  - Args from ConfigMap values: `--model /models/$(MODEL_FILE) --alias $(MODEL_ALIAS) --ctx-size $(CONTEXT_SIZE) --n-gpu-layers $(N_GPU_LAYERS) --threads $(THREADS) -fa on --mlock -ctk q8_0 -ctv q8_0 -b 2048 -ub 1024 --host 0.0.0.0 --port 8080`
  - If concurrent users > 1: add `--parallel <N>`
  - Resources: requests `<requiredCpu>` / `<requiredMemory>`, limits `<limitedCpu>` / `<limitedMemory>`
  - GPU resource: `nvidia.com/gpu: 1` (if using GPU layers)
  - envFrom: configMapRef llamacpp-env
  - Startup probe: HTTP GET `/health` port 8080, initialDelaySeconds 60, periodSeconds 10, failureThreshold 30
  - Liveness probe: HTTP GET `/health` port 8080, periodSeconds 30
  - Volume: `/models` from hostPath `{{ .Values.userspace.appData }}/models`
  - Volume: `/tmp/cache` from emptyDir
- Service: port 8080

## Step 8: Validate and Package

0. **Lint validation** (before packaging):
   Verify these Olares linting rules:
   - `appid` in OlaresManifest.yaml = folder name = `name` in Chart.yaml = deployment name in templates = service name = entrance name = entrance host
   - `metadata.name` field exists in OlaresManifest.yaml (same value as appid)
   - All lowercase, no hyphens in appid
   - `metadata.icon` is NOT empty — must be a valid URL
   - `metadata.title` and `entrances[].title`: max 30 chars, only `[a-z0-9A-Z- ]` allowed (NO dots, underscores, or special chars)
   - Sum of container CPU `requests` <= `requiredCpu` in OlaresManifest
   - Sum of container memory `requests` <= `requiredMemory` in OlaresManifest
   - Deployment/service names are hardcoded to `<appname>` (NOT `{{ .Release.Name }}`)
   - Volume paths use `{{ .Values.userspace.appData }}`
   - `i18n/en-US/OlaresManifest.yaml` and `i18n/zh-CN/OlaresManifest.yaml` both exist
   - If any check fails, fix before proceeding.

1. **Helm lint**:
   ```bash
   helm lint <appname>/
   ```
   If errors, fix and re-lint.

2. **Helm package**:
   ```bash
   helm package <appname>/ -d charts/
   ```
   If this fails, check the error, fix template issues, and retry.

2. **Icon**: Try to fetch model icon from HuggingFace (`https://huggingface.co/api/models/<model-id>` → avatar_url). If unavailable, inform user they can add one manually at `icons/<appname>.png` (256x256, <512KB). Create a placeholder text file noting this.

3. **Build catalog**:
   ```bash
   npm run build:catalog
   ```

4. **Git commit**:
   ```bash
   git add <appname>/ charts/<appname>-*.tgz icons/
   git commit -m "[NEW][<appname>][1.0.0] Add <Display Name> via <backend>"
   ```

5. **Deploy** (ask first):
   > "App packaged and committed. Deploy to Cloudflare Workers marketplace now? (runs `npm run deploy`)"

   If user approves: `npm run deploy`

   After deploy, update README.md model catalog table with the new app's details.

## Step 9: Post-Deploy Summary

Print:
```
Successfully deployed <Display Name>!

Market Source URL: https://olares-models.<account>.workers.dev
App ID: <appname>
Backend: <vLLM / llama.cpp>
Config: <context>K ctx, <concurrent> concurrent users, ~<speed> t/s
Model downloads on first launch (~<size>GB)
```
```

- [ ] **Step 3: Commit**

```bash
git add skills/deploy-model.md
git commit -m "feat: add /deploy-model Claude Code skill"
```

---

## Task 6: Register the Skill

**Files:**
- Modify: User's Claude Code settings to register the skill

- [ ] **Step 1: Check if .claude directory exists in Olares-Models**

```bash
ls C:/Users/treve/Olares-Models/.claude/
```

- [ ] **Step 2: Create .claude/commands directory and register skill**

```bash
mkdir -p C:/Users/treve/Olares-Models/.claude/commands
```

Create `C:/Users/treve/Olares-Models/.claude/commands/deploy-model.md`:

```markdown
Read and follow the skill file at skills/deploy-model.md exactly.
```

This registers `/deploy-model` as a slash command when working in the Olares-Models directory.

- [ ] **Step 3: Commit**

```bash
git add .claude/commands/deploy-model.md
git commit -m "feat: register /deploy-model as Claude Code slash command"
```

---

## Task 7: End-to-End Test

**Files:** None (verification only)

- [ ] **Step 1: Verify repo structure**

```bash
cd C:/Users/treve/Olares-Models && find . -not -path './node_modules/*' -not -path './.git/*' | sort
```

Expected directory tree matches the spec's repository structure.

- [ ] **Step 2: Verify Worker runs locally**

```bash
cd C:/Users/treve/Olares-Models && npm run dev
```

In another terminal:
```bash
curl http://localhost:8787/health
curl http://localhost:8787/api/v1/appstore/info
```

Expected: Health OK, empty app list.

- [ ] **Step 3: Test the skill with a real model**

In the Olares-Models directory, run `/deploy-model` and provide a test model URL like:
```
https://huggingface.co/Qwen/Qwen3-30B-A3B
```

Verify the full flow:
- Model metadata fetched
- Optimal variant recommended
- Config computed and proposed
- App files generated
- Helm package succeeds
- Catalog rebuilt
- Commit created

- [ ] **Step 4: Verify generated app passes basic checks**

```bash
helm lint <generated-app-dir>/
```

Expected: No errors.

- [ ] **Step 5: Update README model catalog**

After successful test deploy, update the README.md model catalog table with the test model's details.

- [ ] **Step 6: Commit test results**

```bash
git add .
git commit -m "test: verify /deploy-model skill with first model"
```

---

## Task 8: Deploy to Cloudflare (Optional)

Only if user wants to go live.

- [ ] **Step 1: Login to Cloudflare**

```bash
npx wrangler login
```

- [ ] **Step 2: Deploy**

```bash
cd C:/Users/treve/Olares-Models && npm run deploy
```

- [ ] **Step 3: Update README with actual Worker URL**

Replace `<your-account>` placeholder with the actual deployed URL.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: update README with live marketplace URL"
```
