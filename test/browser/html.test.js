const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const test = require('node:test');
const { loadPdfModules, uri } = require('../helpers/pdf-modules');
const { buildPdfContent, buildHtmlPage, findPdfBrowser, openPdfBrowser } = loadPdfModules();

test('standalone HTML renders offline from a file at desktop and mobile widths without PDF size limits', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'manuldown-html-test-'));
    const browser = await openPdfBrowser(await findPdfBrowser(process.env.MANULDOWN_PDF_BROWSER || ''));
    try {
        const content = await buildPdfContent('# 日本語のHTML\n\n[見出し](#日本語のhtml)\n\n$x^2$\n\n' +
            '```mermaid\ngraph LR; A-->B\n```\n\n```js\nconst answer = 42;\n```\n\n' +
            '| Header | Value |\n|---|---|\n| Long row | ' + 'Content '.repeat(1200) + ' |\n\n' +
            '![図|160x80](./local.svg)\n\n![Wide|480x240](./local.svg)',
        uri('/workspace/document.md'), async () => 'data:image/svg+xml;base64,' +
            Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><rect width="200" height="100" fill="blue"/></svg>').toString('base64'));
        const html = await buildHtmlPage(path.resolve(__dirname, '../../media'), content.html, '日本語のHTML');
        const filename = path.join(directory, 'export.html');
        await fs.writeFile(filename, html);
        const cdp = browser.connection;
        const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
        const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
        const evaluate = async expression => {
            const result = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
            if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || 'Evaluation failed');
            return result.result.value;
        };
        await cdp.send('Network.enable', {}, sessionId);
        await cdp.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 }, sessionId);
        await cdp.send('Page.navigate', { url: pathToFileURL(filename).href }, sessionId);
        await evaluate(`new Promise((resolve, reject) => {
            const start = Date.now();
            const check = () => {
                if (window.manulPdfReady) window.manulPdfReady.then(resolve, reject);
                else if (Date.now() - start > 10000) reject(new Error('HTML did not load'));
                else setTimeout(check, 25);
            }; check();
        })`);
        assert.equal(await evaluate('document.querySelectorAll(".katex").length'), 1);
        assert.equal(await evaluate('document.querySelectorAll(".export-diagram svg").length'), 1);
        assert.ok(await evaluate('!!document.querySelector("code .token")'));
        assert.equal(await evaluate('document.querySelector("img").naturalWidth'), 200);
        assert.equal(await evaluate('document.querySelector("h1").id'), '日本語のhtml');
        for (const width of [1200, 360]) {
            await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 800, deviceScaleFactor: 1, mobile: false }, sessionId);
            assert.ok(await evaluate('document.documentElement.scrollWidth <= window.innerWidth'), `Content fits at ${width}px`);
            assert.deepEqual(await evaluate('Array.from(document.images, img => [img.width, img.height])'),
                [[160, 80], width === 1200 ? [480, 240] : [328, 164]]);
        }
    } finally {
        await browser.dispose();
        await fs.rm(directory, { recursive: true, force: true });
    }
});
