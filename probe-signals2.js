// Probe round 2: control names (must be 0) + more candidates for the 13th input signal.
const fs = require('fs');

function fnvHash(str) {
  const uint64_max = BigInt(2) ** BigInt(64);
  let hash = BigInt('0xCBF29CE484222325');
  for (let i = 0; i < str.length; i++) {
    hash ^= BigInt(str[i].charCodeAt(0));
    hash *= BigInt(0x100000001B3);
    hash %= uint64_max;
  }
  let shash = hash.toString(16);
  shash = '0'.repeat(16 - shash.length) + shash;
  return shash;
}

const candidates = [
  // controls — definitely fake
  'zzzqqq_nonexistent_12345', 'definitely_not_a_signal', 'foobar',
  // more candidates for the missing 13th input
  'proof_ref', 'proofRef', 'proof_reference', 'proofReference',
  'round', 'roundId', 'round_id', 'epoch', 'chainId', 'chain_id',
  'deadline_at', 'deadlineAt', 'issued_at', 'issuedAt',
  'salt', 'secret', 'proof', 'signature', 'witness',
  'cap', 'limit', 'max', 'min', 'value', 'balance', 'threshold', 'expected',
  'action', 'transfer', 'to', 'from', 'sender', 'id', 'uuid', 'hash', 'digest',
  'input_hash', 'inputHash', 'taskHash', 'task_hash',
  'decisionBit', 'decision_bit', 'should_approve', 'shouldApprove',
  'is_approve', 'approveDecision', 'approval', 'verdict', 'outcome', 'pass',
  'all_pass', 'allPass', 'checks_pass', 'checksPass',
  'isFirstUse', 'is_first_use', 'used', 'usedBefore', 'reuse', 'reused',
  'nonce', 'block', 'blockNumber', 'block_number',
  'currentBlockNumber', 'expiryBlockNumber',
  'vkRegistered', 'registeredVK', 'proofVK', 'vk_registered', 'vk_proof',
  'recipient_address', 'recipientAddress', 'condition_recipient_address',
  'amount_cap', 'amountCap', 'max_amount', 'maxAmount',
  'min_balance', 'minBalance', 'min_threshold_amount',
  'public_balance_value', 'balance_value',
  'registered', 'registered_vk_value', 'proof_vk_value',
  'decision_value', 'decisionValue', 'isApprove', 'is_approved',
  'expected_approve', 'expectedApprove', 'correct', 'correctDecision',
  'gate', 'gatekeeper', 'main', 'output', 'out0', 'signal0',
];

async function main() {
  const buf = fs.readFileSync('circuits/gatekeeper.wasm');
  const mod = await WebAssembly.compile(buf);
  const instance = await WebAssembly.instantiate(mod, {
    runtime: {
      exceptionHandler: () => {},
      printErrorMessage: () => {},
      writeBufferMessage: () => {},
      showSharedRWMemory: () => {},
    },
  });
  const ex = instance.exports;
  ex.init(0);
  console.log('getInputSize() =', ex.getInputSize());
  for (const name of candidates) {
    const h = fnvHash(name);
    const hMSB = parseInt(h.slice(0, 8), 16);
    const hLSB = parseInt(h.slice(8, 16), 16);
    let size;
    try {
      size = ex.getInputSignalSize(hMSB, hLSB);
    } catch (e) {
      size = 'ERR';
    }
    if (typeof size === 'number' && size >= 1) {
      console.log(`FOUND  ${name}  arity=${size}`);
    }
  }
  console.log('done');
}
main().catch((e) => { console.error(e); process.exit(1); });
