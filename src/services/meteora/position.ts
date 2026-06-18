import DLMM from '@meteora-ag/dlmm';
import { Keypair, PublicKey, sendAndConfirmTransaction, Transaction } from '@solana/web3.js';
import BN from 'bn.js';
import { getConnection } from '../../core/connection';
import { config } from '../../config';
import { notifier } from '../telegram/notifier';

export type LbPosition = Awaited<ReturnType<DLMM['getPosition']>>;

export async function getUserPositions(dlmm: DLMM, wallet: Keypair): Promise<LbPosition[]> {
  const { userPositions } = await dlmm.getPositionsByUserAndLbPair(wallet.publicKey);
  return userPositions as LbPosition[];
}

export async function openPosition(
  dlmm: DLMM,
  wallet: Keypair,
  activeBinId: number,
  totalXAmount: BN,
  totalYAmount: BN,
): Promise<PublicKey> {
  const { StrategyType } = await import('@meteora-ag/dlmm');
  const connection = getConnection();
  const newPositionKeypair = Keypair.generate();

  const minBinId = activeBinId - config.binRange;
  const maxBinId = activeBinId + config.binRange;

  const strategyType = StrategyType[config.strategy as keyof typeof StrategyType];

  const createPositionTx = await dlmm.initializePositionAndAddLiquidityByStrategy({
    positionPubKey: newPositionKeypair.publicKey,
    user: wallet.publicKey,
    totalXAmount,
    totalYAmount,
    strategy: {
      maxBinId,
      minBinId,
      strategyType,
    },
    slippage: config.slippageBps / 10000,
  });

  const txId = await sendAndConfirmTransaction(
    connection,
    createPositionTx as Transaction,
    [wallet, newPositionKeypair],
    { skipPreflight: false },
  );

  console.log(`[Position] Dibuka — tx: ${txId}`);
  console.log(`[Position] Range: ${minBinId} → ${maxBinId}, active: ${activeBinId}`);

  await notifier.positionOpened(config.poolAddress, minBinId, maxBinId, activeBinId);

  return newPositionKeypair.publicKey;
}

export async function closePosition(
  dlmm: DLMM,
  wallet: Keypair,
  position: LbPosition,
): Promise<void> {
  const connection = getConnection();
  const { lowerBinId, upperBinId } = position.positionData;

  const removeTxs = await dlmm.removeLiquidity({
    position: position.publicKey,
    user: wallet.publicKey,
    fromBinId: lowerBinId,
    toBinId: upperBinId,
    bps: new BN(10000),
    shouldClaimAndClose: true,
  });

  for (const tx of removeTxs) {
    const txId = await sendAndConfirmTransaction(connection, tx as Transaction, [wallet], {
      skipPreflight: false,
    });
    console.log(`[Position] Ditutup — tx: ${txId}`);
  }
}
