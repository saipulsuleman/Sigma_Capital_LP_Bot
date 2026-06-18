import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { config } from '../config';

let _wallet: Keypair | null = null;

export function getWallet(): Keypair {
  if (!_wallet) {
    const decoded = bs58.decode(config.walletPrivateKey);
    _wallet = Keypair.fromSecretKey(decoded);
  }
  return _wallet;
}
