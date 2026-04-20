import { Wallet } from "ethers";

const w = Wallet.createRandom();
console.log(JSON.stringify({
  address: w.address,
  privateKey: w.privateKey,
  note: "Set privateKey as FACILITATOR_SIGNER_PRIVATE_KEY in .env. Fund address with small ETH on Base Mainnet for gas only. NEVER use this address as a payee."
}, null, 2));
