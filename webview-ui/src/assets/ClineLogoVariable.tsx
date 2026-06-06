import type { ImgHTMLAttributes } from "react"
import type { Environment } from "../../../src/shared/config-types"
import { Environment as EnvironmentValue } from "../../../src/shared/config-types"
import ligCiBlack from "./lig-ci-black.png"
import ligCiWhite from "./lig-ci-white.png"

const ClineLogoVariable = ({
	alt = "LIG VS",
	environment,
	...props
}: ImgHTMLAttributes<HTMLImageElement> & { environment?: Environment }) => {
	const source = environment === EnvironmentValue.local ? ligCiBlack : ligCiWhite

	return <img alt={alt} src={source} {...props} />
}

export default ClineLogoVariable
