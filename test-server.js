// End-to-end test of the LogiGatekeeper server with MOCK task envelopes.
// Run the server first with a DUMMY secret, e.g.:
//   AGENT_GAMES_HMAC_SECRET=test-secret-123 PORT=3456 node server.js
// then:  node test-server.js
// NEVER use a real HMAC secret for tests.
'use strict';

const http = require('http');
const crypto = require('crypto');
const snarkjs = require('snarkjs');
const fs = require('fs');

const PORT = parseInt(process.env.TEST_PORT || '3456', 10);
const SECRET = process.env.TEST_HMAC_SECRET || 'test-secret-123';
const VK_HASH = '0x6b79c6012a6d8651f3e13bc4d2a20370280ab49700c90c5316d4168bfbad77b0';
const RECIPIENT = '0x1111111111111111111111111111111111111111';

let pass = 0;
let fail = 0;
function check(name, ok, extra) {
  if (ok) { pass++; console.log('PASS', name, extra || ''); }
  else { fail++; console.log('FAIL', name, extra || ''); }
}

function sign(body) {
  return crypto.createHmac('sha256', SECRET).update(body).digest('hex');
}

function post(path, obj, secretOverride) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(obj);
    const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) };
    if (secretOverride !== null) {
      headers['x-agent-games-signature'] = crypto.createHmac('sha256', secretOverride === undefined ? SECRET : secretOverride).update(body).digest('hex');
    }
    const req = http.request({ host: '127.0.0.1', port: PORT, path, method: 'POST', headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, raw: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

function get(path) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: PORT, path }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, raw: Buffer.concat(chunks).toString('utf8') }));
    }).on('error', reject);
  });
}

function validTask(taskId, overrides) {
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
      proof_tx: '0x' + 'ab'.repeat(32),
      ...(overrides || {}),
    },
  };
}

async function verifyProof(body) {
  if (!body.proof || !body.public_signals) return false;
  const vk = JSON.parse(fs.readFileSync('circuits/gatekeeper_vk.json', 'utf8'));
  return snarkjs.groth16.verify(vk, body.public_signals, body.proof);
}

function responseSigValid(raw, sigHeader) {
  if (!sigHeader) return false;
  const expected = crypto.createHmac('sha256', SECRET).update(raw).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(sigHeader, 'hex'), Buffer.from(expected, 'hex'));
  } catch (_) { return false; }
}

async function main() {
  // 1) health endpoint
  const h = await get('/health');
  check('GET /health -> 200 ok:true', h.status === 200 && JSON.parse(h.raw).ok === true, h.raw);

  // 2) preflight (signed)
  const pre = await post('/agent', { type: 'agent-games.preflight.v1', agent_id: 'test-agent', issued_at: new Date().toISOString(), nonce: 'n-1' });
  const preBody = JSON.parse(pre.raw);
  check('preflight -> 200 {ok:true, protocolVersion:v1}', pre.status === 200 && preBody.ok === true && preBody.protocolVersion === 'v1', pre.raw);
  check('preflight response is HMAC-signed', responseSigValid(pre.raw, pre.headers['x-agent-games-signature']));

  // 3) valid task -> APPROVE + valid proof
  const t1 = await post('/agent', validTask('550e8400-e29b-41d4-a716-446655440001'));
  const b1 = JSON.parse(t1.raw);
  check('valid task -> 200 APPROVE', t1.status === 200 && b1.decision === 'APPROVE' && b1.reason_code === 'OK', t1.raw.slice(0, 120));
  check('APPROVE response is HMAC-signed', responseSigValid(t1.raw, t1.headers['x-agent-games-signature']));
  check('APPROVE proof verifies against tournament vk', await verifyProof(b1));
  check('APPROVE public_signals has 13 entries', Array.isArray(b1.public_signals) && b1.public_signals.length === 13);
  check('APPROVE public signal decision == 1', b1.public_signals && b1.public_signals[11] === '1', 'signals[11]=' + (b1.public_signals && b1.public_signals[11]));

  // 4) replay same task -> byte-identical cached response
  const t1b = await post('/agent', validTask('550e8400-e29b-41d4-a716-446655440001'));
  check('replay same task_id -> byte-identical response', t1b.raw === t1.raw);

  // 5) trap task (recipient mismatch) -> REJECT + valid proof (decision=0)
  const trap = validTask('550e8400-e29b-41d4-a716-446655440002', {
    recipient: '0x2222222222222222222222222222222222222222',
    proof_tx: '0x' + 'cd'.repeat(32),
  });
  const t2 = await post('/agent', trap);
  const b2 = JSON.parse(t2.raw);
  check('trap (recipient mismatch) -> REJECT', t2.status === 200 && b2.decision === 'REJECT' && b2.reason_code === 'RECIPIENT_MISMATCH', t2.raw.slice(0, 120));
  check('REJECT proof verifies against tournament vk', await verifyProof(b2));
  check('REJECT public signal decision == 0', b2.public_signals && b2.public_signals[11] === '0', 'signals[11]=' + (b2.public_signals && b2.public_signals[11]));

  // 6) bad HMAC -> 401, no decision
  const bad = await post('/agent', validTask('550e8400-e29b-41d4-a716-446655440003'), 'wrong-secret');
  check('bad HMAC -> 401', bad.status === 401, 'status=' + bad.status);

  // 7) missing signature -> 401
  const nosig = await post('/agent', validTask('550e8400-e29b-41d4-a716-446655440004'), null);
  check('missing signature -> 401', nosig.status === 401, 'status=' + nosig.status);

  // 8) reused proof_tx on a different task -> REJECT without proof
  const reuse = validTask('550e8400-e29b-41d4-a716-446655440005', { proof_tx: '0x' + 'ab'.repeat(32) });
  const t3 = await post('/agent', reuse);
  const b3 = JSON.parse(t3.raw);
  check('reused proof_tx -> REJECT PROOF_REUSED, no proof field', t3.status === 200 && b3.decision === 'REJECT' && b3.reason_code === 'PROOF_REUSED' && !b3.proof, t3.raw.slice(0, 120));

  // 9) VK mismatch -> REJECT VK_MISMATCH + proof
  const vkbad = validTask('550e8400-e29b-41d4-a716-446655440006', {
    proof_vk: '0x0000000000000000000000000000000000000000000000000000000000000001',
    proof_tx: '0x' + 'ef'.repeat(32),
  });
  const t4 = await post('/agent', vkbad);
  const b4 = JSON.parse(t4.raw);
  check('VK mismatch -> REJECT VK_MISMATCH', t4.status === 200 && b4.decision === 'REJECT' && b4.reason_code === 'VK_MISMATCH', t4.raw.slice(0, 120));
  check('VK-mismatch REJECT proof verifies', await verifyProof(b4));

  // 10) balance below minimum -> REJECT BALANCE_BELOW_MINIMUM
  const bal = validTask('550e8400-e29b-41d4-a716-446655440007', { public_balance: 500, proof_tx: '0x' + '12'.repeat(32) });
  const t5 = await post('/agent', bal);
  const b5 = JSON.parse(t5.raw);
  check('balance < minimum -> REJECT BALANCE_BELOW_MINIMUM', t5.status === 200 && b5.decision === 'REJECT' && b5.reason_code === 'BALANCE_BELOW_MINIMUM', t5.raw.slice(0, 120));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error('TEST ERROR:', e); process.exit(1); });
