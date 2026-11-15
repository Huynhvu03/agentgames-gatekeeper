/**
 * kurier.js — Kurier client for LogiGatekeeper (zkVerify Agent Games).
 *
 * Why this exists (root cause of Round 03's 0 verified proofs):
 * The Agent Games platform scores a Proof Gatekeeper decision proof from the
 * ON-CHAIN proof reference (`proof_tx`) in the response — its expected
 * response shape is { decision, reason_code, proof_tx } and the field guide
 * describes the loop as "from a public agent endpoint to a finalized proof
 * reference", with Kurier as the RECOMMENDED path ("Get a mainnet API key,
 * register the verification key once, submit proofs with its vk hash, and
 * poll until the job reaches Finalized"). Returning the Groth16 proof inline
 * is not enough: in Round 03 every correct decision still cost -2 for
 * "missing / invalid proof" and earned no reliability bonus.
 *
 * Flow (all stdlib, no new dependencies):
 *   1. register-vk once per process (POST /register-vk/{KEY}, groth16 /
 *      snarkjs / bn128, vk = circuits/gatekeeper_vk.json) -> vkHash.
 *   2. submit-proof (POST /submit-proof/{KEY}, proofType groth16,
 *      vkRegistered true, proofData { proof, publicSignals, vk: vkHash })
 *      -> { jobId, optimisticVerify }.
 *   3. Poll GET /job-status/{KEY}/{jobId} until IncludedInBlock/Finalized
 *      (txHash available) or Failed / budget exhausted.
 *   4. Return the zkVerify transaction hash as proof_tx.
 *
 * Fail-safe contract (NEVER breaks the 60 s task response):
 *   - If no KURIER_API_KEY is configured, everything is a no-op.
 *   - Any Kurier error/timeout -> { proofTx: null } and the caller still
 *     returns decision + inline proof (today's behaviour).
 *   - Total Kurier time per task is capped by budgetMs (default 30 s) and
 *     every single HTTP call has its own 10 s timeout.
 *   - A task_id is submitted at most once: the server caches the full
 *     response (including proof_tx) in state.json, so replays never
 *     re-submit.
 *
 * Env:
 *   KURIER_API_KEY          mainnet key from https://kurier.xyz (signup ->
 *                           dashboard -> create key). REQUIRED for on-chain
 *                           proof submission; without it proofs are inline
 *                           only and score -2 each.
 *   KURIER_API_URL          default https://api.kurier.xyz/api/v1
 *   KURIER_POLL_BUDGET_MS   max ms per task for submit+poll (default 30000)
 *   KURIER_POLL_INTERVAL_MS poll interval (default 2000)
 *   KURIER_CALL_TIMEOUT_MS  per-call HTTP timeout (default 10000)
 *   KURIER_VK_HASH          vk hash to send in proofData.vk (default: the
 *                           tournament's registered vk hash, as published
 *                           on agentgames.zkverify.io/api/circuit-info)
 */
'use strict';

const KURIER_API_URL = (process.env.KURIER_API_URL || 'https://api.kurier.xyz/api/v1').replace(/\/+$/, '');
const KURIER_API_KEY = process.env.KURIER_API_KEY || '';
const KURIER_POLL_BUDGET_MS = parseInt(process.env.KURIER_POLL_BUDGET_MS || '30000', 10);
const KURIER_POLL_INTERVAL_MS = parseInt(process.env.KURIER_POLL_INTERVAL_MS || '2000', 10);
const KURIER_CALL_TIMEOUT_MS = parseInt(process.env.KURIER_CALL_TIMEOUT_MS || '10000', 10);

// Registered verification-key hash for the gatekeeper circuit (zkVerify
// mainnet), as published by the tournament. The field guide says to copy
// this hash when submitting proofs via Kurier.
const REGISTERED_VK_HASH = '0x6b79c6012a6d8651f3e13bc4d2a20370280ab49700c90c5316d4168bfbad77b0';
const KURIER_VK_HASH = process.env.KURIER_VK_HASH || REGISTERED_VK_HASH;

function isConfigured() {
  return KURIER_API_KEY.length > 0;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(url, method, bodyObj) {
  const init = {
    method,
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(KURIER_CALL_TIMEOUT_MS),
  };
  if (bodyObj !== undefined) init.body = JSON.stringify(bodyObj);
  const res = await fetch(url, init);
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (_) { /* non-JSON body */ }
  if (!res.ok) {
    const detail = data && (data.message || data.error) ? ` - ${data.message || data.error}` : '';
    throw new Error(`Kurier ${method} ${url} -> HTTP ${res.status}${detail}`);
  }
  return data;
}

// ---------------------------------------------------------------------------
// Verification-key registration (once per process).
// The tournament's gatekeeper vk is public; registering it is idempotent —
// if it is already registered Kurier returns the existing vkHash (or an
// "already registered" error, which we also accept).
// ---------------------------------------------------------------------------
let vkReg = { state: 'unknown', vkHash: null }; // state: unknown | ok | failed

async function ensureVkRegistered(vkObject) {
  if (vkReg.state === 'ok') return vkReg.vkHash;
  try {
    const data = await fetchJson(
      `${KURIER_API_URL}/register-vk/${KURIER_API_KEY}`,
      'POST',
      {
        proofType: 'groth16',
        proofOptions: { library: 'snarkjs', curve: 'bn128' },
        vk: vkObject,
      }
    );
    const hash = (data && (data.vkHash || (data.meta && data.meta.vkHash))) || null;
    if (hash && hash.toLowerCase() !== KURIER_VK_HASH.toLowerCase()) {
      console.warn(`[kurier] register-vk returned vkHash ${hash}, expected ${KURIER_VK_HASH} — using the returned value`);
    }
    vkReg = { state: 'ok', vkHash: hash || KURIER_VK_HASH };
    console.log('[kurier] vk registered, vkHash=', vkReg.vkHash);
    return vkReg.vkHash;
  } catch (e) {
    // "Already registered" is a success for our purpose: the vk IS on Kurier.
    const msg = String((e && e.message) || e);
    if (/already (registered|exists)/i.test(msg)) {
      console.log('[kurier] vk already registered, proceeding with known vkHash');
      vkReg = { state: 'ok', vkHash: KURIER_VK_HASH };
      return vkReg.vkHash;
    }
    console.error('[kurier] register-vk failed:', msg);
    vkReg = { state: 'failed', vkHash: null };
    return null;
  }
}

// ---------------------------------------------------------------------------
// Submit one decision proof and wait for its on-chain transaction hash.
// Returns { proofTx, jobId, status, reason } — proofTx is null on any
// failure (caller must still answer with decision + inline proof).
// budgetMs caps the whole submit+poll phase for this task.
// ---------------------------------------------------------------------------
async function submitProof({ proof, publicSignals, vkObject, budgetMs }) {
  const started = Date.now();
  const budget = Math.max(0, budgetMs === undefined ? KURIER_POLL_BUDGET_MS : budgetMs);
  const remaining = () => budget - (Date.now() - started);
  if (!isConfigured()) return { proofTx: null, jobId: null, status: null, reason: 'KURIER_NOT_CONFIGURED' };

  // 1) Make sure the vk is registered (cached after the first success).
  const vkHash = await ensureVkRegistered(vkObject);
  if (!vkHash) return { proofTx: null, jobId: null, status: null, reason: 'VK_REGISTER_FAILED' };
  if (remaining() < 3000) return { proofTx: null, jobId: null, status: null, reason: 'BUDGET_EXHAUSTED_BEFORE_SUBMIT' };

  // 2) Submit the proof.
  let jobId = null;
  try {
    const data = await fetchJson(
      `${KURIER_API_URL}/submit-proof/${KURIER_API_KEY}`,
      'POST',
      {
        proofType: 'groth16',
        vkRegistered: true,
        proofOptions: { library: 'snarkjs', curve: 'bn128' },
        proofData: { proof, publicSignals, vk: vkHash },
      }
    );
    jobId = (data && data.jobId) || null;
    if (!jobId) return { proofTx: null, jobId: null, status: null, reason: 'NO_JOB_ID' };
    if (data.optimisticVerify !== undefined && data.optimisticVerify !== 'success') {
      console.error(`[kurier] job ${jobId} optimisticVerify=${data.optimisticVerify} — proof rejected by Kurier, not polling`);
      return { proofTx: null, jobId, status: null, reason: 'OPTIMISTIC_VERIFY_FAILED' };
    }
    console.log(`[kurier] job ${jobId} submitted (optimisticVerify=${data.optimisticVerify})`);
  } catch (e) {
    console.error('[kurier] submit-proof failed:', (e && e.message) || e);
    return { proofTx: null, jobId: null, status: null, reason: 'SUBMIT_FAILED' };
  }

  // 3) Poll job-status until the tx is in a block (txHash available) or
  //    the job fails / the budget runs out.
  for (;;) {
    if (remaining() < 1000) {
      console.error(`[kurier] job ${jobId} poll budget exhausted (${budget}ms) — answering without proof_tx`);
      return { proofTx: null, jobId, status: null, reason: 'POLL_BUDGET_EXHAUSTED' };
    }
    try {
      const st = await fetchJson(`${KURIER_API_URL}/job-status/${KURIER_API_KEY}/${jobId}`, 'GET');
      const status = st && st.status;
      console.log(`[kurier] job ${jobId} status=${status}`);
      if ((status === 'IncludedInBlock' || status === 'Finalized') && st.txHash) {
        return { proofTx: st.txHash, jobId, status, reason: null };
      }
      if (status === 'Failed') {
        console.error(`[kurier] job ${jobId} Failed`);
        return { proofTx: null, jobId, status, reason: 'JOB_FAILED' };
      }
      // Queued / Valid / Submitted: keep polling. (IncludedInBlock without
      // a txHash yet is also treated as "keep polling".)
    } catch (e) {
      console.error('[kurier] job-status poll failed:', (e && e.message) || e);
      // A single failed poll is not fatal — keep polling until the budget
      // runs out (transient 5xx / network blip).
    }
    await sleep(Math.min(KURIER_POLL_INTERVAL_MS, Math.max(0, remaining() - 500)));
  }
}

module.exports = {
  isConfigured,
  ensureVkRegistered,
  submitProof,
  REGISTERED_VK_HASH,
  KURIER_API_URL,
  KURIER_POLL_BUDGET_MS,
  KURIER_POLL_INTERVAL_MS,
};
