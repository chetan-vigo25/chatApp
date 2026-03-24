import React, { memo, useMemo, useState, useCallback } from 'react';
import { View, Text, Image, TouchableOpacity, Linking, Platform, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

const BUBBLE_WIDTH = 260;
const MAP_HEIGHT = 140;
const TILE_SIZE = 256;
// We show a 3x3 grid of tiles scaled down to fill the preview area
const GRID = 3;

/**
 * Convert lat/lng to OSM tile coordinates at a given zoom level.
 * Returns fractional x,y so we can compute the pin offset within the tile grid.
 */
const latLngToTile = (lat, lng, zoom) => {
  const n = Math.pow(2, zoom);
  const x = ((lng + 180) / 360) * n;
  const latRad = (lat * Math.PI) / 180;
  const y = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n;
  return { x, y };
};

/**
 * Generate tile URLs for a 3x3 grid centered on the given lat/lng.
 * Uses OpenStreetMap tile servers which are free and always available.
 */
const getTileGrid = (lat, lng, zoom = 15) => {
  const { x: fx, y: fy } = latLngToTile(lat, lng, zoom);
  const centerTileX = Math.floor(fx);
  const centerTileY = Math.floor(fy);

  const tiles = [];
  const startX = centerTileX - 1;
  const startY = centerTileY - 1;

  for (let row = 0; row < GRID; row++) {
    for (let col = 0; col < GRID; col++) {
      const tileX = startX + col;
      const tileY = startY + row;
      // Use multiple OSM tile subdomains for parallel loading
      const subdomain = ['a', 'b', 'c'][(col + row) % 3];
      tiles.push({
        key: `${tileX}-${tileY}`,
        uri: `https://${subdomain}.tile.openstreetmap.org/${zoom}/${tileX}/${tileY}.png`,
        col,
        row,
      });
    }
  }

  // Calculate pin position within the grid (as fraction 0-1)
  const pinFractionX = (fx - startX) / GRID;
  const pinFractionY = (fy - startY) / GRID;

  return { tiles, pinFractionX, pinFractionY };
};

const LocationBubble = memo(function LocationBubble({
  latitude,
  longitude,
  address,
  mapPreviewUrl,
  isMyMessage,
  time,
  status,
  isEdited,
  themeColors,
}) {
  const lat = Number(latitude) || 0;
  const lng = Number(longitude) || 0;
  // Consider valid if at least one coordinate is non-zero, OR if both were explicitly provided
  const hasCoords = (latitude != null && longitude != null) && (lat !== 0 || lng !== 0);

  const displayAddress = address || 'Shared location';

  // Compute tile grid and pin position once
  const mapData = useMemo(() => {
    if (!hasCoords) return null;
    return getTileGrid(lat, lng, 15);
  }, [lat, lng, hasCoords]);

  // The grid of tiles is GRID*TILE_SIZE px wide but we display it in BUBBLE_WIDTH.
  // Scale factor to fit the grid into our bubble.
  const gridPixelSize = GRID * TILE_SIZE; // 768px
  const scaleX = BUBBLE_WIDTH / gridPixelSize;
  const scaleY = MAP_HEIGHT / gridPixelSize;
  // We use "cover" behavior: scale uniformly to fill, then clip
  const scale = Math.max(scaleX, scaleY);
  const scaledW = gridPixelSize * scale;
  const scaledH = gridPixelSize * scale;
  const offsetX = (BUBBLE_WIDTH - scaledW) / 2;
  const offsetY = (MAP_HEIGHT - scaledH) / 2;

  const openMap = useCallback(() => {
    if (!hasCoords) return;
    const url = Platform.select({
      ios: `maps:?q=${lat},${lng}`,
      android: `geo:${lat},${lng}?q=${lat},${lng}(Location)`,
    });
    Linking.openURL(url).catch(() => {
      Linking.openURL(`https://maps.google.com/?q=${lat},${lng}`).catch(() => {});
    });
  }, [lat, lng, hasCoords]);

  const renderTick = () => {
    if (!isMyMessage) return null;
    const iconProps = { style: { marginLeft: 3 } };
    switch (status) {
      case 'sending':
      case 'uploaded':
      case 'sent':
        return <Ionicons name="checkmark" size={12} color="rgba(255,255,255,0.9)" {...iconProps} />;
      case 'delivered':
        return <Ionicons name="checkmark-done" size={12} color="rgba(255,255,255,0.92)" {...iconProps} />;
      case 'seen':
      case 'read':
        return <Ionicons name="checkmark-done" size={12} color="#67B7FF" {...iconProps} />;
      case 'failed':
        return <Ionicons name="alert-circle" size={12} color="#FF8A80" {...iconProps} />;
      default:
        return null;
    }
  };

  return (
    <TouchableOpacity
      onPress={openMap}
      activeOpacity={0.85}
      style={[
        styles.container,
        { backgroundColor: isMyMessage ? (themeColors?.chatBubbleRight || '#005C4B') : (themeColors?.menuBackground || '#202C33') },
      ]}
    >
      {/* Map Preview — 3x3 OSM tile grid */}
      <View style={styles.mapWrap}>
        {hasCoords && mapData ? (
          <>
            {/* Tile grid container — scaled and centered */}
            <View style={[styles.tileGrid, { width: scaledW, height: scaledH, left: offsetX, top: offsetY }]}>
              {mapData.tiles.map((tile) => (
                <Image
                  key={tile.key}
                  source={{ uri: tile.uri, headers: { 'User-Agent': 'VibeConnect/1.0' } }}
                  style={{
                    position: 'absolute',
                    left: tile.col * TILE_SIZE * scale,
                    top: tile.row * TILE_SIZE * scale,
                    width: TILE_SIZE * scale,
                    height: TILE_SIZE * scale,
                  }}
                  resizeMode="cover"
                  fadeDuration={0}
                />
              ))}
            </View>

            {/* Red pin marker at exact location */}
            <View
              style={[
                styles.pinContainer,
                {
                  left: offsetX + mapData.pinFractionX * scaledW - 14,
                  top: offsetY + mapData.pinFractionY * scaledH - 34,
                },
              ]}
              pointerEvents="none"
            >
              <Ionicons name="location" size={28} color="#E53935" />
              <View style={styles.pinDot} />
            </View>
          </>
        ) : (
          <View style={[styles.noLocationWrap, { backgroundColor: themeColors?.borderColor || '#2a3942' }]}>
            <Ionicons name="location-outline" size={28} color={themeColors?.placeHolderTextColor || '#8696A0'} />
            <Text style={[styles.noLocationText, { color: themeColors?.placeHolderTextColor || '#8696A0' }]}>
              No location data
            </Text>
          </View>
        )}

        {/* Time overlay */}
        <View style={styles.timeOverlay}>
          {isEdited && <Text style={styles.editedText}>edited</Text>}
          <Text style={styles.timeText}>{time}</Text>
          {renderTick()}
        </View>
      </View>

      {/* Address section */}
      <View style={styles.addressBar}>
        <View style={styles.addressIconWrap}>
          <Ionicons name="location" size={18} color="#E53935" />
        </View>
        <View style={styles.addressTextWrap}>
          <Text
            style={[styles.addressText, { color: isMyMessage ? '#fff' : (themeColors?.primaryTextColor || '#E9EDEF') }]}
            numberOfLines={2}
          >
            {displayAddress}
          </Text>
          {hasCoords && (
            <Text style={[styles.coordsText, { color: isMyMessage ? 'rgba(255,255,255,0.6)' : (themeColors?.placeHolderTextColor || '#8696A0') }]}>
              {lat.toFixed(4)}, {lng.toFixed(4)}
            </Text>
          )}
        </View>
      </View>
    </TouchableOpacity>
  );
});

const styles = StyleSheet.create({
  container: {
    width: BUBBLE_WIDTH,
    borderRadius: 10,
    overflow: 'hidden',
  },
  mapWrap: {
    width: BUBBLE_WIDTH,
    height: MAP_HEIGHT,
    overflow: 'hidden',
    backgroundColor: '#1a2a33',
    position: 'relative',
  },
  tileGrid: {
    position: 'absolute',
  },
  pinContainer: {
    position: 'absolute',
    alignItems: 'center',
    zIndex: 10,
  },
  pinDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: '#E53935',
    marginTop: -4,
    borderWidth: 1.5,
    borderColor: '#fff',
  },
  noLocationWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  noLocationText: {
    fontSize: 11,
    fontFamily: 'Roboto-Regular',
    marginTop: 4,
  },
  timeOverlay: {
    position: 'absolute',
    right: 6,
    bottom: 6,
    backgroundColor: 'rgba(0,0,0,0.5)',
    borderRadius: 6,
    paddingHorizontal: 5,
    paddingVertical: 2,
    flexDirection: 'row',
    alignItems: 'center',
    zIndex: 20,
  },
  editedText: {
    color: 'rgba(255,255,255,0.9)',
    fontSize: 9,
    marginRight: 3,
    fontFamily: 'Roboto-Regular',
  },
  timeText: {
    color: '#fff',
    fontSize: 9,
    fontFamily: 'Roboto-Medium',
  },
  addressBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 8,
    gap: 8,
  },
  addressIconWrap: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: 'rgba(229,57,53,0.12)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  addressTextWrap: {
    flex: 1,
  },
  addressText: {
    fontFamily: 'Roboto-Medium',
    fontSize: 13,
    lineHeight: 17,
  },
  coordsText: {
    fontFamily: 'Roboto-Regular',
    fontSize: 10,
    marginTop: 1,
  },
});

export default LocationBubble;
