import { defineConfig } from "vitest/config";

const DOM_TESTS = ["test/textmap/**/*.test.ts", "test/highlight/**/*.test.ts"];

export default defineConfig({
	test: {
		passWithNoTests: true,
		projects: [
			{
				test: {
					name: "node",
					environment: "node",
					include: ["test/**/*.test.ts"],
					exclude: DOM_TESTS,
				},
			},
			{
				test: {
					name: "jsdom",
					environment: "jsdom",
					include: DOM_TESTS,
				},
			},
		],
	},
});
