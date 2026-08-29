import { fileURLToPath, URL } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import plugin from '@vitejs/plugin-react';
import fs from 'fs';
import path from 'path';
import child_process from 'child_process';
export default defineConfig(function (_a) {
    var mode = _a.mode;
    var env = loadEnv(mode, process.cwd(), '');
    var baseURL = env.VITE_BASE_URL;
    var APPPORT = Number(env.VITE_APP_PORT || 5555);
    var certificateName = env.VITE_HTTPS_CERT_NAME || 'griddata.client';
    var baseFolder = env.APPDATA && env.APPDATA !== ''
        ? "".concat(env.APPDATA, "/ASP.NET/https")
        : "".concat(process.env.HOME, "/.aspnet/https");
    var certFilePath = path.join(baseFolder, "".concat(certificateName, ".pem"));
    var keyFilePath = path.join(baseFolder, "".concat(certificateName, ".key"));
    if (!fs.existsSync(certFilePath) || !fs.existsSync(keyFilePath)) {
        var result = child_process.spawnSync('dotnet', [
            'dev-certs',
            'https',
            '--export-path',
            certFilePath,
            '--format',
            'Pem',
            '--no-password',
        ], { stdio: 'inherit' });
        if (result.status !== 0) {
            throw new Error('Could not create HTTPS certificate.');
        }
    }
    var target = env.ASPNETCORE_HTTPS_PORT
        ? "https://localhost:".concat(env.ASPNETCORE_HTTPS_PORT)
        : env.ASPNETCORE_URLS
            ? env.ASPNETCORE_URLS.split(';')[0]
            : baseURL;
    return {
        plugins: [
            plugin()
        ],
        resolve: {
            alias: {
                '@': fileURLToPath(new URL('./src', import.meta.url))
            }
        },
        // Build the client straight into the .NET server's wwwroot so `dotnet run`
        // / publish (and the tunnel) always serve the FRESH bundle. Previously the
        // build went to ./dist and wwwroot stayed empty → phones loaded a stale or
        // empty page and never got any of the client fixes. emptyOutDir is required
        // because wwwroot is outside this project's root.
        build: {
            outDir: fileURLToPath(new URL('../GridData.Server/wwwroot', import.meta.url)),
            emptyOutDir: true,
            // Split heavy vendors into their own cached chunks so app-code changes
            // don't force a re-download of React/antd, and first load parallelises.
            rollupOptions: {
                output: {
                    manualChunks: function (id) {
                        if (!id.includes('node_modules'))
                            return;
                        if (id.includes('antd') || id.includes('@ant-design') || id.includes('rc-'))
                            return 'antd';
                        if (id.includes('react'))
                            return 'react';
                        return 'vendor';
                    },
                },
            },
        },
        server: {
            // Match the production server's cross-origin isolation so the HTTPS
            // development URL (normally :5555 on the LAN) can use
            // SharedArrayBuffer/Atomics across decoder workers as well.
            headers: {
                'Cross-Origin-Opener-Policy': 'same-origin',
                'Cross-Origin-Embedder-Policy': 'require-corp',
                'Cross-Origin-Resource-Policy': 'same-origin',
            },
            // لا تُراقب ملفات المثبّت الكبيرة في public/browser (تسبب EBUSY وتعطّل السيرفر)
            watch: {
                ignored: ['**/public/browser/**'],
            },
            proxy: {
                '^/api': {
                    target: target,
                    changeOrigin: true,
                    secure: false,
                    xfwd: true,
                },
            },
            port: APPPORT,
            host: '0.0.0.0',
            https: {
                key: fs.readFileSync(keyFilePath),
                cert: fs.readFileSync(certFilePath),
            }
        }
    };
});
