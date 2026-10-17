// AppImage — the ONE image component for network/local pictures in the app.
// A thin layer over expo-image so the cache policy lives in a single place:
//   • cache KEY = stable id, never the presigned URL. Chat media URLs are S3
//     presigned links re-signed on every read, so a URL-keyed cache re-downloads
//     the same picture each time. The key is the URL minus its query string
//     (the S3 object path); local file:// sources need no key
//     (see utils/imageSource.js). Pass `cacheKey` to override with a messageId /
//     variant id when the caller has one.
//   • memory-disk cache by default, `recyclingKey` so a recycled list row never
//     flashes the previous row's picture.
//   • drop-in props: `resizeMode` (RN names) maps to expo-image `contentFit`.
//
// NEVER use this for view-once media — those must not enter the disk cache
// (ChatScreen keeps RN <Image cache:'reload'> for them).
import React from 'react';
import { Image } from 'expo-image';
import { cachedImageSource } from '../utils/imageSource';

const CONTENT_FIT = { cover: 'cover', contain: 'contain', stretch: 'fill', center: 'none', repeat: 'cover' };

const resolveSource = (source, cacheKey) => {
  if (source == null || typeof source === 'number') return source; // bundled require()
  const uri = typeof source === 'string' ? source : source.uri;
  if (!uri) return null;
  const base = cachedImageSource(uri);
  return cacheKey ? { ...base, cacheKey: String(cacheKey) } : base;
};

function AppImage({
  source,
  uri,
  cacheKey,
  resizeMode,
  contentFit,
  cachePolicy = 'memory-disk',
  recyclingKey,
  ...rest
}) {
  const resolved = resolveSource(source !== undefined ? source : uri, cacheKey);
  const recycle = recyclingKey || (resolved && typeof resolved === 'object' ? (resolved.cacheKey || resolved.uri) : undefined);
  return (
    <Image
      {...rest}
      source={resolved}
      contentFit={contentFit || CONTENT_FIT[resizeMode] || 'cover'}
      cachePolicy={cachePolicy}
      recyclingKey={recycle}
    />
  );
}

export default React.memo(AppImage);
