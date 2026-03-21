# Olares Models

A curated marketplace of LLM inference apps optimized for **Olares One** hardware, served via a Cloudflare Worker.

## Project Structure

```
<appname>/              # One Helm chart per model (e.g., llamacppqwen314b/, vllmqwen3coder30ba3bfp4/)
  Chart.yaml
  OlaresManifest.yaml
  values.yaml
  owners
  .helmignore
  templates/deployment.yaml   # ConfigMap + Deployment + Service
  i18n/en-US/OlaresManifest.yaml
  i18n/zh-CN/OlaresManifest.yaml
charts/                 # Packaged .tgz Helm charts (committed to git)
icons/                  # Generated PNG icons with backend badges
scripts/
  build-catalog.js      # Scans app dirs → src/catalog.json, src/charts.json, src/icons.json
  generate-icons.js     # Composites org avatar + backend badge → icons/<appname>.png
src/index.ts            # Cloudflare Worker — serves Olares Market Source API
skills/deploy-model.md  # Claude Code skill for deploying new models
```

## Commands

```bash
npm install                       # Install dependencies (must run first)
npm run build:catalog             # Rebuild catalog from app dirs + charts/ + icons/
npm run dev                       # Local dev server at localhost:8787
npm run deploy                    # Build catalog + deploy to Cloudflare Workers
node scripts/generate-icons.js    # Regenerate all model icons
helm lint <appname>/              # Validate chart before packaging
helm package <appname>/ -d charts/  # Package chart into charts/
```

## Deploying a New Model

Use the `/deploy-model` skill. It handles: fetching HuggingFace metadata, finding optimal quantized variants, computing hardware-optimal config, generating all app files, packaging, and publishing.

## Target Hardware (Olares One)

- GPU: RTX 5090M — 24GB GDDR7, 896 GB/s bandwidth
- RAM: 96GB DDR5, ~80 GB/s bandwidth
- CPU: 24-core Intel Core Ultra 9
- VRAM budget: 22GB (2GB headroom for system)

## Naming Convention

App IDs: `<backend><modelname>` — all lowercase, no hyphens, no dots.
- `llamacpp` prefix for llama.cpp backend
- `vllm` prefix for vLLM backend
- Examples: `llamacppqwen314b`, `vllmqwen3coder30ba3bfp4`

## Backend Selection

1. Safetensors/AWQ/GPTQ AND fits in VRAM → **vLLM** (preferred for throughput)
2. GGUF-only → **llama.cpp**
3. Needs partial CPU offload → **llama.cpp**
4. vLLM port: 8000. llama.cpp port: 8080.

## Critical Rules (Learned from Past Bugs)

### GPU Configuration
- Olares GPU requires BOTH `applications.app.bytetrade.io/gpu-inject: "true"` annotation on Deployment metadata AND `nvidia.com/gpu: "1"` in resource limits
- vLLM needs `runtimeClassName: nvidia`
- llama.cpp needs `nvidia.com/gpu: "1"` in both requests AND limits

### VRAM Overflow
- Never overflow into shared VRAM — it's worse than pure CPU (0.69 t/s vs 1.42 t/s measured)
- If model weights alone exceed 22GB, use llama.cpp partial offload or more aggressive quantization

### Version Sync (4 fields — miss one and the store won't update)
When bumping a version, you MUST update ALL FOUR of these to the same value:
1. `Chart.yaml` → `version`
2. `OlaresManifest.yaml` → `metadata.version`
3. `OlaresManifest.yaml` → `metadata.versionName`
4. `OlaresManifest.yaml` → `spec.versionName`
- Out-of-sync versions cause apps to silently not appear or not update in the marketplace
- This is the most common mistake — always grep for the old version to confirm all four are changed

### Olares Linter Rules
- `appid` = folder name = `name` in Chart.yaml = deployment name = service name = entrance name = entrance host
- `metadata.name` must exist in OlaresManifest.yaml (same as appid)
- `metadata.title` and `entrances[].title`: max 30 chars, only `[a-z0-9A-Z- ]` (no dots, underscores, special chars)
- `metadata.icon` must not be empty
- `requiredMemory` >= sum of container memory requests
- `requiredCpu` >= sum of container CPU requests
- Deployment/service names are hardcoded strings (not `{{ .Release.Name }}`)

### llama.cpp Specifics
- Always use `-np 1` (single slot) — parallel slots divide context and double KV cache VRAM
- Flash attention flags changed between versions: verify flag format for the image version in use

### vLLM Specifics
- Use `--max-num-seqs 16` for concurrent request handling (paged attention, no context splitting)
- Use `--enable-prefix-caching` for performance
- MoE models may need `--enforce-eager` and `--cpu-offload-gb 2` to avoid OOM
- For reasoning models, add `--reasoning-parser <parser>` (e.g., `qwen3` for Qwen)
- For tool-calling models, add `--enable-auto-tool-choice --tool-call-parser <parser>`

### Icon Generation
- Add new model entry to `scripts/generate-icons.js` before running it
- Badge colors: `#2d8cf0` for llama.cpp, `#7c3aed` for vLLM, `#000000` for Ollama
- Icon URL format: `https://olares-models.crochetme.workers.dev/icons/<appname>.png`

## Build Pipeline

1. App dirs are the source of truth for metadata
2. `npm run build:catalog` scans them into `src/catalog.json`, `src/charts.json`, `src/icons.json`
3. These JSON files are gitignored — they're build artifacts
4. `charts/*.tgz` files ARE committed (the Worker serves them base64-encoded)
5. The Worker (`src/index.ts`) serves the Olares Market Source API endpoints

## Commit Convention

- New models: `[NEW][<appname>][<version>] Add <Display Name> via <backend>`
- Fixes: `fix: <description>`
- Features: `feat: <description>`
- Version bumps: `chore: bump <model> to v<version>`
- When bumping a version, update ALL four version fields (Chart.yaml + 3 in OlaresManifest.yaml)
