# Design: `/deploy-model` Skill for Olares-Models

**Date**: 2026-03-18
**Status**: Draft
**Approach**: Claude Code Skill (Approach A)

## Overview

A Claude Code skill (`/deploy-model`) that takes a model URL, auto-detects the optimal configuration for Olares One hardware, generates a complete Olares app package, and publishes it to a custom Cloudflare Workers marketplace.

## Target Hardware

| Spec | Value |
|------|-------|
| GPU | RTX 5090M (24GB GDDR7, 896 GB/s) |
| RAM | 96GB DDR5 (~80 GB/s effective) |
| CPU | 24-core Intel |
| Architecture | amd64 |

## Skill Flow

### 1. Trigger

User invokes `/deploy-model` and provides a model URL (e.g., HuggingFace model page or direct file link).

### 2. Model Discovery & Variant Selection

Claude fetches model metadata via WebFetch:

- Pulls base model card to determine: architecture, parameter count, context length, MoE status (and active param count)
- If the URL points to a **generic model** (not a specific quantization):
  - Searches HuggingFace for quantized variants (AWQ, GPTQ, GGUF) from known quantizers (bartowski, TheBloke, casperhansen, etc.)
  - Evaluates each variant against device specs: VRAM fit, expected speed, quality trade-off
  - Selects the best variant and explains why
- If the URL points to an **exact quantized model**: uses it directly, no search

### 3. Backend Selection

- Model has safetensors/AWQ/GPTQ formats and fits in VRAM → **vLLM** (preferred)
- Model is GGUF-only → **llama.cpp**
- Model needs partial CPU offload → **llama.cpp** (vLLM CPU offload is immature)
- Both formats available → **vLLM preferred**

### 4. Optimization Engine

Computes optimal config for the Olares One device profile:

#### Does the model fit fully in VRAM?

- Calculate: `model_weight_size + KV_cache_estimate`
- KV cache: `2 * num_layers * num_kv_heads * head_dim * context_length * 2 bytes`
- If total < 22GB (2GB headroom) → full GPU
- If total 22-24GB → full GPU, reduced context length
- If total > 24GB → partial offload or CPU-only

#### Partial offload (llama.cpp only)

- `layer_size = model_weight_size / num_layers`
- `max_gpu_layers = floor((22GB - KV_cache_estimate) / layer_size)`
- **Never overflow into shared VRAM** (worse than pure CPU: 0.69 t/s vs 1.42 t/s)
- If < 20% of layers fit on GPU → recommend full CPU

#### Context length

- Start from model's native context length
- Reduce until `model_weights + KV_cache` fits within VRAM budget
- Present the maximum context length that fits comfortably

#### Concurrent users

- vLLM: `max_num_seqs = floor(remaining_VRAM / per_request_KV_cache)`
- llama.cpp: conservative default (1-4)

#### Speed estimate

Uses the empirical sweet spot table (below) as the primary reference. The formula `VRAM_bandwidth / model_weight_size` serves as a **ceiling estimate only** — actual throughput is lower due to attention overhead, dequantization cost, and batch effects.

- Full GPU: reference sweet spot table, adjusted for model size
- Partial offload: weighted average based on GPU/CPU layer split
- MoE models: use active params instead of total params for speed calculation

### 5. Config Proposal

Presents a single optimized proposal:

```
Based on [Model Name] ([params], [quant], [weight size]) on Olares One:
- Backend: vLLM / llama.cpp
- GPU allocation: XGB VRAM
- Offloading: Full GPU / Partial (N layers GPU, M layers CPU) / Full CPU
- Context length: N tokens
- Concurrent users: N
- Estimated speed: ~N t/s

Approve or adjust?
```

User approves or tweaks individual values.

### 6. App Generation

Generates the complete Olares app package in `Olares-Models/`.

### 7. Packaging & Publishing

- `helm package` the app
- Generate/fetch icon
- Update market index
- Git commit
- Ask before deploying to Cloudflare Workers

## App Naming Convention

- **appid/folder**: `backendmodelname` — all lowercase, no hyphens (e.g., `vllmqwen330ba3b`)
  - Matches Olares linter rules: appid = folder = chart name = deployment = service = entrance name = entrance host = metadata.name
  - Deployment/service names must be hardcoded to appid (NOT `{{ .Release.Name }}`)
- **Display title**: Human-friendly in OlaresManifest i18n — max 30 chars, only `[a-z0-9A-Z- ]` (NO dots)
- **Icon**: metadata.icon MUST NOT be empty — use HuggingFace org avatar or model icon URL
- **Resources**: `requiredCpu` >= sum of container CPU requests; `requiredMemory` >= sum of container memory requests

## Template Structures

### vLLM Template (two-tier chart)

```
vllmqwen330ba3b/
├── Chart.yaml                          # apiVersion: v2, type: application, appVersion: <model-id>
├── OlaresManifest.yaml                 # olaresManifest.version: 0.10.0
├── .helmignore                         # Helm packaging exclusions
├── values.yaml                         # Empty (config via env vars)
├── owners                              # GitHub handle
├── i18n/
│   ├── en-US/OlaresManifest.yaml       # English display name + description
│   └── zh-CN/OlaresManifest.yaml       # Chinese (Claude translates from English)
├── templates/
│   └── keep                            # Git placeholder for top-level templates dir
├── vllmqwen330ba3b/                    # Client proxy subchart
│   └── templates/
│       └── clientproxy.yaml            # OpenResty nginx reverse proxy (port 8080)
└── vllmqwen330ba3bserver/              # Server subchart
    ├── Chart.yaml
    └── templates/
        ├── deployment.yaml             # vLLM container + HF downloader sidecar
        └── _helpers.tpl                # GPU detection helpers
```

**Key configuration points:**

| Parameter | Implementation |
|-----------|---------------|
| Model path | `--model /models/<model-id>` or env var |
| GPU memory | `--gpu-memory-utilization 0.9` env var |
| Context length | `--max-model-len N` arg |
| Concurrency | `--max-num-seqs N` arg |
| API port | 8000 internal, proxied to 8080 via OpenResty |

**Images:**
- vLLM: `vllm/vllm-openai:v0.17.1-cu130`
- Downloader: `docker.io/beclab/harveyff-hf-downloader:v0.1.0`
- Client proxy: `docker.io/beclab/aboveos-bitnami-openresty:1.25.3-2`

### llama.cpp Template (single chart)

```
llamacppllama3170b/
├── Chart.yaml
├── OlaresManifest.yaml
├── values.yaml
├── owners
├── .helmignore
├── i18n/
│   ├── en-US/OlaresManifest.yaml
│   └── zh-CN/OlaresManifest.yaml       # Chinese (Claude translates from English)
└── templates/
    └── deployment.yaml                 # llama.cpp container + alpine init container + inline ConfigMap
```

**Key configuration points:**

| Parameter | Implementation |
|-----------|---------------|
| Model URL/file | Inline ConfigMap in deployment.yaml: `MODEL_URL`, `MODEL_FILE` |
| GPU layers | Inline ConfigMap: `N_GPU_LAYERS` |
| Context length | Inline ConfigMap: `CONTEXT_SIZE` |
| Concurrency | `--parallel N` arg |
| API port | 8080 direct |

**Images:**
- llama.cpp: `ghcr.io/ggml-org/llama.cpp:server-cuda-b8234`
- Init container: `docker.io/alpine:3.20`

**Additional llama.cpp args (hardcoded best practices):**
- `-fa on` (flash attention — requires value: on/off/auto)
- `--mlock` (prevent model swap to disk)
- `-ctk q8_0 -ctv q8_0` (quantized KV cache)
- `-b 2048 -ub 1024` (batch sizes)
- Use short flags (`-m`, `-a`, `-c`, `-ngl`, `-t`, `-np`) for cross-version compatibility

## OlaresManifest.yaml Spec

Generated for each app with computed values:

```yaml
olaresManifest.version: '0.10.0'
olaresManifest.type: app
metadata:
  appid: <appname>
  title: <Display Title>
  icon: <icon URL>
  description: <short description>
  version: 1.0.0
  versionName: '1.0.0'
entrances:
  - name: <appname>
    port: 8080
    title: <Display Title>
    authLevel: private
spec:
  versionName: '1.0.0'
  fullDescription: <detailed model description — capabilities, use cases, performance notes>
  developer: <from HuggingFace model card or user's GitHub handle>
  website: <HuggingFace model page URL>
  sourceCode: <Olares-Models repo URL>
  submitter: <user's GitHub handle>
  locale:
    - en-US
    - zh-CN
  license:
    - text: <model license, e.g., Apache-2.0, MIT, Llama Community>
  category: AI
  requiredMemory: <low minimum for scheduling, e.g., 1Gi>
  limitedMemory: <actual ceiling, e.g., 28Gi>
  requiredCpu: <low minimum, e.g., 500m>
  limitedCpu: <actual ceiling, e.g., 18>
  requiredGpu: <low minimum for scheduler, e.g., 1Gi>
  limitedGpu: <actual VRAM allocation, e.g., 24Gi>
  requiredDisk: <model weight size + buffer>
  limitedDisk: <disk ceiling>
  supportArch:
    - amd64
permission:
  appData: true
middleware: {}
options:
  dependencies:
    - type: system
      name: olares
      version: '>=1.12.3-0'
```

**GPU/Memory semantics**: `required*` fields are **minimums for the Kubernetes scheduler** (set low so pods can be placed). `limited*` fields are the **actual resource ceilings** that constrain the container. This matches the beclab/apps pattern (e.g., Ollama uses `requiredGpu: 0` with `limitedGpu: 16Gi`).

## Optimization Reference Tables

### Sweet Spots for Olares One

| Model Size | Best Strategy | Expected Speed |
|------------|--------------|----------------|
| Up to 14B | Full GPU, Q6_K or Q8_0 | 80-130 t/s |
| 30-35B dense | Full GPU, Q4_K_M | 45-65 t/s |
| 30B MoE (e.g., Qwen3 30B-A3B) | Full GPU, Q4_K | 200+ t/s |
| 70B+ | Partial GPU offload (~25-28 layers), Q4_K_M | 3-5 t/s |

### Critical Rules

- **Never overflow into shared VRAM** — worse than pure CPU (0.69 t/s vs 1.42 t/s)
- **Prefer smaller model at higher quant** over larger model at lower quant when VRAM-constrained
- **MoE models are exceptional** — 70B-class quality at 8B-class speed
- **Q3_K_L is the absolute floor** for acceptable quality on reasoning tasks
- For multi-user serving: vLLM with AWQ. For single-user: llama.cpp

## Repository Structure

```
Olares-Models/
├── README.md                          # Market source URL, setup, model catalog
├── package.json                       # Cloudflare Worker deps
├── tsconfig.json
├── wrangler.toml                      # Worker config
├── src/                               # Worker source (Market Source API)
├── scripts/                           # Build/deploy scripts
├── charts/                            # Packaged .tgz helm charts
├── icons/                             # App icons (256x256 PNG)
├── .github/workflows/                 # CI (lint, deploy)
│
├── <model-app-1>/                     # Generated model apps
├── <model-app-2>/
└── ...
```

### Cloudflare Worker API

Follows the orales-one-market pattern:

| Endpoint | Purpose |
|----------|---------|
| `GET /api/v1/appstore/hash` | Catalog hash and version |
| `GET /api/v1/appstore/info` | Full marketplace data |
| `POST /api/v1/applications/info` | Batch app details by ID |
| `GET /api/v1/applications/{name}/chart` | Gzipped Helm chart |
| `GET /icons/{name}` | PNG icons |
| `GET /health` | Health check |

### README

Prominently displays:

- **Market Source URL**: `https://olares-models.<worker>.workers.dev`
- **Setup**: "Add to Olares Market → Settings → Custom Sources → paste URL"
- **Device target**: "Optimized for Olares One (RTX 5090M, 96GB RAM, 24-core Intel)"
- **Model catalog table**: name, backend, size, quant, expected speed, GPU requirements

## Packaging Pipeline

1. **Scaffold**: Generate all app files from template
2. **Helm package**: `helm package <app-dir> -d charts/`
3. **Icon**: Fetch from HuggingFace or use generic backend logo (256x256 PNG, <512KB)
4. **Market index**: Update catalog files for Worker discovery
5. **Git commit**: `[NEW][appname][1.0.0] Add <Display Name> via <backend>`
6. **Deploy** (asks first): `npm run deploy` to Cloudflare Workers

## Linting Rules (from OlaresCCApp reference)

The skill must ensure:

- `appid` is lowercase, no hyphens
- `appid = folder name = chart name = deployment name = service name = entrance host`
- Sum of container memory requests < `requiredMemory` in manifest
- i18n files present for en-US and zh-CN
- Volume paths use `{{ .Values.userspace.appData }}` with semverCompare guards for Olares >=1.12.3-0
- Environment variables declared in OlaresManifest `envs` are referenced in deployment as `{{ .Values.olaresEnv.VAR_NAME }}`

## Chart.yaml Convention

Both templates use:
- `apiVersion: v2`
- `type: application`
- `appVersion`: the HuggingFace model ID or quantized variant path (matches beclab/apps convention)
- `version`: starts at `1.0.0`, bumped on updates

## Error Handling

- **HuggingFace API down/rate-limited**: Inform user, ask for manual model details (param count, format, size)
- **No variant fits in VRAM**: Recommend the closest fit with reduced context, or suggest a smaller model in the same family
- **`helm package` fails**: Display the error, check linting rules, fix and retry
- **Cloudflare deploy fails**: Display error, leave the app folder intact for manual deploy later

## Versioning Strategy

- New model apps start at `version: 1.0.0`
- Updating an existing model app (new quant, new llama.cpp/vLLM version, config change) bumps the patch version
- The skill checks if an app with the same name already exists and offers to update rather than overwrite
- Git commit for updates uses: `[UPDATE][appname][version] <change description>`

## Design Decisions

- **amd64 only**: Intentional restriction for Olares One hardware optimization, not an oversight. beclab/apps supports arm64 but this marketplace targets specific hardware.
- **No `docker/` directory**: Excluded because we use shared upstream base images. Custom builds are out of scope. If hardware-specific CUDA optimizations are needed later, a `docker/` directory can be added per app.
- **`generate-model-app.sh` relationship**: The orales-one-market repo has a similar shell script. This skill replaces that workflow with an interactive, optimization-aware alternative. The script remains as a non-Claude fallback.

## Out of Scope

- Multi-GPU tensor parallelism (Olares One has a single GPU)
- ARM64 support (Olares One is amd64 only — intentional, see Design Decisions)
- Custom Docker image builds (using shared base images — see Design Decisions)
- Model fine-tuning or training
