/**
 * Languages offered by the "Choose language" screen.
 *
 * `code` must be a tag ML Kit's on-device translator knows. Adding a language
 * is a one-line change here — but check it against
 * MlkitTranslate.getSupportedLanguages() first: ML Kit covers fewer languages
 * than the cloud API did. Malayalam and Punjabi were dropped for exactly that
 * reason, and the picker filters this list against the native list anyway so an
 * unsupported entry is hidden rather than offered and then silently broken.
 */
export const LANGUAGES = [
  { code: 'en', label: 'English',    english: 'English',    flag: '🇬🇧' },
  { code: 'hi', label: 'हिन्दी',      english: 'Hindi',      flag: '🇮🇳' },
  { code: 'th', label: 'ไทย',         english: 'Thai',       flag: '🇹🇭' },
  { code: 'bn', label: 'বাংলা',       english: 'Bengali',    flag: '🇮🇳' },
  { code: 'mr', label: 'मराठी',       english: 'Marathi',    flag: '🇮🇳' },
  { code: 'gu', label: 'ગુજરાતી',     english: 'Gujarati',   flag: '🇮🇳' },
  { code: 'ta', label: 'தமிழ்',       english: 'Tamil',      flag: '🇮🇳' },
  { code: 'te', label: 'తెలుగు',      english: 'Telugu',     flag: '🇮🇳' },
  { code: 'kn', label: 'ಕನ್ನಡ',       english: 'Kannada',    flag: '🇮🇳' },
  { code: 'ur', label: 'اردو',        english: 'Urdu',       flag: '🇵🇰' },
  { code: 'ar', label: 'العربية',      english: 'Arabic',     flag: '🇸🇦' },
  { code: 'fr', label: 'Français',    english: 'French',     flag: '🇫🇷' },
  { code: 'es', label: 'Español',     english: 'Spanish',    flag: '🇪🇸' },
  { code: 'de', label: 'Deutsch',     english: 'German',     flag: '🇩🇪' },
  { code: 'pt', label: 'Português',   english: 'Portuguese', flag: '🇵🇹' },
  { code: 'ru', label: 'Русский',     english: 'Russian',    flag: '🇷🇺' },
  { code: 'zh', label: '中文',         english: 'Chinese',    flag: '🇨🇳' },
  { code: 'ja', label: '日本語',       english: 'Japanese',   flag: '🇯🇵' },
];

export const getLanguage = (code) =>
  LANGUAGES.find((language) => language.code === code) || LANGUAGES[0];
