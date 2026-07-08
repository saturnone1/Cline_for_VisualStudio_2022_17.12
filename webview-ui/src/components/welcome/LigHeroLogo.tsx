import { ShieldCheck, Sparkles } from "lucide-react"
import ligMarkBlack from "@/assets/lig-mark-black.png"
import ligMarkWhite from "@/assets/lig-mark-white.png"

interface LigHeroLogoProps {
	className?: string
	environment?: string
}

const LigHeroLogo = ({ className = "", environment }: LigHeroLogoProps) => {
	const ligMark = environment === "local" ? ligMarkBlack : ligMarkWhite

	return (
		<div
			className={`relative flex h-20 w-20 items-center justify-center rounded-full border border-[var(--vscode-focusBorder)]/35 bg-[var(--vscode-editorWidget-background)] shadow-[0_14px_34px_rgba(0,0,0,0.22)] ${className}`}>
			<div className="absolute -right-1 top-2 flex h-7 w-7 items-center justify-center rounded-full border border-[var(--vscode-focusBorder)]/45 bg-[var(--vscode-editor-background)]">
				<Sparkles className="h-3.5 w-3.5 text-[var(--vscode-focusBorder)]" />
			</div>
			<div className="flex h-14 w-14 items-center justify-center rounded-full bg-[var(--vscode-button-background)]">
				<img alt="LIG" className="h-7 w-7 object-contain" src={ligMark} />
			</div>
			<ShieldCheck className="absolute -bottom-1 left-1 h-6 w-6 rounded-full bg-[var(--vscode-editor-background)] p-1 text-[var(--vscode-testing-iconPassed)]" />
		</div>
	)
}

export default LigHeroLogo
