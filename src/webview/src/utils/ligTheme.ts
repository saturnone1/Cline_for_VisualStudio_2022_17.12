export type LigTheme = "dark" | "light"

export const LIG_THEME_STORAGE_KEY = "ligVsTheme"

export const normalizeLigTheme = (value: unknown): LigTheme => (value === "light" ? "light" : "dark")

export const getLigTheme = (): LigTheme => {
	if (typeof window === "undefined") {
		return "dark"
	}

	try {
		return normalizeLigTheme(window.localStorage?.getItem(LIG_THEME_STORAGE_KEY))
	} catch {
		return "dark"
	}
}

export const applyLigTheme = (theme: LigTheme) => {
	if (typeof document === "undefined") {
		return
	}

	const normalized = normalizeLigTheme(theme)
	const isDark = normalized === "dark"
	document.documentElement.classList.toggle("dark", isDark)
	document.documentElement.dataset.vsclineTheme = normalized

	if (document.body) {
		document.body.classList.toggle("dark", isDark)
		document.body.dataset.vsclineTheme = normalized
	}

	try {
		const hostWindow = window as Window & {
			chrome?: { webview?: { postMessage: (message: unknown) => void } }
		}
		hostWindow.chrome?.webview?.postMessage({ type: "ligvs_theme_changed", theme: normalized })
	} catch {
		// The browser development host does not expose the Visual Studio bridge.
	}
}

export const setLigTheme = (theme: LigTheme) => {
	const normalized = normalizeLigTheme(theme)

	try {
		window.localStorage?.setItem(LIG_THEME_STORAGE_KEY, normalized)
	} catch {
		// The host shim also defaults to dark if storage is unavailable.
	}

	applyLigTheme(normalized)
	window.dispatchEvent(new CustomEvent<LigTheme>("ligvs-theme-change", { detail: normalized }))
}
