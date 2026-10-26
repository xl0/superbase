import adapter from '@sveltejs/adapter-node';
import type { Adapter } from '@sveltejs/kit';
import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

/** Demo build: static files with a single-page fallback, for any static host. */
const staticSite = (out: string): Adapter => ({
	name: 'superbase-demo',
	async adapt(builder) {
		builder.rimraf(out);
		builder.writeClient(out);
		builder.writePrerendered(out);
		await builder.generateFallback(`${out}/index.html`);
		// GitHub Pages answers unknown paths with 404.html: deep links load the app too.
		builder.copy(`${out}/index.html`, `${out}/404.html`);
	}
});

export default defineConfig(({ mode }) => {
	// `--mode demo` swaps the remote functions for PostgreSQL in the browser (src/lib/demo).
	const demo = mode === 'demo';
	return {
		plugins: [
			tailwindcss(),
			sveltekit({
				compilerOptions: {
					// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
					runes: ({ filename }) =>
						filename.split(/[/\\]/).includes('node_modules') ? undefined : true,
					experimental: { async: true }
				},
				experimental: {
					remoteFunctions: true
				},
				adapter: demo ? staticSite('build-demo') : adapter(),
				// For a demo served from a subpath, e.g. BASE_PATH=/superbase on GitHub Pages.
				paths: { base: (process.env.BASE_PATH ?? '') as '' | `/${string}` }
			})
		],
		resolve: {
			alias: demo ? [{ find: /^#lib\/db\.remote\.js$/, replacement: fileURLToPath(new URL('./src/lib/demo/db.svelte.ts', import.meta.url)) }] : []
		},
		optimizeDeps: { exclude: ['@electric-sql/pglite'] }
	};
});
