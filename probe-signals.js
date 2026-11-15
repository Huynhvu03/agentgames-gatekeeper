// Probe: which signal names exist in gatekeeper.wasm?
// Circom 2 wasm identifies input signals by FNV-1a 64-bit hash of the name.
// getInputSignalSize(hMSB, hLSB) returns >= 0 if the signal exists (value = arity), < 0 otherwise.
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
  // decision
  'decision', 'approve', 'approved', 'out', 'result',
  // envelope fields snake_case
  'registered_vk', 'proof_vk', 'minimum', 'public_balance', 'expiry_block',
  'current_block', 'recipient', 'condition_recipient', 'amount', 'max_transfer', 'proof_tx',
  // envelope fields camelCase
  'registeredVk', 'proofVk', 'publicBalance', 'expiryBlock', 'currentBlock',
  'conditionRecipient', 'maxTransfer', 'proofTx',
  // other plausible names
  'task_id', 'taskId', 'mode', 'vk', 'vk_hash', 'vkHash',
  'registered_vk_hash', 'proof_vk_hash', 'min_threshold', 'minThreshold',
  'threshold', 'balance', 'expiry', 'deadline', 'nonce', 'agent_id', 'agentId',
  'expected_decision', 'expectedDecision', 'is_valid', 'isValid', 'valid',
  'registeredVkHash', 'proofVkHash', 'condition_vk', 'conditionVk',
  'registered_vk_lo', 'registered_vk_hi', 'proof_vk_lo', 'proof_vk_hi',
  'vk_lo', 'vk_hi', 'recipient_hash', 'recipientHash',
  'public_balance_bits', 'amount_bits',
  // circom main-component style
  'in', 'input', 'decision_bit', 'approve_bit',
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
  console.log('getWitnessSize() =', ex.getWitnessSize());
  console.log('circom version =', ex.getVersion() + '.' + ex.getMinorVersion() + '.' + ex.getPatchVersion());
  console.log('--- probe ---');
  const found = [];
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
    if (typeof size === 'number' && size >= 0) {
      console.log(`FOUND  ${name}  arity=${size}`);
      found.push([name, size]);
    }
  }
  console.log('--- summary ---');
  console.log('found', found.length, 'of', candidates.length, 'candidates');
  console.log('total input signals (getInputSize):', ex.getInputSize());
}
main().catch((e) => { console.error(e); process.exit(1); });
