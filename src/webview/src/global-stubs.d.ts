declare module "@anthropic-ai/sdk" {
	export namespace Anthropic {
		type TextBlockParam = any
		type ImageBlockParam = any
		type DocumentBlockParam = any
		type ToolResultBlockParam = any
		type ToolUseBlockParam = any
		type ThinkingBlock = any
		type RedactedThinkingBlockParam = any
		type MessageParam = any
		type ContentBlock = any
	}
}

declare module "vscode" {
	export type LanguageModelChatSelector = any
	export type LanguageModelChatInformation = any
}

declare module "zod" {
	export const z: any
	export type infer<T> = any
	export type ZodTypeAny = any
}
