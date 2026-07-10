/// <reference types="vitest/config" />

import { writeFileSync } from "node:fs"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react-swc"
import { resolve } from "path"
import { defineConfig, type Plugin, ViteDevServer } from "vite"

// Custom plugin to write the server port to a file
const writePortToFile = (): Plugin => {
	return {
		name: "write-port-to-file",
		configureServer(server: ViteDevServer) {
			server.httpServer?.once("listening", () => {
				const address = server.httpServer?.address()
				const port = typeof address === "object" && address ? address.port : null

				if (port) {
					const portFilePath = resolve(__dirname, ".vite-port")
					writeFileSync(portFilePath, port.toString())
				} else {
					console.warn("[writePortToFile] Could not determine server port")
				}
			})
		},
	}
}

const isDevBuild = process.argv.includes("--dev-build")

// Valid platforms, these should match the keys in platformConfigs.json
const VALID_PLATFORMS = ["vscode", "standalone"]
const platform = process.env.PLATFORM || "vscode" // Default to vscode

if (!VALID_PLATFORMS.includes(platform)) {
	throw new Error(`Invalid PLATFORM "${platform}". Must be one of: ${VALID_PLATFORMS.join(", ")}`)
}
console.log("Building webview for", platform)

export default defineConfig({
	base: "./",
	optimizeDeps: {
		force: true, // Forces re-optimization
	},
	plugins: [react(), tailwindcss(), writePortToFile()],
	test: {
		environment: "jsdom",
		globals: true,
		setupFiles: ["./src/setupTests.ts"],
		coverage: {
			provider: "v8",
			reportOnFailure: true,
			reporter: ["html", "lcov", "text"],
			reportsDirectory: "./coverage",
			exclude: [
				"**/*.{spec,test}.{js,jsx,ts,tsx,mjs,cjs}",

				"**/*.d.ts",
				"**/vite-env.d.ts",
				"**/*.{config,setup}.{js,ts,mjs,cjs}",

				"**/*.{css,scss,sass,less,styl}",
				"**/*.{svg,png,jpg,jpeg,gif,ico}",

				"**/*.{json,yaml,yml}",

				"**/__mocks__/**",
				"node_modules/**",
				"build/**",
				"coverage/**",
				"dist/**",
				"public/**",

				"src/services/grpcClient.ts",
			],
		},
	},
	build: {
		outDir: "../../artifacts/WebApp",
		emptyOutDir: true,
		reportCompressedSize: false,
		// Only minify in production build
		minify: !isDevBuild,
		// Enable inline source maps for dev build
		sourcemap: isDevBuild ? "inline" : false,
		rollupOptions: {
			output: {
				inlineDynamicImports: true,
				entryFileNames: `assets/[name].js`,
				chunkFileNames: `assets/[name].js`,
				assetFileNames: `assets/[name].[ext]`,
				// Disable compact output for dev build
				compact: !isDevBuild,
				// Add generous formatting for dev build
				...(isDevBuild && {
					generatedCode: {
						constBindings: false,
						objectShorthand: false,
						arrowFunctions: false,
					},
				}),
			},
		},
		chunkSizeWarningLimit: 100000,
	},
	server: {
		port: 25463,
		hmr: {
			host: "localhost",
			protocol: "ws",
		},
		cors: {
			origin: "*",
			methods: "*",
			allowedHeaders: "*",
		},
	},
	define: {
		__PLATFORM__: JSON.stringify(platform),
		process: JSON.stringify({
			platform: JSON.stringify(process?.platform),
			env: {
				NODE_ENV: JSON.stringify(process?.env?.IS_DEV ? "development" : "production"),
				CLINE_ENVIRONMENT: JSON.stringify(process?.env?.CLINE_ENVIRONMENT ?? "production"),
				IS_DEV: JSON.stringify(process?.env?.IS_DEV),
				IS_TEST: JSON.stringify(process?.env?.IS_TEST),
				CI: JSON.stringify(process?.env?.CI),
				// PostHog environment variables
				TELEMETRY_SERVICE_API_KEY: JSON.stringify(process?.env?.TELEMETRY_SERVICE_API_KEY),
				ERROR_SERVICE_API_KEY: JSON.stringify(process?.env?.ERROR_SERVICE_API_KEY),
			},
		}),
	},
 	resolve: {
 		alias: {
  			"@emotion/is-prop-valid": resolve(
  				__dirname,
  				"./node_modules/@emotion/is-prop-valid/dist/emotion-is-prop-valid.esm.js",
  			),
  			"@heroui/system-rsc": resolve(
  				__dirname,
  				"./node_modules/@heroui/system-rsc/dist/index.mjs",
  			),
  			"@radix-ui/react-dialog": resolve(__dirname, "./node_modules/@radix-ui/react-dialog/dist/index.mjs"),
  			"@radix-ui/react-hover-card": resolve(
  				__dirname,
  				"./node_modules/@radix-ui/react-hover-card/dist/index.mjs",
  			),
  			"@radix-ui/react-label": resolve(__dirname, "./node_modules/@radix-ui/react-label/dist/index.mjs"),
  			"@radix-ui/react-popover": resolve(__dirname, "./node_modules/@radix-ui/react-popover/dist/index.mjs"),
  			"@radix-ui/react-progress": resolve(__dirname, "./node_modules/@radix-ui/react-progress/dist/index.mjs"),
  			"@radix-ui/react-select": resolve(__dirname, "./node_modules/@radix-ui/react-select/dist/index.mjs"),
  			"@radix-ui/react-separator": resolve(
  				__dirname,
  				"./node_modules/@radix-ui/react-separator/dist/index.mjs",
  			),
  			"@radix-ui/react-slider": resolve(__dirname, "./node_modules/@radix-ui/react-slider/dist/index.mjs"),
  			"@radix-ui/react-switch": resolve(__dirname, "./node_modules/@radix-ui/react-switch/dist/index.mjs"),
			"@radix-ui/react-tooltip": resolve(__dirname, "./node_modules/@radix-ui/react-tooltip/dist/index.mjs"),
			"@": resolve(__dirname, "./src"),
			"@components": resolve(__dirname, "./src/components"),
			"@context": resolve(__dirname, "./src/context"),
			"@shared": resolve(__dirname, "../shared"),
			"@utils": resolve(__dirname, "./src/utils"),
		},
	},
})
