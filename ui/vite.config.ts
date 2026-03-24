import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig, loadEnv } from 'vite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig(({ mode }) => {
	const repoRoot = path.join(__dirname, '..');
	const rootEnv = loadEnv(mode, repoRoot, '');
	const gatewayProxy =
		process.env['GATEWAY_PROXY_TARGET'] ?? rootEnv['GATEWAY_PROXY_TARGET'];

	const host = process.env['HOST'] ?? rootEnv['HOST'] ?? '127.0.0.1';
	const gatewayPort = Number(
		rootEnv['PORT'] ?? process.env['PORT'] ?? 3000,
	);
	const proxyHost = host === '0.0.0.0' ? '127.0.0.1' : host;
	const proxyTarget =
		gatewayProxy ??
		`http://${proxyHost}:${Number.isFinite(gatewayPort) ? gatewayPort : 3000}`;

	/** With dev:all, GATEWAY_PROXY_TARGET is set and Vite uses PORT from .env. */
	const serverPort = gatewayProxy
		? Number(process.env['PORT'] ?? rootEnv['PORT'] ?? 3000)
		: Number(
				process.env['VITE_DEV_PORT'] ??
					rootEnv['VITE_DEV_PORT'] ??
					5173,
			);

	/** Same-origin dev: browser hits PORT; Vite forwards API paths to the gateway (PORT+1 in dev:all). */
	const proxy: Record<string, string> = {};
	for (const prefix of [
		'/admin',
		'/health',
		'/healthz',
		'/readyz',
		'/registry',
		'/mcp',
		'/debug',
	]) {
		proxy[prefix] = proxyTarget;
	}

	return {
		plugins: [tailwindcss(), sveltekit()],
		server: {
			host: host === '0.0.0.0' ? true : host,
			port: serverPort,
			strictPort: true,
			proxy,
		},
	};
});
