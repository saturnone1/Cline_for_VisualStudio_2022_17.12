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
			className={`relative flex h-28 w-28 items-center justify-center drop-shadow-[0_16px_32px_rgba(0,0,0,0.30)] ${className}`}>
			<img alt="LIG" className="h-full w-full object-contain" src={ligMark} />
		</div>
	)
}

export default LigHeroLogo
