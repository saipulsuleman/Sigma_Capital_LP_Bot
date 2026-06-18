import DLMM from '@meteora-ag/dlmm';
import { PublicKey } from '@solana/web3.js';
import { getConnection } from '../../core/connection';
import { config } from '../../config';

let _dlmm: DLMM | null = null;

export async function getDlmm(): Promise<DLMM> {
  if (!_dlmm) {
    const connection = getConnection();
    const poolPubkey = new PublicKey(config.poolAddress);
    _dlmm = await DLMM.create(connection, poolPubkey);
  }
  return _dlmm;
}

export async function refreshDlmm(): Promise<DLMM> {
  _dlmm = null;
  return getDlmm();
}
