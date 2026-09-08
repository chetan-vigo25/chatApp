# App Language / Translation — Implementation Guide

Feature: **receive kiye gaye chat messages** on-device translate hote hain.
Entry point: **Settings → App language**.

> **Scope jaan-bujh kar chhota hai.** App ka UI text translate NAHI hota — sirf
> `ChooseLanguage` screen apne aap ko translate karti hai. Language badalne pe
> baaki koi screen nahi badalti. Ye product decision hai, bug nahi.

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

> **Jaan-bujh kar sirf `ChooseLanguage` opted-in hai.** Baaki har screen English
> rehti hai — ye maanga gaya behaviour hai. Picker ka subtitle isliye
> "Messages you receive are translated into the language you pick" kehta hai,
> jo sach hai.
>
> Aage kabhi koi screen opt-in karni ho:
> `node scripts/optin-translate.js <file>` chalao, phir
> `node scripts/check-translate-optin.js` — wo batayega kahan `ignore` chahiye
> taaki kisi user ka naam/phone translator me na chala jaye. Wapas hatana ho to
> `node scripts/optout-translate.js <file>`.

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

### Kaun sa message translate hota hai — recipient-side, opt-in

Translation **poori tarah client-side** hai aur sirf **receive kiye gaye**
messages pe lagti hai. Server pe hamesha original hi store hota hai, isliye ek
hi message har recipient ke device pe alag dikh sakta hai.

Sab kuch ek gate se hokar guzarta hai — `shouldTranslateMessage()`:

| Condition | Kyun |
|---|---|
| `hasLanguagePreference` | Jisne kabhi language chuni hi nahi, usko har message **jaisa bheja gaya waisa** dikhega |
| `!isOwnMessage(msg)` | Aapne likha hai, aapne padha hai. Apna hi message translate karna matlab aapke shabd aapko badal ke dikhana |
| `isTranslatableMessage(msg)` | Text ho, code na ho, mention na ho, deleted na ho |

**`hasPreference` aur `language === 'en'` alag cheezein hain.** Jisne picker
kabhi khola hi nahi uski koi preference nahi — Hindi message Hindi hi rahega.
Jisne jaan-bujh kar English chuna, uski preference hai — wahi Hindi message
uske liye English me translate hoga. Dono ko ek maan lena matlab un logon ke
chats bhi auto-translate karna jinhone kabhi maanga hi nahi.

Example flow:

```
User A (Hindi chuni)  → "कैसे हो?"     → server original store karta hai
                                        → B (koi preference nahi) ko "कैसे हो?"
                                        → A ko bhi "कैसे हो?" (apna message)

User B (kuch nahi chuna) → "How are you?" → server original store karta hai
                                        → B ko "How are you?" (apna message)
                                        → A ka client translate karta hai → "आप कैसे हैं?"
```

`msg.text` kabhi overwrite nahi hota, aur koi translation kisi send path me
nahi jati — display-only hai.

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

### Flicker — original pehle mat dikhao

Message pehle sender ki language me paint hota tha, phir translation aane pe
badal jata tha. Do cheezein isse rokti hain:

1. **`translationFor()` render ke DAURAN resolve karta hai** — state, phir
   `peekTranslation()` (synchronous disk cache). Jo message pehle translate ho
   chuka hai wo **pehle hi frame me** translated paint hota hai.

2. **`translatingKeys` + `<TranslatingBubble />`** — jis message ka translation
   abhi nahi aaya, uski **row apni jagah par rehti hai** (time, ticks,
   reactions sab), sirf uska **body** ek shimmer loader se replace ho jata hai.
   Translation aate hi loader ki jagah translated text aa jata hai — original
   kabhi flash nahi hota.

   Pehle ye rows FlatList ko di hi nahi jati thi. Language badalne par uska
   nateeja bura tha: poora thread khali, phir messages English me wapas, phir
   translate. Isliye ab **chhupaya nahi jata, loader dikhaya jata hai**.

`TRANSLATION_LOADER_MAX_MS` (2000ms) safety net hai: iske baad bubble original
text ke saath dikh jati hai. **Message kabhi permanently loader ke peeche nahi
phansna chahiye** — translation fail ho, model download ho raha ho, kuch bhi ho.

Loader sirf wahan aata hai jahan translation **sach me hogi**:
`willTranslate()` (synchronous, wahi planner jo asli call use karti hai) pehle
poochha jata hai, warna reader ki apni script wale har message par ek frame ka
loader flash hota. Aur jo slot `'skipped'` aata hai wo ref me jata hai (koi
re-render nahi), isliye effect ke aakhir me `translationHoldTick` bump hota hai
taaki loader turant hat jaye.

Pehli translation model ko RAM me load karti hai, isliye wo slow ho sakti hai.
Device pe ye deadline tune karni pad sakti hai.

---

## 6. Source language kaise chunti hai (aur Hinglish ki sachai)

| Message | Reader | Source |
|---|---|---|
| Apni script (Devanagari/Thai/Arabic/CJK) | koi bhi | `identifyLanguage()` |
| Latin, detector kehta hai `en` (ya `und`) | non-Latin reader | `en` → translate |
| Latin, detector kehta hai kuch aur (Hinglish) | non-Latin reader | **refuse — original hi rehta hai** |

### Hinglish — free, on-device, phrase pack se

`"chale chalo"`, `"Abhi nahi"` — Hindi, Latin letters me. ML Kit ke models
**scripts ke beech** translate karte hain: `hi→x` Devanagari maangta hai, `en→x`
asli English. Romanized Hindi koi bhi on-device model nahi padh sakta.

Flow:

1. **Detector se poocho.** Latin text tabhi English mana jata hai jab detector
   bhi English kahe. Warna `detectSource` `null` deta hai.
2. **Phrase pack** (`src/constant/hinglish.js`, **191 phrases**) usse English me
   badalta hai, aur ML Kit us English ko target language me le jata hai —
   **poori tarah device pe, zero cost**.

```
"chale chalo" → (pack) → "let's go" → (ML Kit en→th) → "ไปกันเถอะ"
```

Spelling variants pehle fold hote hain, kyunki Hinglish ka standard spelling
nahi hota: `"nhi yrrr"` → `nahi yaar`, `"kya kr rhe ho"` → `kya kar rahe ho`.

### Coverage kaise badhaye — guess mat karo, MAAPO

Pack me jo nahi hai wo translate nahi hoga. Ise theek karne ka ek hi tareeka
hai: **pack badhao, data ke hisaab se.**

```bash
node scripts/check-hinglish.js                      # sirf integrity
node scripts/check-hinglish.js messages.txt         # + hit rate
node scripts/check-hinglish.js messages.txt -v      # + misses ki list
```

`messages.txt` = aapke asli chat messages, ek per line.

Ye script do aisi galtiyan pakadti hai jo file padh kar **kabhi nahi dikhtin**:

1. **Dead keys.** Lookup pehle message normalize karta hai (`kr`→`kar`,
   `thik`→`theek`). Agar key non-canonical spelling me likhi ho to wo **kabhi
   match nahi karegi**. `'thik hai bye'` chup-chaap bekaar padi thi jab tak ye
   check nahi bana.
2. **Duplicate keys.** Baad wali chup-chaap pehli ko overwrite kar deti hai.

Miss list me har entry ready-to-paste key deti hai:

```
"khana kha liya"   → key to add: "khana kha liya"
```

### Ye approach kitna kaam karta hai — asli numbers

62 realistic Hinglish messages ke corpus pe maapa gaya:

| Step | Hit rate |
|---|---|
| Shuruat (191 phrases) | 48% |
| `kha → kahan` bug fix + filler stripping | **71%** — ek bhi naya phrase nahi |
| Naapi hui misses add ki (216 phrases) | **100%** |

Sabse bada fayda phrases add karne se nahi, **normalization se** aaya. Naya
phrase add karne se pehle dekho ki koi variant ya filler ka issue to nahi.

### Do cheezein jo har entry ki value badha deti hain

**Filler stripping** — `bhai`, `yaar`, `na`, `bro`, `ji`, `toh` shuru/aakhir se
hat jate hain. Isliye `"kaise ho"` ki ek entry `"kaise ho bhai"`,
`"kaise ho yaar"`, `"kaise ho na"` sab cover karti hai. Exact match pehle try
hota hai, to `"haan bhai"` → "yes brother" ab bhi jeetta hai.

**Spelling variants** (`SPELLING_VARIANTS`) — `nhi/nahin/nahee` → `nahi`. Ek
naya variant add karna aksar ek naya phrase add karne se zyada faydemand hai,
kyunki wo **poore pack** pe lagta hai.

> ⚠️ `SPELLING_VARIANTS` me chhote ambiguous shabd mat daalna. `kha → kahan`
> tha, aur usne `"khana kha liya"` (khaya kya) ko `"khana kahan liya"` (kahan
> se liya) bana diya — matlab hi ulta ho gaya. Ambiguous cheezein `PHRASES` me
> daalo jahan poora context hota hai.

### Koi cloud fallback nahi — jaan-bujh kar

Ye app free translate karti hai ya bilkul nahi. Koi paid API nahi, koi backend
route nahi, koi per-character bill nahi.

Iska matlab: **jo phrase pack me nahi hai wo translate nahi hoga.** Coverage
badhane ka ek hi tareeka hai — `PHRASES` me entries add karo. Kisi cloud
provider ko wapas mat laao; wo jaan-bujh kar hataya gaya tha.

### Request kab jati hai

Sasta **script check** pehle — same script = 0 kaam. Latin aapas me alag nahi ho
sakti, isliye French message English reader ko waisa hi dikhega.

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
