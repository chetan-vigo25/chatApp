# WhatsApp-style Keyboard Feature — Setup & Re-apply Guide

This documents the keyboard upgrade we added so the chat **input bar moves glued to the keyboard** (60fps, no jump, no gap) on Android + iOS — exactly like WhatsApp.

> **Use this when:** you replace/update the `src` folder with new code and need to re-apply the same keyboard behavior.
> Hinglish: `src` folder update karne ke baad, neeche diye 4 changes dobara apply karo — bas same keyboard kaam karega.

---

## What this feature does

- Input bar rises/falls **perfectly synced** with the native keyboard (frame-by-frame).
- **No layout jump** on Android (fixes the old double-compensation bug).
- **No gap** between the input bar and the keyboard (nav-bar inset handled).
- Emoji panel still swaps cleanly with the keyboard.

## Library used

`react-native-keyboard-controller` (installed via `npx expo install`). It needs Reanimated v3/v4 + worklets, which the project already has.

---

## ⚙️ Prerequisites (already true in this repo, verify after src update)

```
react-native-reanimated  : ~4.x   (installed)
react-native-worklets    : ~0.7.x (installed, peer of reanimated v4)
react-native-safe-area-context : ~5.x (installed)
```

If a fresh `src` somehow removes these from `package.json`, reinstall:

```bash
npx expo install react-native-reanimated react-native-safe-area-context
```

---

## 🔧 Re-apply in 4 steps

### Step 1 — Install the library

```bash
npx expo install react-native-keyboard-controller
```

> This is a **native** module. After installing you MUST rebuild the dev app (see Step 5). It will NOT work via Expo Go.

---

### Step 2 — `babel.config.js` (worklets plugin MUST be last)

> ⚠️ The original file had a **duplicate `plugins:` key** bug — the second key silently overrode the first, so the Reanimated/Worklets plugin never ran. Merge into ONE `plugins` array with the worklets plugin **last**.

**Final file:**

```js
module.exports = function(api) {
    api.cache(true);
    return {
      presets: ['babel-preset-expo'],
      plugins: [
        [
          "module:react-native-dotenv",
          {
            moduleName: "@env",
            path: ".env",
            allowUndefined: true,
          }
        ],
        // Reanimated/Worklets plugin MUST be listed last.
        "react-native-worklets/plugin",
      ]
    };
  };
```

> After editing babel config, restart Metro with `--clear`.

---

### Step 3 — `App.js` (wrap the app in `KeyboardProvider`)

**Add the import** (near the other top imports):

```js
import { KeyboardProvider } from 'react-native-keyboard-controller';
```

**Wrap the tree** — place `KeyboardProvider` just inside `SafeAreaProvider`, around everything:

```jsx
return (
    <SafeAreaProvider>
     <KeyboardProvider statusBarTranslucent navigationBarTranslucent>
       <ThemeProvider>
         {/* ...all existing providers + AppContent... */}
       </ThemeProvider>
     </KeyboardProvider>
    </SafeAreaProvider>
);
```

> `statusBarTranslucent` + `navigationBarTranslucent` are needed because the app is **edge-to-edge** on Android, so keyboard height accounts for the system bars.

---

### Step 4 — `src/screens/chats/ChatScreen.jsx` (4 edits)

**4a. Add imports** (after the gesture-handler import):

```js
import Reanimated, { useAnimatedStyle } from 'react-native-reanimated';
import { useReanimatedKeyboardAnimation } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
```

**4b. Add the keyboard hook + animated style** (inside the `ChatScreen` component, near the old `keyboardHeight` state). Keep the `keyboardHeight` state — the emoji panel still uses it.

```js
const [keyboardHeight, setKeyboardHeight] = useState(0);
// Frame-synced keyboard height from react-native-keyboard-controller. Tracks the
// native keyboard 1:1 on iOS + Android (60fps, no jump). `height` is negative
// while the keyboard is up; we subtract the bottom inset so the input sits flush
// against the keyboard (no nav-bar gap). Clamped at 0 so resting layout is unchanged.
const { height: kbHeightSV } = useReanimatedKeyboardAnimation();
const insets = useSafeAreaInsets();
const rootKeyboardStyle = useAnimatedStyle(() => ({
  paddingBottom: Math.max(0, Math.abs(kbHeightSV.value) - insets.bottom),
}), [insets.bottom]);
```

> ❌ **Remove** the old `keyboardAnim` ref if it exists:
> `const keyboardAnim = useRef(new Animated.Value(0)).current;`

**4c. Simplify the keyboard listener effect.** The native movement is now driven by `rootKeyboardStyle`. These listeners ONLY capture the resting height (for the emoji panel) + focus state. **Replace** the entire old `Keyboard.addListener` effect (the one that did `Animated.timing(keyboardAnim, ...)` / `keyboardAnim.setValue(...)`) with:

```js
// The live keyboard movement is driven by react-native-keyboard-controller via
// `rootKeyboardStyle`. These listeners only (a) capture the resting keyboard
// height so the emoji panel can match it, and (b) keep focus/emoji UI state.
useEffect(() => {
  const isIOS = Platform.OS === 'ios';
  const showEvent = isIOS ? 'keyboardDidShow' : 'keyboardDidShow';
  const hideEvent = isIOS ? 'keyboardWillHide' : 'keyboardDidHide';

  const showSub = Keyboard.addListener(showEvent, (event) => {
    const nextHeight = event?.endCoordinates?.height || 0;
    if (nextHeight > 0) setKeyboardHeight(nextHeight);
    setIsInputFocused(true);
    setShowEmojiPanel(false);
  });

  const hideSub = Keyboard.addListener(hideEvent, () => {
    setIsInputFocused(false);
  });

  return () => {
    showSub.remove();
    hideSub.remove();
  };
}, []);
```

**4d. Swap the root view** from RN `Animated.View` to the keyboard-driven `Reanimated.View`.

Find the screen's root wrapper (the one that used `paddingBottom: keyboardAnim`) and change:

```jsx
{/* BEFORE */}
<Animated.View style={{ flex: 1, paddingBottom: keyboardAnim }}>
  ...
</Animated.View>
```

to:

```jsx
{/* AFTER */}
<Reanimated.View style={[{ flex: 1 }, rootKeyboardStyle]}>
  ...
</Reanimated.View>
```

> ⚠️ Also update its **closing tag** from `</Animated.View>` to `</Reanimated.View>`.
> Everything inside (header, message list, input bar, emoji panel) stays the same.

---

### Step 5 — Rebuild the native app (REQUIRED)

Because a native module was added, the dev client must be recompiled:

```bash
npx expo run:android      # or: npx expo run:ios
```

Then start Metro with a cleared cache (babel changed):

```bash
npx expo start --dev-client --clear
```

---

## ✅ How to verify it works

1. Open a chat, tap the message input → the bar rises **glued to the keyboard**, no jump, no gap (top edge of keyboard touches the input).
2. Close the keyboard → input falls back smoothly, resting position unchanged.
3. Tap the emoji button while the keyboard is open → clean swap to the emoji panel.
4. Tap the input from the emoji panel → keyboard returns smoothly.

---

## 🧠 Why these specific changes (the bug we fixed)

| Problem (before) | Cause | Fix |
|---|---|---|
| Input **jumped** on Android | `adjustResize` + edge-to-edge resized the window **and** code added `paddingBottom: keyboardHeight` → double offset | keyboard-controller now owns the movement; manual padding removed |
| **Gap** between input and keyboard | keyboard height included the nav-bar region, but content rests above the nav bar | subtract `insets.bottom` in `rootKeyboardStyle` |
| Reanimated worklets not running | `babel.config.js` had a **duplicate `plugins` key** | merged into one array, worklets plugin **last** |

---

## 📂 Files touched (checklist)

- [ ] `package.json` — `react-native-keyboard-controller` added (via `expo install`)
- [ ] `babel.config.js` — single `plugins` array, `react-native-worklets/plugin` last
- [ ] `App.js` — `KeyboardProvider` import + wrapper (with translucent flags)
- [ ] `src/screens/chats/ChatScreen.jsx` — imports, `useReanimatedKeyboardAnimation` + `useSafeAreaInsets` + `rootKeyboardStyle`, simplified `Keyboard` listener, root `Animated.View` → `Reanimated.View`
- [ ] Native rebuild (`expo run:android` / `expo run:ios`) + Metro `--clear`

---

## ♻️ Want the same on other screens?

If a new chat-like screen needs the same behavior, just:
1. Make sure `KeyboardProvider` is at the app root (Step 3 — already global).
2. In that screen, add `useReanimatedKeyboardAnimation()` + `useSafeAreaInsets()` + the `rootKeyboardStyle`, and wrap its root in `<Reanimated.View style={[{flex:1}, rootKeyboardStyle]}>`.

No extra install or rebuild needed after the first time.
