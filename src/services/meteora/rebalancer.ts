import DLMM from '@meteora-ag/dlmm';
import { Keypair, PublicKey } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from '@solana/spl-token';
import BN from 'bn.js';
import { getConnection } from '../../core/connection';
import { config } from '../../config';
import { notifier } from '../telegram/notifier';
import { getUserPositions, openPosition, closePosition, LbPosition } from './position';
import { claimAllFees } from './feeManager';

export function isOutOfRange(position: LbPosition, activeBinId: number): boolean {
  const { lowerBinId, upperBinId } = position.positionData;
  const outsideLow = activeBinId < lowerBinId - config.rebalanceThresholdBins;
  const outsideHigh = activeBinId > upperBinId + config.rebalanceThresholdBins;
  return outsideLow || outsideHigh;
}

export async function rebalance(dlmm: DLMM, wallet: Keypair, activeBinId: number): Promise<void> {
  const positions = await getUserPositions(dlmm, wallet);

  for (const position of positions) {
    if (!isOutOfRange(position, activeBinId)) continue;

    const { lowerBinId, upperBinId } = position.positionData;
    console.log(
      `[Rebalance] Posisi ${position.publicKey.toBase58().slice(0, 8)}... keluar range. ` +
        `Active: ${activeBinId}, range: ${lowerBinId}-${upperBinId}`,
    );

    await notifier.rebalanceTriggered(
      dlmm.pubkey.toBase58(),
      lowerBinId,
      upperBinId,
      activeBinId,
    );

    // 1. Tutup posisi (remove semua liquidity + claim fee + close)
    await closePosition(dlmm, wallet, position);

    // 2. Ambil saldo sesudah close untuk deposit ulang
    const connection = getConnection();
    const xAfter = await connection.getTokenAccountBalance(
      getAssociatedTokenAddress(dlmm.tokenX.publicKey, wallet.publicKey),
    );
    const yAfter = await connection.getTokenAccountBalance(
      getAssociatedTokenAddress(dlmm.tokenY.publicKey, wallet.publicKey),
    );

    const depositX = config.depositAmountX
      ? new BN(config.depositAmountX.toString())
      : new BN(xAfter.value.amount);

    const depositY = config.depositAmountY
      ? new BN(config.depositAmountY.toString())
      : new BN(yAfter.value.amount);

    // 3. Buka posisi baru di sekitar active bin
    await openPosition(dlmm, wallet, activeBinId, depositX, depositY);

    const newMin = activeBinId - config.binRange;
    const newMax = activeBinId + config.binRange;

    await notifier.rebalanceDone(dlmm.pubkey.toBase58(), newMin, newMax, activeBinId);
  }
}

function getAssociatedTokenAddress(mint: PublicKey, owner: PublicKey): PublicKey {
  const [address] = PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  return address;
}
