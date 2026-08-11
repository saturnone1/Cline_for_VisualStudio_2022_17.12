import { StringRequest } from "@shared/proto/cline/common"
import { WebServiceClient } from "@/services/grpcClient"

// Represents a URL found in the text with its position and metadata
export interface UrlMatch {
	url: string // The actual URL
	fullMatch: string // The full matched text
	index: number // Position in the text
	isImage: boolean // Whether this URL is an image
	isProcessed: boolean // Whether we've already processed this URL (to avoid duplicates)
}

// Display segment interface
export interface DisplaySegment {
	type: "text" | "url" | "image" | "link" | "error"
	content: string
	url?: string
	key: string // Pre-computed key for React
}

/**
 * Truncates a single data URI to show prefix + first 20 chars
 * e.g. "data:image/png;base64,iVBORw0KGgo..." becomes "[IMAGE] data:image/png;base64,iVBORw0KGgoAAAANS..."
 */
export const truncateSingleDataUri = (dataUri: string): string => {
	const commaIndex = dataUri.indexOf(",")
	if (commaIndex === -1) {
		return dataUri
	}
	const dataStart = commaIndex + 1
	const data = dataUri.substring(dataStart)
	const truncatedData = data.length > 20 ? data.substring(0, 20) + "..." : data
	return `[IMAGE] ${dataUri.substring(0, dataStart)}${truncatedData}`
}

/**
 * Truncates all data URIs in text
 * e.g. "data:image/png;base64,iVBORw0KGgo..." becomes "[IMAGE] data:image/png;base64,iVBORw..."
 */
export const truncateDataUris = (text: string): string => {
	return text.replace(/data:[^;,]+(?:;[^,]+)?,[^\s<>"']+/g, (match) => truncateSingleDataUri(match))
}

// Safely create a URL object with error handling and ensure HTTPS
export const safeCreateUrl = (url: string): URL | null => {
	try {
		// Convert HTTP to HTTPS for security
		if (url.startsWith("http://")) {
			url = url.replace("http://", "https://")
		}

		return new URL(url)
	} catch (_e) {
		// If the URL doesn't have a protocol, add https://
		if (!url.startsWith("https://")) {
			try {
				return new URL(`https://${url}`)
			} catch (_e) {
				return null
			}
		}
		return null
	}
}

// Check if a string is a valid URL
export const isUrl = (str: string): boolean => {
	return safeCreateUrl(str) !== null
}

// Get hostname safely
export const getSafeHostname = (url: string): string => {
	try {
		const urlObj = safeCreateUrl(url)
		return urlObj ? urlObj.hostname : "unknown-host"
	} catch (_e) {
		return "unknown-host"
	}
}

// Check if a URL is a localhost URL by examining the hostname
export const isLocalhostUrl = (url: string): boolean => {
	try {
		const hostname = getSafeHostname(url)
		return (
			hostname === "localhost" ||
			hostname === "127.0.0.1" ||
			hostname === "0.0.0.0" ||
			hostname.startsWith("192.168.") ||
			hostname.startsWith("10.") ||
			hostname.endsWith(".local")
		)
	} catch (_e) {
		// If we can't parse the URL, assume it's not localhost
		return false
	}
}

// Function to normalize relative URLs by combining with a base URL
export const normalizeRelativeUrl = (relativeUrl: string, baseUrl: string): string => {
	// If it's already an absolute URL or a data URL, return as is
	if (relativeUrl.startsWith("http://") || relativeUrl.startsWith("https://") || relativeUrl.startsWith("data:")) {
		return relativeUrl
	}

	try {
		// Parse the base URL
		const baseUrlObj = safeCreateUrl(baseUrl)
		if (!baseUrlObj) {
			return relativeUrl // If we can't parse the base URL, return original
		}

		// Handle different types of relative paths
		if (relativeUrl.startsWith("//")) {
			// Protocol-relative URL
			return `${baseUrlObj.protocol}${relativeUrl}`
		} else if (relativeUrl.startsWith("/")) {
			// Root-relative URL
			return `${baseUrlObj.protocol}//${baseUrlObj.host}${relativeUrl}`
		} else {
			// Path-relative URL
			// Get the directory part of the URL
			let basePath = baseUrlObj.pathname
			if (!basePath.endsWith("/")) {
				// If the path doesn't end with a slash, remove the file part
				basePath = basePath.substring(0, basePath.lastIndexOf("/") + 1)
			}
			return `${baseUrlObj.protocol}//${baseUrlObj.host}${basePath}${relativeUrl}`
		}
	} catch {
		return relativeUrl // Return original on error
	}
}

// Helper to ensure URL is in a format that can be opened
export const formatUrlForOpening = (url: string): string => {
	// If it's a data URI, return as is
	if (url.startsWith("data:image/")) {
		return url
	}

	// Use safeCreateUrl to validate and format the URL
	const urlObj = safeCreateUrl(url)
	if (urlObj) {
		return urlObj.href
	}

	// Return a safe fallback that won't crash
	return "about:blank"
}

// Function to check if a URL is an image using HEAD request
export const checkIfImageUrl = async (url: string): Promise<boolean> => {
	// For data URLs, we can check synchronously
	if (url.startsWith("data:image/")) {
		return true
	}

	const parsedUrl = safeCreateUrl(url)
	if (!parsedUrl || (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:")) {
		return false
	}

	try {
		const result = await WebServiceClient.checkIsImageUrl(StringRequest.create({ value: parsedUrl.href }))
		return result.isImage
	} catch {
		return false
	}
}

/**
 * Extracts all valid URLs from the given text
 * @param text - The text to search for URLs
 * @param maxUrls - Maximum number of URLs to extract (default: 50)
 * @returns Array of URL matches sorted by position in text
 */
export const extractUrlsFromText = (text: string, maxUrls: number = 50): UrlMatch[] => {
	const matches: UrlMatch[] = []
	const urlRegex = /(?:https?:\/\/|data:image)[^\s<>"']+/g
	let urlMatch: RegExpExecArray | null
	let urlCount = 0

	while ((urlMatch = urlRegex.exec(text)) !== null && urlCount < maxUrls) {
		const url = urlMatch[0]

		// Skip invalid URLs
		if (!isUrl(url)) {
			continue
		}

		// Skip localhost URLs to prevent security issues
		if (isLocalhostUrl(url)) {
			continue
		}

		matches.push({
			url,
			fullMatch: url,
			index: urlMatch.index,
			isImage: false, // Will be determined later
			isProcessed: false,
		})

		urlCount++
	}

	return matches.sort((a, b) => a.index - b.index)
}

/**
 * Processes URLs to determine their types (e.g., image vs link)
 * Processes URLs in small batches to avoid both network flooding and serial latency.
 * @param matches - Array of URL matches to process
 * @param onProgress - Callback for progress updates with updated matches
 * @param cancellationToken - Object to check if processing should be cancelled
 * @returns Promise that resolves when processing is complete
 */
export const processUrlTypes = async (
	matches: UrlMatch[],
	onProgress: (updatedMatches: UrlMatch[]) => void,
	cancellationToken: { cancelled: boolean },
): Promise<void> => {
	const pending = matches.filter((match) => !match.isProcessed)
	const batchSize = Math.min(4, pending.length)
	for (let offset = 0; offset < pending.length && !cancellationToken.cancelled; offset += batchSize) {
		const batch = pending.slice(offset, offset + batchSize)
		await Promise.all(batch.map(async (match) => {
			try {
				match.isImage = await checkIfImageUrl(match.url)
			} finally {
				match.isProcessed = true
			}
		}))
		if (!cancellationToken.cancelled) onProgress([...matches])
	}
}

/**
 * Orchestrates the URL extraction and processing pipeline
 * @param text - The response text to process
 * @param maxUrls - Maximum number of URLs to process
 * @param onMatchesFound - Callback when initial URLs are extracted
 * @param onMatchesUpdated - Callback when URL types are determined
 * @param onError - Error handler callback
 * @returns Cleanup function to cancel processing
 */
export const processResponseUrls = (
	text: string,
	maxUrls: number,
	onMatchesFound: (matches: UrlMatch[]) => void,
	onMatchesUpdated: (matches: UrlMatch[]) => void,
	onError: (error: string) => void,
): (() => void) => {
	const cancellationToken = { cancelled: false }

	const process = async () => {
		try {
			// Extract URLs from text
			const matches = extractUrlsFromText(text, maxUrls)

			// Immediately notify about found matches
			onMatchesFound(matches)

			// Process URLs in the background
			await processUrlTypes(matches, onMatchesUpdated, cancellationToken)
		} catch (_error) {
			onError("Failed to process response content. Switch to plain text mode to view safely.")
		}
	}

	// Start processing
	process()

	// Return cleanup function
	return () => {
		cancellationToken.cancelled = true
	}
}

/**
 * Builds an array of display segments from response text and URL matches
 * @param responseText - The full response text
 * @param urlMatches - Array of URL matches with their positions and types
 * @returns Array of display segments describing how to render the content
 */
export const buildDisplaySegments = (responseText: string, urlMatches: UrlMatch[]): DisplaySegment[] => {
	const segments: DisplaySegment[] = []
	let lastIndex = 0
	let segmentIndex = 0

	// Handle case with no URLs
	if (urlMatches.length === 0) {
		return [
			{
				type: "text",
				content: responseText,
				key: "segment-0",
			},
		]
	}

	// Process each URL match
	for (let i = 0; i < urlMatches.length; i++) {
		const match = urlMatches[i]
		const { url, fullMatch, index } = match

		// Add text segment before this URL
		if (index > lastIndex) {
			segments.push({
				type: "text",
				content: responseText.substring(lastIndex, index),
				key: `segment-${segmentIndex++}`,
			})
		}

		// Add the URL text itself (truncate data URIs since they're very long)
		const isDataUri = url.startsWith("data:")
		const urlContent = isDataUri ? truncateSingleDataUri(fullMatch) : fullMatch
		segments.push({
			type: "url",
			content: urlContent,
			key: `url-${segmentIndex++}`,
		})

		// Add embedded content after the URL
		if (match.isImage) {
			segments.push({
				type: "image",
				content: url,
				url: formatUrlForOpening(url),
				key: `embed-image-${url}-${segmentIndex++}`,
			})
		} else if (match.isProcessed && !isLocalhostUrl(url)) {
			segments.push({
				type: "link",
				content: url,
				url: formatUrlForOpening(url),
				key: `embed-${url}-${segmentIndex++}`,
			})
		}

		// Update lastIndex for next segment
		lastIndex = index + fullMatch.length
	}

	// Add any remaining text after the last URL
	if (lastIndex < responseText.length) {
		segments.push({
			type: "text",
			content: responseText.substring(lastIndex),
			key: `segment-${segmentIndex++}`,
		})
	}

	return segments
}
