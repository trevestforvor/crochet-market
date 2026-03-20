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

### Device Profile (Olares One)
- VRAM: 24GB (RTX 5090M)
- VRAM bandwidth: 896 GB/s
- RAM: 96GB DDR5
- RAM bandwidth: ~80 GB/s
- CPU: 24 cores
- VRAM budget: 22GB (2GB headroom for system)

### Calculations

**Model weight size**: sum of all weight files (safetensors or GGUF), or estimate from param count x bytes per param for the quantization level.

**KV cache per token per layer**: `2 x num_kv_heads x head_dim x 2 bytes` (K and V, FP16)

**KV cache for context**: `kv_per_token_per_layer x num_layers x context_length`

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

**Concurrent users**:
- **llama.cpp**: Always use `-np 1` (single slot). Parallel slots divide context across users, reducing per-user context and doubling KV cache VRAM. Single user is the right default for local inference.
- **vLLM**: Set `--max-num-seqs 16`. vLLM handles concurrent requests efficiently with paged attention — no context splitting.

**Speed estimate** — use this empirical table as the PRIMARY reference (formula `VRAM_bandwidth / model_weight_size` is a ceiling only):

| Model Size | Full GPU Speed |
|------------|---------------|
| Up to 14B | 80-130 t/s |
| 30-35B dense | 45-65 t/s |
| 30B MoE (3B active) | 200+ t/s |
| 70B+ partial offload | 3-5 t/s |

For models between ranges, interpolate. For MoE, use active params for speed lookup.

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

Wait for user approval. If they adjust values, recalculate dependent values.

## Step 6: Generate App Name

Construct the appid:
- Backend prefix: `vllm` or `llamacpp`
- Model name: lowercase, remove special chars, no hyphens
- Example: Qwen3.5 30B-A3B → `vllmqwen3530ba3b`

Verify the name doesn't already exist as a directory in the repo. If it does, ask user: update existing or create new with suffix?

## Step 7: Generate App Files

### For vLLM backend — generate single chart:

**`<appname>/Chart.yaml`**:
```yaml
apiVersion: v2
appVersion: '<huggingface-model-id>'
description: '<model display name> served via vLLM — optimized for Olares One'
name: <appname>
type: application
version: '1.0.0'
```

**`<appname>/OlaresManifest.yaml`**: Generate with these fields:
```yaml
olaresManifest.version: '0.11.0'
olaresManifest.type: app
metadata:
  name: <appname>
  appid: <appname>
  title: <Display Title — alphanumeric, hyphens, spaces only, max 30 chars, no dots>
  icon: https://olares-models.crochetme.workers.dev/icons/<appname>.png
  description: <one-line model description>
  version: 1.0.0
  versionName: '1.0.0'
  categories:
    - AI
entrances:
  - name: <appname>
    host: <appname>
    port: <8000 for vLLM, 8080 for llama.cpp>
    title: <Display Title — same rules as metadata.title>
    authLevel: private
spec:
  versionName: '1.0.0'   # MUST always match metadata.version and metadata.versionName — all three must be identical
  fullDescription: |
    <detailed description — model capabilities, hardware target, performance>
  developer: <from HuggingFace model card>
  website: <HuggingFace model page URL>
  sourceCode: https://github.com/trevestforvor/OlaresModels
  submitter: trevestforvor
  locale:
    - en-US
    - zh-CN
  license:
    - text: <model license from model card>
  category: AI
  requiredMemory: <must be >= sum of container memory requests, e.g., 24Gi>
  limitedMemory: 40Gi
  requiredCpu: <must be >= sum of container CPU requests, e.g., 4000m>
  limitedCpu: 16000m
  requiredGpu: 1Gi
  limitedGpu: 24Gi
  requiredDisk: 25Gi
  limitedDisk: 50Gi
  supportArch:
    - amd64
permission:
  appData: true
middleware: {}
options:
  apiTimeout: 0
  dependencies:
    - type: system
      name: olares
      version: '>=1.12.3-0'
```

Note: `requiredMemory` and `requiredCpu` MUST be >= the sum of all container resource `requests` in the deployment template, or the Olares linter will reject the chart. `limited*` = actual resource ceilings.

**`<appname>/templates/deployment.yaml`**: vLLM deployment:

```yaml
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: vllm-env
  namespace: "{{ .Release.Namespace }}"
data:
  MODEL_NAME: "<HUGGINGFACE_MODEL_ID>"
  MODEL_ALIAS: "<MODEL_ALIAS>"
  MAX_MODEL_LEN: "<COMPUTED_CONTEXT>"
  GPU_MEMORY_UTILIZATION: "<GPU_MEM_UTIL>"
  MAX_NUM_SEQS: "16"
  MAX_NUM_BATCHED_TOKENS: "<COMPUTED_BATCHED_TOKENS>"
---
apiVersion: apps/v1
kind: Deployment
metadata:
  creationTimestamp: null
  labels:
    io.kompose.service: <appname>
  name: <appname>
  namespace: "{{ .Release.Namespace }}"
  annotations:
    applications.app.bytetrade.io/gpu-inject: "true"
spec:
  replicas: 1
  selector:
    matchLabels:
      io.kompose.service: <appname>
  strategy:
    type: Recreate
  template:
    metadata:
      creationTimestamp: null
      labels:
        io.kompose.network/chrome-default: "true"
        io.kompose.service: <appname>
    spec:
      runtimeClassName: nvidia
      containers:
        - name: vllm-server
          image: "vllm/vllm-openai:cu130-nightly"
          command:
            - vllm
            - serve
          args:
            - "$(MODEL_NAME)"
            - "--served-model-name"
            - "$(MODEL_ALIAS)"
            - "--host"
            - "0.0.0.0"
            - "--port"
            - "8000"
            - "--max-model-len"
            - "$(MAX_MODEL_LEN)"
            - "--gpu-memory-utilization"
            - "$(GPU_MEMORY_UTILIZATION)"
            - "--max-num-seqs"
            - "$(MAX_NUM_SEQS)"
            - "--max-num-batched-tokens"
            - "$(MAX_NUM_BATCHED_TOKENS)"
            - "--dtype"
            - "auto"
            - "--trust-remote-code"
            - "--download-dir"
            - "/models"
            - "--enable-prefix-caching"
          env:
            - name: HF_HOME
              value: "/models/huggingface"
            - name: VLLM_ATTENTION_BACKEND
              value: "FLASH_ATTN"
          envFrom:
            - configMapRef:
                name: vllm-env
          ports:
            - containerPort: 8000
          livenessProbe:
            httpGet:
              path: /health
              port: 8000
              scheme: HTTP
            initialDelaySeconds: 120
            periodSeconds: 30
            timeoutSeconds: 10
            failureThreshold: 5
          startupProbe:
            httpGet:
              path: /health
              port: 8000
              scheme: HTTP
            initialDelaySeconds: 60
            periodSeconds: 15
            timeoutSeconds: 10
            failureThreshold: 120
          resources:
            limits:
              cpu: "16"
              memory: "40Gi"
              nvidia.com/gpu: "1"
            requests:
              cpu: "4"
              memory: "24Gi"
          volumeMounts:
            - mountPath: "/models"
              name: models
      volumes:
        - name: models
          hostPath:
            path: "{{ .Values.userspace.appData }}/models"
            type: DirectoryOrCreate
      restartPolicy: Always
status: {}
---
apiVersion: v1
kind: Service
metadata:
  creationTimestamp: null
  labels:
    io.kompose.service: <appname>
  name: <appname>
  namespace: "{{ .Release.Namespace }}"
spec:
  ports:
    - name: "vllm"
      port: 8000
      targetPort: 8000
  selector:
    io.kompose.service: <appname>
status:
  loadBalancer: {}
```

Replace all `<PLACEHOLDER>` values with the computed values from Step 5. GPU requires BOTH the `applications.app.bytetrade.io/gpu-inject: "true"` annotation AND `nvidia.com/gpu: "1"` in resource limits. The `runtimeClassName: nvidia` is required for vLLM. vLLM downloads models automatically via `--download-dir`, so no init container is needed. If the model supports reasoning/thinking, add `--reasoning-parser <parser>` (e.g., `qwen3` for Qwen models).

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

### For llama.cpp backend — generate single chart:

Same top-level files (Chart.yaml, OlaresManifest.yaml, .helmignore, values.yaml, owners, i18n/) as vLLM but with port 8080 in entrances.

**`<appname>/templates/deployment.yaml`**: llama.cpp deployment:

```yaml
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: llamacpp-env
  namespace: "{{ .Release.Namespace }}"
data:
  MODEL_URL: "<DIRECT_GGUF_DOWNLOAD_URL>"
  MODEL_FILE: "<FILENAME>.gguf"
  MODEL_ALIAS: "<ALIAS>"
  CONTEXT_SIZE: "<COMPUTED_CONTEXT>"
  N_GPU_LAYERS: "<COMPUTED_OR_99>"
  THREADS: "16"
---
apiVersion: apps/v1
kind: Deployment
metadata:
  creationTimestamp: null
  labels:
    io.kompose.service: <appname>
  name: <appname>
  namespace: "{{ .Release.Namespace }}"
  annotations:
    applications.app.bytetrade.io/gpu-inject: "true"
spec:
  replicas: 1
  selector:
    matchLabels:
      io.kompose.service: <appname>
  strategy:
    type: Recreate
  template:
    metadata:
      creationTimestamp: null
      labels:
        io.kompose.network/chrome-default: "true"
        io.kompose.service: <appname>
    spec:
      initContainers:
        - name: model-downloader
          image: "docker.io/alpine:3.20"
          command:
            - sh
            - '-c'
            - |
              MODEL_PATH="/models/${MODEL_FILE}"
              if [ -f "$MODEL_PATH" ]; then
                echo "Model already downloaded: $MODEL_PATH"
                ls -lh "$MODEL_PATH"
              else
                echo "Downloading model from $MODEL_URL ..."
                wget -O "$MODEL_PATH.tmp" "$MODEL_URL"
                mv "$MODEL_PATH.tmp" "$MODEL_PATH"
                echo "Download complete."
                ls -lh "$MODEL_PATH"
              fi
          envFrom:
            - configMapRef:
                name: llamacpp-env
          resources:
            limits:
              cpu: "2"
              memory: 512Mi
            requests:
              cpu: 100m
              memory: 128Mi
          volumeMounts:
            - mountPath: "/models"
              name: models
      containers:
        - name: llamacpp-server
          image: "ghcr.io/ggml-org/llama.cpp:server-cuda13-b8369"
          args:
            - "--host"
            - "0.0.0.0"
            - "--port"
            - "8080"
            - "--model"
            - "/models/$(MODEL_FILE)"
            - "--alias"
            - "$(MODEL_ALIAS)"
            - "--ctx-size"
            - "$(CONTEXT_SIZE)"
            - "--n-gpu-layers"
            - "$(N_GPU_LAYERS)"
            - "--threads"
            - "$(THREADS)"
          envFrom:
            - configMapRef:
                name: llamacpp-env
          ports:
            - containerPort: 8080
          livenessProbe:
            httpGet:
              path: /health
              port: 8080
              scheme: HTTP
            initialDelaySeconds: 60
            timeoutSeconds: 10
            periodSeconds: 30
            failureThreshold: 5
          startupProbe:
            httpGet:
              path: /health
              port: 8080
              scheme: HTTP
            initialDelaySeconds: 30
            timeoutSeconds: 10
            periodSeconds: 10
            failureThreshold: 120
          resources:
            limits:
              cpu: "16"
              memory: "40Gi"
              nvidia.com/gpu: "1"
            requests:
              cpu: "4"
              memory: "24Gi"
              nvidia.com/gpu: "1"
          volumeMounts:
            - mountPath: "/models"
              name: models
      volumes:
        - name: models
          hostPath:
            path: "{{ .Values.userspace.appData }}/models"
            type: DirectoryOrCreate
      restartPolicy: Always
status: {}
---
apiVersion: v1
kind: Service
metadata:
  creationTimestamp: null
  labels:
    io.kompose.service: <appname>
  name: <appname>
  namespace: "{{ .Release.Namespace }}"
spec:
  ports:
    - name: "llamacpp"
      port: 8080
      targetPort: 8080
  selector:
    io.kompose.service: <appname>
status:
  loadBalancer: {}
```

Replace all `<PLACEHOLDER>` values with computed values from Step 5. GPU requires BOTH the `applications.app.bytetrade.io/gpu-inject: "true"` annotation on the Deployment metadata AND `nvidia.com/gpu: "1"` in both resource limits and requests. If not using GPU (full CPU mode), remove the annotation and the nvidia.com/gpu entries.

## Step 8: Validate and Package

0. **Lint validation** before packaging — verify:
   - `appid` in OlaresManifest.yaml = folder name = `name` in Chart.yaml = deployment name = service name = entrance name = entrance host
   - `metadata.name` field exists in OlaresManifest.yaml (same value as appid)
   - All lowercase, no hyphens in appid
   - `metadata.icon` is NOT empty — must be a valid URL
   - `metadata.title` and `entrances[].title`: max 30 chars, only `[a-z0-9A-Z- ]` allowed (NO dots, underscores, or special chars)
   - Sum of container CPU `requests` <= `requiredCpu` in OlaresManifest
   - Sum of container memory `requests` <= `requiredMemory` in OlaresManifest
   - Deployment/service names are hardcoded to `<appname>` (NOT `{{ .Release.Name }}`)
   - Volume paths use `{{ .Values.userspace.appData }}`
   - `i18n/en-US/OlaresManifest.yaml` and `i18n/zh-CN/OlaresManifest.yaml` both exist

1. **Helm lint**: `helm lint <appname>/`

2. **Helm package**: `helm package <appname>/ -d charts/`

3. **Icon**: Run `node scripts/generate-icons.js` after adding the new model's entry to the `models` object in that script. Each entry needs:
   - `avatarUrl`: the model org's HuggingFace avatar (find at `https://huggingface.co/<org>`, look for `cdn-avatars.huggingface.co` URL)
   - `backend`: `'llama.cpp'`, `'vLLM'`, or `'Ollama'`
   - `badgeColor`: `'#2d8cf0'` for llama.cpp, `'#7c3aed'` for vLLM, `'#000000'` for Ollama
   - `badgeText`: `'#ffffff'`
   The script composites the org avatar (256x256) with a backend badge in the bottom-right corner.
   Set the icon URL in OlaresManifest.yaml to: `https://olares-models.crochetme.workers.dev/icons/<appname>.png`

4. **Build catalog**: `npm run build:catalog`

5. **Git commit**:
   ```bash
   git add <appname>/ charts/<appname>-*.tgz icons/
   git commit -m "[NEW][<appname>][1.0.0] Add <Display Name> via <backend>"
   ```

6. **Deploy** (ask first):
   > "App packaged and committed. Deploy to Cloudflare Workers marketplace now? (runs `npm run deploy`)"
   If approved: `npm run deploy`
   After deploy, update README.md model catalog table.

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

## Critical Rules

- **Never overflow into shared VRAM** — worse than pure CPU (0.69 t/s vs 1.42 t/s)
- **Prefer smaller model at higher quant** over larger model at lower quant
- **MoE models are exceptional** — use active params for sizing, not total params
- **Q3_K_L is the absolute floor** for acceptable quality on reasoning tasks
- For multi-user: vLLM with AWQ. For single-user: llama.cpp
- All appids: lowercase, no hyphens, backend prefix + model name mashed together
- **Version sync**: `Chart.yaml version`, `metadata.version`, `metadata.versionName`, and `spec.versionName` in OlaresManifest.yaml MUST all be identical. Out-of-sync versions cause apps to not appear in the marketplace.
