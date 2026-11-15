// Test: generate a Groth16 proof with the real gatekeeper circuit.
// Valid scenario (all checks pass, decision = APPROVE = 1).
// Then verify with snarkjs and print public signals to learn their ORDER.
const snarkjs = require('snarkjs');
const fs = require('fs');

const VK_HASH = '0x6b79c6012a6d8651f3e13bc4d2a20370280ab49700c90c5316d4168bfbad77b0';

async function main() {
  const input = {
    decision: 1,
    registeredVkHash: VK_HASH,
    proofVkHash: VK_HASH,
    publicBalance: 1460,
    minimum: 1000,
    amount: 500,
    maxTransfer: 1000,
    recipient: '0x1111111111111111111111111111111111111111',
    conditionRecipient: '0x1111111111111111111111111111111111111111',
    expiryBlock: 2000000,
    currentBlock: 1999999,
    taskId: '0x550e8400e29b41d4a716446655440000',
    salt: 12345,
  };
  console.log('generating proof...');
  const t0 = Date.now();
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    input,
    'circuits/gatekeeper.wasm',
    'circuits/gatekeeper_final.zkey'
  );
  const dt = Date.now() - t0;
  console.log('proof generated in', dt, 'ms');
  console.log('proof bytes:', JSON.stringify(proof).length);
  console.log('publicSignals:', JSON.stringify(publicSignals, null, 2));

  const vKey = JSON.parse(fs.readFileSync('/tmp/vk.json', 'utf8'));
  const ok = await snarkjs.groth16.verify(vKey, publicSignals, proof);
  console.log('snarkjs groth16 verify:', ok ? 'OK' : 'FAIL');
  fs.writeFileSync('/tmp/test-proof.json', JSON.stringify({ proof, publicSignals }, null, 2));
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
