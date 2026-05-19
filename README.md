# AgentIAM Facilitator

x402-compliant facilitator for Base Mainnet USDC settlement. Non-custodial. Part of the Achilles / Project Olympus stack.

**Live:** `https://achillesalpha.onrender.com/facilitator`

## Endpoints

- `POST /facilitator/verify` — validate signed EIP-3009 payload
- `POST /facilitator/settle` — submit `transferWithAuthorization` to Base
- `GET  /facilitator/supported` — list schemes+networks (`exact`/`base`)
- `GET  /facilitator/stats` — public telemetry
- `GET  /.well-known/x402.json` — discovery manifest

## Spec

Full technical spec: [docs/SPEC.md](docs/SPEC.md)

## Run locally

```bash
cp .env.example .env
# fill in BASE_RPC_URL, POSTGRES_URL
npm run genkey       # generate facilitator signer, paste privkey into .env, fund the address with gas ETH on Base
npm install
npm run dev
```

## See also

- [agentiam-recipes](https://github.com/achilliesbot/agentiam-recipes) — integration guides for the 18 AgentIAM x402 endpoints settled by this facilitator
- [x402-paywall](https://github.com/achilliesbot/x402-paywall) — drop-in React kit for gating any site behind USDC-on-Base micropayments
- Endpoint catalog: [achillesalpha.com/.well-known/x402](https://achillesalpha.com/.well-known/x402)

## License

Apache-2.0
