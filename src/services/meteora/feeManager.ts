import DLMM from '@meteora-ag/dlmm';
import { Keypair, sendAndConfirmTransaction, Transaction } from '@solana/web3.js';
import BN from 'bn.js';
import { getConnection } from '../../core/connection';
import { notifier } from '../telegram/notifier';
import { getUserPositions, LbPosition } from './position';

function formatAmount(amount: BN, decimals = 6): string {
  return (amount.toNumber() / Math.pow(10, decimals)).toFixed(4);
}

export async function claimAllFees(dlmm: DLMM, wallet: Keypair): Promise<boolean> {
  const connection = getConnection();
  const positions = await getUserPositions(dlmm, wallet);

  if (positions.length === 0) {
    console.log('[Fee] Tidak ada posisi aktif untuk diklaim');
    return false;
  }

  let anyClaimed = false;

  for (const position of positions) {
    const feeX = position.positionData.feeX;
    const feeY = position.positionData.feeY;
    const totalFee = feeX.add(feeY);

    if (totalFee.isZero()) {
      console.log(`[Fee] Posisi ${position.publicKey.toBase58().slice(0, 8)}... fee = 0, skip`);
      continue;
    }

    try {
      const claimTxs = await dlmm.claimSwapFee({
        owner: wallet.publicKey,
        position: position as any,
      });

      for (const tx of claimTxs) {
        const txId = await sendAndConfirmTransaction(connection, tx as Transaction, [wallet], {
          skipPreflight: false,
        });

        const feeXStr = formatAmount(feeX);
        const feeYStr = formatAmount(feeY);

        console.log(`[Fee] Diklaim — feeX: ${feeXStr}, feeY: ${feeYStr}, tx: ${txId}`);

        await notifier.feeClaimed(
          dlmm.pubkey.toBase58(),
          feeXStr,
          feeYStr,
          dlmm.tokenX.publicKey.toBase58().slice(0, 6),
          dlmm.tokenY.publicKey.toBase58().slice(0, 6),
        );
      }

      anyClaimed = true;
    } catch (err) {
      console.error(`[Fee] Error klaim posisi ${position.publicKey.toBase58()}:`, err);
    }
  }

  return anyClaimed;
}

export function hasFeeAboveThreshold(position: LbPosition, thresholdUsd: number): boolean {
  const feeX = position.positionData.feeX;
  const feeY = position.positionData.feeY;
  const totalRaw = feeX.add(feeY).toNumber();
  const estimatedUsd = totalRaw / 1_000_000;
  return estimatedUsd >= thresholdUsd;
}
