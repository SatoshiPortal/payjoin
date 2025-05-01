export enum ReceiveStatus {
  Pending = 'pending',
  Fallback = 'fallback',
  NonPayjoin = 'non-payjoin',
  Unconfirmed = 'unconfirmed',
  Confirmed = 'confirmed',
  Expired = 'expired',
  Cancelled = 'cancelled',
}

export enum SendStatus {
  Pending = 'pending',
  Unconfirmed = 'unconfirmed',
  Confirmed = 'confirmed',
  Expired = 'expired',
  Cancelled = 'cancelled',
}