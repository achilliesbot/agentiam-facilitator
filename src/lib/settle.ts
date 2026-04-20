import { Contract, Wallet, JsonRpcProvider, Signature } from "ethers";
import {
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
  USDC_BASE,
} from "../types";
import { verifyPayment, VerifyDeps } from "./verify";

const USDC_ABI = [
  "function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)",
];

export interface SettleDeps extends VerifyDeps {
  signer: Wallet;
  claimNonce: (nonce: string, payer: string, expiresAtUnix: number) => Promise<boolean>;
  releaseNonce: (nonce: string) => Promise<void>;
  recordSettlement: (row: {
    tx_hash: string;
    payer: string;
    payee: string;
    amount: string;
    service_id?: string;
    resource_url?: string;
    block_number: number;
    gas_used: string;
  }) => Promise<void>;
  settlementTimeoutMs: number;
}

export async function settlePayment(
  payload: PaymentPayload,
  requirements: PaymentRequirements,
  deps: SettleDeps
): Promise<SettleResponse> {
  const v = await verifyPayment(payload, requirements, deps);
  if (!v.isValid)
    return {
      success: false,
      errorReason: "invalid_payment",
      network: "base",
      payer: v.payer,
    };

  const a = payload.payload.authorization;
  const claimed = await deps.claimNonce(a.nonce, a.from, Number(a.validBefore));
  if (!claimed)
    return {
      success: false,
      errorReason: "already_settled",
      network: "base",
      payer: a.from,
    };

  const usdc = new Contract(USDC_BASE, USDC_ABI, deps.signer);
  const sig = Signature.from(payload.payload.signature);

  try {
    const tx = await usdc.transferWithAuthorization(
      a.from,
      a.to,
      a.value,
      a.validAfter,
      a.validBefore,
      a.nonce,
      sig.v,
      sig.r,
      sig.s
    );
    const receipt = await Promise.race([
      tx.wait(1),
      new Promise<null>((_, rej) =>
        setTimeout(() => rej(new Error("timeout")), deps.settlementTimeoutMs)
      ),
    ]);
    if (!receipt || receipt.status !== 1) {
      await deps.releaseNonce(a.nonce);
      return {
        success: false,
        errorReason: "tx_reverted",
        transaction: tx.hash,
        network: "base",
        payer: a.from,
      };
    }
    await deps.recordSettlement({
      tx_hash: receipt.hash,
      payer: a.from,
      payee: a.to,
      amount: a.value,
      resource_url: requirements.resource,
      block_number: receipt.blockNumber,
      gas_used: receipt.gasUsed.toString(),
    });
    return { success: true, transaction: receipt.hash, network: "base", payer: a.from };
  } catch (err: any) {
    await deps.releaseNonce(a.nonce);
    return {
      success: false,
      errorReason: "rpc_error",
      network: "base",
      payer: a.from,
    };
  }
}
