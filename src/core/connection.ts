import { Connection, Commitment } from '@solana/web3.js';
import { config } from '../config';

const COMMITMENT: Commitment = 'confirmed';

let _connection: Connection | null = null;

export function getConnection(): Connection {
  if (!_connection) {
    _connection = new Connection(config.rpcEndpoint, {
      commitment: COMMITMENT,
      confirmTransactionInitialTimeout: 60000,
    });
  }
  return _connection;
}
