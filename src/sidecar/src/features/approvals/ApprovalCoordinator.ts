import type { ToolApprovalResult } from "../../application/ports/AgentInteraction"

export class ApprovalCoordinator {
	private resolver: ((result: ToolApprovalResult) => void) | null = null

	get hasPending() { return this.resolver !== null }

	request() {
		this.clear({ approved: false, reason: "Superseded by a newer LIG VS tool approval request." })
		return new Promise<ToolApprovalResult>((resolve) => { this.resolver = resolve })
	}

	take() {
		const resolver = this.resolver
		this.resolver = null
		return resolver
	}

	clear(result: ToolApprovalResult) {
		const resolver = this.take()
		resolver?.(result)
	}
}
