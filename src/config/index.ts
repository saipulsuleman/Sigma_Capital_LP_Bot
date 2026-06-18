import dotenv from 'dotenv';
import { StrategyType } from '@meteora-ag/dlmm';

dotenv.config();

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`Missing required env var: ${key}`);
  return value;
}

export const config = {
  rpcEndpoint: requireEnv('RPC_ENDPOINT'),
  walletPrivateKey: requireEnv('WALLET_PRIVATE_KEY'),
  poolAddress: requireEnv('POOL_ADDRESS'),

  strategy: (process.env.STRATEGY_TYPE ?? 'Spot') as keyof typeof StrategyType,
  binRange: parseInt(process.env.BIN_RANGE ?? '10', 10),

  rebalanceCheckIntervalMs: parseInt(process.env.REBALANCE_CHECK_INTERVAL_MS ?? '30000', 10),
  rebalanceThresholdBins: parseInt(process.env.REBALANCE_THRESHOLD_BINS ?? '1', 10),

  feeClaimIntervalMs: parseInt(process.env.FEE_CLAIM_INTERVAL_MS ?? '3600000', 10),
  feeClaimThresholdUsd: parseFloat(process.env.FEE_CLAIM_THRESHOLD_USD ?? '1.0'),

  telegram: {
    botToken: requireEnv('TELEGRAM_BOT_TOKEN'),
    chatId: requireEnv('TELEGRAM_CHAT_ID'),
  },

  slippageBps: parseInt(process.env.SLIPPAGE_BPS ?? '100', 10),

  depositAmountX: process.env.DEPOSIT_AMOUNT_X ? BigInt(process.env.DEPOSIT_AMOUNT_X) : undefined,
  depositAmountY: process.env.DEPOSIT_AMOUNT_Y ? BigInt(process.env.DEPOSIT_AMOUNT_Y) : undefined,
};
