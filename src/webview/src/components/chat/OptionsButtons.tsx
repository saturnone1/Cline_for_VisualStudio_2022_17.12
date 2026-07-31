import { AskResponseRequest } from "@shared/proto/cline/task"
import { useRef, useState } from "react"
import styled from "styled-components"
import { CODE_BLOCK_BG_COLOR } from "@/components/common/CodeBlock"
import { TaskServiceClient } from "@/services/grpcClient"
import { createClientOperationId } from "@/services/grpcClientBase"

const OptionButton = styled.button<{ $isSelected?: boolean; $isNotSelectable?: boolean }>`
	padding: 8px 12px;
	background: ${(props) => (props.$isSelected ? "var(--vscode-focusBorder)" : CODE_BLOCK_BG_COLOR)};
	color: ${(props) => (props.$isSelected ? "white" : "var(--vscode-input-foreground)")};
	border: 1px solid var(--vscode-editorGroup-border);
	border-radius: 2px;
	cursor: ${(props) => (props.$isNotSelectable ? "default" : "pointer")};
	text-align: left;
	font-size: 12px;

	${(props) =>
		!props.$isNotSelectable &&
		`
		&:hover {
			background: var(--vscode-focusBorder);
			color: white;
		}
	`}
`

export const OptionsButtons = ({
	options,
	selected,
	isActive,
	inputValue,
}: {
	options?: string[]
	selected?: string
	isActive?: boolean
	inputValue?: string
}) => {
	const responseInFlightRef = useRef(false)
	const [responsePending, setResponsePending] = useState(false)

	if (!options?.length) {
		return null
	}

	const hasSelected = selected !== undefined && options.includes(selected)

	return (
		<div
			style={{
				display: "flex",
				flexDirection: "column",
				gap: "8px",
			}}>
			{/* <div style={{ color: "var(--vscode-descriptionForeground)", fontSize: "11px", textTransform: "uppercase" }}>
				SELECT ONE:
			</div> */}
			{options.map((option, index) => (
				<OptionButton
					className="options-button"
					disabled={hasSelected || !isActive || responsePending}
					id={`options-button-${index}`}
					$isNotSelectable={hasSelected || !isActive || responsePending}
					$isSelected={option === selected}
					key={index}
					onClick={async () => {
						if (hasSelected || !isActive || responseInFlightRef.current) {
							return
						}
						responseInFlightRef.current = true
						setResponsePending(true)
						try {
							await TaskServiceClient.askResponse(
								AskResponseRequest.create({
									responseType: "messageResponse",
									text: option + (inputValue ? `: ${inputValue?.trim()}` : ""),
									images: [],
									clientOperationId: createClientOperationId(),
								}),
							)
						} catch (error) {
							console.error("Error sending option response:", error)
						} finally {
							responseInFlightRef.current = false
							setResponsePending(false)
						}
					}}>
					<span className="ph-no-capture">{option}</span>
				</OptionButton>
			))}
		</div>
	)
}
