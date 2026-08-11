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

export function serializeCommandInvocationForPlatform(command: string, args: string[], platform: string) {
	const normalizedCommand = normalizeCommandArgumentForPlatform(command, platform)
	const normalizedArgs = args.map((argument) => normalizeCommandArgumentForPlatform(argument, platform))
	if (platform !== "win32") {
		return [normalizedCommand, ...normalizedArgs].map(quotePosixArgument).join(" ")
	}
	return [normalizedCommand, ...normalizedArgs].map(quoteWindowsCommandArgument).join(" ")
}

function quoteWindowsCommandArgument(value: string) {
	if (value.length > 0 && !/[\s"&|<>^()]/.test(value)) return value
	return `"${value.replace(/(\\*)"/g, "$1$1\\\"").replace(/(\\+)$/, "$1$1")}"`
}

function quotePosixArgument(value: string) {
	if (value.length > 0 && /^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value
	return `'${value.replace(/'/g, `'"'"'`)}'`
}
