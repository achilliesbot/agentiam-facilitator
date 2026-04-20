# AgentIAM Facilitator — Technical Spec v1.1

```yaml
status: DRAFT
version: 1.1.0
spec_target: x402 v0.2 (exact/evm scheme)
owner:
  build: Atlas
  orchestration: Achilles
authority: Zeus greenlight 2026-04-20
audience: agents + engineers
network: base-mainnet
chain_id: 8453
asset: USDC (0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913)
host: achillesalpha.onrender.com
prefix: /facilitator
repo: achilliesbot/agentiam-facilitator
wallet_payee_default: "0x069c6012E053DFBf50390B19FaE275aD96D22ed7"
```

---

## 0. Agent-readable summary

```yaml
capability: x402_facilitator
schemes_supported: ["exact"]
networks_supported: ["base"]
assets_supported: ["0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"]
endpoints:
  - path: /facilitator/verify
    method: POST
    purpose: validate signed payment payload without settling
  - path: /facilitator/settle
    method: POST
    purpose: submit validated payment to chain and return tx hash
  - path: /facilitator/supported
    method: GET
    purpose: list schemes+networks this facilitator accepts
  - path: /facilitator/stats
    method: GET
    purpose: telemetry (public-safe metrics only)
auth: none (public facilitator)
fee_model: v1_free
rate_limits:
  verify: 100/min/ip
  settle: 60/min/ip
  supported: 600/min/ip
spec_compliance: x402-foundation/x402 @ v0.2
non_custodial: true
custody_of_funds: false
```

---

## 1. Mission

AgentIAM Facilitator is a custom x402-spec-compliant facilitator that serves as the **settlement + trust layer** for the Achilles service stack and selected third-party x402 services.

Two roles in one process:

1. **Facilitator** — verifies signed EIP-3009 payment authorizations and settles USDC on Base per x402 spec
2. **Trust layer** — records settlement telemetry, computes payee reputation, feeds Delphi/Ares analytics (v2)

This is the strategic wedge that Coinbase's neutral default facilitator cannot fill.

---

## 2. Scope

### 2.1 In-scope (v1)

- `POST /facilitator/verify`
- `POST /facilitator/settle`
- `GET /facilitator/supported`
- `GET /facilitator/stats`
- EVM `exact` scheme per `specs/schemes/exact/scheme_exact_evm.md`
- Base Mainnet, chain_id 8453, USDC only
- EIP-3009 `transferWithAuthorization`
- Nonce replay protection (Postgres-backed)
- Rate limiting (IP + payer)
- Sentinel alerting hooks

### 2.2 Out-of-scope (v1)

- SVM / Solana schemes
- Non-USDC assets (USDT, DAI, etc.)
- Fiat on/off ramps
- Custodial flows
- Facilitator-fee extraction from third parties
- Multi-network (Optimism, Arbitrum, Polygon come in v1.2)
- Gasless relayer metatransactions beyond EIP-3009

---

## 3. x402 protocol compliance

### 3.1 Spec reference

Pinned to: `github.com/x402-foundation/x402` @ `v0.2` (tag at build start)

Canonical docs:
- `docs.x402.org/core-concepts/facilitator`
- `specs/schemes/exact/scheme_exact_evm.md`
- `typescript/packages/x402-facilitator` (ref impl to fork)

### 3.2 Compliance matrix

| Requirement | Level | Implementation |
|---|---|---|
| /verify returns `{isValid, invalidReason?, payer?}` | MUST | yes |
| /settle returns `{success, transaction?, errorReason?, network, payer}` | MUST | yes |
| /supported returns `{kinds: [{scheme, network}]}` | MUST | yes |
| Non-custodial (no key holding) | MUST | yes — facilitator holds only gas-payer signer key |
| Replay protection (nonce reuse rejected) | MUST | yes — Postgres nonce table + 120s in-mem cache |
| Clock skew tolerance `validAfter`/`validBefore` | MUST | reject if `validBefore - now > 3600s` |
| Signature recovery per EIP-712 | MUST | ethers.js verifyTypedData |
| Settlement idempotency (same payload → same tx or reject) | MUST | SettlementCache + DB uniqueness on tx_hash |
| Rate limiting | SHOULD | express-rate-limit |
| Telemetry | MAY (we do) | Postgres + Scribe |

---

## 4. Data structures

### 4.1 `PaymentRequirements` (from resource server, per x402 spec)

```ts
interface PaymentRequirements {
  scheme: "exact";
  network: "base";
  maxAmountRequired: string;        // atomic units, e.g. "10000" = 0.01 USDC
  resource: string;                 // full URL of protected resource
  description: string;
  mimeType: string;
  outputSchema?: object;
  payTo: string;                    // EVM address, checksummed
  maxTimeoutSeconds: number;        // default 60
  asset: string;                    // USDC contract address
  extra?: {
    name: string;                   // EIP-712 domain name ("USD Coin")
    version: string;                // EIP-712 domain version ("2")
  };
}
```

### 4.2 `PaymentPayload` (from client agent)

```ts
interface PaymentPayload {
  x402Version: 1;
  scheme: "exact";
  network: "base";
  payload: {
    signature: string;              // 0x... 65-byte sig
    authorization: {
      from: string;                 // payer EVM address
      to: string;                   // must equal PaymentRequirements.payTo
      value: string;                // atomic units, ≤ maxAmountRequired
      validAfter: string;           // unix seconds
      validBefore: string;          // unix seconds
      nonce: string;                // 0x + 32 bytes hex
    };
  };
}
```

### 4.3 Facilitator responses

```ts
type VerifyResponse =
  | { isValid: true; payer: string }
  | { isValid: false; invalidReason: InvalidReason; payer?: string };

type InvalidReason =
  | "insufficient_funds"
  | "invalid_scheme"
  | "invalid_network"
  | "invalid_asset"
  | "invalid_signature"
  | "expired"
  | "not_yet_valid"
  | "amount_too_low"
  | "amount_too_high"
  | "payee_mismatch"
  | "nonce_reused"
  | "invalid_payload";

type SettleResponse =
  | {
      success: true;
      transaction: string;          // 0x tx hash
      network: "base";
      payer: string;
    }
  | {
      success: false;
      errorReason: SettleError;
      transaction?: string;         // set if submitted but failed
      network: "base";
      payer?: string;
    };

type SettleError =
  | "invalid_payment"               // verify failed
  | "already_settled"               // dedupe hit
  | "rpc_error"
  | "tx_reverted"
  | "gas_estimation_failed"
  | "internal_error";
```

### 4.4 EIP-712 typed data for signature recovery

```ts
const domain = {
  name: "USD Coin",
  version: "2",
  chainId: 8453,
  verifyingContract: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
};

const types = {
  TransferWithAuthorization: [
    { name: "from",        type: "address" },
    { name: "to",          type: "address" },
    { name: "value",       type: "uint256" },
    { name: "validAfter",  type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce",       type: "bytes32" }
  ]
};
```

---

## 5. Endpoint contracts

### 5.1 `POST /facilitator/verify`

**Request**
```http
POST /facilitator/verify HTTP/1.1
Host: achillesalpha.onrender.com
Content-Type: application/json

{
  "paymentPayload": { ...PaymentPayload... },
  "paymentRequirements": { ...PaymentRequirements... }
}
```

**Response (200)**
```json
{ "isValid": true, "payer": "0xabc..." }
```

**Response (200, invalid — note: x402 returns 200 with isValid:false)**
```json
{ "isValid": false, "invalidReason": "expired", "payer": "0xabc..." }
```

**Response (400 — malformed request)**
```json
{ "error": "malformed_payload", "detail": "..." }
```

### 5.2 `POST /facilitator/settle`

**Request** — same shape as `/verify`.

**Response (200, success)**
```json
{
  "success": true,
  "transaction": "0x7e3f...",
  "network": "base",
  "payer": "0xabc..."
}
```

**Response (200, failure)**
```json
{
  "success": false,
  "errorReason": "already_settled",
  "transaction": "0x7e3f...",
  "network": "base",
  "payer": "0xabc..."
}
```

### 5.3 `GET /facilitator/supported`

**Response (200)**
```json
{
  "kinds": [
    { "scheme": "exact", "network": "base" }
  ]
}
```

### 5.4 `GET /facilitator/stats`

Public-safe aggregates only (no per-payer leakage).

**Response (200)**
```json
{
  "total_settled_tx": 1247,
  "total_settled_usdc": "31.27",
  "services_using_facilitator": 8,
  "last_settlement_at": "2026-05-10T14:23:07Z",
  "uptime_24h": 0.9998
}
```

---

## 6. Verify pipeline (deterministic)

```
INPUT: (paymentPayload P, paymentRequirements R)

1. SCHEMA_VALIDATE(P, R)
   fail → 400 "malformed_payload"

2. IF P.scheme ≠ "exact" → return { isValid:false, invalidReason:"invalid_scheme" }
3. IF P.network ≠ "base" → return { isValid:false, invalidReason:"invalid_network" }
4. IF R.asset ≠ USDC_BASE → return { isValid:false, invalidReason:"invalid_asset" }

5. A = P.payload.authorization
6. IF A.to ≠ R.payTo → return { isValid:false, invalidReason:"payee_mismatch" }

7. now = unix_seconds()
8. IF now < int(A.validAfter) → return { isValid:false, invalidReason:"not_yet_valid" }
9. IF now ≥ int(A.validBefore) → return { isValid:false, invalidReason:"expired" }
10. IF int(A.validBefore) - now > 3600 → return { isValid:false, invalidReason:"invalid_payload" }  # clock skew guard

11. IF int(A.value) > int(R.maxAmountRequired) → return { isValid:false, invalidReason:"amount_too_high" }
12. IF int(A.value) < MIN_AMOUNT (1 atomic unit) → return { isValid:false, invalidReason:"amount_too_low" }

13. recovered = ecrecover_eip712(domain, types, A, P.payload.signature)
14. IF recovered ≠ A.from → return { isValid:false, invalidReason:"invalid_signature" }

15. IF nonce_exists(A.nonce) → return { isValid:false, invalidReason:"nonce_reused", payer:A.from }

16. balance = usdc.balanceOf(A.from) via Base RPC
17. IF balance < int(A.value) → return { isValid:false, invalidReason:"insufficient_funds", payer:A.from }

18. return { isValid:true, payer:A.from }
```

**Determinism note:** verify does not mutate state. Nonce is not consumed until settle succeeds.

---

## 7. Settle pipeline

```
INPUT: (paymentPayload P, paymentRequirements R)

1. verify_result = VERIFY(P, R)
   IF !verify_result.isValid → return { success:false, errorReason:"invalid_payment", ... }

2. A = P.payload.authorization

3. BEGIN TX (Postgres)
     IF nonce_exists(A.nonce) → COMMIT, return { success:false, errorReason:"already_settled" }
     INSERT nonce INTO facilitator_nonces (nonce, expires_at = validBefore)
   COMMIT

4. Try:
     tx = usdc.transferWithAuthorization(
       A.from, A.to, A.value,
       A.validAfter, A.validBefore, A.nonce,
       split_signature(P.payload.signature)
     )
     receipt = wait_for_confirmations(tx.hash, 1, timeout=30s)

5. IF receipt.status ≠ 1:
     DELETE nonce FROM facilitator_nonces WHERE nonce = A.nonce  # allow retry
     return { success:false, errorReason:"tx_reverted", transaction:tx.hash, payer:A.from }

6. INSERT INTO facilitator_settlements (
     tx_hash, payer, payee, amount_usdc, service_id, network, scheme, settled_at
   )

7. emit_scribe_event("facilitator.settled", { tx_hash, payer, payee, amount, service_id })

8. return { success:true, transaction:tx.hash, network:"base", payer:A.from }
```

**Gas payer:** the facilitator signer account. Funded with a small ETH buffer on Base (target: 0.01 ETH, alert below 0.003). Gas cost ~$0.0005/tx on Base → negligible at v1 volume.

---

## 8. Sequence diagram (text)

```
Client Agent (CA)    Resource Server (RS)    AgentIAM Facilitator (F)    Base RPC (B)
     |                       |                         |                         |
     |---- GET /resource --->|                         |                         |
     |<-- 402 + Requirements-|                         |                         |
     |                       |                         |                         |
     | sign EIP-712 auth                              |                         |
     |                       |                         |                         |
     |-GET /resource w/ X-PAYMENT------>|              |                         |
     |                       |--POST /facilitator/verify------>|                |
     |                       |                         |--balanceOf-->|         |
     |                       |                         |<-------------|         |
     |                       |<-------- {isValid:true} -|                         |
     |                       |                         |                         |
     |<-- 200 + resource ----|                         |                         |
     |                       |--POST /facilitator/settle----->|                 |
     |                       |                         |--transferWithAuth-->|  |
     |                       |                         |<-- tx hash ---------|  |
     |                       |                         |--wait 1 conf----->|    |
     |                       |                         |<------------------|    |
     |                       |<-- {success, tx} -------|                         |
```

---

## 9. Database schema

```sql
-- settlements ledger
CREATE TABLE IF NOT EXISTS facilitator_settlements (
  id              BIGSERIAL PRIMARY KEY,
  tx_hash         TEXT        UNIQUE NOT NULL,
  payer           TEXT        NOT NULL,
  payee           TEXT        NOT NULL,
  amount_usdc     NUMERIC(78,0) NOT NULL,   -- atomic units
  amount_usdc_h   NUMERIC(20,6) NOT NULL,   -- human-readable
  service_id      TEXT,
  resource_url    TEXT,
  network         TEXT        NOT NULL DEFAULT 'base',
  scheme          TEXT        NOT NULL DEFAULT 'exact',
  settled_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  block_number    BIGINT,
  gas_used        BIGINT
);
CREATE INDEX idx_fs_payer   ON facilitator_settlements(payer);
CREATE INDEX idx_fs_payee   ON facilitator_settlements(payee);
CREATE INDEX idx_fs_service ON facilitator_settlements(service_id);
CREATE INDEX idx_fs_time    ON facilitator_settlements(settled_at DESC);

-- nonce replay guard
CREATE TABLE IF NOT EXISTS facilitator_nonces (
  nonce       TEXT        PRIMARY KEY,
  payer       TEXT        NOT NULL,
  inserted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at  TIMESTAMPTZ NOT NULL
);
CREATE INDEX idx_fn_expires ON facilitator_nonces(expires_at);

-- sweeper: DELETE FROM facilitator_nonces WHERE expires_at < NOW() - INTERVAL '1 hour';

-- rate limits (fallback if Redis unavailable)
CREATE TABLE IF NOT EXISTS facilitator_rate_log (
  ip          INET        NOT NULL,
  endpoint    TEXT        NOT NULL,
  ts          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_frl ON facilitator_rate_log(ip, endpoint, ts);

-- payee reputation (v2 foundation, start capturing now)
CREATE TABLE IF NOT EXISTS facilitator_payee_reputation (
  payee           TEXT PRIMARY KEY,
  total_settled   NUMERIC(78,0) NOT NULL DEFAULT 0,
  tx_count        BIGINT NOT NULL DEFAULT 0,
  first_seen_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_settled_at TIMESTAMPTZ,
  dispute_count   INT NOT NULL DEFAULT 0
);
```

---

## 10. Configuration

```yaml
env:
  NODE_ENV: production
  BASE_RPC_URL: https://base-mainnet.g.alchemy.com/v2/<key>  # from APIS.md
  USDC_CONTRACT: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
  CHAIN_ID: 8453
  FACILITATOR_SIGNER_PRIVATE_KEY: <env only, never logged>     # separate from canonical wallet; gas only
  POSTGRES_URL: postgres://postgres@localhost/achilles_db
  CANONICAL_WALLET: "0x069c6012E053DFBf50390B19FaE275aD96D22ed7"
  RATE_LIMIT_VERIFY: 100
  RATE_LIMIT_SETTLE: 60
  CLOCK_SKEW_MAX_SECONDS: 3600
  SETTLEMENT_TIMEOUT_MS: 30000
  MIN_ETH_GAS_BALANCE: "0.003"
  ALERT_WEBHOOK_TELEGRAM: <chat_id 508434678>
```

**Key separation:** facilitator signer is a **new** EOA, funded only with gas ETH. It is **never** a payee. It is **not** the canonical wallet. If it's compromised, only gas funds are at risk.

---

## 11. Integration — agent-to-agent usage

### 11.1 For a resource server using our facilitator

```ts
import { verify, settle } from "agentiam-facilitator-client";

app.get("/premium", async (req, res) => {
  const paymentHeader = req.header("X-PAYMENT");
  const requirements = {
    scheme: "exact",
    network: "base",
    maxAmountRequired: "10000",        // 0.01 USDC
    resource: "https://example.com/premium",
    payTo: "0xYourWallet",
    asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    maxTimeoutSeconds: 60,
    extra: { name: "USD Coin", version: "2" }
  };

  if (!paymentHeader) {
    return res.status(402).json({ x402Version: 1, accepts: [requirements] });
  }

  const payload = JSON.parse(Buffer.from(paymentHeader, "base64").toString());
  const v = await verify(payload, requirements, { facilitator: "https://achillesalpha.onrender.com/facilitator" });
  if (!v.isValid) return res.status(402).json({ error: v.invalidReason });

  // serve resource
  res.json({ data: "..." });

  // async settle (don't block client)
  settle(payload, requirements, { facilitator: "https://achillesalpha.onrender.com/facilitator" })
    .catch(err => alert_sentinel(err));
});
```

### 11.2 For a client agent paying for a resource

```ts
const res1 = await fetch(url);
if (res1.status === 402) {
  const { accepts } = await res1.json();
  const req = accepts[0];
  const auth = await signEIP712TransferAuth({
    from: myAddr,
    to: req.payTo,
    value: req.maxAmountRequired,
    validAfter: 0,
    validBefore: Math.floor(Date.now()/1000) + req.maxTimeoutSeconds,
    nonce: randomBytes32(),
  });
  const payload = { x402Version:1, scheme:"exact", network:"base", payload: { signature: auth.sig, authorization: auth.msg } };
  const res2 = await fetch(url, { headers: { "X-PAYMENT": base64(JSON.stringify(payload)) } });
  return res2.json();
}
```

### 11.3 Discovery

Agents locate our facilitator via:
- `/.well-known/x402.json` on achillesalpha.onrender.com (v1.1 — serve manifest)
- agentic.market listing (submitted post-launch)
- 402index registration update

---

## 12. Observability

### 12.1 Structured logs (all endpoints)

```json
{
  "ts": "2026-05-10T14:23:07.123Z",
  "level": "info",
  "event": "facilitator.verify",
  "request_id": "uuid",
  "ip": "1.2.3.4",
  "payer": "0xabc",
  "payee": "0xdef",
  "amount": "10000",
  "network": "base",
  "scheme": "exact",
  "result": "valid",
  "latency_ms": 142
}
```

### 12.2 Metrics (exposed at /facilitator/metrics, internal)

- `facilitator_verify_total{result}`
- `facilitator_settle_total{result}`
- `facilitator_settle_latency_ms` (histogram)
- `facilitator_active_services` (gauge)
- `facilitator_gas_balance_eth` (gauge)
- `facilitator_rpc_errors_total`

### 12.3 Scribe events

Emitted to `signals` table via Scribe:
- `facilitator.settled` (every success)
- `facilitator.verify_failed` (suspicious repeat failures)
- `facilitator.rpc_degraded`
- `facilitator.gas_low`

### 12.4 Sentinel alerts (→ Telegram Zeus)

- Gas balance < 0.003 ETH
- Non-USDC asset attempt (any)
- Non-Base network attempt (any)
- > 10 consecutive verify failures from one IP
- RPC error rate > 5% over 5 min
- Settlement latency p99 > 10s over 5 min

---

## 13. Security

| Threat | Mitigation |
|---|---|
| Replay attack (same nonce) | Postgres nonce uniqueness + 120s in-mem cache |
| Signature forgery | EIP-712 recover, compare to `from` |
| Payee redirection | Enforce `A.to == R.payTo` |
| Amount inflation | Enforce `A.value ≤ R.maxAmountRequired` |
| Clock skew exploit | Reject `validBefore - now > 3600s` |
| Facilitator key leak | Signer EOA holds gas ETH only, separate from canonical wallet |
| RPC MITM | Alchemy over TLS, RPC URL in env only |
| Credential logging | Payload sig redacted in logs (log hash only) |
| DoS | Rate limits + Cloudflare in front of achillesalpha |
| Duplicate settle | DB nonce + tx_hash uniqueness |
| Postgres down | Fail closed — return `internal_error`, don't settle |
| Race condition on nonce | Single transaction `INSERT` with PK conflict → already_settled |

---

## 14. Failure modes

| Failure | Behavior | Recovery |
|---|---|---|
| RPC timeout on balanceOf | verify returns `invalid_payload` with log | retry via client |
| RPC timeout on settle submission | return `rpc_error`, delete nonce | client retries, new tx |
| Tx submitted but no receipt in 30s | return `rpc_error` WITH tx hash, keep nonce | operator reconciles via hash |
| Tx reverted on-chain | return `tx_reverted`, delete nonce | client retries |
| Postgres down | fail closed, 503 | Scribe alert, Atlas triages |
| Gas balance exhausted | Sentinel alerts Zeus, /settle returns `rpc_error` | top up signer EOA |

---

## 15. Build plan

**Day 1 (setup + fork)**
- [ ] Create repo `achilliesbot/agentiam-facilitator`
- [ ] Fork x402-foundation TS facilitator ref impl at v0.2 tag
- [ ] Strip SVM + non-USDC paths
- [ ] Wire Base Mainnet Alchemy RPC + USDC contract ABI
- [ ] Generate facilitator signer EOA, fund with 0.01 ETH on Base
- [ ] Deploy `/facilitator/*` route to achillesalpha staging

**Day 2 (DB + migrate EP)**
- [ ] Run schema migration on achilles_db
- [ ] Nonce sweeper cron (hourly DELETE expired)
- [ ] Migrate 5 EP services (NoLeak, MemGuard, RiskOracle, SecureExec, FlowCore) to use our facilitator
- [ ] End-to-end test with real Base USDC against canonical wallet

**Day 3 (observability + publish)**
- [ ] Structured logging + metrics endpoint
- [ ] Scribe event emission wired
- [ ] Sentinel alerts wired
- [ ] Publish `/.well-known/x402.json` manifest
- [ ] README + integration example in repo

**Day 4 (distribution)**
- [ ] Update 402index registration
- [ ] Submit to agentic.market as facilitator
- [ ] Announce from @AchillesAlphaAI
- [ ] Direct outreach to 3 ACP agents with facilitator offer

**Day 5 (harden + v2 groundwork)**
- [ ] Load test (1k verify/min, 500 settle/min)
- [ ] Payee reputation table starts capturing
- [ ] Write AgentIAM Pro pricing doc

---

## 16. Acceptance criteria (v1 GA)

- [ ] `/facilitator/supported` returns spec-compliant JSON
- [ ] `/facilitator/verify` correctly validates a real EIP-3009 signature against USDC Base
- [ ] `/facilitator/settle` successfully executes `transferWithAuthorization` on Base Mainnet and returns tx hash
- [ ] 5 EP services route through our facilitator, zero fallback to Coinbase default
- [ ] All 12 sample failures from spec test vectors return correct `invalidReason`
- [ ] Replay attack rejected on 2nd attempt with same nonce
- [ ] Load test passes: 1k verify/min p95 < 500ms, 500 settle/min p95 < 4s
- [ ] Sentinel gas-low alert fires correctly in staging
- [ ] Manifest published at `/.well-known/x402.json`
- [ ] Repo public, license Apache-2.0, README with integration snippet

---

## 17. 30-day success metrics

| Metric | Target |
|---|---|
| Total settled tx through facilitator | 500+/day by day 30 |
| External services pointing at facilitator | 10+ |
| p95 settlement latency | < 3s |
| Uptime | ≥ 99.9% |
| Gas spend | < $10 total |
| First AgentIAM Pro customer | by day 21 |
| agentic.market listing | by day 7 |
| Pro tier MRR | ≥ $100 by day 30 |

---

## 18. v2 roadmap (for planning, not v1 build)

- Multi-network: Optimism, Arbitrum, Polygon
- AgentIAM Pro: premium tier bundling reputation + risk oracle
- Gasless meta-tx relayer variants
- Facilitator fee (1-3 bps opt-in premium routing)
- Payee reputation API (public `/facilitator/reputation/:addr`)
- Dispute resolution workflow
- Federation with other non-Coinbase facilitators

---

## 19. Open questions (for Zeus)

1. **Signer EOA funding** — do we top from canonical wallet or a separate treasury tap? Recommend: manual top-up from canonical, low-frequency (monthly), keep flows clean.
2. **Open-source license** — Apache-2.0 default. MIT acceptable. Confirm before publish.
3. **Pro tier pricing anchor** — propose $49/mo for AgentIAM Pro v2. Need Zeus signoff before marketing.
4. **Announce timing** — do we tweet day 4 (post-staging) or day 7 (post-load-test)? Recommend day 7.

---

## 20. Kickoff

Atlas begins Day 1 now. Scribe logs milestones. Achilles reports end-of-day to Zeus via Telegram. Any blocking issue → immediate escalation.
