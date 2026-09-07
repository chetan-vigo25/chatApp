/**
 * One tile in the media grid.
 *
 * Two things make the grid cheap, and both live here:
 *
 *  • It is React.memo'd over PRIMITIVE props only (id, uri, size, colours).
 *    Nothing object-shaped is passed except the store and the press handler,
 *    which are stable for the life of the sheet — so `renderItem` never needs
 *    to change identity and a re-render of the list body bails out at every
 *    cell it did not affect.
 *
 *  • Selection is read from the store through useSyncExternalStore rather than
 *    handed down as a prop. A tap therefore notifies subscribers directly and
 *    re-renders ONLY the cells whose number actually changed — the tapped one,
 *    plus the ones that renumber behind a deselect. With selection as a prop,
 *    every visible cell would re-render on every tap.
 *
 * The <Image> is expo-image: it decodes the local asset down to the tile size
 * natively and keeps it in its own memory/disk cache. The grid never touches
 * full-resolution bytes — the original is resolved once, at send, by
 * utils/deviceMedia.normalizeLibraryAsset. No Base64, ever.
 */
import React, { useCallback, useSyncExternalStore } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';

import { formatMediaDuration } from '../utils/deviceMedia';

function MediaGridCell({
  id,
  uri,
  isVideo,
  duration,
  size,
  gutter,
  store,
  onPress,
  accent,
  surface,
  labelFont,
}) {
  const order = useSyncExternalStore(
    store.subscribe,
    useCallback(() => store.orderOf(id), [store, id]),
  );
  const selected = order > 0;

  const handlePress = useCallback(() => { onPress(id); }, [onPress, id]);

  return (
    <TouchableOpacity
      activeOpacity={0.85}
      onPress={handlePress}
      style={{ width: size, height: size, marginLeft: gutter, marginBottom: gutter }}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      accessibilityLabel={isVideo ? 'Video' : 'Photo'}
    >
      <View style={[styles.thumb, { backgroundColor: surface }]}>
        <Image
          source={uri}
          style={StyleSheet.absoluteFill}
          contentFit="cover"
          cachePolicy="memory-disk"
          // No cross-fade: a grid of tiles animating in as you fling is both
          // distracting and extra compositing work per frame.
          transition={0}
          // Tells expo-image this view is recycled, so a scrolled-away tile
          // never flashes the previous asset before the new one decodes.
          recyclingKey={id}
          priority="low"
        />

        {isVideo ? (
          <View style={styles.durationChip}>
            <Ionicons name="videocam" size={10} color="#fff" />
            <Text style={[styles.duration, { fontFamily: labelFont }]}>
              {formatMediaDuration(duration)}
            </Text>
          </View>
        ) : null}

        {selected ? (
          <>
            <View style={[styles.pickOverlay, { borderColor: accent }]} />
            <View style={[styles.pickBadge, { backgroundColor: accent }]}>
              <Text style={[styles.pickBadgeText, { fontFamily: labelFont }]}>{order}</Text>
            </View>
          </>
        ) : null}
      </View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  thumb: { flex: 1 },
  durationChip: {
    position: 'absolute',
    left: 4,
    bottom: 4,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    paddingHorizontal: 5,
    paddingVertical: 2,
    borderRadius: 4,
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  duration: { fontSize: 10, color: '#fff' },
  pickOverlay: {
    ...StyleSheet.absoluteFillObject,
    borderWidth: 3,
    backgroundColor: 'rgba(0,0,0,0.25)',
  },
  pickBadge: {
    position: 'absolute',
    top: 5,
    right: 5,
    minWidth: 20,
    height: 20,
    borderRadius: 10,
    paddingHorizontal: 5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pickBadgeText: { fontSize: 11, color: '#fff' },
});

export default React.memo(MediaGridCell);
