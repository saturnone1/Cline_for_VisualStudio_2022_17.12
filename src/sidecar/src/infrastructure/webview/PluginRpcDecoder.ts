import type { PluginCommand } from "../../features/plugins/PluginRpcHandler"

export function decodePluginRpcCommand(key: string): PluginCommand | undefined {
	return ["PluginService.listPlugins", "PluginService.getPluginConfigStatus", "PluginsService.listPlugins", "PluginsService.getPluginConfigStatus"].includes(key) ? { type: "list" } : undefined
}
