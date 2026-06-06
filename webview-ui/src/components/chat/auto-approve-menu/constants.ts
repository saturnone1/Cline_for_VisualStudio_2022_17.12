import { ActionMetadata } from "./types"
import { translate, type UiLanguage } from "@/i18n"

export const ACTION_METADATA: ActionMetadata[] = [
	{
		id: "readFiles",
		label: "프로젝트 파일 읽기",
		shortName: "읽기",
		icon: "codicon-search",
		subAction: {
			id: "readFilesExternally",
			label: "모든 파일 읽기",
			shortName: "전체 읽기",
			icon: "codicon-folder-opened",
			parentActionId: "readFiles",
		},
	},
	{
		id: "editFiles",
		label: "프로젝트 파일 편집",
		shortName: "편집",
		icon: "codicon-edit",
		subAction: {
			id: "editFilesExternally",
			label: "모든 파일 편집",
			shortName: "전체 편집",
			icon: "codicon-files",
			parentActionId: "editFiles",
		},
	},
	{
		id: "executeSafeCommands",
		label: "안전한 명령 실행",
		shortName: "안전 명령",
		icon: "codicon-terminal",
		subAction: {
			id: "executeAllCommands",
			label: "모든 명령 실행",
			shortName: "모든 명령",
			icon: "codicon-terminal-bash",
			parentActionId: "executeSafeCommands",
		},
	},
	{
		id: "useBrowser",
		label: "브라우저 사용",
		shortName: "브라우저",
		icon: "codicon-globe",
	},
	{
		id: "useMcp",
		label: "MCP 서버 사용",
		shortName: "MCP",
		icon: "codicon-server",
	},
]

export const NOTIFICATIONS_SETTING: ActionMetadata = {
	id: "enableNotifications",
	label: "알림 사용",
	shortName: "알림",
	icon: "codicon-bell",
}

const actionTextKeys: Record<string, { label: string; shortName: string }> = {
	readFiles: { label: "autoApprove.read", shortName: "autoApprove.read" },
	readFilesExternally: { label: "autoApprove.readAll", shortName: "autoApprove.readAll" },
	editFiles: { label: "autoApprove.edit", shortName: "autoApprove.edit" },
	editFilesExternally: { label: "autoApprove.editAll", shortName: "autoApprove.editAll" },
	executeSafeCommands: { label: "autoApprove.safeCommands", shortName: "autoApprove.safeCommands" },
	executeAllCommands: { label: "autoApprove.allCommands", shortName: "autoApprove.allCommands" },
	useBrowser: { label: "autoApprove.browser", shortName: "autoApprove.browser" },
	useMcp: { label: "autoApprove.mcp", shortName: "autoApprove.mcp" },
	enableNotifications: { label: "autoApprove.notifications", shortName: "autoApprove.notificationShort" },
}

export function localizeActionMetadata(action: ActionMetadata, language: UiLanguage): ActionMetadata {
	const keys = actionTextKeys[String(action.id)]
	return {
		...action,
		label: keys ? translate(language, keys.label as any) : action.label,
		shortName: keys ? translate(language, keys.shortName as any) : action.shortName,
		subAction: action.subAction ? localizeActionMetadata(action.subAction, language) : undefined,
	}
}

export function localizeActionMetadataList(actions: ActionMetadata[], language: UiLanguage): ActionMetadata[] {
	return actions.map((action) => localizeActionMetadata(action, language))
}
