import adapter from '@sveltejs/adapter-static';
import { fileURLToPath } from 'node:url';

const gatewayLib = fileURLToPath(new URL('../src/lib', import.meta.url));

/** @type {import('@sveltejs/kit').Config} */
const config = {
	kit: {
		adapter: adapter({
			pages: 'build',
			assets: 'build',
			fallback: 'index.html',
			precompress: false,
		}),
		paths: {
			base: '/ui',
		},
		alias: {
			'$components': './src/components',
			'$gatewayLib': gatewayLib,
		},
	},
	vitePlugin: {
		dynamicCompileOptions: ({ filename }) =>
			filename.includes('node_modules') ? undefined : { runes: true }
	}
};

export default config;
