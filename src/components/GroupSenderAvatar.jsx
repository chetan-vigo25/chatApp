import React, { useEffect, useState } from 'react';
import { Image, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { usePeerProfileName } from '../services/peerProfileNameStore';
import {
  avatarNameSource, getAvatarColor, getAvatarInitial, shouldShowAvatarInitial, UNSAVED_AVATAR_BG,
} from '../utils/avatarIdentity';

/**
 * The small sender avatar beside a received group message.
 *
 * Same rule as the chat list (utils/avatarIdentity): photo when there is one
 * (and it loads); otherwise the first letter of the sender's OWN profile name,
 * even while their label is a number or an "@handle". It used to take
 * charAt(0) of the label, which drew "@" for a hidden sender and "+" for a
 * number.
 */
const GroupSenderAvatar = ({ userId, uri, label, senderName, size = 30 }) => {
  const [failedUri, setFailedUri] = useState(null);
  useEffect(() => { setFailedUri(null); }, [uri]);
  const photo = uri && uri !== failedUri ? uri : null;
  const profileName = usePeerProfileName(userId, !photo);
  const source = avatarNameSource({ profileName: profileName || senderName, displayName: label });
  const radius = size / 2;

  if (photo) {
    return (
      <Image
        source={{ uri: photo }}
        onError={() => setFailedUri(photo)}
        style={{ width: size, height: size, borderRadius: radius }}
      />
    );
  }
  if (!shouldShowAvatarInitial(source)) {
    return (
      <View style={{ width: size, height: size, borderRadius: radius, backgroundColor: UNSAVED_AVATAR_BG, alignItems: 'center', justifyContent: 'center' }}>
        <Ionicons name="person" size={size * 0.55} color="#fff" />
      </View>
    );
  }
  return (
    <View style={{ width: size, height: size, borderRadius: radius, backgroundColor: getAvatarColor(userId || source), alignItems: 'center', justifyContent: 'center' }}>
      <Text style={{ color: '#fff', fontFamily: 'Roboto-SemiBold', fontSize: size * 0.43 }}>
        {getAvatarInitial(source)}
      </Text>
    </View>
  );
};

export default React.memo(GroupSenderAvatar);
