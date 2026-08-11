import styled from "styled-components"
import { CODE_BLOCK_BG_COLOR } from "@/components/common/CodeBlock"

export const CheckpointContainer = styled.div<{ $isMenuOpen?: boolean; $isCheckedOut?: boolean }>`
	display: flex;
	align-items: center;
	padding: 8px 0 0;
	gap: 4px;
	position: relative;
	min-width: 0;
	min-height: 17px;
	margin-top: -2px;
	margin-bottom: 1px;
	opacity: ${(props) => (props.$isCheckedOut || props.$isMenuOpen ? 1 : 0.5)};

	&:first-of-type { padding-top: 0; }
	&:hover { opacity: 1; }
	.hover-content {
		display: ${(props) => (props.$isMenuOpen ? "flex" : "none")};
		align-items: center;
		gap: 4px;
		flex: 1;
	}
	&:hover .hover-content { display: flex; }
	.hover-show-inverse {
		display: ${(props) => (props.$isMenuOpen ? "none" : "flex")};
		flex: 1;
	}
	&:hover .hover-show-inverse { display: none; }
`

export const DottedLine = styled.div<{ $small?: boolean; $isCheckedOut?: boolean }>`
	flex: ${(props) => (props.$small ? "0 0 5px" : "1")};
	min-width: 5px;
	height: 1px;
	background-image: linear-gradient(
		to right,
		${(props) => (props.$isCheckedOut ? "var(--vscode-textLink-foreground)" : "var(--vscode-descriptionForeground)")} 50%,
		transparent 50%
	);
	background-size: 4px 1px;
	background-repeat: repeat-x;
`

export const ButtonGroup = styled.div`
	display: flex;
	align-items: center;
	gap: 4px;
	flex-shrink: 0;
`

export const CheckpointButton = styled.button<{ disabled?: boolean; $isActive?: boolean; $isCheckedOut?: boolean }>`
	background: ${(props) => props.$isActive || props.disabled ? props.$isCheckedOut ? "var(--vscode-textLink-foreground)" : "var(--vscode-descriptionForeground)" : "transparent"};
	border: none;
	color: ${(props) => props.$isActive || props.disabled ? "var(--vscode-editor-background)" : props.$isCheckedOut ? "var(--vscode-textLink-foreground)" : "var(--vscode-descriptionForeground)"};
	padding: 2px 6px;
	font-size: 9px;
	cursor: pointer;
	position: relative;

	&::before {
		content: "";
		position: absolute;
		inset: 0;
		border-radius: 1px;
		background-image: ${(props) => props.$isActive || props.disabled ? "none" : `linear-gradient(to right, ${props.$isCheckedOut ? "var(--vscode-textLink-foreground)" : "var(--vscode-descriptionForeground)"} 50%, transparent 50%), linear-gradient(to bottom, ${props.$isCheckedOut ? "var(--vscode-textLink-foreground)" : "var(--vscode-descriptionForeground)"} 50%, transparent 50%), linear-gradient(to right, ${props.$isCheckedOut ? "var(--vscode-textLink-foreground)" : "var(--vscode-descriptionForeground)"} 50%, transparent 50%), linear-gradient(to bottom, ${props.$isCheckedOut ? "var(--vscode-textLink-foreground)" : "var(--vscode-descriptionForeground)"} 50%, transparent 50%)`};
		background-size: 4px 1px, 1px 4px, 4px 1px, 1px 4px;
		background-repeat: repeat-x, repeat-y, repeat-x, repeat-y;
		background-position: 0 0, 100% 0, 0 100%, 0 0;
	}
	&:hover:not(:disabled) {
		background: ${(props) => props.$isCheckedOut ? "var(--vscode-textLink-foreground)" : "var(--vscode-descriptionForeground)"};
		color: var(--vscode-editor-background);
		&::before { display: none; }
	}
	&:disabled { opacity: 0.5; cursor: not-allowed; }
`

export const RestoreConfirmTooltip = styled.div`
	position: fixed;
	background: ${CODE_BLOCK_BG_COLOR};
	border: 1px solid var(--vscode-editorGroup-border);
	padding: 14px;
	border-radius: 5px;
	width: min(calc(100vw - 54px), 200px);
	z-index: 1000;
	box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);

	&::before { content: ""; position: absolute; top: -8px; left: 0; right: 0; height: 8px; }
	&::after {
		content: "";
		position: absolute;
		top: -6px;
		right: 24px;
		width: 10px;
		height: 10px;
		background: ${CODE_BLOCK_BG_COLOR};
		border-left: 1px solid var(--vscode-editorGroup-border);
		border-top: 1px solid var(--vscode-editorGroup-border);
		transform: rotate(45deg);
		z-index: 1;
	}
	&[data-placement^="top"]::before { top: auto; bottom: -8px; }
	&[data-placement^="top"]::after { top: auto; bottom: -6px; transform: rotate(225deg); }
	p { margin: 0; color: var(--vscode-descriptionForeground); font-size: 11px; line-height: 14px; white-space: normal; overflow-wrap: anywhere; }
`

export const PrimaryRestoreOption = styled.div`
	margin-bottom: 12px;
	p { margin-top: 8px; }
`

export const MoreOptionsToggle = styled.button`
	width: 100%;
	padding: 2px 0;
	margin-bottom: -4px;
	background: transparent;
	color: var(--vscode-textLink-foreground);
	border: none;
	font-size: 11px;
	cursor: pointer;
	display: flex;
	align-items: center;
	justify-content: flex-start;
	opacity: 0.8;
	&:hover { opacity: 1; }
`

export const AdditionalOptions = styled.div`
	padding-top: 8px;
	margin-top: 6px;
	border-top: 1px solid var(--vscode-editorGroup-border);
`

export const RestoreOption = styled.div`
	&:not(:last-child) { margin-bottom: 12px; }
	p { margin-top: 8px; }
`
