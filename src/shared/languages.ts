/**
 * Languages offered in the UI. Codes are BCP-47 as expected by
 * `translationConfig.targetLanguageCode` (Gemini 3.5 Live Translate supports 70+;
 * this is a curated subset — add more as needed).
 */
export const LANGUAGES = [
  { code: "ko", label: "한국어" },
  { code: "en", label: "English" },
  { code: "ja", label: "日本語" },
  { code: "zh-Hans", label: "中文(简体)" },
  { code: "es", label: "Español" },
  { code: "fr", label: "Français" },
  { code: "de", label: "Deutsch" },
  { code: "it", label: "Italiano" },
  { code: "pt", label: "Português" },
  { code: "ru", label: "Русский" },
  { code: "vi", label: "Tiếng Việt" },
  { code: "th", label: "ไทย" },
  { code: "id", label: "Bahasa Indonesia" },
  { code: "hi", label: "हिन्दी" },
  { code: "ar", label: "العربية" },
  { code: "pl", label: "Polski" },
] as const;

export type LanguageCode = (typeof LANGUAGES)[number]["code"];

const CODES = new Set<string>(LANGUAGES.map((l) => l.code));

export function isSupportedLanguage(code: unknown): code is LanguageCode {
  return typeof code === "string" && CODES.has(code);
}

/** "zh-Hans" -> "zh", "en-US" -> "en" */
export function baseLanguage(code: string): string {
  return code.split("-")[0]!.toLowerCase();
}

export function languageLabel(code: string): string {
  return LANGUAGES.find((l) => l.code === code)?.label ?? code;
}
