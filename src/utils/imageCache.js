// Image cache helpers (expo-image). Policy: see components/AppImage.jsx.
//
// There is deliberately NO prefetch helper: expo-image's prefetch keys by the
// full URL and cannot take a cacheKey, so prefetching a presigned URL would
// store it under a key the renderer never asks for. A thumbnail is cached under
// its stable key the first time it renders, and full media only downloads on an
// explicit user tap.
import { Image } from 'expo-image';

/** Drop every cached picture (memory + disk). Called on logout / account switch. */
export const clearImageCache = async () => {
  try { await Image.clearMemoryCache(); } catch { /* best effort */ }
  try { await Image.clearDiskCache(); } catch { /* best effort */ }
};
