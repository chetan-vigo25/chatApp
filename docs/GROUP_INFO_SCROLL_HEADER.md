# Group Info — Collapsing Scroll Header

This documents the WhatsApp/Telegram-style **collapsing header** on the Group Info screen: at the top you see the teal hero with floating round buttons; as you **scroll up**, a solid header bar with the **group name** fades in behind the back/edit buttons (so they're never left hovering over white content).

> **Use this when:** you replace/update the `src` folder and need to re-apply the same scroll header.
> Hinglish: Group Info screen pe scroll karte hi upar solid header + group name aata hai. `src` update ke baad neeche ke changes dobara lagao.

**File:** `src/screens/group/GroupInfo.jsx`

> ✅ This is **JS-only** (RN `Animated`). No new library, no native rebuild — just Metro fast refresh.

---

## ⚠️ The one gotcha that breaks it

The list MUST be **`Animated.ScrollView`**, not a plain `ScrollView`. With a native-driven `onScroll` (`useNativeDriver: true`) a plain `ScrollView` throws:

```
TypeError: _this.props.onScroll is not a function (it is Object)
```

So when you re-apply, remember to swap **both** the opening tag and the closing tag of the MAIN scroll view (leave any ScrollView inside a Modal alone).

---

## 🔧 Re-apply in 4 edits

### Edit 1 — Add scroll tracking (near the existing `fadeAnim` ref)

`HERO_H` already exists at the top of the file (`const HERO_H = Math.min(SCREEN_W, 380);`). Add:

```js
const fadeAnim = useRef(new Animated.Value(0)).current;
// Scroll position drives the collapsing header: the solid header bar + title
// fade in once the hero has scrolled mostly off, so the back/edit buttons
// never hover detached over the white content below.
const scrollY = useRef(new Animated.Value(0)).current;
const headerSolidOpacity = scrollY.interpolate({
  inputRange: [HERO_H * 0.3, HERO_H * 0.55],
  outputRange: [0, 1],
  extrapolate: 'clamp',
});
const headerTitleOpacity = scrollY.interpolate({
  inputRange: [HERO_H * 0.42, HERO_H * 0.62],
  outputRange: [0, 1],
  extrapolate: 'clamp',
});
// Inverse of the solid fade — drives the over-hero (white icon on dark circle)
// button layer so it fades OUT as the clean solid-header layer fades in.
const headerHeroOpacity = scrollY.interpolate({
  inputRange: [HERO_H * 0.3, HERO_H * 0.55],
  outputRange: [1, 0],
  extrapolate: 'clamp',
});
```

> Lower multipliers = header solidifies **sooner** on scroll (less gap/half-state). Tune via `HERO_H * 0.3 / 0.55 / 0.42 / 0.62`.

---

### Edit 2 — Add the fading solid background + title inside the floating header

Replace the existing floating-header block (`<View style={[styles.floatingHeaderSafe, ...]}>`) with this version. It adds (a) a `pageBg` background layer that fades in, and (b) the group-name title between the back and edit buttons.

```jsx
<View style={[styles.floatingHeaderSafe, { paddingTop: Platform.OS === 'android' ? Math.max(insets.top, STATUS_H) : 8 }]}>
  {/* Solid header surface — transparent over the hero, fades in on scroll */}
  <Animated.View
    pointerEvents="none"
    style={[
      StyleSheet.absoluteFill,
      {
        backgroundColor: pageBg,
        opacity: headerSolidOpacity,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: theme.colors.borderColor || 'rgba(0,0,0,0.08)',
        elevation: 4,
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.08,
        shadowRadius: 4,
      },
    ]}
  />
  <View style={styles.floatingHeaderRow}>
    <TouchableOpacity onPress={() => navigation.goBack()} activeOpacity={0.7} style={styles.floatingBtnTouch}>
      {/* over the hero: white icon on a dark translucent circle */}
      <Animated.View style={[styles.floatingBtnLayer, styles.floatingBtnCircle, { opacity: headerHeroOpacity }]}>
        <FontAwesome6 name="arrow-left" size={18} color="#fff" />
      </Animated.View>
      {/* on the solid header: clean dark icon, no circle */}
      <Animated.View pointerEvents="none" style={[styles.floatingBtnLayer, { opacity: headerSolidOpacity }]}>
        <FontAwesome6 name="arrow-left" size={20} color={theme.colors.primaryTextColor} />
      </Animated.View>
    </TouchableOpacity>
    <Animated.Text
      numberOfLines={1}
      style={[styles.floatingHeaderTitle, { color: theme.colors.primaryTextColor, opacity: headerTitleOpacity }]}
    >
      {groupName}
    </Animated.Text>
    {canEditGroup ? (
      <TouchableOpacity onPress={() => navigation.navigate('EditGroup', { groupId })} activeOpacity={0.7} style={styles.floatingBtnTouch}>
        <Animated.View style={[styles.floatingBtnLayer, styles.floatingBtnCircle, { opacity: headerHeroOpacity }]}>
          <Ionicons name="create-outline" size={18} color="#fff" />
        </Animated.View>
        <Animated.View pointerEvents="none" style={[styles.floatingBtnLayer, { opacity: headerSolidOpacity }]}>
          <Ionicons name="create-outline" size={22} color={theme.colors.primaryTextColor} />
        </Animated.View>
      </TouchableOpacity>
    ) : (
      <View style={styles.floatingBtnTouch} />
    )}
  </View>
</View>
```

> The buttons **cross-fade**: white-icon-on-dark-circle over the hero → clean dark icon (no circle) on the solid header — exactly like WhatsApp. Driven by `headerHeroOpacity` (out) and `headerSolidOpacity` (in).
> The empty `<View style={styles.floatingBtnTouch} />` (when `canEditGroup` is false) keeps the title balanced.

---

### Edit 3 — Swap `ScrollView` → `Animated.ScrollView` and wire `onScroll`

**Opening tag** — the MAIN content scroll view (the one right after the floating header):

```jsx
<Animated.ScrollView
  showsVerticalScrollIndicator={false}
  contentContainerStyle={{ paddingBottom: 100 }}
  scrollEventThrottle={16}
  onScroll={Animated.event([{ nativeEvent: { contentOffset: { y: scrollY } } }], { useNativeDriver: true })}
>
```

**Closing tag** — change that same scroll view's close from `</ScrollView>` to:

```jsx
</Animated.ScrollView>
```

> ⚠️ There's another `<ScrollView>` inside the Transfer-Ownership **Modal** — leave that one as plain `ScrollView`.

---

### Edit 4 — Add the title style (in the `StyleSheet.create({...})` block)

Add right after the `floatingBtn` style:

```js
// Cross-fading header button (over-hero ↔ solid-header)
floatingBtnTouch: {
  width: 40,
  height: 40,
  alignItems: 'center',
  justifyContent: 'center',
},
floatingBtnLayer: {
  position: 'absolute',
  width: 40,
  height: 40,
  alignItems: 'center',
  justifyContent: 'center',
},
floatingBtnCircle: {
  borderRadius: 20,
  backgroundColor: 'rgba(0,0,0,0.35)',
},
floatingHeaderTitle: {
  flex: 1,
  fontFamily: 'Roboto-SemiBold',
  fontSize: 17,
  marginHorizontal: 12,
  textTransform: 'capitalize',
},
```

---

## ✅ Verify

1. Open Group Info — top shows the teal hero with floating round buttons (as before).
2. Scroll up → a solid header bar with the **group name** smoothly fades in behind the buttons.
3. Scroll back to top → header fades back to transparent. No flicker, no jump.

---

## 🧠 Why

The screen had floating dark-circle buttons absolutely positioned over a hero image, but **no solid header appeared on scroll** — so once the teal hero scrolled away, the buttons hovered over white content. We added a scroll-driven solid background + title that fade in, native-driven (`useNativeDriver: true`) for 60fps.

## 📂 Files touched (checklist)

- [ ] `src/screens/group/GroupInfo.jsx` — `scrollY` + 2 interpolations, fading solid header bg + title, `ScrollView` → `Animated.ScrollView` (main one only), `floatingHeaderTitle` style.
- [ ] No install, no rebuild — just fast refresh.
