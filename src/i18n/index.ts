import { createInstance } from "i18next";
import { initReactI18next } from "react-i18next";
import enSettings from "../locales/en/settings.json";
import zhSettings from "../locales/zh-CN/settings.json";
import jaSettings from "../locales/ja/settings.json";
import enLanguage from "../locales/en/language.json";
import zhLanguage from "../locales/zh-CN/language.json";
import jaLanguage from "../locales/ja/language.json";
import enShell from "../locales/en/shell.json";
import zhShell from "../locales/zh-CN/shell.json";
import jaShell from "../locales/ja/shell.json";
import enOverview from "../locales/en/overview.json";
import zhOverview from "../locales/zh-CN/overview.json";
import jaOverview from "../locales/ja/overview.json";
import enSpark from "../locales/en/spark.json";
import zhSpark from "../locales/zh-CN/spark.json";
import jaSpark from "../locales/ja/spark.json";
import enStatistics from "../locales/en/statistics.json";
import zhStatistics from "../locales/zh-CN/statistics.json";
import jaStatistics from "../locales/ja/statistics.json";
import enActivity from "../locales/en/activity.json";
import zhActivity from "../locales/zh-CN/activity.json";
import jaActivity from "../locales/ja/activity.json";
import enDevices from "../locales/en/devices.json";
import zhDevices from "../locales/zh-CN/devices.json";
import jaDevices from "../locales/ja/devices.json";
import enHardware from "../locales/en/hardware.json";
import zhHardware from "../locales/zh-CN/hardware.json";
import jaHardware from "../locales/ja/hardware.json";
import enBenchmarks from "../locales/en/benchmarks.json";
import zhBenchmarks from "../locales/zh-CN/benchmarks.json";
import jaBenchmarks from "../locales/ja/benchmarks.json";
import enTooleval from "../locales/en/tooleval.json";
import zhTooleval from "../locales/zh-CN/tooleval.json";
import jaTooleval from "../locales/ja/tooleval.json";
import enToolMessages from "../locales/en/toolMessages.json";
import zhToolMessages from "../locales/zh-CN/toolMessages.json";
import jaToolMessages from "../locales/ja/toolMessages.json";
import enShareCards from "../locales/en/shareCards.json";
import zhShareCards from "../locales/zh-CN/shareCards.json";
import jaShareCards from "../locales/ja/shareCards.json";
import enShowcase from "../locales/en/showcase.json";
import zhShowcase from "../locales/zh-CN/showcase.json";
import jaShowcase from "../locales/ja/showcase.json";

export const LOCALES = ["en", "zh-CN", "ja"] as const;
export type Locale = (typeof LOCALES)[number];
export const LOCALE_STORAGE_KEY = "sparkdash-locale";

export function normalizeLocale(value: string | null | undefined): Locale | null {
  if (!value) return null;
  const tag = value.toLowerCase().replace(/_/g, "-");
  if (tag === "en" || tag.startsWith("en-")) return "en";
  if (tag === "zh" || tag === "zh-cn" || tag === "zh-sg" || tag === "zh-my" || tag === "zh-hans" || tag.startsWith("zh-hans-")) return "zh-CN";
  if (tag === "ja" || tag.startsWith("ja-")) return "ja";
  return null;
}

export function detectLocale(): Locale {
  try {
    const stored = normalizeLocale(localStorage.getItem(LOCALE_STORAGE_KEY));
    if (stored) return stored;
  } catch { /* Browser storage is optional. */ }
  return normalizeLocale(typeof navigator === "undefined" ? null : navigator.language) ?? "en";
}

// One bundled loader for this small foundation. English catalogs are the source
// of truth; subsequent pages add namespaces rather than parallel loaders.
export const i18n = createInstance();
void i18n.use(initReactI18next).init({
  resources: {
    en: { settings: enSettings, language: enLanguage, shell: enShell, overview: enOverview, spark: enSpark, activity: enActivity, statistics: enStatistics, devices: enDevices, hardware: enHardware, shareCards: enShareCards, toolMessages: enToolMessages, tooleval: enTooleval, benchmarks: enBenchmarks, showcase: enShowcase },
    "zh-CN": { settings: zhSettings, language: zhLanguage, shell: zhShell, overview: zhOverview, spark: zhSpark, activity: zhActivity, statistics: zhStatistics, devices: zhDevices, hardware: zhHardware, shareCards: zhShareCards, toolMessages: zhToolMessages, tooleval: zhTooleval, benchmarks: zhBenchmarks, showcase: zhShowcase },
    ja: { settings: jaSettings, language: jaLanguage, shell: jaShell, overview: jaOverview, spark: jaSpark, activity: jaActivity, statistics: jaStatistics, devices: jaDevices, hardware: jaHardware, shareCards: jaShareCards, toolMessages: jaToolMessages, tooleval: jaTooleval, benchmarks: jaBenchmarks, showcase: jaShowcase },
  },
  lng: detectLocale(),
  fallbackLng: "en",
  supportedLngs: [...LOCALES],
  load: "currentOnly",
  defaultNS: "settings",
  ns: ["settings", "language", "shell", "overview", "spark", "activity", "statistics", "devices", "hardware", "shareCards", "toolMessages", "tooleval", "benchmarks", "showcase"],
  interpolation: { escapeValue: false },
  returnEmptyString: false,
  initAsync: false,
});

function updateDocumentLanguage() {
  if (typeof document !== "undefined") document.documentElement.lang = i18n.resolvedLanguage ?? "en";
}
i18n.on("languageChanged", updateDocumentLanguage);
updateDocumentLanguage();

export async function setLocale(locale: Locale): Promise<void> {
  await i18n.changeLanguage(locale);
  try { localStorage.setItem(LOCALE_STORAGE_KEY, locale); } catch { /* Switching still works without storage. */ }
}
