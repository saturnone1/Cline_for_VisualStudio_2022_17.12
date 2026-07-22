import { createContext, createElement, useCallback, useContext } from "react"
import type { ReactNode } from "react"
import { en } from "./translations/en"
import { ko } from "./translations/ko"

export type UiLanguage = "en" | "ko";
type Vars = Record<string, string | number | undefined>;

const dictionaries = { en, ko }
export type I18nKey = keyof typeof en;
const UiLanguageContext = createContext<UiLanguage>("ko");

export function normalizeUiLanguage(value: unknown): UiLanguage {
	return value === "en" ? "en" : "ko";
}

export function translate(language: unknown, key: I18nKey, vars: Vars = {}): string {
	const dictionary = dictionaries[normalizeUiLanguage(language)];
	const template = dictionary[key] || en[key] || key;
	return template.replace(/\{(\w+)\}/g, (_match, name) => String(vars[name] ?? ""));
}

export function useI18n() {
	const language = useContext(UiLanguageContext);
	const t = useCallback((key: I18nKey, vars?: Vars) => translate(language, key, vars), [language]);
	return { language, t };
}

export function UiLanguageProvider({ language, children }: { language: unknown; children: ReactNode }) {
	return createElement(UiLanguageContext.Provider, { value: normalizeUiLanguage(language) }, children);
}
