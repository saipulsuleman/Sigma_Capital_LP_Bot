import DLMM from '@meteora-ag/dlmm';
import { Keypair } from '@solana/web3.js';
import { config } from '../config';
import { notifier } from '../services/telegram/notifier';
import { getUserPositions } from '../services/meteora/position';
import { rebalance, isOutOfRange } from '../services/meteora/rebalancer';
import { claimAllFees, hasFeeAboveThreshold } from '../services/meteora/feeManager';
import { getDlmm, refreshDlmm } from '../services/meteora/client';

export class PositionMonitor {
  private dlmm: DLMM;
  private wallet: Keypair;
  private rebalanceTimer: ReturnType<typeof setInterval> | null = null;
  private feeClaimTimer: ReturnType<typeof setInterval> | null = null;
  private isRebalancing = false;

  constructor(dlmm: DLMM, wallet: Keypair) {
    this.dlmm = dlmm;
    this.wallet = wallet;
  }

  async start(): Promise<void> {
    console.log('[Monitor] Bot mulai jalan...');
    await notifier.info(`Bot LP Meteora aktif\nPool: ${config.poolAddress}`);

    this.startRebalanceLoop();
    this.startFeeClaimLoop();
  }

  stop(): void {
    if (this.rebalanceTimer) clearInterval(this.rebalanceTimer);
    if (this.feeClaimTimer) clearInterval(this.feeClaimTimer);
    console.log('[Monitor] Bot dihentikan.');
  }

  private startRebalanceLoop(): void {
    const check = async () => {
      if (this.isRebalancing) return;

      try {
        this.dlmm = await refreshDlmm();
        const activeBin = await this.dlmm.getActiveBin();
        const positions = await getUserPositions(this.dlmm, this.wallet);

        if (positions.length === 0) {
          console.log(`[Monitor] Tidak ada posisi aktif. Active bin: ${activeBin.binId}`);
          return;
        }

        const needsRebalance = positions.some((p) => isOutOfRange(p, activeBin.binId));

        if (needsRebalance) {
          this.isRebalancing = true;
          console.log(`[Monitor] Rebalance diperlukan. Active bin: ${activeBin.binId}`);

          try {
            await rebalance(this.dlmm, this.wallet, activeBin.binId);
          } finally {
            this.isRebalancing = false;
          }
        } else {
          const p = positions[0];
          console.log(
            `[Monitor] Posisi OK. Active bin: ${activeBin.binId}, ` +
              `range: ${p.positionData.lowerBinId}-${p.positionData.upperBinId}`,
          );
        }
      } catch (err) {
        console.error('[Monitor] Error cek rebalance:', err);
        await notifier.error(`Error monitor: ${(err as Error).message}`);
      }
    };

    check();
    this.rebalanceTimer = setInterval(check, config.rebalanceCheckIntervalMs);
  }

  private startFeeClaimLoop(): void {
    const claim = async () => {
      try {
        this.dlmm = await refreshDlmm();
        const positions = await getUserPositions(this.dlmm, this.wallet);

        const shouldClaim = positions.some((p) =>
          hasFeeAboveThreshold(p, config.feeClaimThresholdUsd),
        );

        if (shouldClaim) {
          console.log('[Fee] Fee melebihi threshold, mulai klaim...');
          await claimAllFees(this.dlmm, this.wallet);
        } else {
          console.log('[Fee] Fee belum mencapai threshold, skip.');
        }
      } catch (err) {
        console.error('[Fee] Error klaim fee:', err);
        await notifier.error(`Error klaim fee: ${(err as Error).message}`);
      }
    };

    this.feeClaimTimer = setInterval(claim, config.feeClaimIntervalMs);
  }
}
