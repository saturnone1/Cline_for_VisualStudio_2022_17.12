export function normalizeCommandForPlatform(command: string, platform: string) {
	if (platform !== "win32" || !command) {
		return command
	}

	return command.replace(/(^|\s)(?!\/)([A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.()[\]{}$@+-]+)+)/g, (_match, prefix: string, candidate: string) => {
		if (candidate.includes("://")) {
			return `${prefix}${candidate}`
		}
		return `${prefix}${candidate.replace(/\//g, "\\")}`
	})
}

export function normalizeCommandArgumentForPlatform(argument: string, platform: string) {
	if (platform !== "win32" || !argument || argument.startsWith("/") || argument.includes("://")) {
		return argument
	}
	return argument.includes("/") ? argument.replace(/\//g, "\\") : argument
}
