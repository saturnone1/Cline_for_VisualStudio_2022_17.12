import type { ImgHTMLAttributes } from "react"
import ligCiWhite from "./lig-ci-white.png"

const ClineLogoWhite = ({ alt = "LIG VS", ...props }: ImgHTMLAttributes<HTMLImageElement>) => (
	<img alt={alt} src={ligCiWhite} {...props} />
)
export default ClineLogoWhite
