import express from "express";
import rateLimit from "express-rate-limit";
import { JsonRpcProvider, Wallet } from "ethers";
import pino from "pino";
import { z } from "zod";
import { PaymentPayload, PaymentRequirements, SupportedResponse } from "./types";
import { verifyPayment } from "./lib/verify";
import { settlePayment } from "./lib/settle";
import {
  makePool,
  migrate,
  nonceExists,
  claimNonce,
  releaseNonce,
  recordSettlement,
  stats,
} from "./db/pg";

const log = pino({ level: process.env.LOG_LEVEL ?? "info" });

const env = {
  PORT: Number(process.env.PORT ?? 8080),
  BASE_RPC_URL: process.env.BASE_RPC_URL!,
  POSTGRES_URL: process.env.POSTGRES_URL!,
  FACILITATOR_SIGNER_PRIVATE_KEY: process.env.FACILITATOR_SIGNER_PRIVATE_KEY!,
  RATE_LIMIT_VERIFY: Number(process.env.RATE_LIMIT_VERIFY ?? 100),
  RATE_LIMIT_SETTLE: Number(process.env.RATE_LIMIT_SETTLE ?? 60),
  CLOCK_SKEW_MAX_SECONDS: Number(process.env.CLOCK_SKEW_MAX_SECONDS ?? 3600),
  SETTLEMENT_TIMEOUT_MS: Number(process.env.SETTLEMENT_TIMEOUT_MS ?? 30000),
};

for (const k of ["BASE_RPC_URL", "POSTGRES_URL", "FACILITATOR_SIGNER_PRIVATE_KEY"] as const) {
  if (!env[k]) throw new Error(`missing env: ${k}`);
}

const provider = new JsonRpcProvider(env.BASE_RPC_URL);
const signer = new Wallet(env.FACILITATOR_SIGNER_PRIVATE_KEY, provider);
const pool = makePool(env.POSTGRES_URL);

const authSchema = z.object({
  from: z.string(),
  to: z.string(),
  value: z.string(),
  validAfter: z.string(),
  validBefore: z.string(),
  nonce: z.string(),
});

const payloadSchema = z.object({
  x402Version: z.literal(1),
  scheme: z.literal("exact"),
  network: z.literal("base"),
  payload: z.object({
    signature: z.string(),
    authorization: authSchema,
  }),
});

const requirementsSchema = z.object({
  scheme: z.literal("exact"),
  network: z.literal("base"),
  maxAmountRequired: z.string(),
  resource: z.string(),
  description: z.string().optional(),
  mimeType: z.string().optional(),
  outputSchema: z.any().optional(),
  payTo: z.string(),
  maxTimeoutSeconds: z.number(),
  asset: z.string(),
  extra: z.object({ name: z.string(), version: z.string() }).optional(),
});

const bodySchema = z.object({
  paymentPayload: payloadSchema,
  paymentRequirements: requirementsSchema,
});

const app = express();
app.use(express.json({ limit: "32kb" }));
app.set("trust proxy", 1);

const deps = {
  provider,
  nonceExists: (n: string) => nonceExists(pool, n),
  clockSkewMaxSeconds: env.CLOCK_SKEW_MAX_SECONDS,
  minAmount: 1n,
  signer,
  claimNonce: (n: string, p: string, e: number) => claimNonce(pool, n, p, e),
  releaseNonce: (n: string) => releaseNonce(pool, n),
  recordSettlement: (r: any) => recordSettlement(pool, r),
  settlementTimeoutMs: env.SETTLEMENT_TIMEOUT_MS,
};

app.get("/facilitator/supported", (_req, res) => {
  const r: SupportedResponse = { kinds: [{ scheme: "exact", network: "base" }] };
  res.json(r);
});

app.post(
  "/facilitator/verify",
  rateLimit({ windowMs: 60_000, max: env.RATE_LIMIT_VERIFY }),
  async (req, res) => {
    const parsed = bodySchema.safeParse(req.body);
    if (!parsed.success)
      return res.status(400).json({ error: "malformed_payload", detail: parsed.error.issues });
    const { paymentPayload, paymentRequirements } = parsed.data as {
      paymentPayload: PaymentPayload;
      paymentRequirements: PaymentRequirements;
    };
    const result = await verifyPayment(paymentPayload, paymentRequirements, deps);
    log.info({ event: "verify", result, payer: paymentPayload.payload.authorization.from });
    res.json(result);
  }
);

app.post(
  "/facilitator/settle",
  rateLimit({ windowMs: 60_000, max: env.RATE_LIMIT_SETTLE }),
  async (req, res) => {
    const parsed = bodySchema.safeParse(req.body);
    if (!parsed.success)
      return res.status(400).json({ error: "malformed_payload", detail: parsed.error.issues });
    const { paymentPayload, paymentRequirements } = parsed.data as {
      paymentPayload: PaymentPayload;
      paymentRequirements: PaymentRequirements;
    };
    const result = await settlePayment(paymentPayload, paymentRequirements, deps);
    log.info({ event: "settle", result, payer: paymentPayload.payload.authorization.from });
    res.json(result);
  }
);

app.get("/facilitator/stats", async (_req, res) => {
  try {
    res.json(await stats(pool));
  } catch (err: any) {
    res.status(503).json({ error: "db_unavailable" });
  }
});

app.get("/.well-known/x402.json", (_req, res) => {
  res.json({
    x402Version: 1,
    facilitator: {
      name: "AgentIAM Facilitator",
      url: "https://achillesalpha.onrender.com/facilitator",
      operator: "Achilles / Project Olympus",
      supported: [{ scheme: "exact", network: "base" }],
      docs: "https://github.com/achilliesbot/agentiam-facilitator",
    },
  });
});

app.get("/health", (_req, res) => res.json({ ok: true }));

(async () => {
  await migrate(pool);
  app.listen(env.PORT, () => log.info({ port: env.PORT, signer: signer.address }, "facilitator up"));
})();
