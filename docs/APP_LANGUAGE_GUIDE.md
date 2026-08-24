# App Language / Translation — Implementation Guide

Feature: app ka static UI text aur chat message bodies **on-device** translate
hote hain. Entry point: **Settings → App language**.

> **Ye file 2026-08-24 ko rewrite hui.** Pehle ye Google ke free
> `translate_a/single` endpoint wala implementation document karti thi. Wo
> endpoint hata diya gaya hai — kyun, wo Section 1 me hai.

---

## 1. Engine kyun badla (mat wapas jaana)

Pehla version `translate` npm package + Google ka undocumented free endpoint
`https://translate.googleapis.com/translate_a/single?client=gtx` use karta tha.
Wo **production me kaam nahi karta**:

* Ek hi IP se ~6 requests ke baad `HTTP 429`, aur block ghanton chalta hai.
* Har chat message = 1 request; users carrier NAT ke peeche IP share karte hain.
* Har message ka plaintext Google ko jata tha — chat app me privacy/compliance issue.
* Unofficial endpoint — Google kabhi bhi band ya change kar sakta hai.

Ab **Google ML Kit on-device translation** hai: koi network nahi, koi key nahi,
koi rate limit nahi, koi billing nahi, aur message device se bahar nahi jata.

**Trade-offs jo maan ke chalna hai:**

| | |
|---|---|
| Har language ka model | ~30 MB, user ke select karne pe download |
| Languages | ML Kit ke paas kam hain — **Malayalam aur Punjabi nahi hain** |
| Quality | Cloud API se kam, khaas kar romanized text pe |
| RAM | Ek live translator 30–150 MB leta hai (isliye max 2 cache) |
| iOS | Deployment target **15.5+** mandatory (ML Kit 8.x) |

---

## 2. Files

### Native module — `modules/expo-mlkit-translate/`

| File | Kya |
|---|---|
| `android/.../MlkitTranslateModule.kt` | Kotlin: translate, language-id, model manage |
| `ios/MlkitTranslateModule.swift` | Swift: wahi API |
| `ios/ExpoMlkitTranslate.podspec` | `GoogleMLKit/Translate` + `/LanguageID` 8.0.0, iOS 15.5, `static_framework` |
| `src/MlkitTranslate.ts` | JS wrapper (`requireOptionalNativeModule` — Expo Go pe crash nahi karta) |

Native API:

```ts
translate({ text, source, target, allowDownload })  // ERR_MLKIT_MODEL_MISSING if absent
identifyLanguage(text)                              // BCP-47 or 'und'
isModelDownloaded(lang) / downloadModel({ language, requireWifi })
deleteModel(lang) / getDownloadedModels() / getSupportedLanguages()
```

### App files

| File | Kya |
|---|---|
| `src/components/Translate.js` | Cache, provider, model management, drop-in `Text`/`TextInput` |
| `src/constant/languages.js` | 18 languages (picker native list se filter bhi karta hai) |
| `src/screens/profiles/ChooseLanguage.jsx` | Picker + download state |
| `App.js` | `<LanguageProvider>` — `ThemeProvider` ke andar, `NetworkProvider` ke bahar |
| `src/navigations/RootNavigator.js` | `ChooseLanguage` route |
| `src/screens/profiles/Setting.jsx` | "App language" row |
| `src/screens/chats/ChatScreen.jsx` | Message-body translation (Section 5) |
| `src/services/sessionManager.js` | Language ko `AsyncStorage.clear()` se bachata hai |

---

## 3. Screen ko translate karna

```js
// PEHLE
import { View, Text, TextInput } from 'react-native';
// BAAD ME
import { View } from 'react-native';
import { Text, TextInput } from '../../components/Translate';
```

`ignore` lagao: user data, naam, numbers, currency, IDs, brand name, aur wo text
jo pehle se dusri language me hai.

`<Text>Hello {name}</Text>` ka children **array** banta hai — wrapper use
jaan-bujh kar chhod deta hai. Todo: `<Text>Hello</Text><Text ignore> {name}</Text>`

`Alert.alert()` ke liye `t(text, language)` use karo.

> **Abhi sirf `ChooseLanguage` screen opted-in hai.** Settings/ChatList/Profile/
> Calls sab English hain. Picker ka subtitle "The app translates itself into the
> language you pick" isliye poori tarah sach nahi — ya aur screens opt-in karo,
> ya wo line badlo.

---

## 4. Persistence (ye teen baar toota hai — dobara mat todna)

1. **`LanguageProvider` module-level `cachedLanguage` se hydrate hota hai**, aur
   read import time pe shuru hota hai. Pehle `useState('en')` tha — English ek
   *published state* ban jati thi, aur ChatScreen (jo SQLite se turant messages
   bhar leta hai) poora pass galat language pe chala deta tha.
   `useState(() => cachedLanguage || SOURCE_LANGUAGE)` — lazy initialiser zaroori hai.

2. **`ready` flag ka intezaar karo.** ChatScreen `languageReady` false hone tak
   translate nahi karta.

3. **`sessionManager.DEVICE_PREFERENCE_KEYS`** — `clearAllSessionData()` bare
   `AsyncStorage.clear()` chalata hai (logout, token-refresh fail, re-login), jo
   `app.language` + `translation.cache.v3` uda deta tha. Ab wipe se pehle padhe
   jaate hain aur baad me wapas likhe jaate hain. **Naya preference key add karo
   to yahan bhi add karna.**

4. **Cache flush** — 250ms debounce + `AppState` background pe turant flush.
   Lamba window matlab reload pe translation gayab.

---

## 5. Chat messages (`ChatScreen.jsx`)

### Translation LIST level pe rakho — bubble ke andar nahi

Bubble ke andar translated `<Text>` lagane se sirf *descendant* re-render hota
hai; bubble ka measured box purana reh jata hai. Symptom: `"क्या हुआ"` beech me
toot jata hai, ya `"हुआ"` **clip hokar gayab** ho jata hai.

Isliye `messageTranslations` **list-level state** me hai, `${messageKey}::${language}`
se keyed, aur **language switch pe wipe NAHI hota** (warna hi → en → hi karne pe
sab dobara fetch hota hai).

Wire karna zaroori hai warna row re-render hi nahi hoga:

```jsx
}, [..., language, messageTranslations, translationRetryTick]);  // renderChatsItem deps
extraData={mediaRenderExtra}                                     // isme dono hain
```

### Kya translate NAHI hota

| | Kyun |
|---|---|
| Code (fenced ``` aur auto-detected) | Translator pura body badal deta hai → shared code corrupt |
| @mentions wale messages | Naam mangle, mention offsets kharab |
| Sender name, time, ticks, menu | User data / chhua hi nahi |
| Deleted / system rows | `isDeleted`, `type: 'system'` |

`deletedFor` ko **truthiness se mat check karna** — wo un users ka array hai
jinhone message apne liye delete kiya. `|| msg.deletedFor` ne normal messages
hamesha ke liye skip kar diye the.

### Effect me per-run `alive` cleanup mat lagana

Effect `messages` pe depend karta hai, aur ek incoming message ke baad `messages`
kai baar update hota hai (receipts → status → SQLite refresh). Cleanup in-flight
translation cancel kar dega aur slot already-seen hone se retry nahi hoga.
Result sirf **unmount** ya **language change** pe discard hota hai.

### Self-heal

Model abhi download ho raha ho to `translateDetailed` `'deferred'` return karta
hai — **failure nahi**, aur retry budget kharch nahi hota. Effect ke aakhir me
ek timer lagta hai jo model aane par apne aap dobara try karta hai.

### Batching

Har message pe alag `setState` matlab poori FlatList ka ek re-render. Results
batch hokar ek commit me jate hain.

---

## 6. Source language kaise chunti hai

| Message ka script | Reader | Source |
|---|---|---|
| Apni script (Devanagari/Thai/Arabic/CJK) | koi bhi | `identifyLanguage()` |
| Latin | non-Latin reader (hi, th, ta, ar, ja, zh…) | **forced `en`** |

**Latin pe `en` force kyun?** Hinglish. `"Ab btao"` ko detector `hi` batata hai;
reader bhi `hi` hai → source == target → message jaisa ka waisa wapas. `en`
force karne se `"अब बताओ"` milta hai, aur asli English messages pe koi farak
nahi padta (English hi source hai).

`identifyLanguage` `'und'` de to English maan lete hain.

### Request kab jati hai

Sasta **script check** pehle — same script = 0 kaam. Latin aapas me alag nahi ho
sakti, isliye French message English reader ko waisa hi dikhega.

---

## 7. Fonts — ye asli problem hai, dhyan rakhna

`assets/fonts/Roboto-Regular.ttf` me **sirf 922 codepoints** hain: Latin, Greek,
Cyrillic. Picker ki 18 me se **12 languages ke glyphs isme hain hi nahi** —
Devanagari, Bengali, Gujarati, Tamil, Telugu, Kannada, Urdu, Arabic, Thai,
Chinese, Japanese.

Solution: `needsSystemFont(text)` (`Translate.js` se export). Jahan bhi foreign
script render ho sakti hai, wahan `fontFamily` **undefined** kar do taaki OS apna
font chune:

```jsx
style={[styles.x, needsSystemFont(text) && { fontFamily: undefined }]}
```

Abhi teen jagah laga hai: chat message body, picker ke endonyms, Settings ka
language subtitle. **Koi nayi jagah foreign script dikhaye to wahan bhi lagana.**

Cyrillic jaan-bujh kar chhoda hai — Roboto usse cover karta hai.

---

## 8. Known limitations

| | |
|---|---|
| Machine translation quality | Chhote UI labels bina context ke galat ho sakte hain |
| Pehla paint original | String pehle original dikhti hai, phir translation; cached ho to same frame |
| RTL | Arabic/Urdu ka **text** sahi aata hai par layout mirror nahi hota (uske liye `I18nManager.forceRTL` + restart chahiye — app-wide change) |
| Chat list | ChatList ka last-message preview translate nahi hota, sirf khuli chat hoti hai |
| Layout | German/Tamil strings English se lambi — buttons aur single-line rows check karo |
| Hinglish → English reader | Convert nahi hoti (dono Latin → skip) |
| Model storage | Har language ~30 MB; `deleteModel()` se hata sakte ho |

---

## 9. Build

`translate` npm package **hata diya gaya hai**. Ab:

```bash
# module package.json me file: dep se linked hai
npx expo prebuild
npx expo run:android
npx expo run:ios      # iOS 15.5+ zaroori
```

Expo Go me native module nahi hota — `isTranslationAvailable()` false deta hai
aur picker banner dikhata hai. App crash nahi karta.

---

## 10. Troubleshooting

| Problem | Fix |
|---|---|
| Text translate nahi ho raha | Us screen ne abhi bhi `react-native` ka `Text` import kiya hai |
| Sab English hai | Selected language `en` hai — jaan-bujh kar kuch nahi hota |
| Messages English hi hain, log me `deferred` | Model download nahi hua. Picker kholo, download hone do |
| ▯▯▯ boxes | `needsSystemFont()` lagana bhool gaye — Section 7 |
| `unable to resolve module dependency: 'MLKit'` | `import MLKit` galat hai. `MLKitCommon` + `MLKitLanguageID` + `MLKitTranslate` alag-alag import karo |
| iOS pod install fail | Deployment target 15.5 se kam hai — `app.json` me `expo-build-properties.ios.deploymentTarget` |
| Language reload pe reset | `LanguageProvider` wrap nahi hua, ya naya key `DEVICE_PREFERENCE_KEYS` me nahi hai |
| Picker pe language nahi dikh rahi | ML Kit us language ko support nahi karta — picker native list se filter karta hai |
| Message beech me toot raha / word gayab | Translation bubble ke andar ho rahi hai — Section 5 |
| Language wapas badalne pe (hi → en → hi) English hi | Map `messageKey` se keyed hai ya wipe ho raha hai — `${messageKey}::${language}` use karo |
| Hinglish waisa ka waisa | Section 6 — `sl=en` forcing check karo |
