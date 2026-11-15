# LogiGatekeeper — Windows Run Guide

Agent server for zkVerify **Agent Games Season 01, Proof Gatekeeper track**.
Agent name: **LogiGatekeeper** · Repo: https://github.com/Huynhvu03/agentgames-gatekeeper
Event ends **21/11/2026**. Scored rounds run **daily 17:30–03:30 (VN time)**, 8 tasks/day.
The PC, the server and the tunnel must stay on during those hours.

## What the server does

- `POST /agent` — receives the platform's signed task envelope, verifies the
  HMAC signature on the raw body **before** parsing, decides
  APPROVE/REJECT with a deterministic checklist (no LLM), generates a
  Groth16 proof of the decision with snarkjs + the tournament's own
  gatekeeper circuit, and returns the signed response — all within 60 s.
- `POST /agent` also answers the platform's preflight
  (`{ok:true, protocolVersion:"v1"}`, signed).
- `GET /health` (and `GET /agent`, `GET /`) — health check, returns 200.

Decision checklist (APPROVE only if ALL pass, otherwise REJECT — fail closed):
1. proof VK == registered VK
2. public balance >= minimum threshold
3. recipient == condition recipient
4. amount <= max transfer cap
5. expiry block > current block
6. proof reference (`proof_tx`) not used before (a reused reference is
   rejected **without** a proof)

Task IDs are idempotency keys: a retried task returns the byte-identical
cached response. Seen tasks + used proof references are kept in `state.json`
— **do not delete `state.json` during the event.**

## 1. Install on the Windows PC

1. **Node.js LTS** — download from https://nodejs.org (LTS, v20 or newer).
   Verify in PowerShell: `node --version` and `npm --version`.
2. **Git** — https://git-scm.com/download/win (needed once, to clone the repo).
3. **cloudflared** — download the Windows build from
   https://developers.cloudflare.com/cloudflare-one/connections/connect/downloads/
   (`cloudflared-windows-amd64.exe`), rename to `cloudflared.exe` and put it
   in a folder on PATH (e.g. `C:\tools\`) or in the repo folder.

## 2. Get the code

```powershell
git clone https://github.com/Huynhvu03/agentgames-gatekeeper.git
cd agentgames-gatekeeper
npm install
```

Files in the repo: `server.js`, `package.json`, `test-server.js`,
`.env.example`, `.gitignore`, `circuits/` (gatekeeper.wasm,
gatekeeper_final.zkey, gatekeeper_vk.json — all committed, see below),
`README-WINDOWS.md` (this file).

## 3. Create `.env` with the HMAC secret

```powershell
copy .env.example .env
notepad .env
```

Fill in:

```ini
AGENT_GAMES_HMAC_SECRET=<paste the secret here>
AGENT_ID=<agent id from the dashboard, optional>
PORT=3000
```

**Where the secret comes from:** when the agent is registered on the
Agent Games dashboard (Dashboard → My Agents → Register agent), the platform
generates a 32-byte HMAC secret and shows it **exactly once**. Copy it
immediately into `.env`. Never commit `.env`, never paste the secret into
chat, never put it in the repo. (`.env` is in `.gitignore`.)

## 4. Start the server

```powershell
npm start
```

You should see:

```text
LogiGatekeeper listening on http://localhost:3000  (POST /agent, GET /health)
```

Check it in a second PowerShell window:

```powershell
curl.exe http://localhost:3000/health
```

→ `{"ok":true,"agent":"LogiGatekeeper",...}`

## 5. Expose it with a cloudflared tunnel

In another PowerShell window, from the repo folder (or anywhere, if
cloudflared is on PATH):

```powershell
cloudflared tunnel --url http://localhost:3000
```

cloudflared prints a public URL like:

```text
https://logi-gatekeeper-abc123.trycloudflare.com
```

This is a **quick tunnel — no account needed, no port forwarding, no
firewall rule** (the tunnel connects outbound to Cloudflare).

> ⚠️ The quick-tunnel URL **changes on every restart**. Each time the
> tunnel restarts you must update the endpoint on the dashboard (step 6).
> For a stable URL, set up a **named tunnel** (needs a free Cloudflare
> account + a domain) — see "Optional upgrade" below.

Test the public URL from outside (phone browser or another machine):

```powershell
curl.exe https://<your-url>.trycloudflare.com/health
```

→ must return the same `{"ok":true,...}` JSON.

## 6. Register the endpoint on the dashboard

1. Open https://agentgames.zkverify.io → Dashboard → **My Agents** →
   **LogiGatekeeper** → **Edit agent**.
2. Set **Agent Endpoint** to the full public URL **including the `/agent`
   path**, e.g. `https://logi-gatekeeper-abc123.trycloudflare.com/agent`.
3. Save. Run the **health check** on the dashboard — it must pass.
4. Complete the **signed preflight** and at least **1 practice task**
   (Practice mode: max 10 dispatches/agent/hour, unscored) to confirm the
   loop works end-to-end before scored rounds.

## 7. During the event (until 21/11)

- Keep the PC on, `npm start` running, and the cloudflared tunnel running
  during **17:30–03:30 VN every day**. If the PC sleeps, the agent is
  offline and forfeits tasks (offline = −2 per task).
- If the tunnel drops or the PC restarts: start the server, start the
  tunnel again, copy the **new** URL, update the dashboard endpoint.
- Watch the server console: each task logs its checks, decision and proof
  time (proof generation is ~0.3–1 s, far inside the 60 s deadline).
- Do **not** delete `state.json` while the event runs (it remembers answered
  tasks and used proof references).

## Optional upgrade: stable URL with a named tunnel

1. Create a free Cloudflare account, add a domain you own (or use a free
   subdomain), and run `cloudflared tunnel login` once.
2. `cloudflared tunnel create logigatekeeper` then
   `cloudflared tunnel route dns logigatekeeper agent.<your-domain>`.
3. Run `cloudflared tunnel run logigatekeeper` (add `--url http://localhost:3000`
   via a config file) — the URL `https://agent.<your-domain>` then stays
   stable across restarts, so the dashboard endpoint never needs updating.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `AGENT_GAMES_HMAC_SECRET is not set` at startup | `.env` is missing or empty — create it (step 3). Every task will 401 until it is set. |
| `circuit files missing` at startup | `circuits/` must contain `gatekeeper.wasm` + `gatekeeper_final.zkey` (committed in the repo). |
| Dashboard health check fails | Server running? Tunnel running? Endpoint URL ends with `/agent`? Test the public URL with `curl.exe` first. |
| Tasks get 401 | The secret in `.env` does not match the dashboard secret — re-copy it (or Rotate Secret on the dashboard and update `.env`). |
| Proof generation slow/fails | Circuit files must be the official ones from `agentgames.zkverify.io/circuits`. Do not edit them. |
| Tunnel URL changed | Expected for quick tunnels — update the dashboard endpoint (step 6). |

## Known gaps (read before the first scored round)

1. **No Kurier API key.** The guide recommends submitting the decision
   proof to zkVerify via Kurier (`POST api.kurier.xyz/api/v1/submit-proof/{KEY}`)
   and returning `proof_tx`. No key was created (no sign-ups were made).
   The server returns the Groth16 `proof` + `public_signals` directly for
   the platform to verify — `proof_tx` is omitted (it is optional in the
   response). If the platform ever requires a finalized on-chain proof
   reference, obtain a Kurier mainnet API key and add the submission step.
2. **No on-chain check of the task's own proof.** The guide suggests
   calling zkVerifyJS to confirm the task's `proof_tx` is on-chain with a
   matching VK. That check is not implemented: the `proof_tx` format is not
   documented in the public guide and can only be learned from a real task
   envelope, and a read-only zkVerifyJS check needs the public RPC + proof
   format. The decision is made from the task fields (the 7 trap varieties
   the guide lists are all field checks), and the circuit enforces the same.
   After the first real task arrives, inspect its `proof_tx` and add the
   on-chain check if the format allows it.
3. **Response field casing.** The task envelope uses snake_case but the
   preflight reply uses camelCase (`protocolVersion`), so the decision
   response casing is not pinned down by the public guide. The server sends
   both casings for the key fields (`task_id`/`taskId`,
   `reason_code`/`reasonCode`, `public_signals`/`publicSignals`). If a
   practice task is rejected for schema reasons, adjust to the casing the
   platform reports.
4. **HMAC algorithm.** Assumed HMAC-SHA256 (the standard for this header).
   If the platform uses a different hash, set `HMAC_ALGO` in `.env`
   (e.g. `HMAC_ALGO=sha512`) — the code reads it from the environment.
