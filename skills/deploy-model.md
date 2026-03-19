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

**Concurrent users (vLLM)**:
- `per_request_kv = kv_per_token_per_layer x num_layers x avg_context_per_request`
- Assume avg_context_per_request = context_length / 2
- `max_num_seqs = floor((22GB - model_weights) / per_request_kv)`
- Minimum: 1, cap at 64

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

**`<appname>/OlaresManifest.yaml`**: Generate with these fields:
```yaml
olaresManifest.version: '0.10.0'
olaresManifest.type: app
metadata:
  appid: <appname>
  title: <Display Title>
  icon: <icon URL from HuggingFace or empty string>
  description: <one-line model description>
  version: 1.0.0
  versionName: '1.0.0'
entrances:
  - name: <appname>
    port: 8080
    title: <Display Title>
    authLevel: private
spec:
  versionName: '1.0.0'
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
  requiredMemory: 1Gi
  limitedMemory: <computed ceiling, e.g., 28Gi>
  requiredCpu: 500m
  limitedCpu: <computed ceiling, e.g., 18>
  requiredGpu: 1Gi
  limitedGpu: <computed VRAM allocation, e.g., 24Gi>
  requiredDisk: <model weight size + 5GB buffer>
  limitedDisk: <model weight size + 15GB buffer>
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

Note: `required*` = low minimums for Kubernetes scheduler. `limited*` = actual resource ceilings.

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

**`<appname>/<appname>/templates/clientproxy.yaml`**: Nginx reverse proxy:

```yaml
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: nginx-config
  namespace: {{ .Release.Namespace }}
data:
  nginx.conf: |
    server {
        listen 8080;
        location / {
            proxy_pass http://download-svc.{{ .Release.Name }}server-shared:8090;
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
            proxy_read_timeout 1800s;
            proxy_http_version 1.1;
            proxy_set_header Upgrade $http_upgrade;
            proxy_set_header Connection "upgrade";
            add_header 'Access-Control-Allow-Origin' '*' always;
            add_header 'Access-Control-Allow-Methods' 'GET, POST, OPTIONS' always;
            add_header 'Access-Control-Allow-Headers' 'Content-Type, Authorization' always;
            if ($request_method = 'OPTIONS') {
                return 204;
            }
        }
        location /ping {
            return 200 'pong';
            add_header Content-Type text/plain;
        }
    }
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ .Release.Name }}
  namespace: {{ .Release.Namespace }}
  labels:
    app: {{ .Release.Name }}
spec:
  replicas: 1
  selector:
    matchLabels:
      app: {{ .Release.Name }}
  template:
    metadata:
      labels:
        app: {{ .Release.Name }}
    spec:
      containers:
        - name: nginx
          image: docker.io/beclab/aboveos-bitnami-openresty:1.25.3-2
          ports:
            - containerPort: 8080
          resources:
            requests:
              cpu: 100m
              memory: 128Mi
            limits:
              cpu: 500m
              memory: 500Mi
          readinessProbe:
            httpGet:
              path: /ping
              port: 8080
            initialDelaySeconds: 5
            periodSeconds: 5
          livenessProbe:
            httpGet:
              path: /ping
              port: 8080
            initialDelaySeconds: 10
            periodSeconds: 10
          volumeMounts:
            - name: nginx-config
              mountPath: /etc/nginx/conf.d/default.conf
              subPath: nginx.conf
      volumes:
        - name: nginx-config
          configMap:
            name: nginx-config
---
apiVersion: v1
kind: Service
metadata:
  name: vllmclient
  namespace: {{ .Release.Namespace }}
spec:
  type: ClusterIP
  selector:
    app: {{ .Release.Name }}
  ports:
    - port: 8080
      targetPort: 8080
```

**`<appname>/<appname>server/Chart.yaml`**:
```yaml
apiVersion: v2
appVersion: '<huggingface-model-id>'
description: '<model display name> server'
name: <appname>server
type: application
version: '1.0.0'
```

**`<appname>/<appname>server/templates/_helpers.tpl`**:
```
{{- define "GPU.getGPUInfo" -}}
{{- $gpuModel := "" -}}
{{- $gpuModelName := "" -}}
{{- $isSparkDGX := "false" -}}
{{- range .Values.nodes }}
  {{- range .gpu }}
    {{- $gpuModel = .Model -}}
    {{- $gpuModelName = .ModelName -}}
    {{- if eq (upper .Model) "GB10" }}
      {{- $isSparkDGX = "true" -}}
    {{- end }}
  {{- end }}
{{- end }}
{{- dict "gpuModel" $gpuModel "gpuModelName" $gpuModelName "isSparkDGX" $isSparkDGX | toJson -}}
{{- end -}}
```

**`<appname>/<appname>server/templates/deployment.yaml`**: vLLM deployment:

```yaml
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ .Release.Name }}server
  namespace: {{ .Release.Namespace }}
  labels:
    app: {{ .Release.Name }}server
spec:
  replicas: 1
  strategy:
    type: Recreate
  selector:
    matchLabels:
      app: {{ .Release.Name }}server
  template:
    metadata:
      labels:
        app: {{ .Release.Name }}server
    spec:
      containers:
        - name: vllm
          image: vllm/vllm-openai:v0.17.1-cu130
          command: ["/bin/bash", "-c"]
          args:
            - |
              echo "Waiting for model download to complete..."
              while [ ! -f /models/.download_complete ]; do sleep 10; done
              echo "Model ready. Starting vLLM..."
              {{- $gpuInfo := include "GPU.getGPUInfo" . | fromJson }}
              {{- if eq $gpuInfo.isSparkDGX "true" }}
              exec vllm serve --model /models/<MODEL_ID> --gpu-memory-utilization 0.85 --max-model-len 8192 --max-num-seqs <MAX_NUM_SEQS> --port 8000
              {{- else }}
              exec vllm serve --model /models/<MODEL_ID> --gpu-memory-utilization <GPU_MEM_UTIL> --max-model-len <MAX_MODEL_LEN> --max-num-seqs <MAX_NUM_SEQS> --port 8000
              {{- end }}
          ports:
            - containerPort: 8000
          env:
            - name: HF_TOKEN
              value: ""
            - name: VLLM_WORKER_MULTIPROC_METHOD
              value: "spawn"
            - name: TZ
              value: "UTC"
          resources:
            requests:
              cpu: "1"
              memory: 11Gi
            limits:
              cpu: "<LIMITED_CPU>"
              memory: "<LIMITED_MEMORY>"
              nvidia.com/gpu: "1"
          startupProbe:
            httpGet:
              path: /health
              port: 8000
            initialDelaySeconds: 300
            periodSeconds: 15
            failureThreshold: 40
          livenessProbe:
            httpGet:
              path: /health
              port: 8000
            periodSeconds: 60
            failureThreshold: 3
          volumeMounts:
            - name: model-storage
              mountPath: /models
        - name: download-model
          image: docker.io/beclab/harveyff-hf-downloader:v0.1.0
          ports:
            - containerPort: 8090
          env:
            - name: MODEL_ID
              value: "<MODEL_ID>"
            - name: HF_HOME
              value: "/models"
          resources:
            requests:
              cpu: 100m
              memory: 500Mi
            limits:
              cpu: "1"
              memory: 1Gi
          startupProbe:
            httpGet:
              path: /ping
              port: 8090
            initialDelaySeconds: 10
            periodSeconds: 10
            failureThreshold: 30
          livenessProbe:
            httpGet:
              path: /ping
              port: 8090
            periodSeconds: 60
            failureThreshold: 10
          volumeMounts:
            - name: model-storage
              mountPath: /models
      volumes:
        - name: model-storage
          hostPath:
            path: {{ .Values.userspace.appData }}/models
            type: DirectoryOrCreate
---
apiVersion: v1
kind: Service
metadata:
  name: download-svc
  namespace: {{ .Release.Namespace }}
spec:
  type: ClusterIP
  selector:
    app: {{ .Release.Name }}server
  ports:
    - port: 8090
      targetPort: 8090
```

Replace all `<PLACEHOLDER>` values with the computed values from Step 5.

### For llama.cpp backend — generate single chart:

Same top-level files (Chart.yaml, OlaresManifest.yaml, .helmignore, values.yaml, owners, i18n/) as vLLM but with port 8080 direct in entrances.

**`<appname>/templates/deployment.yaml`**: llama.cpp deployment:

```yaml
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: llamacpp-env
  namespace: {{ .Release.Namespace }}
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
  name: {{ .Release.Name }}
  namespace: {{ .Release.Namespace }}
  labels:
    app: {{ .Release.Name }}
spec:
  replicas: 1
  strategy:
    type: Recreate
  selector:
    matchLabels:
      app: {{ .Release.Name }}
  template:
    metadata:
      labels:
        app: {{ .Release.Name }}
    spec:
      initContainers:
        - name: model-downloader
          image: docker.io/alpine:3.20
          command: ["/bin/sh", "-c"]
          args:
            - |
              if [ ! -f "/models/$(MODEL_FILE)" ]; then
                echo "Downloading model..."
                wget -q "$(MODEL_URL)" -O "/models/$(MODEL_FILE)"
                echo "Download complete."
              else
                echo "Model already exists, skipping download."
              fi
          envFrom:
            - configMapRef:
                name: llamacpp-env
          volumeMounts:
            - name: model-storage
              mountPath: /models
      containers:
        - name: llamacpp
          image: ghcr.io/ggml-org/llama.cpp:server-cuda-b8234
          ports:
            - containerPort: 8080
          args:
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
            - "--flash-attn"
            - "--mlock"
            - "--cache-type-k"
            - "q8_0"
            - "--cache-type-v"
            - "q8_0"
            - "--batch"
            - "2048"
            - "--ubatch"
            - "1024"
            - "--host"
            - "0.0.0.0"
            - "--port"
            - "8080"
          envFrom:
            - configMapRef:
                name: llamacpp-env
          resources:
            requests:
              cpu: "<REQUIRED_CPU>"
              memory: "<REQUIRED_MEMORY>"
            limits:
              cpu: "<LIMITED_CPU>"
              memory: "<LIMITED_MEMORY>"
              nvidia.com/gpu: "1"
          startupProbe:
            httpGet:
              path: /health
              port: 8080
            initialDelaySeconds: 60
            periodSeconds: 10
            failureThreshold: 30
          livenessProbe:
            httpGet:
              path: /health
              port: 8080
            periodSeconds: 30
            failureThreshold: 3
          volumeMounts:
            - name: model-storage
              mountPath: /models
            - name: cache
              mountPath: /tmp/cache
      volumes:
        - name: model-storage
          hostPath:
            path: {{ .Values.userspace.appData }}/models
            type: DirectoryOrCreate
        - name: cache
          emptyDir: {}
---
apiVersion: v1
kind: Service
metadata:
  name: {{ .Release.Name }}
  namespace: {{ .Release.Namespace }}
spec:
  type: ClusterIP
  selector:
    app: {{ .Release.Name }}
  ports:
    - port: 8080
      targetPort: 8080
```

Replace all `<PLACEHOLDER>` values with computed values from Step 5. If concurrent users > 1, add `--parallel <N>` to the args list. If not using GPU (full CPU mode), remove the `nvidia.com/gpu: "1"` resource limit.

## Step 8: Validate and Package

0. **Lint validation** before packaging — verify:
   - `appid` in OlaresManifest.yaml = folder name = `name` in Chart.yaml = deployment name = service name = entrance name
   - All lowercase, no hyphens in appid
   - Sum of container memory `requests` < `requiredMemory` in OlaresManifest
   - Volume paths use `{{ .Values.userspace.appData }}`
   - `i18n/en-US/OlaresManifest.yaml` and `i18n/zh-CN/OlaresManifest.yaml` both exist

1. **Helm lint**: `helm lint <appname>/`

2. **Helm package**: `helm package <appname>/ -d charts/`

3. **Icon**: Fetch from HuggingFace if available. Otherwise inform user to add manually at `icons/<appname>.png` (256x256, <512KB).

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
