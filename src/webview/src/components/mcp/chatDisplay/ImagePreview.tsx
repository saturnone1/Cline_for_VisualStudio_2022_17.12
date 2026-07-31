import { StringRequest } from "@shared/proto/cline/common"
import DOMPurify from "dompurify"
import React, { useCallback, useMemo, useState } from "react"
import ChatErrorBoundary from "@/components/chat/ChatErrorBoundary"
import { FileServiceClient, WebServiceClient } from "@/services/grpcClient"
import { formatUrlForOpening, getSafeHostname } from "./utils/mcpRichUtil"

interface ImagePreviewProps {
	url: string
}

const ImagePreview: React.FC<ImagePreviewProps> = ({ url }) => {
	const [status, setStatus] = useState<"loading" | "ready" | "error">("loading")
	const safeUrl = useMemo(() => DOMPurify.sanitize(url), [url])
	const hostname = useMemo(() => getSafeHostname(url), [url])

	const openImage = useCallback(async () => {
		try {
			if (url.startsWith("data:")) {
				await FileServiceClient.openImage(StringRequest.create({ value: url }))
				return
			}
			await WebServiceClient.openInBrowser(
				StringRequest.create({ value: DOMPurify.sanitize(formatUrlForOpening(url)) }),
			)
		} catch (error) {
			console.error("Error opening image:", error)
		}
	}, [url])

	if (status === "error") {
		return (
			<button
				className="image-preview-error w-full cursor-pointer rounded border border-(--vscode-editorWidget-border) bg-transparent p-3 text-left text-(--vscode-errorForeground)"
				onClick={openImage}
				type="button">
				<div className="font-semibold">Failed to load image</div>
				<div className="mt-1 text-xs">{hostname}</div>
				<div className="mt-2 text-[11px] text-(--vscode-textLink-foreground)">Click to open in browser</div>
			</button>
		)
	}

	return (
		<div
			className="image-preview relative my-2.5 max-w-full cursor-pointer overflow-hidden rounded"
			onClick={status === "ready" ? openImage : undefined}
			onKeyDown={(event) => {
				if (status === "ready" && (event.key === "Enter" || event.key === " ")) void openImage()
			}}
			role={status === "ready" ? "button" : undefined}
			tabIndex={status === "ready" ? 0 : undefined}>
			{status === "loading" && (
				<div className="flex h-32 items-center justify-center border border-(--vscode-editorWidget-border) text-(--vscode-descriptionForeground)">
					<span className="codicon codicon-loading codicon-modifier-spin mr-2" />
					Loading image from {hostname}...
				</div>
			)}
			<img
				alt={`Image from ${hostname}`}
				onError={() => setStatus("error")}
				onLoad={() => setStatus("ready")}
				src={safeUrl}
				style={{
					display: status === "loading" ? "none" : "block",
					height: "auto",
					maxWidth: "100%",
					width: "100%",
				}}
			/>
		</div>
	)
}

const MemoizedImagePreview = React.memo(ImagePreview)

const ImagePreviewWithErrorBoundary: React.FC<ImagePreviewProps> = (props) => (
	<ChatErrorBoundary errorTitle="Something went wrong displaying this image" resetKey={props.url}>
		<MemoizedImagePreview {...props} />
	</ChatErrorBoundary>
)

export default ImagePreviewWithErrorBoundary
