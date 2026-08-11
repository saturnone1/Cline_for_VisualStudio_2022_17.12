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
			className={`lig-brand-logo relative flex h-32 w-32 items-center justify-center ${className}`}>
			<div aria-hidden="true" className="lig-brand-orbit absolute inset-0 rounded-full" />
			<img alt="LIG" className="lig-brand-mark h-28 w-28 object-contain" src={ligMark} />
		</div>
	)
}

export default LigHeroLogo
