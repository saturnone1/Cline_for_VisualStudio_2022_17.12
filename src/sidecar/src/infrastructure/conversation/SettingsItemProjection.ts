import path from "node:path"
import { createId } from "./TaskHistoryProjection"

export function buildSettingsToggleMap(items: Array<Record<string, unknown>>, scope: "global" | "local") {
	return Object.fromEntries(
		items
			.filter((item) => (scope === "global" ? isGlobalSettingsItem(item) : !isGlobalSettingsItem(item)))
			.map((item) => [settingsItemKey(item), item.enabled !== false]),
	)
}

export function isGlobalSettingsItem(item: Record<string, unknown>) {
	const source = getString(item, "source")
	return source === "global" || source === "global-plugin" || getString(item, "path").toLowerCase().includes("\\cline\\")
}

export function settingsItemKey(item: Record<string, unknown>) {
	return getString(item, "path") || getString(item, "id") || getString(item, "name") || createId()
}

export function settingsItemToSkillInfo(item: Record<string, unknown>) {
	return {
		name: getString(item, "name") || settingsItemKey(item),
		path: settingsItemKey(item),
		enabled: item.enabled !== false,
		description: getString(item, "description"),
	}
}

export function normalizeChangePath(filePath: string) {
	return path.resolve(filePath).toLowerCase()
}

function getString(value: Record<string, unknown>, key: string) {
	const item = value[key]
	return typeof item === "string" ? item : item == null ? "" : String(item)
}
