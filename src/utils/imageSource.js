/**
 * expo-image source for chat media. Chat media URLs are S3 presigned links
 * that expire after 1h (X-Amz-Expires=3600 → 403) and are re-signed on every
 * sync, so a cache keyed by the FULL url misses on every re-sign. The object
 * path is stable per media, so it is the cache key: a picture seen once paints
 * from disk even after its stored link has expired. Local files need no key.
 */
export const cachedImageSource = (uri) => {
  const u = String(uri || '');
  if (!/^https?:\/\//i.test(u)) return { uri: u };
  const q = u.indexOf('?');
  return q > 0 ? { uri: u, cacheKey: u.slice(0, q) } : { uri: u };
};

export default cachedImageSource;
