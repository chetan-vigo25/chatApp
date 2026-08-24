/** BCP-47 tag ML Kit understands, e.g. 'en', 'hi', 'zh'. */
export type MlkitLanguage = string;

/** Returned by `identifyLanguage` when ML Kit cannot tell. */
export const UNDETERMINED_LANGUAGE = 'und';

export interface TranslateArgs {
  text: string;
  /** Source language. Must be a downloaded model unless `allowDownload`. */
  source: MlkitLanguage;
  target: MlkitLanguage;
  /**
   * Let ML Kit fetch a missing model mid-call.
   *
   * Left FALSE on the chat path on purpose: a model is ~30MB and pulling it
   * while the user waits for a bubble to translate would stall on cellular.
   * The picker screen downloads deliberately instead.
   */
  allowDownload?: boolean;
}

export interface DownloadArgs {
  language: MlkitLanguage;
  /** Defaults to true — a 30MB model should not land on someone's data plan. */
  requireWifi?: boolean;
}

/** Stable `code` values on rejected promises. */
export const MLKIT_ERROR = {
  UNAVAILABLE: 'ERR_MLKIT_UNAVAILABLE',
  UNSUPPORTED_LANGUAGE: 'ERR_MLKIT_UNSUPPORTED_LANGUAGE',
  MODEL_MISSING: 'ERR_MLKIT_MODEL_MISSING',
  FAILED: 'ERR_MLKIT_FAILED',
} as const;
