import React, { useEffect, useRef, useState } from 'react';
import { View, Text, Image, TouchableOpacity, StyleSheet } from 'react-native';
import { fetchLinkPreview, getCachedLinkPreview } from '../utils/linkPreview';
import { toSecureMediaUri } from '../utils/mediaService';

// WhatsApp-style link-preview card shown ABOVE the text inside a message bubble.
// Self-contained: it fetches (or reads the cache for) the URL's Open Graph data
// and renders itself when ready. Because it owns its async state, it re-renders
// on resolve even though the surrounding message row is memoized.
function LinkPreviewCard({ url, isMyMessage, theme, isDarkMode, onOpen }) {
  const cached = getCachedLinkPreview(url); // undefined = unfetched, null = no preview
  const [data, setData] = useState(cached !== undefined ? cached : null);
  const [imgError, setImgError] = useState(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    setImgError(false);
    const c = getCachedLinkPreview(url);
    if (c !== undefined) { setData(c); return undefined; }
    setData(null);
    let alive = true;
    fetchLinkPreview(url).then((res) => {
      if (alive && mountedRef.current) setData(res);
    });
    return () => { alive = false; };
  }, [url]);

  if (!data || (!data.title && !data.image)) return null;

  const primaryText = isMyMessage ? '#FFFFFF' : (theme?.colors?.primaryTextColor || '#111');
  const mutedText = isMyMessage
    ? 'rgba(255,255,255,0.82)'
    : (theme?.colors?.secondaryTextColor || theme?.colors?.placeHolderTextColor || '#667781');
  const cardBg = isMyMessage
    ? 'rgba(255,255,255,0.15)'
    : (isDarkMode ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.05)');
  const accent = theme?.colors?.themeColor || '#25D366';

  const imageUri = !imgError && data.image ? toSecureMediaUri(data.image) : null;

  return (
    <TouchableOpacity
      activeOpacity={0.85}
      onPress={() => onOpen?.(data.url || url)}
      style={[styles.card, { backgroundColor: cardBg, borderLeftColor: accent }]}
    >
      {imageUri ? (
        <Image
          source={{ uri: imageUri }}
          style={styles.image}
          resizeMode="cover"
          onError={() => setImgError(true)}
        />
      ) : null}
      <View style={styles.textWrap}>
        {!!data.siteName && (
          <Text numberOfLines={1} style={[styles.site, { color: accent }]}>
            {data.siteName}
          </Text>
        )}
        {!!data.title && (
          <Text numberOfLines={2} style={[styles.title, { color: primaryText }]}>
            {data.title}
          </Text>
        )}
        {!!data.description && (
          <Text numberOfLines={2} style={[styles.desc, { color: mutedText }]}>
            {data.description}
          </Text>
        )}
      </View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: 10,
    borderLeftWidth: 3,
    overflow: 'hidden',
    marginBottom: 6,
    minWidth: 200,
    maxWidth: 260,
  },
  image: {
    width: '100%',
    height: 130,
    backgroundColor: 'rgba(0,0,0,0.08)',
  },
  textWrap: {
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  site: {
    fontSize: 11,
    fontFamily: 'Roboto-Medium',
    marginBottom: 2,
  },
  title: {
    fontSize: 13.5,
    fontFamily: 'Roboto-Medium',
    lineHeight: 18,
  },
  desc: {
    fontSize: 12,
    fontFamily: 'Roboto-Regular',
    lineHeight: 16,
    marginTop: 2,
  },
});

export default React.memo(LinkPreviewCard);
