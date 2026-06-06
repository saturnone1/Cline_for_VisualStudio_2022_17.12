import type { ImgHTMLAttributes } from "react"
import type { Environment } from "../../../src/shared/config-types"
import ligWordmarkGray from "./lig-wordmark-gray.png"

const ClineLogoTired = ({
	alt = "LIG VS",
	environment: _environment,
	...props
}: ImgHTMLAttributes<HTMLImageElement> & { environment?: Environment }) => <img alt={alt} src={ligWordmarkGray} {...props} />

export default ClineLogoTired
