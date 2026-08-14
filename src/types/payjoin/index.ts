export interface TxEntry {
  address: string | null;
  amount: string;           // satoshis serialised as string (bigint-safe)
  ownedBy: 'sender' | 'receiver' | null;
}

export enum ReceiveStatus {
  Pending = 'pending',
  Fallback = 'fallback',
  NonPayjoin = 'non-payjoin',
  Unconfirmed = 'unconfirmed',
  Confirmed = 'confirmed',
  Expired = 'expired',
  Cancelled = 'cancelled',
}

/**
 * What the expiry sweep concluded about a terminal send's locked inputs.
 *
 * Drives whether processTerminalSend releases those inputs, leaves them to a
 * spend, or holds them for another cron tick.
 */
export enum FallbackOutcome {
  /** a tx spending these inputs is on the network — the locks are moot */
  Broadcast = 'broadcast',
  /** nothing is on the network and nothing can be — give the inputs back */
  Release = 'release',
  /** we cannot tell right now — keep the locks and retry next cron tick */
  Defer = 'defer',
}

export enum SendStatus {
  Pending = 'pending',
  Fallback = 'fallback',
  Unconfirmed = 'unconfirmed',
  Confirmed = 'confirmed',
  Expired = 'expired',
  Cancelled = 'cancelled',
}