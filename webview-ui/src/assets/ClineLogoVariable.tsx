import type { ImgHTMLAttributes } from "react"
import type { Environment } from "../../../src/shared/config-types"
import { Environment as EnvironmentValue } from "../../../src/shared/config-types"
import ligWordmarkBlue from "./lig-wordmark-blue.png"
import ligWordmarkGray from "./lig-wordmark-gray.png"
import ligWordmarkWhite from "./lig-wordmark-white.png"

const ClineLogoVariable = ({
	alt = "LIG VS",
	environment,
	...props
}: ImgHTMLAttributes<HTMLImageElement> & { environment?: Environment }) => {
	const source = environment === EnvironmentValue.local ? ligWordmarkBlue : environment === EnvironmentValue.staging ? ligWordmarkGray : ligWordmarkWhite

	return <img alt={alt} src={source} {...props} />
}

export default ClineLogoVariable
