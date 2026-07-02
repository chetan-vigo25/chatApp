/**
 * Public TypeScript surface for expo-cell-info.
 *
 * Numeric fields are `number | null` — Android's "unknown/unavailable" sentinels
 * are normalized to `null` natively, so a `null` means "not reported by the
 * modem", never a garbage 2147483647.
 */

export type CellType = 'LTE' | 'NR' | 'GSM' | 'WCDMA' | 'CDMA' | 'TDSCDMA';

/** CellSignalStrength.getLevel() bucket, 0..4 mapped to a label. */
export type SignalStrength =
  | 'NONE_OR_UNKNOWN'
  | 'POOR'
  | 'MODERATE'
  | 'GOOD'
  | 'GREAT';

/** Fields present on every returned cell regardless of radio type. */
export interface BaseCellInfo {
  cellType: CellType;
  /** True for the currently-registered serving cell. */
  registered: boolean;
  /** SIM subscription id this cell was read from, or null (single-SIM / unknown). */
  subscriptionId: number | null;
  /** Signal power in dBm, or null. */
  dbm: number | null;
  /** ASU level (radio-type specific scale), or null. */
  asuLevel: number | null;
  /** Coarse, human-readable signal bucket. */
  signalStrength: SignalStrength;
}

export interface LteCellInfo extends BaseCellInfo {
  cellType: 'LTE';
  ci: number | null;
  pci: number | null;
  tac: number | null;
  earfcn: number | null;
  /** Channel bandwidth in kHz (API 28+), or null. */
  bandwidth?: number | null;
  mcc?: string | null;
  mnc?: string | null;
  timingAdvance: number | null;
}

export interface NrCellInfo extends BaseCellInfo {
  cellType: 'NR';
  /** NR Cell Identity (up to 36-bit) — may exceed 32-bit, hence number. */
  nci: number | null;
  pci: number | null;
  tac: number | null;
  nrarfcn: number | null;
  mcc: string | null;
  mnc: string | null;
}

export interface GsmCellInfo extends BaseCellInfo {
  cellType: 'GSM';
  cid: number | null;
  lac: number | null;
  arfcn: number | null;
  bsic: number | null;
  mcc?: string | null;
  mnc?: string | null;
  timingAdvance?: number | null;
}

export interface WcdmaCellInfo extends BaseCellInfo {
  cellType: 'WCDMA';
  cid: number | null;
  lac: number | null;
  psc: number | null;
  uarfcn: number | null;
  mcc?: string | null;
  mnc?: string | null;
}

export interface CdmaCellInfo extends BaseCellInfo {
  cellType: 'CDMA';
  basestationId: number | null;
  networkId: number | null;
  systemId: number | null;
}

export interface TdscdmaCellInfo extends BaseCellInfo {
  cellType: 'TDSCDMA';
  cid: number | null;
  lac: number | null;
  cpid: number | null;
  uarfcn: number | null;
  mcc: string | null;
  mnc: string | null;
}

/** Discriminated union — narrow on `cellType` to get the type-specific fields. */
export type CellInfo =
  | LteCellInfo
  | NrCellInfo
  | GsmCellInfo
  | WcdmaCellInfo
  | CdmaCellInfo
  | TdscdmaCellInfo;

export interface GetCellInfoOptions {
  /**
   * When true, neighboring (non-serving) cells are included. Defaults to false
   * (serving cell only).
   */
  includeNeighbors?: boolean;
}

/** Standard Expo permission response shape. */
export interface PermissionResponse {
  status: 'granted' | 'undetermined' | 'denied';
  granted: boolean;
  canAskAgain: boolean;
  expires: 'never' | number;
}
