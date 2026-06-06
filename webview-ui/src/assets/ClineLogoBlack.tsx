import type { ImgHTMLAttributes } from "react"
import ligWordmarkBlack from "./lig-wordmark-black.png"

const ClineLogoBlack = ({ alt = "LIG VS", ...props }: ImgHTMLAttributes<HTMLImageElement>) => (
	<img alt={alt} src={ligWordmarkBlack} {...props} />
)

export default ClineLogoBlack
