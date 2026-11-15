# circuits/

Official gatekeeper circuit artifacts for zkVerify Agent Games Season 01,
downloaded 15/11/2026 from https://agentgames.zkverify.io/api/circuit-info:

| File | Size | SHA-256 (verify after download) |
|---|---|---|
| `gatekeeper.wasm` | 1,755,820 bytes (~1.68 MB) | (compute with `certutil -hashfile gatekeeper.wasm SHA256` on Windows) |
| `gatekeeper_final.zkey` | 309,750 bytes (~0.30 MB) | (same) |
| `gatekeeper_vk.json` | 5,117 bytes | exported with `snarkjs zkey export verificationkey` |

- Verification-key hash (zkVerify mainnet): `0x6b79c6012a6d8651f3e13bc4d2a20370280ab49700c90c5316d4168bfbad77b0`
- Circuit: Groth16 / BN254, Circom 2.2.3, 647 wires, 13 inputs, 13 public signals.
- The 13 circuit inputs (recovered by probing the wasm's FNV-hashed signal
  table): `decision`, `registeredVkHash`, `proofVkHash`, `publicBalance`,
  `minimum`, `amount`, `maxTransfer`, `recipient`, `conditionRecipient`,
  `expiryBlock`, `currentBlock`, `taskId`, `salt`.
  `salt` is a private input (not among the public signals); the other 12
  inputs are public, plus 1 circuit output (a commitment hash) = 13 public
  signals. Public-signal order (from a test proof): [0]=output commitment,
  [1]=registeredVkHash, [2]=proofVkHash, [3]=minimum, [4]=publicBalance,
  [5]=expiryBlock, [6]=currentBlock, [7]=recipient, [8]=conditionRecipient,
  [9]=amount, [10]=maxTransfer, [11]=decision, [12]=taskId.

## Commit or download?

**COMMIT these files to the GitHub repo.** Total ~2 MB — far below GitHub's
100 MB per-file limit and the 1 GB repo soft limit. Committing them means the
Windows PC gets everything with one `git clone`, no extra download step, and
the exact tested files are what runs in production. Do NOT commit `.env`
(the HMAC secret) or `state.json` (runtime state) — both are git-ignored.
