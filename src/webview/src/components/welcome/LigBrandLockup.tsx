import LigHeroLogo from "./LigHeroLogo"

interface LigBrandLockupProps {
	environment?: string
}

const LigBrandLockup = ({ environment }: LigBrandLockupProps) => (
	<div className="lig-brand-lockup flex flex-col items-center gap-4">
		<LigHeroLogo environment={environment} />
		<div className="lig-brand-copy flex flex-col items-center text-center">
			<div className="lig-brand-title text-[clamp(2.25rem,16vw,4.75rem)] leading-none font-black tracking-normal">
				LIG VS
			</div>
			<div className="lig-brand-byline mt-2 text-sm font-semibold tracking-normal">by M&amp;S.Team3</div>
		</div>
	</div>
)

export default LigBrandLockup
