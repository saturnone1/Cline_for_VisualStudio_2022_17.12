import type { ImgHTMLAttributes } from "react"
import type { Environment } from "@shared/configTypes"
import { Environment as EnvironmentValue } from "@shared/configTypes"
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
