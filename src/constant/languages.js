/**
 * Languages offered by the "Choose language" screen.
 *
 * `code` must be a valid ISO 639-1 tag — the `translate` package validates it
 * and throws for anything else. Adding a language is a one-line change here;
 * nothing else in the app needs to know about it.
 */
export const LANGUAGES = [
  { code: 'en', label: 'English',    english: 'English',    flag: '🇬🇧' },
  { code: 'hi', label: 'हिन्दी',      english: 'Hindi',      flag: '🇮🇳' },
  { code: 'bn', label: 'বাংলা',       english: 'Bengali',    flag: '🇮🇳' },
  { code: 'mr', label: 'मराठी',       english: 'Marathi',    flag: '🇮🇳' },
  { code: 'gu', label: 'ગુજરાતી',     english: 'Gujarati',   flag: '🇮🇳' },
  { code: 'pa', label: 'ਪੰਜਾਬੀ',      english: 'Punjabi',    flag: '🇮🇳' },
  { code: 'ta', label: 'தமிழ்',       english: 'Tamil',      flag: '🇮🇳' },
  { code: 'te', label: 'తెలుగు',      english: 'Telugu',     flag: '🇮🇳' },
  { code: 'kn', label: 'ಕನ್ನಡ',       english: 'Kannada',    flag: '🇮🇳' },
  { code: 'ml', label: 'മലയാളം',     english: 'Malayalam',  flag: '🇮🇳' },
  { code: 'ur', label: 'اردو',        english: 'Urdu',       flag: '🇵🇰' },
  { code: 'ar', label: 'العربية',      english: 'Arabic',     flag: '🇸🇦' },
  { code: 'fr', label: 'Français',    english: 'French',     flag: '🇫🇷' },
  { code: 'es', label: 'Español',     english: 'Spanish',    flag: '🇪🇸' },
  { code: 'de', label: 'Deutsch',     english: 'German',     flag: '🇩🇪' },
  { code: 'pt', label: 'Português',   english: 'Portuguese', flag: '🇵🇹' },
  { code: 'ru', label: 'Русский',     english: 'Russian',    flag: '🇷🇺' },
  { code: 'zh', label: '中文',         english: 'Chinese',    flag: '🇨🇳' },
  { code: 'ja', label: '日本語',       english: 'Japanese',   flag: '🇯🇵' },
  { code: 'th', label: 'ไทย',         english: 'Thai',       flag: '🇹🇭' },
];

export const getLanguage = (code) =>
  LANGUAGES.find((language) => language.code === code) || LANGUAGES[0];
