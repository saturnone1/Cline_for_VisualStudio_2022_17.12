export function replaceTextExactlyOnce(content: string, oldText: string, newText: string, filePath: string) {
	const first = content.indexOf(oldText)
	if (first < 0) throw new Error(`old_text not found in ${filePath}`)
	if (content.indexOf(oldText, first + oldText.length) >= 0) {
		throw new Error(`old_text matches more than once in ${filePath}; provide a larger unique block.`)
	}
	return content.slice(0, first) + newText + content.slice(first + oldText.length)
}
