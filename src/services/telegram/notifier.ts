import TelegramBot from 'node-telegram-bot-api';
import { config } from '../../config';

let _bot: TelegramBot | null = null;

function getBot(): TelegramBot {
  if (!_bot) {
    _bot = new TelegramBot(config.telegram.botToken);
  }
  return _bot;
}

async function send(message: string): Promise<void> {
  try {
    await getBot().sendMessage(config.telegram.chatId, message, { parse_mode: 'HTML' });
  } catch (err) {
    console.error('[Telegram] Gagal kirim notifikasi:', err);
  }
}

export const notifier = {
  info: (msg: string) => send(`ℹ️ ${msg}`),
  success: (msg: string) => send(`✅ ${msg}`),
  warning: (msg: string) => send(`⚠️ ${msg}`),
  error: (msg: string) => send(`❌ ${msg}`),

  positionOpened: (pool: string, minBin: number, maxBin: number, activeBin: number) =>
    send(
      `✅ <b>Posisi Dibuka</b>\n` +
        `Pool: <code>${pool}</code>\n` +
        `Bin range: ${minBin} → ${maxBin}\n` +
        `Active bin: ${activeBin}`,
    ),

  rebalanceTriggered: (pool: string, oldMin: number, oldMax: number, activeBin: number) =>
    send(
      `🔄 <b>Rebalance Triggered</b>\n` +
        `Pool: <code>${pool}</code>\n` +
        `Old range: ${oldMin} → ${oldMax}\n` +
        `Active bin: ${activeBin} (di luar range!)`,
    ),

  rebalanceDone: (pool: string, newMin: number, newMax: number, activeBin: number) =>
    send(
      `✅ <b>Rebalance Selesai</b>\n` +
        `Pool: <code>${pool}</code>\n` +
        `Range baru: ${newMin} → ${newMax}\n` +
        `Active bin: ${activeBin}`,
    ),

  feeClaimed: (pool: string, feeX: string, feeY: string, tokenX: string, tokenY: string) =>
    send(
      `💰 <b>Fee Diklaim</b>\n` +
        `Pool: <code>${pool}</code>\n` +
        `${feeX} ${tokenX} + ${feeY} ${tokenY}`,
    ),
};
