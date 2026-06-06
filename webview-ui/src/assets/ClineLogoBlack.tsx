import type { ImgHTMLAttributes } from "react"
import ligCiBlack from "./lig-ci-black.png"

const ClineLogoBlack = ({ alt = "LIG VS", ...props }: ImgHTMLAttributes<HTMLImageElement>) => (
	<img alt={alt} src={ligCiBlack} {...props} />
)

export default ClineLogoBlack
