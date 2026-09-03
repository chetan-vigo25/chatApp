# ThemeContext — Portable Implementation Guide

Is app ka **poora theme system** (light / dark / system + user-selectable accent
color) kaise bana hai, aur **dusre React Native app me bilkul isi tarah** kaise
lagana hai — step by step, copy-paste ready.

Source of truth is app me: [`src/contexts/ThemeContext.js`](../src/contexts/ThemeContext.js)

> **Ye guide self-contained hai.** Neeche jo code blocks hain unhe waise ka waisa
> naye app me paste karo — koi chat-app-specific dependency nahi hai. Sirf
> `AsyncStorage` chahiye, baaki sab React Native core hai.

---

## 0. Ye system karta kya hai

| Capability | Detail |
|---|---|
| 3 theme modes | **System** (OS follow kare), **Light**, **Dark** — manual choice persist hoti hai |
| Persistence | `AsyncStorage` key `theme` (`'dark'` / `'light'`) — key absent = system mode |
| Live OS sync | `Appearance.addChangeListener` — sirf tab jab user ne manual theme set nahi ki |
| Background sync | `AppState` — app foreground me aate hi OS theme dobara padhta hai (Section 6) |
| User accent color | `chatColor`, AsyncStorage key `selectedColor`, default = brand color |
| Design tokens | `colors`, `fonts`, `fontSizes`, `spacing`, `radii` — ek hi jagah |
| No-flash boot | `isLoading` flag — persisted theme padhne tak pehla frame hold hota hai |
| Bridges | React Navigation theme + react-native-paper theme dono sync rehte hain |
| Safe fallback | Provider ke bahar `useTheme()` call kare to crash nahi, light theme milta hai |

**Design rule jo mat todna:** koi bhi screen `isDarkMode` dekh kar `if/else`
color na chune. Screen sirf **token** padhe (`theme.colors.background`), aur dono
themes me us token ki value alag ho. Isi wajah se naya token add karna = dono
theme objects me ek line, aur poori app apne aap sahi ho jati hai.

---

## 1. Dependencies

```bash
npm i @react-native-async-storage/async-storage
```

Bas. `Appearance` aur `AppState` React Native core me hain.

Optional bridges (agar tumhare app me ye libs hain):

```bash
npm i @react-navigation/native react-native-paper expo-status-bar
```

---

## 2. Step 1 — `src/contexts/ThemeContext.js`

Ye poori file hai. Sirf `BRAND` color aur `fonts` apne app ke hisaab se badlo.

```jsx
import React, { createContext, useContext, useState, useEffect, useRef } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Appearance, AppState } from 'react-native';

const ThemeContext = createContext();

// Brand/accent color — ek hi source of truth. FAB, send button, links, active
// tab, sab yahi use karte hain. Ye default `chatColor` bhi hai.
const BRAND = '#03b0a2';

// App-wide font family. Jo bhi component theme.fonts padhega use ye milega,
// OS ka "System" font nahi. (Naye app me apne font names daalo.)
const fonts = {
  thin: 'Roboto-Light',
  light: 'Roboto-Light',
  regular: 'Roboto-Regular',
  medium: 'Roboto-Medium',
  semibold: 'Roboto-SemiBold',
  bold: 'Roboto-Bold',
};

// Type scale — naya code raw number (13, 17, 19...) na likhe, isme se closest
// step uthaye. Warna 14+ ad-hoc sizes ho jate hain.
const fontSizes = {
  caption: 11,
  small: 12,
  body: 14,
  subtitle: 15,
  title: 16,
  heading: 18,
  large: 22,
};

const spacing = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 };
const radii = { sm: 6, md: 10, lg: 16, pill: 999 };

// Surfaces jo DONO themes me dark rehti hain by design (media viewer, camera,
// video call). Naam diya hai taki decision dikhe — inhe kabhi mode-dependent
// tokens me flatten mat karna.
export const alwaysDark = {
  background: '#000000',
  surface: '#1F2C34',
  text: '#ffffff',
  textMuted: 'rgba(255,255,255,0.7)',
  scrim: 'rgba(0,0,0,0.5)',
};

// User-chosen accent pe text readable rahe: light accent -> dark ink,
// dark accent -> white ink.
export const isLightColor = (hex) => {
  if (typeof hex !== 'string') return false;
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  if (full.length < 6) return false;
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  return 0.299 * r + 0.587 * g + 0.114 * b > 160;
};
export const onColorFor = (hex) => (isLightColor(hex) ? '#0B141A' : '#E9EDEF');
export const metaOnColorFor = (hex) =>
  isLightColor(hex) ? 'rgba(11,20,26,0.62)' : 'rgba(255,255,255,0.65)';

// Accent-colored surface ka background: user ka custom color jeetega, warna
// theme ka apna token.
export const sentBubbleBgFor = (chatColor, theme) =>
  chatColor && chatColor !== BRAND ? chatColor : theme.colors.bubbleSent;

// ---------------------------------------------------------------- LIGHT
const lightTheme = {
  colors: {
    background: '#ffffff',
    primaryTextColor: '#0B141A',
    textColor: '#0B141A',            // alias — kuch call sites ye naam padhte hain
    secondaryTextColor: '#667781',
    muted: '#667781',
    textWhite: '#ffffff',
    themeColor: BRAND,
    primary: BRAND,                  // alias
    onAccent: '#ffffff',
    placeHolderTextColor: '#a9a9a9',
    borderColor: '#e6e6e6',
    border: '#e6e6e6',
    divider: 'rgba(0,0,0,0.06)',
    menuBackground: '#f5f5f5',
    cardBackground: '#ffffff',
    surface: '#f5f6f6',
    headerBackground: '#ffffff',
    iconColor: '#54656f',
    danger: '#e53935',
    success: BRAND,
    warning: '#B26A00',
    info: '#0277BD',
    scrim: 'rgba(0,0,0,0.5)',
    shadow: '#000000',
    readReceipt: '#53BDEB',
    bubbleSent: '#03574f',
    bubbleSentText: '#E9EDEF',
    chatBackground: '#F6F3EE',
    bubbleReceived: '#ffffff',
    bubbleDeleted: '#f5f5f5',
    bubbleMeta: '#5B6B75',
    replyHighlight: '#D19D00',
    disabledOpacity: 0.4,
  },
  fonts,
  fontSizes,
  spacing,
  radii,
};

// ---------------------------------------------------------------- DARK
// Same token names, dark-appropriate values — taki contrast bana rahe.
const darkTheme = {
  colors: {
    background: '#000000',
    primaryTextColor: '#ffffff',
    textColor: '#ffffff',
    secondaryTextColor: '#8696a0',
    muted: '#8696a0',
    textWhite: '#ffffff',
    themeColor: BRAND,
    primary: BRAND,
    onAccent: '#ffffff',
    placeHolderTextColor: '#8696a0',
    borderColor: '#2A3942',
    border: '#2A3942',
    divider: 'rgba(255,255,255,0.08)',
    menuBackground: '#16222C',
    cardBackground: '#16222C',
    surface: '#1F2C33',
    headerBackground: '#1F2C33',
    iconColor: '#aebac1',
    danger: '#ff6b6b',
    success: BRAND,
    warning: '#FFC107',
    info: '#53BDEB',
    scrim: 'rgba(0,0,0,0.5)',
    // #000 pe shadow dikhti hi nahi — dark me elevation `divider` border se
    // dikhati hai. shadow transparent rakho taki light-mode shadow styles
    // dark me keechad na banayein.
    shadow: 'transparent',
    readReceipt: '#53BDEB',
    bubbleSent: '#03574f',
    bubbleSentText: '#E9EDEF',
    chatBackground: '#000000',
    bubbleReceived: '#151E23',
    bubbleDeleted: '#101519',
    bubbleMeta: '#8696a0',
    replyHighlight: '#FFC107',
    disabledOpacity: 0.55,
  },
  fonts,
  fontSizes,
  spacing,
  radii,
};

export const defaultTheme = lightTheme;

export const ThemeProvider = ({ children }) => {
  const [isDarkMode, setIsDarkMode] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [chatColor, setChatColor] = useState(BRAND);
  const [hasManualTheme, setHasManualTheme] = useState(false);

  // hasManualTheme ka ref — AppState/Appearance listeners stale closure me
  // fasenge nahi (Section 6 padho).
  const manualRef = useRef(false);
  useEffect(() => { manualRef.current = hasManualTheme; }, [hasManualTheme]);

  // 1) Boot: saved theme + accent color padho
  useEffect(() => {
    const initializeTheme = async () => {
      try {
        const savedTheme = await AsyncStorage.getItem('theme');
        const savedChatColor = await AsyncStorage.getItem('selectedColor');

        if (savedChatColor !== null) setChatColor(savedChatColor);

        if (savedTheme !== null) {
          // User ne manually theme choose ki hui hai
          setIsDarkMode(savedTheme === 'dark');
          setHasManualTheme(true);
        } else {
          // Kuch saved nahi -> system follow karo
          setIsDarkMode(Appearance.getColorScheme() === 'dark');
          setHasManualTheme(false);
        }
      } catch (error) {
        console.error('Error loading theme:', error);
        setIsDarkMode(Appearance.getColorScheme() === 'dark');
      } finally {
        setIsLoading(false);
      }
    };
    initializeTheme();
  }, []);

  // 2) OS theme change live suno — sirf system mode me
  useEffect(() => {
    const subscription = Appearance.addChangeListener(({ colorScheme }) => {
      if (!manualRef.current) setIsDarkMode(colorScheme === 'dark');
    });
    return () => subscription.remove();
  }, []);

  // 3) AppState: app wapas foreground me aaye to OS theme dobara padho.
  //    Kyun zaroori hai — Section 6.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state !== 'active') return;
      if (manualRef.current) return;               // manual choice OS se overwrite na ho
      setIsDarkMode(Appearance.getColorScheme() === 'dark');
    });
    return () => sub.remove();
  }, []);

  // 4) Manual toggle
  const toggleTheme = async () => {
    try {
      const newTheme = !isDarkMode;
      setIsDarkMode(newTheme);
      setHasManualTheme(true);
      await AsyncStorage.setItem('theme', newTheme ? 'dark' : 'light');
    } catch (error) {
      console.error('Error saving theme:', error);
    }
  };

  // Explicit set (settings screen ke Light / Dark buttons)
  const setTheme = async (isDark) => {
    try {
      setIsDarkMode(isDark);
      setHasManualTheme(true);
      await AsyncStorage.setItem('theme', isDark ? 'dark' : 'light');
    } catch (error) {
      console.error('Error saving theme:', error);
    }
  };

  // Wapas System mode pe — key hatao, matlab "koi manual choice nahi"
  const resetThemeToSystem = async () => {
    try {
      setHasManualTheme(false);
      setIsDarkMode(Appearance.getColorScheme() === 'dark');
      await AsyncStorage.removeItem('theme');
    } catch (error) {
      console.error('Error resetting theme:', error);
    }
  };

  // 5) Accent / chat color
  const updateChatColor = async (color) => {
    try {
      setChatColor(color);
      await AsyncStorage.setItem('selectedColor', color);
    } catch (error) {
      console.error('Error saving chat color:', error);
    }
  };

  const resetChatColor = async () => {
    try {
      await AsyncStorage.removeItem('selectedColor');
      setChatColor(lightTheme.colors.themeColor);
    } catch (error) {
      console.error('Error resetting chat color:', error);
    }
  };

  const theme = isDarkMode ? darkTheme : lightTheme;

  const value = {
    theme: {
      ...theme,
      colors: { ...theme.colors, chatColor: chatColor || theme.colors.themeColor },
    },
    isDarkMode,
    toggleTheme,
    setTheme,
    resetThemeToSystem,
    updateChatColor,
    resetChatColor,
    chatColor,
    isLoading,
    hasManualTheme, // settings me "System" vs "Manual" dikhane ke liye
  };

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
};

// Provider ke bahar call ho jaye to crash nahi — safe light-theme fallback.
// (Isi wajah se koi utility/modal jo tree ke bahar render hota hai wo bhi
// bina guard ke useTheme() kar sakta hai.)
export const useTheme = () => {
  const context = useContext(ThemeContext);
  if (!context) {
    return {
      theme: defaultTheme,
      isDarkMode: false,
      toggleTheme: () => {},
      setTheme: () => {},
      resetThemeToSystem: () => {},
      isLoading: false,
      hasManualTheme: false,
    };
  }
  return context;
};

export default ThemeContext;
```

---

## 3. Step 2 — Provider ko sahi jagah mount karo (`App.js`)

`ThemeProvider` **sabse upar** hona chahiye — har wo provider/UI jo theme padhta
hai uske andar aaye.

```jsx
import { ThemeProvider, useTheme } from './src/contexts/ThemeContext';

export default function App() {
  return (
    <SafeAreaProvider>
      <ThemeProvider>          {/* <-- sabse bahar */}
        <ThemedPaperProvider>  {/* optional, Section 5 */}
          <AppContent />
        </ThemedPaperProvider>
      </ThemeProvider>
    </SafeAreaProvider>
  );
}
```

**Rule:** `ThemeProvider` ke bahar koi aisa component mat rakho jo color dikhata
ho. Is app me order hai
`ShareIntentProvider → SafeAreaProvider → KeyboardProvider → ThemeProvider → LanguageProvider → … → AppContent`
(dekho [`App.js:117-157`](../App.js#L117-L157)).

---

## 4. Step 3 — Pehla frame hold karo + StatusBar (`AppContent`)

Ye **sabse zaroori step** hai. `isDarkMode` `false` se boot hota hai, isliye agar
tum `isLoading` pe render hold nahi karoge to dark-mode user ko **har cold start
pe white flash** dikhega.

```jsx
import { StatusBar } from 'expo-status-bar';
import { useTheme } from '../contexts/ThemeContext';

export default function AppContent() {
  const { theme, isDarkMode, isLoading: themeLoading } = useTheme();
  const [fontsLoaded] = useFonts({ /* ... */ });

  // Persisted theme padhne tak kuch mat dikhao — warna dark users ko
  // har cold start pe light UI ka flash milega.
  if (!fontsLoaded || themeLoading) return null;

  return (
    <SafeAreaProvider style={{ flex: 1, backgroundColor: theme.colors.background }}>
      <RootNavigator />
      {/* StatusBar icons theme ke ulta rang ke — dark bg pe light icons */}
      <StatusBar style={isDarkMode ? 'light' : 'dark'} />
    </SafeAreaProvider>
  );
}
```

Bare React Native me `expo-status-bar` na ho to:

```jsx
import { StatusBar } from 'react-native';
<StatusBar
  barStyle={isDarkMode ? 'light-content' : 'dark-content'}
  backgroundColor={theme.colors.headerBackground}
/>
```

---

## 5. Step 4 — Library bridges (warna half app light rahega)

Third-party libs apna **khud ka** theme padhte hain, tumhara context nahi. Har
aisi lib ko bridge chahiye.

### React Navigation

```jsx
const { theme, isDarkMode } = useTheme();

<NavigationContainer
  theme={{
    dark: isDarkMode,
    colors: {
      primary: theme.colors.themeColor,
      background: theme.colors.background,
      card: theme.colors.surface,
      text: theme.colors.primaryTextColor,
      border: theme.colors.border,
      notification: theme.colors.themeColor,
    },
    // React Navigation 7 me `fonts` MANDATORY hai custom theme pe —
    // bina iske header/label components crash ya fallback karte hain.
    fonts: {
      regular: { fontFamily: theme.fonts.regular, fontWeight: '400' },
      medium:  { fontFamily: theme.fonts.medium,  fontWeight: '500' },
      bold:    { fontFamily: theme.fonts.bold,    fontWeight: '700' },
      heavy:   { fontFamily: theme.fonts.bold,    fontWeight: '800' },
    },
  }}
>
  <Stack.Navigator
    screenOptions={{
      headerShown: false,
      cardStyle: { backgroundColor: theme.colors.background },
    }}
  >
  {/* ... */}
  </Stack.Navigator>
</NavigationContainer>
```

Reference: [`src/navigations/RootNavigator.js:74-110`](../src/navigations/RootNavigator.js#L74-L110)

### react-native-paper

Paper ke `Portal` / `Dialog` / `Menu` / `Snackbar` apni MD3 theme se render hote
hain. Bina bridge ke wo dark mode me bhi **light** rahenge.

```jsx
import { Provider as PaperProvider, MD3DarkTheme, MD3LightTheme } from 'react-native-paper';

// ThemeProvider ke ANDAR hona chahiye taki theme switch pe re-render ho.
const ThemedPaperProvider = ({ children }) => {
  const { theme, isDarkMode } = useTheme();
  const base = isDarkMode ? MD3DarkTheme : MD3LightTheme;
  return (
    <PaperProvider
      theme={{
        ...base,
        colors: {
          ...base.colors,
          primary: theme.colors.themeColor,
          background: theme.colors.background,
          surface: theme.colors.surface,
          onSurface: theme.colors.primaryTextColor,
          outline: theme.colors.border,
          error: theme.colors.danger,
        },
      }}
    >
      {children}
    </PaperProvider>
  );
};
```

Reference: [`App.js:35-51`](../App.js#L35-L51)

---

## 6. AppState — kyun chahiye aur kya karta hai

Sirf `Appearance.addChangeListener` kaafi **nahi** hai:

* Android pe app background me ho tab user Settings me jaa kar dark mode toggle
  kare — JS listener ya to fire hi nahi hota, ya app suspended hone ki wajah se
  event drop ho jata hai. App wapas kholte hi purani theme dikhti hai.
* iOS pe auto (sunset/sunrise) dark mode background me switch hota hai; app
  wapas aane pe UI stale ho sakti hai.
* Kuch OEM Android skins (MIUI, ColorOS) background app ko `Appearance` event
  bilkul nahi bhejte.

Fix wahi hai jo Section 2 ke code me point **3)** pe hai:

```jsx
useEffect(() => {
  const sub = AppState.addEventListener('change', (state) => {
    if (state !== 'active') return;        // sirf foreground pe
    if (manualRef.current) return;         // manual choice ko OS overwrite na kare
    setIsDarkMode(Appearance.getColorScheme() === 'dark');
  });
  return () => sub.remove();
}, []);
```

Teen cheezein dhyan se:

1. **`manualRef` (ref, state nahi).** Listener sirf ek baar register hota hai
   (`[]` deps), to uske closure me `hasManualTheme` hamesha boot-time ka `false`
   rehta. Ref padhne se hamesha latest value milti hai. Agar tum state
   directly padhoge to jis user ne Light lock ki hai uski theme foreground pe
   OS se overwrite ho jayegi — ye bug pakadna mushkil hai.
2. **Listener ko `[]` deps pe hi rakho.** Har theme change pe subscribe/
   unsubscribe karna Android pe events drop karta hai.
3. **`state !== 'active'` guard.** iOS `'inactive'` bhi bhejta hai (control
   centre, call banner) — us par kuch mat karo.

`AppState` isi app me aur bhi kaam karta hai (presence, call resume, app lock) —
`src/components/AppLockGate.js`, `src/calls/CallProvider.jsx`. Wo theme se alag
concerns hain, bas pattern same hai: **ek listener, ref se latest state, `active`
pe re-derive.**

---

## 7. Screens me use kaise karna hai

```jsx
import { useTheme } from '../contexts/ThemeContext';

export default function MyScreen() {
  const { theme } = useTheme();

  return (
    <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
      <Text style={[styles.title, {
        color: theme.colors.primaryTextColor,
        fontFamily: theme.fonts.semibold,
        fontSize: theme.fontSizes.heading,
      }]}>
        Hello
      </Text>
    </View>
  );
}

// Static layout StyleSheet me — sirf COLORS inline aate hain.
const styles = StyleSheet.create({
  container: { flex: 1, padding: 16 },
  title: { marginBottom: 8 },
});
```

**Pattern:** layout (`flex`, `padding`, `margin`) `StyleSheet.create` me static
rahe; sirf theme-dependent values (colors, fonts) inline array me merge ho. Isse
StyleSheet ka caching bhi milta hai aur theme switch pe values bhi update hoti
hain.

### Do / Don't

| ❌ Mat karo | ✅ Karo |
|---|---|
| `color: isDarkMode ? '#fff' : '#000'` | `color: theme.colors.primaryTextColor` |
| `backgroundColor: '#f5f5f5'` | `backgroundColor: theme.colors.surface` |
| `fontSize: 17` | `fontSize: theme.fontSizes.title` |
| `fontFamily: 'System'` | `fontFamily: theme.fonts.regular` |
| Media viewer me `theme.colors.background` | `alwaysDark.background` |
| Naya hex screen me hardcode karna | Dono theme objects me naya token add karna |

`isDarkMode` sirf 3 jagah legit hai: StatusBar style, library bridges, aur woh
assets jinke do version hain (light/dark logo).

---

## 8. Settings screen (System / Light / Dark + accent color)

```jsx
const {
  theme, isDarkMode, hasManualTheme,
  setTheme, resetThemeToSystem,
  chatColor, updateChatColor, resetChatColor,
} = useTheme();

// Kaun sa option selected dikhana hai
const activeThemeKey = !hasManualTheme ? 'system' : isDarkMode ? 'dark' : 'light';

const onPick = (key) => {
  if (key === 'system') resetThemeToSystem();
  else if (key === 'light') setTheme(false);
  else setTheme(true);
};
```

`hasManualTheme` isliye expose kiya hai — uske bina tum "System" aur "Light" me
farq nahi kar paoge jab OS light pe ho (dono me `isDarkMode === false`).

Reference: [`src/screens/chats/ChatColorTheme.jsx`](../src/screens/chats/ChatColorTheme.jsx)

Accent color pick karne pe:

```jsx
updateChatColor('#7B61FF');   // persist + turant sab jagah live
// text jo is accent PE aayega:
<Text style={{ color: onColorFor(chatColor) }}>Send</Text>
```

---

## 9. Token reference

**colors** — dono themes me same naam, alag values:

| Token | Kaam |
|---|---|
| `background` | Screen ka base |
| `surface` / `cardBackground` / `menuBackground` | Elevated surfaces, cards, sheets |
| `headerBackground` | App bar / header |
| `primaryTextColor` (alias `textColor`) | Primary ink |
| `secondaryTextColor` / `muted` | Secondary ink, timestamps, captions |
| `placeHolderTextColor` | TextInput placeholder |
| `themeColor` (alias `primary`) | Brand accent — FAB, active tab, links |
| `onAccent` | Accent ke upar ka text |
| `border` / `borderColor` | Hairlines, input outline |
| `divider` | List separators (semi-transparent) |
| `iconColor` | Default icon tint |
| `danger` / `success` / `warning` / `info` | Semantic states |
| `scrim` | Modal ke peeche ka overlay |
| `shadow` | Light me `#000`, **dark me `transparent`** |
| `disabledOpacity` | Disabled controls ka opacity |
| `chatColor` | User ka chuna accent — runtime pe inject hota hai |

**scales:** `fonts.{thin,light,regular,medium,semibold,bold}` ·
`fontSizes.{caption,small,body,subtitle,title,heading,large}` ·
`spacing.{xs,sm,md,lg,xl}` · `radii.{sm,md,lg,pill}`

**helpers:** `alwaysDark` · `isLightColor(hex)` · `onColorFor(hex)` ·
`metaOnColorFor(hex)` · `sentBubbleBgFor(chatColor, theme)` · `defaultTheme`

---

## 10. Gotchas (jo humein bhagne pade)

| Symptom | Wajah | Fix |
|---|---|---|
| Cold start pe white flash | `isDarkMode` `false` se boot hota hai | `if (themeLoading) return null` |
| Background se aane pe purani theme | `Appearance` event background me drop | AppState listener (Section 6) |
| User ki Light choice apne aap dark ho gayi | Listener ne stale `hasManualTheme` padha | `manualRef` use karo, state nahi |
| Dialog/Menu dark mode me white | Paper apni theme padhta hai | `ThemedPaperProvider` |
| RN Navigation 7 header crash | custom theme me `fonts` missing | theme me `fonts` block do |
| Dark mode me cards ke neeche gandagi | `shadow` `#000` tha | dark me `shadow: 'transparent'`, `divider` border se elevation |
| Video/media screen light ho gayi | mode-dependent token use kiya | `alwaysDark` use karo |
| Accent pe text nahi dikh raha | white ink hardcoded | `onColorFor(chatColor)` |

---

## 11. Naye app me lagane ki checklist

- [ ] `npm i @react-native-async-storage/async-storage`
- [ ] `src/contexts/ThemeContext.js` copy karo; `BRAND` + `fonts` badlo
- [ ] Font files bundle karo (`useFonts` / `react-native.config.js`) — `fonts.*` ke names match hone chahiye
- [ ] `App.js` me `ThemeProvider` sabse upar mount karo
- [ ] Root screen pe `isLoading` gate + `StatusBar` lagao
- [ ] `NavigationContainer` ko theme do (`fonts` block mat bhoolna)
- [ ] Paper use karte ho to `ThemedPaperProvider` add karo
- [ ] AppState listener present hai (Section 2 ka point 3)
- [ ] Settings screen: System / Light / Dark + accent picker
- [ ] Test: **cold start dark me** (koi flash nahi) · **background me OS theme badal ke wapas aao** (update hota hai) · **Light lock karke OS dark karo** (Light hi rehna chahiye) · **accent badlo** (turant live, restart ke baad bhi rehta hai)
