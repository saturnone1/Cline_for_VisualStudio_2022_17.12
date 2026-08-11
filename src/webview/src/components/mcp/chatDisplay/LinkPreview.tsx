import { StringRequest } from "@shared/proto/cline/common"
import DOMPurify from "dompurify"
import React, { useCallback, useEffect, useMemo, useState } from "react"
import ChatErrorBoundary from "@/components/chat/ChatErrorBoundary"
import { WebServiceClient } from "@/services/grpcClient"
import { getSafeHostname, normalizeRelativeUrl } from "./utils/mcpRichUtil"

interface OpenGraphData {
	title?: string
	description?: string
	image?: string
	url?: string
	siteName?: string
	type?: string
}

interface LinkPreviewProps {
	url: string
}

const LinkPreview: React.FC<LinkPreviewProps> = ({ url }) => {
	const [loading, setLoading] = useState(true)
	const [error, setError] = useState("")
	const [data, setData] = useState<OpenGraphData | null>(null)
	const hostname = useMemo(() => getSafeHostname(url), [url])

	useEffect(() => {
		let disposed = false
		setLoading(true)
		setError("")
		setData(null)
		WebServiceClient.fetchOpenGraphData(StringRequest.create({ value: url }))
			.then((response) => {
				if (disposed) return
				setData({
					title: response.title || undefined,
					description: response.description || undefined,
					image: response.image || undefined,
					url: response.url || undefined,
					siteName: response.siteName || undefined,
					type: response.type || undefined,
				})
			})
			.catch((cause) => {
				if (!disposed) setError(cause instanceof Error ? cause.message : String(cause))
			})
			.finally(() => {
				if (!disposed) setLoading(false)
			})
		return () => { disposed = true }
	}, [url])

	const openUrl = useCallback(async () => {
		try {
			await WebServiceClient.openInBrowser(StringRequest.create({ value: DOMPurify.sanitize(url) }))
		} catch (cause) {
			console.error("Error opening URL in browser:", cause)
		}
	}, [url])

	if (loading) {
		return (
			<div className="flex h-32 max-w-lg items-center justify-center rounded border border-(--vscode-editorWidget-border) text-(--vscode-descriptionForeground)">
				<span className="codicon codicon-loading codicon-modifier-spin mr-2" />
				Loading preview for {hostname}...
			</div>
		)
	}

	if (error) {
		return (
			<button
				className="h-32 w-full max-w-lg cursor-pointer overflow-auto rounded border border-(--vscode-editorWidget-border) bg-transparent p-3 text-left text-(--vscode-errorForeground)"
				onClick={openUrl}
				type="button">
				<div className="font-semibold">Unable to load preview</div>
				<div className="mt-1 text-xs">{hostname}</div>
				<div className="mt-1 text-[11px] opacity-80">{error}</div>
				<div className="mt-2 text-[11px] text-(--vscode-textLink-foreground)">Click to open in browser</div>
			</button>
		)
	}

	const preview = data ?? { title: hostname, siteName: hostname, description: "No description available" }
	return (
		<button
			className="flex h-32 w-full max-w-lg cursor-pointer overflow-hidden rounded border border-(--vscode-editorWidget-border) bg-transparent p-0 text-left text-inherit"
			onClick={openUrl}
			type="button">
			{preview.image && (
				<div className="h-32 w-32 shrink-0">
					<img
						alt=""
						onError={(event) => { event.currentTarget.style.display = "none" }}
						src={DOMPurify.sanitize(normalizeRelativeUrl(preview.image, url))}
						style={{ height: "100%", objectFit: "contain", objectPosition: "center", width: "100%" }}
					/>
				</div>
			)}
			<div className="flex h-full min-w-0 flex-1 flex-col overflow-hidden p-3">
				<div className="truncate font-semibold">{preview.title || "No title"}</div>
				<div className="mb-2 truncate text-xs text-(--vscode-textLink-foreground)">
					{preview.siteName || hostname}
				</div>
				<div className="line-clamp-3 flex-1 overflow-hidden text-xs text-(--vscode-descriptionForeground)">
					{preview.description || "No description available"}
				</div>
			</div>
		</button>
	)
}

const MemoizedLinkPreview = React.memo(LinkPreview)

const LinkPreviewWithErrorBoundary: React.FC<LinkPreviewProps> = (props) => (
	<ChatErrorBoundary errorTitle="Something went wrong displaying this link preview" resetKey={props.url}>
		<MemoizedLinkPreview {...props} />
	</ChatErrorBoundary>
)

export default LinkPreviewWithErrorBoundary
