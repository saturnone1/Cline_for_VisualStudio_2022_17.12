import { BannerAction, BannerCardData } from "@shared/cline/banner"
import { CircleAlert, ExternalLink, Gift, Info, Megaphone, Rocket, Sparkles, TriangleAlert, type LucideIcon } from "lucide-react"
import React from "react"
import { BannerData } from "@/components/common/BannerCarousel"

const bannerIcons: Readonly<Record<string, LucideIcon>> = {
	"circle-alert": CircleAlert,
	"external-link": ExternalLink,
	gift: Gift,
	info: Info,
	megaphone: Megaphone,
	rocket: Rocket,
	sparkles: Sparkles,
	"triangle-alert": TriangleAlert,
	warning: TriangleAlert,
}

function bannerIcon(name: string | undefined) {
	if (!name) return undefined
	const Icon = bannerIcons[name.trim().toLowerCase()] ?? Info
	return <Icon className="size-4" />
}

/**
 * Convert BannerCardData to BannerData for rendering
 */
export function convertBannerData(
	banner: BannerCardData,
	handlers: {
		onAction: (action: BannerAction) => void
		onDismiss: (bannerId: string) => void
	},
): BannerData {
	const { onAction, onDismiss } = handlers

	// Filter and process actions
	const filteredActions =
		banner.actions?.map((action) => ({
			label: action.title,
			onClick: () => onAction(action),
		})) || []

	return {
		id: banner.id,
		icon: bannerIcon(banner.icon),
		title: banner.title,
		description: banner.description,
		actions: filteredActions.length > 0 ? filteredActions : undefined,
		onDismiss: () => onDismiss(banner.id),
	}
}
