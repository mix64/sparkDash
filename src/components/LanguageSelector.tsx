import { useTranslation } from "react-i18next";
import { i18n, LOCALES, setLocale, type Locale } from "../i18n";
import { SettingRow } from "./SettingRows";

export function LanguageSelector() {
  const { t } = useTranslation("language");
  const labels: Record<Locale, string> = { en: t("english"), "zh-CN": t("simplifiedChinese"), ja: t("japanese") };
  const current = i18n.resolvedLanguage;
  return (
    <SettingRow title={t("title")} help={t("help")}>
      <div className="seg" role="radiogroup" aria-label={t("title")}>
        {LOCALES.map((locale) => (
          <button key={locale} type="button" role="radio" aria-checked={current === locale} className={current === locale ? "is-on" : ""} onClick={() => void setLocale(locale)}>
            {labels[locale]}
          </button>
        ))}
      </div>
    </SettingRow>
  );
}
