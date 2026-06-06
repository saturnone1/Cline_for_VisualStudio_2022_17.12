import type { ImgHTMLAttributes } from "react"
import type { Environment } from "../../../src/shared/config-types"
import ligCiWhite from "./lig-ci-white.png"

const ClineLogoSanta = ({
	alt = "LIG VS",
	environment: _environment,
	...props
}: ImgHTMLAttributes<HTMLImageElement> & { environment?: Environment }) => <img alt={alt} src={ligCiWhite} {...props} />

export default ClineLogoSanta
