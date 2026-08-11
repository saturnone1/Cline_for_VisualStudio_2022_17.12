import type { OAuthAuthorizationPort } from "../../application/ports/OAuthAuthorizationPort"
import { createOAuthAuthorizationRequest } from "./ProviderAuthSupport"

export class ProviderOAuthAuthorizationAdapter implements OAuthAuthorizationPort {
	create(provider: string, callbackUrl: string, state: string, request: Record<string, unknown>) {
		const authorization = createOAuthAuthorizationRequest(provider, callbackUrl, state, request)
		return { ...authorization, tokenExchange: authorization.tokenExchange || undefined }
	}
}
