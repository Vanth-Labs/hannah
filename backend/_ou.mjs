import { runTool } from './src/pipeline/tools.js';
// URL VÁLIDA (pasa new URL, protocolo https) pero con ; y $() en el path:
await runTool('open_url', { url: 'https://example.invalid/x;touch$(id)/tmp/PWNED2;' }, {});
await new Promise(r=>setTimeout(r,400));
