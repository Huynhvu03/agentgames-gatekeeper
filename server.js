/**
 * LogiGatekeeper — Proof Gatekeeper agent for zkVerify Agent Games (Season 01).
 *
 * Plain Node.js (no framework). Runs on Windows or Linux.
 * - POST /agent  : task envelope (Proof Gatekeeper) + preflight
 * - GET  /health : health check
 * - GET  /       : status
 *
 * Env (see .env.example):
 *   AGENT_GAMES_HMAC_SECRET : 32-byte secret shown ONCE at agent registration (NEVER commit it)
 *   AGENT_ID                : agent id from the dashboard (optional, used for preflight logging)
 *   PORT                    : default 3000
 *
 * Decision logic is a DETERMINISTIC checklist over the task fields (no LLM):
 *   APPROVE only if every check passes, otherwise REJECT. Fail closed.
 * A Groth16 proof of the decision is generated locally with snarkjs and the
 * tournament's own gatekeeper circuit, and returned with the response.
 */
'use strict';

// Load .env if present (optional; env vars set in the shell take precedence).
try { require('dotenv').config(); } catch (_) { /* dotenv not installed — use real env vars */ }

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const snarkjs = require('snarkjs');

const PORT = parseInt(process.env.PORT || '3000', 10);
const HMAC_SECRET = process.env.AGENT_GAMES_HMAC_SECRET || '';
const AGENT_ID = process.env.AGENT_ID || '';
const HMAC_ALGO = process.env.HMAC_ALGO || 'sha256'; // platform default: HMAC-SHA256

const CIRCUITS_DIR = path.join(__dirname, 'circuits');
const WASM_PATH = path.join(CIRCUITS_DIR, 'gatekeeper.wasm');
const ZKEY_PATH = path.join(CIRCUITS_DIR, 'gatekeeper_final.zkey');
const VK_PATH = path.join(CIRCUITS_DIR, 'gatekeeper_vk.json');
const STATE_PATH = path.join(__dirname, 'state.json');

// Registered verification-key hash for the gatekeeper circuit (zkVerify mainnet).
const REGISTERED_VK_HASH = '0x6b79c6012a6d8651f3e13bc4d2a20370280ab49700c90c5316d4168bfbad77b0';

const TASK_TIMEOUT_MS = 55_000; // respond inside the 60 s platform deadline

// ---------------------------------------------------------------------------
// Persistent state: seen task_ids (idempotency) + used proof references.
// Stored in memory and in state.json so a restart does not forget them.
// ---------------------------------------------------------------------------
let state = { seenTasks: {}, usedProofRefs: {} };
try {
  if (fs.existsSync(STATE_PATH)) {
    const loaded = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    if (loaded && typeof loaded === 'object') state = { seenTasks: loaded.seenTasks || {}, usedProofRefs: loaded.usedProofRefs || {} };
  }
} catch (e) {
  console.error('[state] could not load state.json, starting empty:', e.message);
}
function saveState() {
  try {
    fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
  } catch (e) {
    console.error('[state] could not save state.json:', e.message);
  }
}

// ---------------------------------------------------------------------------
// HMAC helpers. Header: x-agent-games-signature, HMAC over the RAW body.
// Accepts hex, "sha256=<hex>" and base64 encodings on verify; signs as hex.
// ---------------------------------------------------------------------------
function hmacHex(secret, body) {
  return crypto.createHmac(HMAC_ALGO, secret).update(body).digest('hex');
}
function verifySignature(secret, rawBody, headerValue) {
  if (!secret || !headerValue) return false;
  let provided = String(headerValue).trim();
  if (provided.toLowerCase().startsWith('sha256=')) provided = provided.slice(7);
  const expectedHex = hmacHex(secret, rawBody);
  // 1) hex
  try {
    const a = Buffer.from(provided, 'hex');
    const b = Buffer.from(expectedHex, 'hex');
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) return true;
  } catch (_) { /* not hex, try base64 */ }
  // 2) base64
  try {
    const a = Buffer.from(provided, 'base64');
    const b = Buffer.from(expectedHex, 'hex');
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) return true;
  } catch (_) { /* no match */ }
  return false;
}
function signBody(secret, rawBody) {
  return hmacHex(secret, rawBody);
}

// ---------------------------------------------------------------------------
// Small field helpers.
// ---------------------------------------------------------------------------
function normHex(v) {
  if (v === undefined || v === null) return null;
  let s = String(v).trim().toLowerCase();
  if (s.startsWith('0x')) s = s.slice(2);
  if (!/^[0-9a-f]+$/.test(s)) return null;
  return '0x' + s.replace(/^0+(?=[0-9a-f])/, '');
}
function hexToBigInt(v) {
  const n = normHex(v);
  return n === null ? null : BigInt(n);
}
function toBigInt(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') return Number.isSafeInteger(v) ? BigInt(v) : null;
  if (typeof v === 'string') {
    const t = v.trim();
    if (/^0x[0-9a-fA-F]+$/.test(t)) return BigInt(t);
    if (/^-?\d+$/.test(t)) return BigInt(t);
  }
  return null;
}
function uuidToBigInt(uuid) {
  if (typeof uuid !== 'string') return null;
  const hex = uuid.replace(/-/g, '').toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(hex)) return null;
  return BigInt('0x' + hex);
}

// ---------------------------------------------------------------------------
// Deterministic decision checklist (the 7 checks from the field guide).
// Returns { approve: boolean, reason: string, checks: {...} }.
// ---------------------------------------------------------------------------
function decide(input) {
  const checks = {};
  const reasons = [];

  // 1) proof VK equals registered VK
  const regVk = normHex(input.registered_vk);
  const proofVk = normHex(input.proof_vk);
  checks.vkMatch = !!(regVk && proofVk && regVk === proofVk);
  if (!checks.vkMatch) reasons.push('VK_MISMATCH');

  // 2) public balance >= minimum threshold
  const balance = toBigInt(input.public_balance);
  const minimum = toBigInt(input.minimum);
  checks.balanceOk = balance !== null && minimum !== null && balance >= minimum;
  if (!checks.balanceOk) reasons.push('BALANCE_BELOW_MINIMUM');

  // 3) recipient matches condition recipient
  const recipient = normHex(input.recipient);
  const conditionRecipient = normHex(input.condition_recipient);
  checks.recipientOk = !!(recipient && conditionRecipient && recipient === conditionRecipient);
  if (!checks.recipientOk) reasons.push('RECIPIENT_MISMATCH');

  // 4) amount within cap
  const amount = toBigInt(input.amount);
  const maxTransfer = toBigInt(input.max_transfer);
  checks.amountOk = amount !== null && maxTransfer !== null && amount >= 0n && amount <= maxTransfer;
  if (!checks.amountOk) reasons.push('AMOUNT_OVER_CAP');

  // 5) expiry block ahead of current block
  const expiry = toBigInt(input.expiry_block);
  const current = toBigInt(input.current_block);
  checks.expiryOk = expiry !== null && current !== null && expiry > current;
  if (!checks.expiryOk) reasons.push('EXPIRED');

  // 6) proof reference present? (informational only — the circuit does not
  //    take proof_tx as an input, so a missing reference must not by itself
  //    force a REJECT; the reuse check below handles present references.)
  const proofRef = input.proof_tx === undefined || input.proof_tx === null ? null : String(input.proof_tx);
  checks.proofRefPresent = proofRef !== null && proofRef.length > 0;
  if (!checks.proofRefPresent) reasons.push('MISSING_PROOF_REF');

  const approve = checks.vkMatch && checks.balanceOk && checks.recipientOk &&
    checks.amountOk && checks.expiryOk;
  return { approve, reason: approve ? 'OK' : reasons[0], reasons, checks };
}

// ---------------------------------------------------------------------------
// Groth16 proof generation with the tournament's own gatekeeper circuit.
// Circuit inputs (13, recovered by probing gatekeeper.wasm):
//   decision, registeredVkHash, proofVkHash, publicBalance, minimum,
//   amount, maxTransfer, recipient, conditionRecipient, expiryBlock,
//   currentBlock, taskId, salt
// The circuit constrains decision == (all checks pass); a wrong decision
// cannot even build a witness, so proof generation itself enforces honesty.
// ---------------------------------------------------------------------------
let vkCache = null;
function getVk() {
  if (!vkCache) vkCache = JSON.parse(fs.readFileSync(VK_PATH, 'utf8'));
  return vkCache;
}

async function generateProof(input, approve) {
  // taskId as a field element: UUID -> its 128-bit hex value; anything else
  // -> first 16 bytes of sha256(task_id) (deterministic fallback).
  let taskIdBig = uuidToBigInt(input.task_id);
  if (taskIdBig === null) {
    taskIdBig = BigInt('0x' + crypto.createHash('sha256').update(String(input.task_id)).digest('hex').slice(0, 32));
  }
  const circuitInput = {
    decision: approve ? 1 : 0,
    registeredVkHash: normHex(input.registered_vk),
    proofVkHash: normHex(input.proof_vk),
    publicBalance: toBigInt(input.public_balance).toString(),
    minimum: toBigInt(input.minimum).toString(),
    amount: toBigInt(input.amount).toString(),
    maxTransfer: toBigInt(input.max_transfer).toString(),
    recipient: normHex(input.recipient),
    conditionRecipient: normHex(input.condition_recipient),
    expiryBlock: toBigInt(input.expiry_block).toString(),
    currentBlock: toBigInt(input.current_block).toString(),
    taskId: '0x' + taskIdBig.toString(16).padStart(32, '0'),
    // Random salt per proof: binds this proof to this attempt and keeps
    // proofs unique even for identical task fields.
    salt: '0x' + crypto.randomBytes(16).toString('hex'),
  };
  const t0 = Date.now();
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(circuitInput, WASM_PATH, ZKEY_PATH);
  const ms = Date.now() - t0;
  // Self-check: the proof must verify against the tournament verification key.
  const ok = await snarkjs.groth16.verify(getVk(), publicSignals, proof);
  if (!ok) throw new Error('generated proof failed local verification');
  return { proof, publicSignals, ms };
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------
function sendJson(res, status, obj, sign) {
  const body = JSON.stringify(obj);
  const headers = { 'Content-Type': 'application/json' };
  if (sign && HMAC_SECRET) headers['x-agent-games-signature'] = signBody(HMAC_SECRET, body);
  res.writeHead(status, headers);
  res.end(body);
}
function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------
async function handleAgent(req, res) {
  const started = Date.now();
  const rawBody = await readRawBody(req);
  const sig = req.headers['x-agent-games-signature'];

  // 0) Verify HMAC on the RAW body BEFORE parsing anything.
  if (!verifySignature(HMAC_SECRET, rawBody, sig)) {
    console.log('[agent] 401 bad signature');
    return sendJson(res, 401, { error: 'invalid signature' }, false);
  }

  let env;
  try {
    env = JSON.parse(rawBody.toString('utf8'));
  } catch (e) {
    console.log('[agent] 400 bad json');
    return sendJson(res, 400, { error: 'invalid json' }, true);
  }

  // Preflight: { type: 'agent-games.preflight.v1', agent_id, issued_at, nonce }
  if (env && env.type === 'agent-games.preflight.v1') {
    console.log('[agent] preflight nonce=', env.nonce);
    return sendJson(res, 200, { ok: true, protocolVersion: 'v1' }, true);
  }

  // Task envelope: agent-games.proof-gatekeeper.v1
  const input = env.input || env;
  const taskId = env.task_id || input.task_id;
  if (!taskId || typeof taskId !== 'string') {
    console.log('[agent] 400 missing task_id');
    return sendJson(res, 400, { error: 'missing task_id' }, true);
  }

  // Idempotency: a retried task returns the byte-identical cached response.
  if (state.seenTasks[taskId]) {
    const cached = state.seenTasks[taskId];
    console.log('[agent] replay task', taskId, '-> cached', cached.decision);
    const headers = { 'Content-Type': 'application/json' };
    if (HMAC_SECRET) headers['x-agent-games-signature'] = signBody(HMAC_SECRET, cached.raw);
    res.writeHead(200, headers);
    return res.end(cached.raw);
  }

  // Deadline guard: if the platform deadline is already too close, fail closed.
  const deadlineMs = env.deadline_at ? Date.parse(env.deadline_at) : NaN;
  if (!Number.isNaN(deadlineMs) && deadlineMs - Date.now() < 5_000) {
    console.log('[agent] task', taskId, 'deadline too close, REJECT');
    return finishTask(res, taskId, input, false, 'DEADLINE_PASSED', null, started);
  }

  const { approve, reason, checks } = decide(input);
  console.log('[agent] task', taskId, 'checks=', JSON.stringify(checks), '->', approve ? 'APPROVE' : 'REJECT', reason);

  // Proof-reuse trap: a proof reference already used for another task.
  // The platform scores these with decision only (no proof).
  const proofRef = input.proof_tx === undefined || input.proof_tx === null ? null : String(input.proof_tx);
  if (proofRef && state.usedProofRefs[proofRef] && state.usedProofRefs[proofRef] !== taskId) {
    console.log('[agent] task', taskId, 'proof reference reused, REJECT without proof');
    return finishTask(res, taskId, input, false, 'PROOF_REUSED', null, started);
  }

  // Generate the Groth16 proof of the decision. If proof generation fails,
  // fail closed: REJECT without a proof (never approve without proof).
  let proofData = null;
  try {
    proofData = await generateProof({ ...input, task_id: taskId }, approve);
    console.log('[agent] proof generated in', proofData.ms, 'ms, verified OK');
  } catch (e) {
    console.log('[agent] proof generation failed for', taskId, ':', e.message, '-> REJECT without proof');
    return finishTask(res, taskId, input, false, 'PROOF_GENERATION_FAILED', null, started);
  }

  // Mark the proof reference used (only for tasks that carried a proof).
  if (proofRef) {
    state.usedProofRefs[proofRef] = taskId;
    saveState();
  }
  return finishTask(res, taskId, input, approve, reason, proofData, started);
}

function finishTask(res, taskId, input, approve, reason, proofData, started) {
  const decision = approve ? 'APPROVE' : 'REJECT';
  // Field-name hedge: the task envelope the platform sends is snake_case,
  // but the preflight reply it expects is camelCase (protocolVersion), so the
  // decision-response casing is not pinned down by the public guide. Send
  // both casings for the key fields; the proof itself is identical either way.
  const obj = {
    task_id: taskId, taskId,
    decision,
    reason_code: reason, reasonCode: reason,
  };
  if (proofData) {
    obj.proof = proofData.proof;
    obj.public_signals = proofData.publicSignals;
    obj.publicSignals = proofData.publicSignals;
    // proof_tx is optional: no Kurier key is configured, so the decision
    // proof is returned for the platform to verify directly (see README).
  }
  const raw = JSON.stringify(obj);
  state.seenTasks[taskId] = { decision, raw };
  saveState();
  const headers = { 'Content-Type': 'application/json' };
  if (HMAC_SECRET) headers['x-agent-games-signature'] = signBody(HMAC_SECRET, raw);
  console.log('[agent] task', taskId, decision, reason, 'in', Date.now() - started, 'ms');
  res.writeHead(200, headers);
  res.end(raw);
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/agent' || url.pathname === '/')) {
      // GET on the endpoint path itself also answers OK: the platform's
      // health check may probe the registered URL (…/agent) with a GET.
      return sendJson(res, 200, { ok: true, agent: 'LogiGatekeeper', time: new Date().toISOString() }, false);
    }
    if (req.method === 'POST' && (url.pathname === '/agent' || url.pathname === '/')) {
      // 60 s hard deadline: abort work that would overrun it.
      const timer = setTimeout(() => {
        if (!res.writableEnded) {
          try { sendJson(res, 200, { task_id: null, decision: 'REJECT', reason_code: 'TIMEOUT' }, true); } catch (_) {}
        }
      }, TASK_TIMEOUT_MS);
      timer.unref();
      await handleAgent(req, res);
      clearTimeout(timer);
      return;
    }
    return sendJson(res, 404, { error: 'not found' }, false);
  } catch (e) {
    console.error('[server] error:', e);
    if (!res.writableEnded) {
      try { sendJson(res, 500, { error: 'internal error' }, false); } catch (_) {}
    }
  }
});

if (!HMAC_SECRET) {
  console.warn('[warn] AGENT_GAMES_HMAC_SECRET is not set — incoming tasks will get 401 until it is configured.');
}
if (!fs.existsSync(WASM_PATH) || !fs.existsSync(ZKEY_PATH)) {
  console.warn('[warn] circuit files missing in circuits/ — proof generation will fail until gatekeeper.wasm + gatekeeper_final.zkey are present.');
}
server.listen(PORT, () => {
  console.log(`LogiGatekeeper listening on http://localhost:${PORT}  (POST /agent, GET /health)`);
});
