# Veistra Cloud: system diagram

What exists in `veistra-prod` today, how the pieces talk to each other, and how the Veistra
desktop app (and the tools that stand in for its unbuilt parts) reach them. Built today = solid
edges. Planned = dashed edges. Every node and edge below is labeled `[build]` or `[plan]`.

Sources are cited in the table at the bottom. Where a source contradicts the brief this diagram
was built from, the contradiction is called out in that table and in the summary handed back with
this file — this diagram follows the newer, more specific sources (Terraform, the Plane-frontend
handoff) over the older status banner in `docs/cloud-services.md`.

## 1. Main system diagram

```mermaid
flowchart LR
    classDef planned stroke-dasharray: 5 5,stroke:#b00,color:#b00;
    classDef built stroke:#0a5,color:#0a5;

    subgraph LAPTOP["Laptop build: Veistra desktop, Windows"]
        direction TB
        UIshell["Veistra shell (Tauri v2)<br/>build: apps home, files, viewer, docs, design, schematify"]
        UIagents["Agents app - apps-agents<br/>build (branch cloud-ui-agents-app, not yet merged to main)<br/>lists agent VMs, sessions, transcripts"]
        UIprojects["apps-projects - plan<br/>project switcher, embedded Plane webview, New project dialog"]
        RustCloud["Rust cloud module - src-tauri-src-cloud<br/>build (same unmerged branch): auth, compute, storage, http"]
        RustPlane["Rust plane module + IAP tunnel manager<br/>plan: plane_get/plane_post, gcloud tunnel spawn, wake flow"]
        CLI["veistra-project CLI (Python, run by hand)<br/>build: list/create/show/archive"]
        WakeLib["veistra-wake / veistra-idle libraries<br/>build: infra/common, used as a library from CLI and Rust"]
        HostsFile["hosts file entry<br/>plan: plane.veistra.internal -> 127.0.0.1"]
    end

    class UIshell built
    class UIagents built
    class RustCloud built
    class CLI built
    class WakeLib built
    class UIprojects planned
    class RustPlane planned
    class HostsFile planned

    subgraph GCP["GCP project veistra-prod, VPC veistra, us-central1-a, no public IPs"]
        direction TB
        Worker["veistra-worker VM<br/>build: e2-standard-8, Claude Code + Godot + Blender, image veistra-agent<br/>stops itself when idle"]
        GPU["veistra-gpu VM<br/>build: Spot g2-standard-8 with L4, TERMINATED at rest"]
        PlaneVM["plane-vm<br/>build: e2-standard-2, Plane CE v1.4.2 containers (unmodified)<br/>stops itself after 30 idle min"]
        PlaneWatch["plane-watch + job worker loop<br/>plan: polls ai:* labels, writes job files, starts veistra-worker"]
        NAT["Cloud NAT (router veistra-us-central1)<br/>build: outbound only, no public IPs"]
    end

    class Worker built
    class GPU built
    class PlaneVM built
    class NAT built
    class PlaneWatch planned

    subgraph MANAGED["Serverless / managed services"]
        direction TB
        Hindsight["Hindsight on Cloud Run<br/>build: service 'hindsight', min=0 max=2 instances, port 8888->8888 mapped as :8888 path /mcp"]
        CloudSQL["Cloud SQL veistra-hindsight<br/>build: Postgres db-f1-micro, private VPC access"]
        Vertex["Vertex AI<br/>build: gemini-3.1-flash-lite (global endpoint), gemini-embedding-001"]
        BucketArtifacts["gs://veistra-artifacts<br/>build: artifact registry + design canvases under design/"]
        BucketSessions["gs://veistra-prod-sessions<br/>build: agent session status.json + transcript.jsonl"]
        BucketRenderQ["gs://veistra-prod-render-queue<br/>build: jobs/ and done/ for the GPU node"]
        BucketProjects["gs://veistra-projects<br/>build: prod/projects/*.json; prod/jobs/pending,claimed,done - plan"]
        SecretMgr["Secret Manager<br/>build: claude-oauth-token, plane-*, plane-dev-*, hindsight db url"]
        DNS["Cloud DNS private zone veistra-internal<br/>build: plane.veistra.internal -> plane-vm internal IP"]
        ArtifactRegMirror["Artifact Registry (ghcr.io mirror)<br/>build: image source for Cloud Run"]
    end

    class Hindsight built
    class CloudSQL built
    class Vertex built
    class BucketArtifacts built
    class BucketSessions built
    class BucketRenderQ built
    class SecretMgr built
    class DNS built
    class ArtifactRegMirror built
    class BucketProjects planned

    subgraph EXTERNAL["External"]
        direction TB
        GitHub["GitHub<br/>build: Firelight-Innovations/Veistra, Anomaly, Torn-Apart repos"]
        Anthropic["Anthropic API<br/>build: subscription OAuth token, no API key"]
    end

    class GitHub built
    class Anthropic built

    %% --- Laptop internal ---
    UIshell -->|"in-process"| UIagents
    UIshell -.->|"in-process - plan"| UIprojects
    UIagents -->|"Tauri command call"| RustCloud
    UIprojects -.->|"Tauri command - plan"| RustPlane
    RustPlane -.->|"reuses - plan"| WakeLib
    CLI -->|"imports"| WakeLib
    RustPlane -.->|"writes once - plan"| HostsFile

    %% --- Laptop -> GCP / managed, built (Agents app) ---
    RustCloud -->|"Bearer access token: GCE REST instances.list/start"| Worker
    RustCloud -->|"Bearer access token: GCE REST instances.list"| GPU
    RustCloud -->|"Bearer access token: GCS JSON API list+get"| BucketSessions

    %% --- Laptop -> Plane, planned ---
    RustPlane -.->|"GCE REST start - plan"| PlaneVM
    RustPlane -.->|"gcloud start-iap-tunnel :8765 - plan"| PlaneVM
    RustPlane -.->|"X-API-Key plane-pat-veistra, HTTP :8765 - plan"| PlaneVM
    UIprojects -.->|"child webview, same session - plan"| PlaneVM
    HostsFile -.->|"resolves plane.veistra.internal - plan"| RustPlane

    %% --- veistra-project CLI (today's stand-in for apps/projects) ---
    CLI -->|"veistra-wake: GCE REST start then health poll"| PlaneVM
    CLI -->|"X-API-Key plane-pat-veistra, HTTP :8765 via IAP tunnel"| PlaneVM
    CLI -->|"gcloud secrets versions access"| SecretMgr
    CLI -->|"GCS JSON API read/write JSON"| BucketProjects
    CLI -->|"GCS JSON API .keep placeholder"| BucketArtifacts

    %% --- GCP internal ---
    Worker -->|"Compute Engine REST start"| GPU
    Worker -->|"Cloud NAT egress, package + image pulls"| NAT
    PlaneVM -->|"Cloud NAT egress, image pulls"| NAT
    Worker -->|"VPC TCP :8765"| PlaneVM
    PlaneVM -.->|"GCE REST start - plan, plane-watch wakes worker"| Worker
    Worker -->|"resolves via"| DNS
    DNS -->|"A record"| PlaneVM
    PlaneVM -.->|"docker network - plan"| PlaneWatch
    PlaneWatch -.->|"writes job JSON - plan"| BucketProjects
    PlaneWatch -.->|"comments + label swap, REST :8765 - plan"| PlaneVM

    %% --- Worker to managed services, built ---
    Worker -->|"MCP over HTTPS, ID token: /mcp/asset-build/, /mcp/godot-build/"| Hindsight
    Worker -->|"veistra-render: writes job, GCE REST start"| GPU
    Worker -->|"GCS JSON API read/write"| BucketArtifacts
    Worker -->|"GCS JSON API write status.json + transcript.jsonl"| BucketSessions
    GPU -->|"GCS JSON API read job, upload screenshots"| BucketRenderQ
    GPU -->|"GCS JSON API upload .glb + turntable PNGs"| BucketArtifacts
    Worker -->|"gcloud secrets versions access: claude-oauth-token"| SecretMgr
    Worker -->|"claude -p, subscription OAuth"| Anthropic
    Worker -->|"git clone/push, IAP has no route - via NAT"| GitHub

    %% --- Hindsight internals, built ---
    Hindsight -->|"private VPC connector, TCP 5432"| CloudSQL
    Hindsight -->|"service account, aiplatform.user"| Vertex
    Hindsight -->|"pulls image"| ArtifactRegMirror
    Hindsight -->|"reads secret hindsight-database-url"| SecretMgr

    %% --- Plane MCP on worker, planned ---
    Worker -.->|"plane-mcp-server stdio, X-API-Key plane-pat-agent - plan A4.4"| PlaneVM
```

## 2. Sequence: open Plane from Veistra (planned end state)

```mermaid
sequenceDiagram
    participant U as Owner
    participant UI as apps/projects [plan]
    participant Rust as Rust plane module [plan]
    participant GCE as Compute Engine REST [build]
    participant Tun as IAP tunnel [plan]
    participant Plane as plane-vm [build]

    U->>UI: Select a project
    UI->>Rust: open_project(slug)
    Rust->>GCE: GET instances/plane-vm
    GCE-->>Rust: status
    alt status is TERMINATED
        Rust->>GCE: POST instances/plane-vm/start
        loop every 3s, up to 120s
            Rust->>GCE: GET instances/plane-vm
            GCE-->>Rust: status
        end
    end
    Rust->>Tun: spawn gcloud start-iap-tunnel :8765
    Tun-->>Rust: tunnel listening on 127.0.0.1:8765
    loop every 3s, up to 240s total
        Rust->>Plane: GET / and GET /api/instances/
        Plane-->>Rust: connection refused or 502 (starting)
    end
    Plane-->>Rust: 200 and 200
    Rust-->>UI: healthy, elapsed Ns
    UI->>Plane: mount child webview at deep link
    Plane-->>U: signed-in Plane project view
```

## 3. Sequence: `ai:*` label to worker to Plane comment (planned)

```mermaid
sequenceDiagram
    participant O as Owner or Veistra [plan: Veistra path]
    participant Plane as plane-vm - Plane API [build]
    participant Watch as plane-watch [plan]
    participant Jobs as gs://veistra-projects/prod/jobs [plan]
    participant GCE as Compute Engine REST [build]
    participant Worker as veistra-worker [build]
    participant Claude as claude -p session [build]
    participant MCP as plane-mcp-server [plan]

    O->>Plane: add label ai:breakdown (or Veistra button writes the same job)
    Watch->>Plane: poll issues with ai:* label, every 60s
    Plane-->>Watch: matching issue
    Watch->>Jobs: write jobs/pending/<job-id>.json
    Watch->>Plane: comment "Queued for agent: job <id>"
    Watch->>Plane: swap label for ai:queued
    Watch->>GCE: POST instances/veistra-worker/start
    GCE-->>Watch: RUNNING
    Worker->>Jobs: claim job (move pending -> claimed, generation precondition)
    Worker->>Claude: claude -p with prompt template + job JSON
    Claude->>MCP: plane-mcp-server stdio calls (read/update/comment)
    MCP->>Plane: X-API-Key plane-pat-agent, REST :8765
    Claude-->>Worker: summary comment, label ai:done or ai:failed
    Worker->>Jobs: move job to done/
    Worker->>Worker: write Hindsight retain entry
```

## 4. Legend

| Style | Meaning |
|---|---|
| Solid arrow, green node border | Built today: the code exists (in this worktree, in `main`, or on a named branch) and, per the sources below, the resource is deployed |
| Dashed arrow (`-.->`), red node border, `[plan]` | Planned: designed but not written, or written but not wired up end to end |
| `classDef built` / `classDef planned` | Applied per node; edges are annotated `[build]`/`[plan]` in their label or in prose above |

Two built things sit in an unusual place and are called out individually rather than folded into
"built" or "planned":

- **The Agents app** (`apps/agents`, `src-tauri/src/cloud/*`) is fully written and uses the real
  mechanism this document describes — `gcloud auth print-access-token`, Compute Engine REST list
  and start, Cloud Storage JSON API list and download — but it lives on branch
  `cloud-ui/agents-app`, which is **not merged into `main`** and not present in this worktree
  (`tools/veistra-project`). It is drawn as built because the mechanism is real and demonstrated, not
  because it ships today.
- **`veistra-project` (Python CLI)** is the thing that actually creates/lists/shows/archives
  projects today. It is not part of the Veistra desktop app; it is a terminal tool the owner (or
  an agent on the worker) runs by hand. `apps/projects` is meant to replace the parts of it that
  touch the UI (B3.1), but until B1-B3 land, the CLI is the only "project" surface that exists.

## 5. Node and edge to source map

| Node / item | Source |
|---|---|
| `veistra-prod`, VPC `veistra`, Cloud NAT, IAP-only firewall | `infra/terraform/foundation/main.tf` (`google_compute_network.veistra`, `google_compute_router_nat.veistra`, `google_compute_firewall.iap_ingress`) |
| `veistra-worker` VM, agent image, idle stop | `infra/terraform/worker/main.tf` (`google_compute_instance.agent`, var `agents`, default `e2-standard-8`); `infra/images/agent/` |
| `veistra-gpu` VM, Spot L4, TERMINATED at rest | `infra/terraform/gpu/main.tf` (`google_compute_instance.gpu`, `desired_status = "TERMINATED"`, `machine_type = "g2-standard-8"`) |
| `plane-vm`, disk `plane-data`, DNS, firewall | `infra/terraform/plane/main.tf` (`google_compute_instance.plane`, `google_compute_disk.data`, `google_dns_managed_zone.internal`, `google_compute_firewall.plane_iap`/`plane_agents`) |
| Plane CE v1.4.2 live, cold-start numbers, PATs | `docs/handoffs/plane-frontend.md` ("What is live" table) |
| Hindsight on Cloud Run + Cloud SQL + Vertex | `infra/terraform/hindsight/main.tf` (`google_cloud_run_v2_service.hindsight`, `google_sql_database_instance.hindsight`, env `HINDSIGHT_API_LLM_MODEL`) |
| Buckets `veistra-artifacts`, `-render-queue`, `-sessions`, `veistra-projects` | `infra/terraform/registry/main.tf`; `infra/terraform/plane/main.tf` (`google_storage_bucket_iam_member.projects`) |
| Secret Manager (`claude-oauth-token`, `plane-*`) | `infra/terraform/secrets/main.tf`, `infra/terraform/plane/main.tf` (`local.secrets`) |
| `veistraWaker` custom role, wake/idle contract | `infra/terraform/plane/main.tf` (`google_project_iam_custom_role.waker`); `infra/common/veistra-wake/`, `infra/common/veistra-idle/` |
| `veistra-project` CLI, prod projects | `tools/veistra-project/veistra_project.py`, `tools/veistra-project/README.md` |
| UI-facing contracts (auth, artifact/session/canvas shapes, Hindsight rules) | `docs/cloud-services.md` |
| Agents app (built, unmerged) | `git show origin/cloud-ui/agents-app` — `src-tauri/src/apps/agents.rs`, `src-tauri/src/cloud/{mod,auth,compute,storage,http}.rs` |
| `apps/projects` (planned), design rules, deep links | `docs/design/VEISTRA-PLANE-DESIGN.md` §7.4, §11 (task table B1-B3); `docs/handoffs/plane-frontend.md` ("Not built yet") |
| `plane-watch`, AI job queue, job flow | `docs/design/VEISTRA-PLANE-DESIGN.md` §7.3, §8.1; `docs/handoffs/plane-frontend.md` ("Not built yet") |
| Local dev Plane `:8766` | `docs/design/VEISTRA-PLANE-DESIGN.md` §9; `docs/handoffs/plane-frontend.md` |
| Cost model, scale-to-zero targets | `docs/design/VEISTRA-PLANE-DESIGN.md` §4-§5; `infra/README.md` ("Cost at idle") |
| Overall PRD scope and phases | `docs/design/VEISTRA-CLOUD-PRD.md` |
