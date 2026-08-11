export type OAuthCallbackHttpResult = Readonly<{ success: boolean; message: string }>
export type OAuthCallbackHttpHandler = (url: string) => Promise<OAuthCallbackHttpResult>

export interface OAuthCallbackListenerPort {
	start(handler: OAuthCallbackHttpHandler): Promise<number>
	dispose(): void
}
