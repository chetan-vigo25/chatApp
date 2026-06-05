import React, { useEffect, useRef, useState } from 'react';
import { Text, StyleSheet } from 'react-native';
import { useTheme } from '../../contexts/ThemeContext';

const fmt = (totalSec) => {
  const s = Math.max(0, Math.floor(totalSec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  const ss = String(sec).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
};

/**
 * Elapsed-time ticker for an active call. `startMs` is the answeredAt epoch.
 */
export default function CallTimer({ startMs, style }) {
  const { theme } = useTheme();
  const [elapsed, setElapsed] = useState(0);
  const intRef = useRef(null);

  useEffect(() => {
    if (!startMs) return undefined;
    const tick = () => setElapsed((Date.now() - startMs) / 1000);
    tick();
    intRef.current = setInterval(tick, 1000);
    return () => { if (intRef.current) clearInterval(intRef.current); };
  }, [startMs]);

  return (
    <Text style={[styles.timer, { color: theme.colors.textWhite }, style]}>
      {fmt(elapsed)}
    </Text>
  );
}

const styles = StyleSheet.create({
  timer: {
    fontFamily: 'Roboto-Medium',
    fontSize: 15,
    letterSpacing: 0.4,
    opacity: 0.9,
  },
});
