// End-to-end test of the Kurier integration with a MOCK Kurier server.
// The mock implements register-vk / submit-proof / job-status with
// switchable behaviours (success, submit failure, job failure, never
// included, optimistic-verify failure) so every fail-safe path is covered.
//
// Run:  node test-kurier.js
// It copies the code dir to a temp dir (fresh state.json), spawns the real
// server.js as a child process pointed at the mock Kurier, runs the
// scenarios, then cleans up. NEVER use a real HMAC secret or Kurier key.
'use strict';

const http = require('http');
const crypto = require('crypto');
const snarkjs = require('snarkjs');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const SECRET = 'test-secret-123';
const VK_HASH = '0x6b79c6012a6d8651f3e13bc4d2a20370280ab49700c90c5316d4168bfbad77b0';
const RECIPIENT = '0x1111111111111111111111111111111111111111';
const MOCK_TX_HASH = '0x' + 'aa'.repeat(32);
const MOCK_BLOCK_HASH = '0x' + 'bb'.repeat(32);
const MOCK_PORT = parseInt(process.env.MOCK_PORT || '3561', 10);
const SERVER_PORT = parseInt(process.env.TEST_PORT || '3457', 10);
const SERVER2_PORT = SERVER_PORT + 1;

let pass = 0;
let fail = 0;
function check(name, ok, extra) {
  if (ok) { pass++; console.log('PASS', name, extra || ''); }
  else { fail++; console.log('FAIL', name, extra || ''); }
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ---------------------------------------------------------------------------
// Mock Kurier
// ---------------------------------------------------------------------------
let mockMode = 'success'; // success | fail-submit | fail-job | never | optimistic-fail
const counts = { register: 0, submit: 0, jobStatus: 0 };
const jobPolls = {};
let jobSeq = 0;

function mockHandler(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const parts = url.pathname.split('/').filter(Boolean); // api/v1/<ep>/<key>[/<jobId>]
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    res.setHeader('Content-Type', 'application/json');
    const ep = parts[2];
    if (req.method === 'POST' && ep === 'register-vk') {
      counts.register++;
      return res.end(JSON.stringify({ vkHash: VK_HASH }));
    }
    if (req.method === 'POST' && ep === 'submit-proof') {
      counts.submit++;
      if (mockMode === 'fail-submit') {
        res.writeHead(500);
        return res.end(JSON.stringify({ error: 'mock submit failure' }));
      }
      const jobId = `job-${++jobSeq}`;
      jobPolls[jobId] = 0;
      return res.end(JSON.stringify({
        jobId,
        optimisticVerify: mockMode === 'optimistic-fail' ? 'failed' : 'success',
      }));
    }
    if (req.method === 'GET' && ep === 'job-status') {
      counts.jobStatus++;
      const jobId = parts[4];
      jobPolls[jobId] = (jobPolls[jobId] || 0) + 1;
      if (mockMode === 'fail-job') return res.end(JSON.stringify({ jobId, status: 'Failed' }));
      if (mockMode === 'never') return res.end(JSON.stringify({ jobId, status: 'Queued' }));
      if (jobPolls[jobId] === 1) return res.end(JSON.stringify({ jobId, status: 'Submitted' }));
      return res.end(JSON.stringify({ jobId, status: 'IncludedInBlock', txHash: MOCK_TX_HASH, blockHash: MOCK_BLOCK_HASH }));
    }
    res.writeHead(404);
    res.end(JSON.stringify({ error: 'mock: not found' }));
  });
}

// ---------------------------------------------------------------------------
// HTTP helpers (signed like the platform)
// ---------------------------------------------------------------------------
function sign(body) {
  return crypto.createHmac('sha256', SECRET).update(body).digest('hex');
}
function post(port, pathName, obj) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(obj);
    const req = http.request({
      host: '127.0.0.1', port, path: pathName, method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'x-agent-games-signature': sign(body),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, raw: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(body);
  });
}
function get(port, pathName) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: pathName }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, raw: Buffer.concat(chunks).toString('utf8') }));
    }).on('error', reject);
  });
}
function validTask(taskId, overrides) {
  // Unique proof_tx per taskId: reusing one across tasks is the
  // PROOF_REUSED trap and would (correctly) reject the later tasks.
  const uniqueProofTx = '0x' + crypto.createHash('sha256').update(taskId).digest('hex');
  return {
    type: 'agent-games.proof-gatekeeper.v1',
    task_id: taskId,
    mode: 'scored',
    issued_at: new Date().toISOString(),
    deadline_at: new Date(Date.now() + 60_000).toISOString(),
    input: {
      registered_vk: VK_HASH,
      proof_vk: VK_HASH,
      minimum: 1000,
      public_balance: 1460,
      expiry_block: 2000000,
      current_block: 1999999,
      recipient: RECIPIENT,
      condition_recipient: RECIPIENT,
      amount: 500,
      max_transfer: 1000,
      proof_tx: uniqueProofTx,
      ...(overrides || {}),
    },
  };
}
async function verifyProof(body) {
  if (!body.proof || !body.public_signals) return false;
  const vk = JSON.parse(fs.readFileSync(path.join(__dirname, 'circuits/gatekeeper_vk.json'), 'utf8'));
  return snarkjs.groth16.verify(vk, body.public_signals, body.proof);
}
function responseSigValid(raw, sigHeader) {
  if (!sigHeader) return false;
  const expected = crypto.createHmac('sha256', SECRET).update(raw).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(sigHeader, 'hex'), Buffer.from(expected, 'hex'));
  } catch (_) { return false; }
}

// ---------------------------------------------------------------------------
// Child server management
// ---------------------------------------------------------------------------
function startServer(cwd, port, extraEnv) {
  const child = spawn('node', ['server.js'], {
    cwd,
    env: {
      ...process.env,
      AGENT_GAMES_HMAC_SECRET: SECRET,
      PORT: String(port),
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d.toString(); });
  child.stderr.on('data', (d) => { out += d.toString(); });
  return { child, getLog: () => out };
}
async function waitHealthy(port, timeoutMs = 15000) {
  const t0 = Date.now();
  for (;;) {
    try {
      const h = await get(port, '/health');
      if (h.status === 200) return true;
    } catch (_) { /* not up yet */ }
    if (Date.now() - t0 > timeoutMs) return false;
    await sleep(300);
  }
}

async function main() {
  // 1) Copy the code tree to a temp dir (fresh state.json; symlink node_modules).
  const srcDir = __dirname;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gk-kurier-test-'));
  fs.cpSync(srcDir, tmpDir, {
    recursive: true,
    filter: (f) => !f.endsWith('node_modules') && !f.endsWith('state.json'),
  });
  fs.symlinkSync(path.join(srcDir, 'node_modules'), path.join(tmpDir, 'node_modules'), 'dir');
  console.log('test dir:', tmpDir);

  // 2) Start the mock Kurier.
  const mock = http.createServer(mockHandler);
  await new Promise((resolve) => mock.listen(MOCK_PORT, resolve));
  console.log(`mock Kurier on :${MOCK_PORT}`);

  const kurierEnv = {
    KURIER_API_KEY: 'test-key',
    KURIER_API_URL: `http://127.0.0.1:${MOCK_PORT}/api/v1`,
    KURIER_POLL_BUDGET_MS: '8000',
    KURIER_POLL_INTERVAL_MS: '500',
  };

  // 3) Start the server under test (with Kurier configured).
  const srv = startServer(tmpDir, SERVER_PORT, kurierEnv);
  if (!await waitHealthy(SERVER_PORT)) {
    console.log('FAIL server did not become healthy');
    process.exit(1);
  }

  // --- Scenario 1: Kurier success -> APPROVE + proof_tx + valid proof ---
  mockMode = 'success';
  const t1 = await post(SERVER_PORT, '/agent', validTask('kurier-test-0001'));
  const b1 = JSON.parse(t1.raw);
  check('kurier success -> 200 APPROVE', t1.status === 200 && b1.decision === 'APPROVE', t1.raw.slice(0, 120));
  check('kurier success -> proof_tx is the mock tx hash', b1.proof_tx === MOCK_TX_HASH, 'proof_tx=' + b1.proof_tx);
  check('kurier success -> proof still verifies', await verifyProof(b1));
  check('kurier success -> response is HMAC-signed', responseSigValid(t1.raw, t1.headers['x-agent-games-signature']));
  check('kurier success -> register-vk called once', counts.register === 1, `register=${counts.register}`);
  check('kurier success -> submit-proof called once', counts.submit === 1, `submit=${counts.submit}`);
  await sleep(300); // let the server log flush
  check('kurier success -> server log shows proof_tx', srv.getLog().includes(`proof_tx=${MOCK_TX_HASH}`));

  // --- Scenario 2: replay -> byte-identical, NO re-submission ---
  const t1b = await post(SERVER_PORT, '/agent', validTask('kurier-test-0001'));
  check('replay -> byte-identical response', t1b.raw === t1.raw);
  check('replay -> submit-proof NOT called again', counts.submit === 1, `submit=${counts.submit}`);

  // --- Scenario 3: submit-proof fails -> decision + proof, no proof_tx ---
  mockMode = 'fail-submit';
  const t2 = await post(SERVER_PORT, '/agent', validTask('kurier-test-0002'));
  const b2 = JSON.parse(t2.raw);
  check('kurier submit 500 -> 200 APPROVE with proof, no proof_tx', t2.status === 200 && b2.decision === 'APPROVE' && !!b2.proof && !b2.proof_tx, t2.raw.slice(0, 120));
  check('kurier submit 500 -> proof still verifies', await verifyProof(b2));

  // --- Scenario 4: job fails -> decision + proof, no proof_tx ---
  mockMode = 'fail-job';
  const t3 = await post(SERVER_PORT, '/agent', validTask('kurier-test-0003'));
  const b3 = JSON.parse(t3.raw);
  check('kurier job Failed -> 200 APPROVE with proof, no proof_tx', t3.status === 200 && b3.decision === 'APPROVE' && !!b3.proof && !b3.proof_tx, t3.raw.slice(0, 120));

  // --- Scenario 5: job never included -> poll budget caps it, still answers ---
  mockMode = 'never';
  const t0 = Date.now();
  const t4 = await post(SERVER_PORT, '/agent', validTask('kurier-test-0004'));
  const tookMs = Date.now() - t0;
  const b4 = JSON.parse(t4.raw);
  check('kurier never included -> 200 APPROVE with proof, no proof_tx', t4.status === 200 && b4.decision === 'APPROVE' && !!b4.proof && !b4.proof_tx, t4.raw.slice(0, 120));
  check('kurier never included -> answered within 20 s (budget respected)', tookMs < 20000, `took ${tookMs}ms`);

  // --- Scenario 6: optimisticVerify != success -> no polling, no proof_tx ---
  mockMode = 'optimistic-fail';
  const jsBefore = counts.jobStatus;
  const t5 = await post(SERVER_PORT, '/agent', validTask('kurier-test-0005'));
  const b5 = JSON.parse(t5.raw);
  check('kurier optimisticVerify failed -> 200 APPROVE with proof, no proof_tx', t5.status === 200 && b5.decision === 'APPROVE' && !!b5.proof && !b5.proof_tx, t5.raw.slice(0, 120));
  check('kurier optimisticVerify failed -> job-status NOT polled', counts.jobStatus === jsBefore, `jobStatus=${counts.jobStatus} (was ${jsBefore})`);

  // --- Scenario 7: no Kurier key -> old behaviour, zero Kurier calls ---
  const snap = { ...counts };
  const srv2 = startServer(tmpDir, SERVER2_PORT, { KURIER_API_KEY: '' });
  if (!await waitHealthy(SERVER2_PORT)) {
    console.log('FAIL second server did not become healthy');
    process.exit(1);
  }
  const t6 = await post(SERVER2_PORT, '/agent', validTask('kurier-test-0006'));
  const b6 = JSON.parse(t6.raw);
  check('no KURIER_API_KEY -> 200 APPROVE with proof, no proof_tx', t6.status === 200 && b6.decision === 'APPROVE' && !!b6.proof && !b6.proof_tx, t6.raw.slice(0, 120));
  check('no KURIER_API_KEY -> zero Kurier calls made', counts.register === snap.register && counts.submit === snap.submit && counts.jobStatus === snap.jobStatus,
    `register ${snap.register}->${counts.register}, submit ${snap.submit}->${counts.submit}`);

  // Cleanup
  srv.child.kill();
  srv2.child.kill();
  await sleep(500);
  mock.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error('TEST ERROR:', e); process.exit(1); });
