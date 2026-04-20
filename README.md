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

## License

Apache-2.0
