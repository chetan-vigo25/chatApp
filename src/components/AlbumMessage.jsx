import React, { useMemo } from 'react';
import { View, Image, Text, TouchableOpacity, ActivityIndicator, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { toSecureMediaUri } from '../utils/mediaService';
import useMediaDownload from '../hooks/useMediaDownload';

const GRID_WIDTH = 220;
const GAP = 3;
const MAX_VISIBLE = 4;

const normalizeMediaId = (raw) => {
  if (!raw) return null;
  if (typeof raw === 'object') return String(raw.$oid || raw._id || raw.id || '');
  return String(raw);
};

// Thumbnail shown before download (blurred). Prefers the local file once present.
const thumbSource = (item) => {
  const uri = item?.localUri || item?.mediaThumbnailUrl || item?.mediaUrl || null;
  return uri ? toSecureMediaUri(uri) : null;
};

const isVisual = (item) => item?.fileCategory === 'image' || item?.fileCategory === 'video';

function TileOverlay({ item, hiddenCount, available, downloading, progress }) {
  // Upload states (own message still sending) take precedence.
  if (item.uploadStatus === 'uploading' || item.uploadStatus === 'pending') {
    return (
      <View style={styles.dimOverlay}>
        <ActivityIndicator size="small" color="#fff" />
      </View>
    );
  }
  if (item.uploadStatus === 'failed') {
    return (
      <View style={styles.dimOverlay}>
        <Ionicons name="alert-circle" size={22} color="#FF8A80" />
      </View>
    );
  }
  // Receiver download gate.
  if (downloading) {
    return (
      <View style={styles.dimOverlay}>
        <ActivityIndicator size="small" color="#fff" />
        {progress > 0 && progress < 100 ? (
          <Text style={styles.progressText}>{Math.round(progress)}%</Text>
        ) : null}
      </View>
    );
  }
  if (!available) {
    return (
      <View style={styles.dimOverlay}>
        {hiddenCount > 0 ? (
          <Text style={styles.moreText}>+{hiddenCount}</Text>
        ) : (
          <View style={styles.downloadCircle}>
            <Ionicons name="cloud-download" size={18} color="#fff" />
          </View>
        )}
      </View>
    );
  }
  if (hiddenCount > 0) {
    return (
      <View style={styles.dimOverlay}>
        <Text style={styles.moreText}>+{hiddenCount}</Text>
      </View>
    );
  }
  if (item.fileCategory === 'video') {
    return (
      <View style={styles.playOverlay} pointerEvents="none">
        <View style={styles.playCircle}>
          <Ionicons name="play" size={18} color="#fff" style={styles.playIcon} />
        </View>
      </View>
    );
  }
  return null;
}

function Tile({ item, index, height, width, hiddenCount, onPressItem, isMine, chatId, messageId }) {
  const mediaId = normalizeMediaId(item?.mediaId);
  const { status, progress, localPath, isDownloaded, requestDownload } = useMediaDownload(mediaId);

  // Own media is already local. Received media is gated until downloaded.
  const isSending = item.uploadStatus === 'uploading' || item.uploadStatus === 'pending';
  const available = isMine || isSending || isDownloaded || Boolean(item?.localUri);
  const downloading = !available && (status === 'downloading' || status === 'queued');

  const localUri = localPath || item?.localUri || null;
  const source = available
    ? (localUri ? toSecureMediaUri(localUri) : thumbSource(item))
    : thumbSource(item);

  const handlePress = () => {
    if (isSending || downloading) return;
    if (available) {
      onPressItem?.({ ...item, localUri: localUri || item?.localUri || null }, index);
      return;
    }
    // Receiver tap → download this item, then it becomes viewable.
    if (!mediaId && !item?.mediaUrl) return;
    requestDownload({
      chatId,
      messageType: item?.fileCategory || 'image',
      filename: item?.mediaMeta?.fileName || mediaId || `${index}`,
      mediaUrl: item?.mediaUrl || null,
      messageId,
    }).catch(() => {});
  };

  return (
    <TouchableOpacity
      activeOpacity={0.85}
      onPress={handlePress}
      style={[styles.tile, { width, height }]}
    >
      {isVisual(item) && source ? (
        <Image
          source={{ uri: source }}
          style={styles.tileImage}
          resizeMode="cover"
          blurRadius={available ? 0 : 2}
        />
      ) : (
        <View style={styles.fileTile}>
          <Ionicons
            name={item.fileCategory === 'audio' ? 'musical-notes' : 'document-text'}
            size={22}
            color="rgba(255,255,255,0.85)"
          />
          <Text style={styles.fileName} numberOfLines={1}>
            {item?.mediaMeta?.fileName || 'File'}
          </Text>
        </View>
      )}
      <TileOverlay
        item={item}
        hiddenCount={hiddenCount}
        available={available}
        downloading={downloading}
        progress={progress}
      />
    </TouchableOpacity>
  );
}

/**
 * WhatsApp-style album bubble (N attachments in ONE message).
 *   2 items  → 2 columns
 *   3 items  → 1 large on top + 2 below
 *   4 items  → 2 × 2 grid
 *   5+ items → 2 × 2 grid, last tile shows "+N"
 * While the album is sending, each tile shows its own upload state.
 */
export default function AlbumMessage({ message, onPressItem, isMine = false }) {
  const items = useMemo(
    () => (Array.isArray(message?.mediaItems) ? message.mediaItems : []),
    [message?.mediaItems],
  );

  const chatId = message?.chatId || message?.roomId || null;
  const messageId = message?.messageId || message?.serverMessageId
    || (message?._id?.$oid ? String(message._id.$oid) : message?._id) || message?.id || null;

  const shared = { onPressItem, isMine, chatId, messageId };

  if (!items.length) return null;

  const visible = items.slice(0, MAX_VISIBLE);
  const hidden = items.length - MAX_VISIBLE;
  const half = (GRID_WIDTH - GAP) / 2;

  if (items.length === 1) {
    return (
      <View style={styles.container}>
        <Tile item={visible[0]} index={0} width={GRID_WIDTH} height={GRID_WIDTH} hiddenCount={0} {...shared} />
      </View>
    );
  }

  if (items.length === 2) {
    return (
      <View style={[styles.container, styles.row]}>
        {visible.map((item, i) => (
          <Tile key={i} item={item} index={i} width={half} height={150} hiddenCount={0} {...shared} />
        ))}
      </View>
    );
  }

  if (items.length === 3) {
    return (
      <View style={styles.container}>
        <Tile item={visible[0]} index={0} width={GRID_WIDTH} height={140} hiddenCount={0} {...shared} />
        <View style={[styles.row, styles.rowGapTop]}>
          {visible.slice(1).map((item, i) => (
            <Tile key={i} item={item} index={i + 1} width={half} height={108} hiddenCount={0} {...shared} />
          ))}
        </View>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.row}>
        {visible.slice(0, 2).map((item, i) => (
          <Tile key={i} item={item} index={i} width={half} height={108} hiddenCount={0} {...shared} />
        ))}
      </View>
      <View style={[styles.row, styles.rowGapTop]}>
        {visible.slice(2).map((item, i) => (
          <Tile
            key={i}
            item={item}
            index={i + 2}
            width={half}
            height={108}
            hiddenCount={i === 1 ? hidden : 0}
            {...shared}
          />
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    width: GRID_WIDTH,
  },
  row: {
    flexDirection: 'row',
    gap: GAP,
  },
  rowGapTop: {
    marginTop: GAP,
  },
  tile: {
    borderRadius: 10,
    overflow: 'hidden',
    backgroundColor: 'rgba(0,0,0,0.25)',
  },
  tileImage: {
    width: '100%',
    height: '100%',
  },
  fileTile: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingHorizontal: 8,
    backgroundColor: 'rgba(0,0,0,0.35)',
  },
  fileName: {
    color: 'rgba(255,255,255,0.85)',
    fontSize: 10,
    fontFamily: 'Roboto-Regular',
    maxWidth: '100%',
  },
  dimOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.45)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  moreText: {
    color: '#fff',
    fontSize: 22,
    fontFamily: 'Roboto-Medium',
  },
  downloadCircle: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: 'rgba(0,0,0,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  progressText: {
    color: '#fff',
    fontSize: 11,
    fontFamily: 'Roboto-Medium',
    marginTop: 4,
  },
  playOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  },
  playCircle: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: 'rgba(0,0,0,0.5)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  playIcon: {
    marginLeft: 2,
  },
});
