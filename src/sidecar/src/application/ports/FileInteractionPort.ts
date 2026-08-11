export type RuleFileMutation = Readonly<{
	isGlobal: boolean
	filename?: string
	rulePath?: string
	type?: string
}>

export type SkillFileMutation = Readonly<{
	isGlobal: boolean
	skillName?: string
	skillPath?: string
}>

export interface FileInteractionPort {
	createRule(request: RuleFileMutation, workspaceRoot: string): Promise<string>
	deleteRule(request: RuleFileMutation, workspaceRoot: string): Promise<void>
	createSkill(request: SkillFileMutation, workspaceRoot: string): Promise<string>
	deleteSkill(request: SkillFileMutation, workspaceRoot: string): Promise<void>
	openMention(value: string, workspaceRoots: readonly string[]): Promise<void>
	openImage(value: string): Promise<void>
	openConversationHistory(taskId: string, content: string): Promise<void>
	openFocusChain(taskId: string, content: string): Promise<void>
}
