import { EmptyRequest } from "@shared/proto/cline/common"
import { VSCodeButton, VSCodeLink } from "@vscode/webview-ui-toolkit/react"
import styled from "styled-components"
import { LINKS } from "@/constants"
import { useI18n } from "@/i18n"
import { McpServiceClient } from "@/services/grpcClient"

type AddLocalServerFormProps = {
	onServerAdded: () => void
}

const AddLocalServerForm = ({}: AddLocalServerFormProps) => {
	const { t } = useI18n()

	return (
		<FormContainer>
			<div className="text-(--vscode-foreground)">
				{t("mcp.local.description")} <code>cline_mcp_settings.json</code>. {t("mcp.local.descriptionTail")}{" "}
				<VSCodeLink href={LINKS.DOCUMENTATION.LOCAL_MCP_SERVER_DOCS} style={{ display: "inline" }}>
					{t("mcp.remote.here")}
				</VSCodeLink>
			</div>

			<VSCodeButton
				appearance="primary"
				onClick={() => {
					McpServiceClient.openMcpSettings(EmptyRequest.create({})).catch((error) => {
						console.error("Error opening MCP settings:", error)
					})
				}}
				style={{ width: "100%", marginBottom: "5px", marginTop: 8 }}>
				{t("mcp.local.openSettings")}
			</VSCodeButton>
		</FormContainer>
	)
}

const FormContainer = styled.div`
	padding: 16px 20px;
	display: flex;
	flex-direction: column;
	gap: 8px;
`

export default AddLocalServerForm
