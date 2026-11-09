import path from 'path'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'url'
import { getConnectableHost, normalizeLoopbackHost } from './shared/networkHosts.js'
import { isLocalAuthDisabled } from './shared/localAuth.js'
import { LEGACY_LIGHT_PRESETS, LIGHT_PRESETS } from '../apps/desktop/src/lightAppearance'
import { renderLoadingHtml } from '../apps/desktop/src/appearance'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const repoRoot = path.resolve(__dirname, '..')

export default defineConfig(({ mode }) => {
  // Load the single root .env and let exported shell vars override file values.
  const env = {
    ...loadEnv(mode, repoRoot, ''),
    ...process.env,
  }

  const configuredHost = env.HOST || '0.0.0.0'
  // Keep wildcard bind addresses while using connectable proxy targets.
  const host = normalizeLoopbackHost(configuredHost)
  const proxyHost = env.PROXY_HOST || getConnectableHost(configuredHost)
  const serverPort = env.SERVER_PORT || env.PORT || 3001
  // Resolve through the package manager for both hoisted npm and local pnpm.
  const require = createRequire(import.meta.url)
  const codeMirrorDependencies = [
    '@codemirror/lang-css',
    '@codemirror/lang-html',
    '@codemirror/lang-javascript',
    '@codemirror/lang-json',
    '@codemirror/lang-markdown',
    '@codemirror/lang-python',
    '@codemirror/language',
    '@codemirror/merge',
    '@codemirror/search',
    '@codemirror/state',
    '@codemirror/theme-one-dark',
    '@codemirror/view',
    '@replit/codemirror-minimap',
    '@uiw/react-codemirror',
  ]

  const disableLocalAuth = isLocalAuthDisabled(env.PILOTDECK_DISABLE_LOCAL_AUTH)

  return {
    define: {
      'import.meta.env.VITE_PILOTDECK_VERSION': JSON.stringify(env.PILOTDECK_VERSION || JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).version),
      'import.meta.env.VITE_PILOTDECK_REQUEST_HEADERS': JSON.stringify(env.PILOTDECK_REQUEST_HEADERS || 'full'),
      'import.meta.env.VITE_DISABLE_LOCAL_AUTH': JSON.stringify(disableLocalAuth ? 'true' : 'false'),
    },
    plugins: [react(), {
      name: 'continuous-startup-shell',
      transformIndexHtml(html, context) {
        // Only the application's HTML entry owns the startup shell.
        if (path.resolve(context.filename) !== path.join(__dirname, 'index.html')) return html;
        const page = renderLoadingHtml({ language: 'en', themeMode: 'system' }, true);
        const style = page.match(/<style>([\s\S]*?)<\/style>/)[1];
        const body = page.match(/<body[^>]*>([\s\S]*?)<\/body>/)[1];
        return html.replace('<div id="root"></div>', () => `<div id="pilotdeck-startup-shell"><style>${style}</style>${body}</div><div id="root"></div>`);
      },
    }, {
      name: 'appearance-first-paint',
      transformIndexHtml() {
        // Apply the theme synchronously before the app bundle loads.
        return [{ tag: 'script', injectTo: 'head-prepend', children: `
          try {
            var desktop = window.pilotdeckDesktop?.getAppearance?.();
            var mode = desktop?.themeMode || localStorage.getItem('themeMode') || localStorage.getItem('theme') || 'system';
            if (!['light', 'dark', 'system'].includes(mode)) mode = 'system';
            var dark = mode === 'dark' || (mode === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
            document.documentElement.classList.toggle('dark', dark);
            document.documentElement.style.backgroundColor = dark ? '#0a0a0a' : '#ffffff';
            var preference = desktop?.lightAppearance || JSON.parse(localStorage.getItem('pilotdeck-light-appearance-v1') || 'null');
            var presets = ${JSON.stringify({ ...LIGHT_PRESETS, ...LEGACY_LIGHT_PRESETS })};
            var background = preference?.preset === 'custom' ? preference.custom?.background : presets[preference?.preset]?.background;
            document.documentElement.style.backgroundColor = dark ? '#0a0a0a' : /^#[0-9a-f]{6}$/i.test(background) ? background : '#ffffff';
          } catch (_) {}
        ` }];
      },
    }],
    resolve: {
      // All extensions and wrappers must share CodeMirror and React instances.
      dedupe: ['react', 'react-dom', ...codeMirrorDependencies],
      alias: [
        { find: /^react$/, replacement: require.resolve('react') },
        { find: /^react-dom$/, replacement: require.resolve('react-dom') },
        { find: /^react\/jsx-runtime$/, replacement: require.resolve('react/jsx-runtime') },
        { find: /^react\/jsx-dev-runtime$/, replacement: require.resolve('react/jsx-dev-runtime') },
      ]
    },
    optimizeDeps: {
      include: codeMirrorDependencies,
    },
    server: {
      host,
      port: parseInt(env.VITE_PORT) || 5173,
      proxy: {
        // The same-origin artifacts preview is intended for trusted networks.
        '/api/artifacts': { target: env.ARTIFACTS_PROXY_TARGET || 'http://127.0.0.1:8799', changeOrigin: true },
        '/artifacts-static': { target: env.ARTIFACTS_PROXY_TARGET || 'http://127.0.0.1:8799', changeOrigin: true },
        '/artifacts.js': { target: env.ARTIFACTS_PROXY_TARGET || 'http://127.0.0.1:8799', changeOrigin: true },
        '/artifacts.css': { target: env.ARTIFACTS_PROXY_TARGET || 'http://127.0.0.1:8799', changeOrigin: true },
        '/artifacts.html': { target: env.ARTIFACTS_PROXY_TARGET || 'http://127.0.0.1:8799', changeOrigin: true },
        '/api': `http://${proxyHost}:${serverPort}`,
        '/memory-dashboard': `http://${proxyHost}:${serverPort}`,
        '/ws': {
          target: `ws://${proxyHost}:${serverPort}`,
          ws: true,
          timeout: 0,
          proxyTimeout: 0,
        },
        '/shell': {
          target: `ws://${proxyHost}:${serverPort}`,
          ws: true,
          timeout: 0,
          proxyTimeout: 0,
        }
      }
    },
    build: {
      outDir: 'dist',
      manifest: true,
      chunkSizeWarningLimit: 1000,
      rollupOptions: {
        output: {
          manualChunks(id) {
            // Assign resolved packages, including React's internal JSX runtime.
            const modulePath = id.replaceAll('\\', '/')
            const vendorPackages = {
              'vendor-react': ['react', 'react-dom', 'react-router-dom'],
              'vendor-codemirror': [
                '@uiw/react-codemirror',
                '@codemirror/lang-css',
                '@codemirror/lang-html',
                '@codemirror/lang-javascript',
                '@codemirror/lang-json',
                '@codemirror/lang-markdown',
                '@codemirror/lang-python',
                '@codemirror/theme-one-dark'
              ],
              'vendor-xterm': ['@xterm/xterm', '@xterm/addon-fit', '@xterm/addon-clipboard', '@xterm/addon-webgl']
            }
            for (const [chunk, packages] of Object.entries(vendorPackages)) {
              if (packages.some(name => modulePath.includes(`/node_modules/${name}/`))) return chunk
            }
          }
        }
      }
    },
    test: {
      maxWorkers: process.platform === 'win32' ? 4 : undefined,
      // Fixture-heavy suites spawn real git/node subprocesses; the 5s default made
      // 21 suites fail with 'Test timed out' on a loaded Windows runner. The
      // node-side suite already allows 60s (package.json test:src).
      testTimeout: 30_000,
      hookTimeout: 30_000,
      environment: 'jsdom',
      // e2e/ 里是 Playwright 规格，不是 vitest 用例；交给 playwright 跑，
      // 否则会被 vitest 按 *.spec.mjs 收集进来并全部报错。
      include: [
        'src/**/*.{test,spec}.?(c|m)[jt]s?(x)',
        'server/**/*.{test,spec}.?(c|m)[jt]s?(x)',
        'shared/**/*.{test,spec}.?(c|m)[jt]s?(x)'
      ],
      server: {
        deps: {
          inline: ['react', 'react-dom']
        }
      }
    }
  }
})
