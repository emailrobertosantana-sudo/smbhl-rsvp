import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		projects: [
			{
				plugins: [
					cloudflareTest({
						wrangler: { configPath: "./wrangler.jsonc" },
					}),
				],
				test: {
					name: "workers",
					include: ["test/**/*.spec.js"],
				},
			},
			// Public page QA batch: tests that need a real browser layout
			// (contrast, overflow) -- they run in Node, drive the Worker
			// through wrangler's local test harness, and measure the page
			// in Playwright's Chromium. See test/rendered/support/.
			{
				test: {
					name: "rendered",
					environment: "node",
					include: ["test/rendered/**/*.spec.mjs"],
					testTimeout: 300000,
					hookTimeout: 180000,
					fileParallelism: false,
				},
			},
		],
	},
});
