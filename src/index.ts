import { config } from './config';
import { getConnection } from './core/connection';
import { getWallet } from './core/wallet';
import { getDlmm } from './services/meteora/client';
import { notifier } from './services/telegram/notifier';
import { openPosition } from './services/meteora/position';
import { PositionMonitor } from './monitors/positionMonitor';
import BN from 'bn.js';

async function main() {
  console.log('=== Sigma Capital LP Bot ===');
  console.log(`Pool: ${config.poolAddress}`);
  console.log(`Strategi: ${config.strategy}, Bin range: ±${config.binRange}`);
  console.log(`Rebalance check: setiap ${config.rebalanceCheckIntervalMs / 1000}s`);
  console.log(`Fee claim: setiap ${config.feeClaimIntervalMs / 1000 / 60}m`);

  const connection = getConnection();
  const wallet = getWallet();
  const dlmm = await getDlmm();

  console.log(`\nWallet: ${wallet.publicKey.toBase58()}`);
  console.log(`Pool pubkey: ${dlmm.pubkey.toBase58()}`);

  const activeBin = await dlmm.getActiveBin();
  console.log(`Active bin: ${activeBin.binId}, harga: ${activeBin.pricePerToken}`);

  // Jika ada DEPOSIT_AMOUNT_X dan DEPOSIT_AMOUNT_Y di env, buka posisi awal
  if (config.depositAmountX && config.depositAmountY) {
    console.log('\nMembuka posisi awal...');
    await openPosition(
      dlmm,
      wallet,
      activeBin.binId,
      new BN(config.depositAmountX.toString()),
      new BN(config.depositAmountY.toString()),
    );
  }

  const monitor = new PositionMonitor(dlmm, wallet);
  await monitor.start();

  // Graceful shutdown
  process.on('SIGINT', async () => {
    console.log('\nMenghentikan bot...');
    monitor.stop();
    await notifier.warning('Bot LP dihentikan secara manual (SIGINT)');
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    console.log('\nMenghentikan bot...');
    monitor.stop();
    await notifier.warning('Bot LP dihentikan (SIGTERM)');
    process.exit(0);
  });

  process.on('uncaughtException', async (err) => {
    console.error('Uncaught exception:', err);
    await notifier.error(`Bot crash: ${err.message}`);
    process.exit(1);
  });
}

main().catch(async (err) => {
  console.error('Fatal error:', err);
  try {
    await notifier.error(`Bot gagal start: ${err.message}`);
  } catch {}
  process.exit(1);
});
