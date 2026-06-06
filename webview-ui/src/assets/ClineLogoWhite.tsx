import type { ImgHTMLAttributes } from "react"
import ligWordmarkWhite from "./lig-wordmark-white.png"

const ClineLogoWhite = ({ alt = "LIG VS", ...props }: ImgHTMLAttributes<HTMLImageElement>) => (
	<img alt={alt} src={ligWordmarkWhite} {...props} />
)
export default ClineLogoWhite
