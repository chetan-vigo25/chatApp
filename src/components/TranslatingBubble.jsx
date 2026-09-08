/**
 * The "this bubble is being translated" placeholder.
 *
 * Changing the app language re-translates every visible message. ML Kit runs
 * on-device, so that is usually milliseconds — but the very first pass after a
 * switch (and any pass that has to wake a freshly downloaded model) is slow
 * enough to see. The two things the chat used to do in that window were both
 * bad: paint the sender's English and swap it a tick later, or hide the row
 * outright so the thread looked like it had lost messages.
 *
 * This is the third option: the bubble keeps its place, its timestamp and its
 * ticks, and only the BODY is replaced by shimmering bars until the translation
 * lands. Nothing jumps, nothing is unreadable-then-readable, and the user can
 * see that work is happening.
 *
 * Sizing is derived from the ORIGINAL text so the placeholder is roughly the
 * shape of the message it stands in for — a one-word message does not get a
 * three-line skeleton.
 *
 * The label is deliberately WORDLESS (a language glyph + typing dots). This is
 * the one moment in the app where we do not yet know how to write "Translating"
 * in the reader's language, so we don't try.
 */
import React, { useEffect, useMemo } from 'react';
import { Animated, Easing, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

/* ── one animation for every placeholder on screen ───────────────────────────
   A chat can hold a dozen of these at once right after a language switch.
   Giving each its own Animated.loop meant a dozen native animations doing the
   same thing, so they share ONE driver, started with the first placeholder and
   stopped with the last. */
const pulse = new Animated.Value(0);
let loop = null;
let live = 0;

function acquirePulse() {
  live += 1;
  if (!loop) {
    pulse.setValue(0);
    loop = Animated.loop(
      Animated.timing(pulse, {
        toValue: 1,
        duration: 1200,
        easing: Easing.linear,
        useNativeDriver: true,
      }),
    );
    loop.start();
  }
  return pulse;
}

function releasePulse() {
  live = Math.max(0, live - 1);
  if (live === 0 && loop) {
    loop.stop();
    loop = null;
  }
}

/**
 * Roughly how wide one line of bubble text is, in characters, at 15px.
 *
 * Kept deliberately short of the real line length: the bars sit in a row NEXT
 * to the timestamp + ticks inside a bubble capped at 80% of the screen, and a
 * fixed-width bar in that flex-shrinking column would be clipped rather than
 * wrapped if it asked for more room than the bubble has.
 */
const CHARS_PER_LINE = 26;
/** Average advance width of a character at the message font size. */
const CHAR_WIDTH = 7;
const MAX_LINES = 3;

/** Bar widths that trace the shape of the string being translated. */
function barsFor(text) {
  const length = Math.min((typeof text === 'string' ? text.trim().length : 0) || 8, CHARS_PER_LINE * MAX_LINES);
  const lines = Math.max(1, Math.min(MAX_LINES, Math.ceil(length / CHARS_PER_LINE)));
  return Array.from({ length: lines }, (_, i) => {
    const chars = Math.min(CHARS_PER_LINE, Math.max(4, length - i * CHARS_PER_LINE));
    return Math.round(chars * CHAR_WIDTH);
  });
}

// Staggered so the three dots read as "working", not as three blinking lights.
const DOT_RANGE = [0, 0.25, 0.5, 0.75, 1];
const DOT_OUTPUTS = [
  [1, 0.3, 0.3, 0.3, 1],
  [0.3, 1, 0.3, 0.3, 0.3],
  [0.3, 0.3, 1, 0.3, 0.3],
];

export default function TranslatingBubble({ text, isMyMessage, isDarkMode, theme }) {
  const bars = useMemo(() => barsFor(text), [text]);

  // Strictly paired: no "already started" guard, so React 18's double-invoked
  // dev effect (mount → cleanup → mount) ends with the loop RUNNING rather than
  // released by a cleanup that never gets a matching acquire.
  useEffect(() => {
    acquirePulse();
    return () => { releasePulse(); };
  }, []);

  // Outgoing bubbles are the theme colour, incoming ones the surface — so the
  // bars are drawn as a tint OF the bubble rather than a fixed grey, which
  // would go invisible on one of them.
  const barColor = isMyMessage
    ? 'rgba(255,255,255,0.30)'
    : (isDarkMode ? 'rgba(255,255,255,0.20)' : 'rgba(0,0,0,0.10)');
  const glyphColor = isMyMessage
    ? 'rgba(255,255,255,0.75)'
    : (isDarkMode ? 'rgba(233,237,239,0.65)' : theme?.colors?.placeHolderTextColor || '#8696A0');

  const barOpacity = useMemo(() => pulse.interpolate({
    inputRange: [0, 0.5, 1],
    outputRange: [0.55, 1, 0.55],
  }), []);
  const dotOpacities = useMemo(
    () => DOT_OUTPUTS.map((outputRange) => pulse.interpolate({ inputRange: DOT_RANGE, outputRange })),
    [],
  );

  return (
    <View
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel="Translating message"
      style={{ paddingVertical: 2 }}
    >
      {bars.map((width, index) => (
        <Animated.View
          key={`tbar_${index}`}
          style={{
            width,
            height: 10,
            borderRadius: 5,
            backgroundColor: barColor,
            marginBottom: index === bars.length - 1 ? 0 : 6,
            opacity: barOpacity,
          }}
        />
      ))}
      <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 7 }}>
        <Ionicons name="language-outline" size={12} color={glyphColor} />
        <View style={{ flexDirection: 'row', alignItems: 'center', marginLeft: 5 }}>
          {dotOpacities.map((opacity, index) => (
            <Animated.View
              key={`tdot_${index}`}
              style={{
                width: 4,
                height: 4,
                borderRadius: 2,
                marginRight: index === dotOpacities.length - 1 ? 0 : 3,
                backgroundColor: glyphColor,
                opacity,
              }}
            />
          ))}
        </View>
      </View>
    </View>
  );
}
