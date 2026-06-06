import type { ImgHTMLAttributes } from "react"
import type { Environment } from "../../../src/shared/config-types"
import ligWordmarkBlue from "./lig-wordmark-blue.png"

const ClineLogoSanta = ({
	alt = "LIG VS",
	environment: _environment,
	...props
}: ImgHTMLAttributes<HTMLImageElement> & { environment?: Environment }) => <img alt={alt} src={ligWordmarkBlue} {...props} />

export default ClineLogoSanta
