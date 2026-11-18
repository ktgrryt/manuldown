const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');
const { loadPdfModules, uri } = require('../helpers/pdf-modules');
const { buildPdfContent, renderPdf, defaultPdfLayout, openPdfBrowser, findPdfBrowser, getPdfPreviewHtml } = loadPdfModules();
const repository = path.resolve(__dirname, '../..');
const mediaRoot = path.join(repository, 'media');
const browserPath = process.env.MANULDOWN_PDF_BROWSER || '';

async function readPdf(bytes) {
    const pdfjs = await import(pathToFileURL(path.join(repository, 'node_modules/pdfjs-dist/legacy/build/pdf.mjs')).href);
    const task = pdfjs.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false });
    const pdf = await task.promise;
    const pages = [];
    try {
        for (let number = 1; number <= pdf.numPages; number++) {
            const page = await pdf.getPage(number);
            const text = await page.getTextContent();
            pages.push({ text: text.items.map(item => item.str).join(' ').normalize('NFKC'),
                items: text.items, viewport: page.getViewport({ scale: 1 }), annotations: await page.getAnnotations() });
        }
        return pages;
    } finally { await task.destroy(); }
}

const generate = (html, extra = {}) => renderPdf({ mediaRoot, html, title: 'PDF browser test',
    layout: defaultPdfLayout, breaks: [], browserPath, signal: new AbortController().signal, ...extra });

test('PDF browser prints searchable Japanese, repeats table headers, and honors manual page breaks', async () => {
    const source = '# 日本語の文書\n\nText with $x^2$ and [a link](https://example.com).\n\n' +
        '```mermaid\nflowchart LR\nMarkdown --> Preview --> Export\n```\n\n## Table\n\n| Name | Value |\n|---|---|\n' +
        Array.from({ length: 70 }, (_, index) => `| Row-${index + 1} | Content ${index + 1} |`).join('\n') +
        '\n\n## Final section\n\nThe last paragraph.\n';
    const content = await buildPdfContent(source, uri('/workspace/document.md'), async () => null);
    const initial = await generate(content.html);
    assert.deepEqual(initial.warnings, []);
    const pages = await readPdf(initial.bytes);
    assert.equal(initial.boundaries.length, content.blocks.length, 'Every source block has a printed position');
    assert.ok(pages.every(page => page.annotations.every(annotation => !annotation.url?.includes('manuldown.invalid'))), 'Private position probes are absent from the saved PDF');
    assert.ok(pages.length >= 3);
    assert.match(pages[0].text.replace(/\s+/g, ''), /日本語の文書/);
    assert.match(pages[0].text, /Markdown/);
    assert.ok(pages[0].annotations.some(annotation => annotation.url === 'https://example.com/'));
    assert.equal(pages.filter(page => page.text.includes('Name')).length, 3, 'Table header repeats across all table pages');
    const allText = pages.map(page => page.text).join(' ');
    for (let index = 1; index <= 70; index++) assert.ok(allText.includes(`Row-${index}`), `Row ${index} is present`);
    const section = content.blocks.find(block => block.label === 'Final section');
    const adjusted = await generate(content.html, { breaks: [section.id] });
    const adjustedPages = await readPdf(adjusted.bytes);
    assert.match(adjustedPages.at(-1).text, /^Final section/);
    assert.equal(adjusted.boundaries.find(boundary => boundary.id === section.id).page, adjustedPages.length);
    assert.ok(adjustedPages.length > pages.length);
});

test('PDF browser retains long code, handles landscape, and cancels an in-flight render', async () => {
    const source = '```js\n' + Array.from({ length: 160 }, (_, index) => `const line${index} = ${index};`).join('\n') + '\n```\n';
    const content = await buildPdfContent(source, uri('/workspace/code.md'), async () => null);
    const result = await generate(content.html, { layout: { ...defaultPdfLayout, landscape: true } });
    const pages = await readPdf(result.bytes);
    assert.ok(pages.length > 1);
    assert.ok(pages[0].viewport.width > pages[0].viewport.height);
    assert.match(pages.at(-1).text, /line159/);
    const controller = new AbortController();
    const pending = generate(content.html, { signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    await assert.rejects(pending, /cancelled|closed|aborted/i);
});

test('PDF browser keeps a heading with its following text and decodes a local image', async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="100"><rect width="600" height="100" fill="#0969da"/><circle cx="300" cy="50" r="30" fill="white"/></svg>';
    const content = await buildPdfContent('## Boundary heading\n\n' + 'Following paragraph text. '.repeat(45) +
        '\n\n![Local picture](./picture.svg)\n', uri('/workspace/document.md'), async () => `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`);
    const html = '<div style="height:calc(var(--pdf-height) - 44px)">Before the page boundary</div>' +
        content.html.replace('<h2 ', '<h2 style="margin:0" ');
    const result = await generate(html);
    assert.deepEqual(result.warnings, []);
    const pages = await readPdf(result.bytes);
    assert.equal(pages.length, 2);
    assert.ok(!pages[0].text.includes('Boundary heading'), 'Heading must not be isolated at the foot of page one');
    assert.match(pages[1].text, /^Boundary heading/);
    assert.match(pages[1].text, /Following paragraph text/);
    const boundary = result.boundaries.find(item => item.id === content.blocks[0].id);
    assert.equal(boundary.page, 2, 'Heading boundary follows automatic keep-with-next pagination');
    const baseline = pages[1].items.find(item => item.str === 'Boundary heading').transform[5];
    assert.ok(Math.abs(boundary.rect[3] - baseline) < 25, `Guide is close to the printed heading, including page margins: ${boundary.rect[3]} vs ${baseline}`);
});

test('PDF boundary mapping follows paragraphs moved by widow/orphan control and naturally paginated tables', async () => {
    const content = await buildPdfContent('Paragraph moved to the next page by orphan control. '.repeat(12) +
        '\n\n| Header | Value |\n|---|---|\n' + Array.from({ length: 70 }, (_, i) => `| Row-${i} | Text |`).join('\n') +
        '\n\nAfter the table.\n', uri('/workspace/boundaries.md'), async () => null);
    const result = await generate('<div style="height:calc(var(--pdf-height) - 35px)">Filler</div>' + content.html);
    const pages = await readPdf(result.bytes);
    const paragraphPage = pages.findIndex(page => page.text.includes('Paragraph moved')) + 1;
    assert.equal(paragraphPage, 2);
    assert.equal(result.boundaries.find(boundary => boundary.id === content.blocks[0].id).page, paragraphPage);
    const tablePage = pages.findIndex(page => page.text.includes('Row-0')) + 1;
    assert.equal(result.boundaries.find(boundary => boundary.id === content.blocks[1].id).page, tablePage);
    const after = result.boundaries.find(boundary => boundary.id === content.blocks[2].id);
    assert.equal(after.page, pages.findIndex(page => page.text.includes('After the table')) + 1);
    assert.equal(after.atPageStart, false, 'A block after a continuing table is not mistaken for the page start');
});

test('PDF browser fits a very tall image on one page without a blank trailing page', async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="2000"><rect width="300" height="2000" fill="#0969da"/><circle cx="150" cy="1900" r="80" fill="white"/></svg>';
    const content = await buildPdfContent('![Tall image](./tall.svg)\n', uri('/workspace/image.md'),
        async () => `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`);
    const result = await generate(content.html);
    assert.deepEqual(result.warnings, []);
    assert.equal((await readPdf(result.bytes)).length, 1);
});

test('PDF prints a resized image at its selected width and intrinsic aspect ratio', async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="300"><rect width="600" height="300" fill="#0969da"/></svg>';
    const content = await buildPdfContent('[![図|160x80](image.svg)](https://example.com/width)\n\n' +
        '[![図|x60](image.svg)](https://example.com/height)',
        uri('/workspace/image.md'), async () => 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64'));
    const result = await generate(content.html);
    assert.deepEqual(result.warnings, []);
    const [page] = await readPdf(result.bytes);
    // An inline link spans its image's width. PDF points are 3/4 of a CSS pixel.
    for (const [link, expectedWidth] of [['width', 160], ['height', 120]]) {
        const { rect } = page.annotations.find(annotation => annotation.url === 'https://example.com/' + link);
        assert.ok(Math.abs(rect[2] - rect[0] - expectedWidth * 0.75) < 1, `Printed width: ${rect[2] - rect[0]} pt`);
    }
});

test('manual breaks at an automatic page boundary do not add empty pages, including after paper/font changes', async () => {
    const content = await buildPdfContent('# First page\n\n## New page\n\nFollowing text.\n', uri('/workspace/pages.md'), async () => null);
    const target = content.blocks[1];
    const html = content.html.replace('class="export-block export-heading"', 'class="export-block export-heading" style="height:var(--pdf-height)"');
    for (const layout of [defaultPdfLayout, { ...defaultPdfLayout, paper: 'Letter', landscape: true, margin: 'wide', fontSize: 'large' }]) {
        const automatic = await generate(html, { layout });
        const adjusted = await generate(html, { layout, breaks: [target.id, target.id] });
        const pages = await readPdf(adjusted.bytes);
        assert.equal(pages.length, (await readPdf(automatic.bytes)).length);
        assert.equal(pages.length, 2);
        assert.match(pages[1].text, /^New page/);
        assert.equal(adjusted.boundaries.find(boundary => boundary.id === target.id).page, 2);
        assert.equal(automatic.boundaries.find(boundary => boundary.id === target.id).atPageStart, true, 'An existing automatic page start has no insertion position');
        assert.equal(adjusted.boundaries.find(boundary => boundary.id === target.id).atPageStart, true, 'Manual breaks at page starts still have removable controls');
    }
});

test('PDF preview displays actual pages with its CSP and accepts layout and break controls', async t => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="100"><rect width="600" height="100" fill="#0969da"/></svg>';
    const source = '# Document\n\nA paragraph with $x^2$.\n\n![Image](image.svg)\n\n- List item one\n- List item two\n\n' +
        '```mermaid\nflowchart LR\nMarkdown --> PDF\n```\n\n| Name | Value |\n|---|---|\n' +
        Array.from({ length: 70 }, (_, i) => `| Row-${i} | Content |`).join('\n') +
        '\n\n## Next section\n\nMore text.\n\n```js\n' + Array.from({ length: 140 }, (_, i) => `const tail${i} = ${i};`).join('\n') + '\n```\n';
    const content = await buildPdfContent(source, uri('/workspace/document.md'), async () => `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`);
    const result = await generate(content.html);
    const insertionCount = result.boundaries.filter(boundary => boundary.id !== content.blocks[0].id && !boundary.atPageStart).length;
    const artifactDirectory = process.env.MANULDOWN_PDF_ARTIFACTS || path.join(os.tmpdir(), 'manuldown-pdf-test');
    await fs.mkdir(artifactDirectory, { recursive: true });
    let origin;
    let html;
    const state = { type: 'state', sessionId: 'browser-test', revision: 0, documentName: 'document.md', layout: defaultPdfLayout,
        blocks: content.blocks, breaks: [], busy: false, reloading: false, saving: false, stale: false,
        canExport: false, canUndo: false, canRedo: false, warnings: [], error: '' };
    const server = http.createServer(async (request, response) => {
        try {
            if (request.url === '/') { response.setHeader('Content-Type', 'text/html'); response.end(html); return; }
            if (request.url === '/mermaid-preview') {
                response.setHeader('Content-Type', 'text/html');
                response.end(`<!doctype html><html><head><link rel="stylesheet" href="/media/ui-chrome.css"><link rel="stylesheet" href="/media/editor.css"><style>:root{--vscode-editor-background:#1e1e1e;--vscode-editor-foreground:#ccc;--vscode-descriptionForeground:#9d9d9d;--vscode-editorWidget-background:#252526;--vscode-editorGroup-border:#313131;--vscode-focusBorder:#007fd4}</style></head><body><div id="editor" contenteditable="true"><pre><code class="language-mermaid">graph LR\nA--&gt;B</code><div class="mermaid-preview"><svg viewBox="0 0 1000 500"><rect x="200" y="160" width="600" height="180" rx="10" fill="#252526" stroke="#777"/><text x="500" y="260" text-anchor="middle" fill="#ccc" font-size="28">Shared preview controls</text></svg></div></pre></div><script type="module">import {MermaidViewer} from '/media/modules/MermaidViewer.js';window.viewer=new MermaidViewer(document.getElementById('editor'));window.viewer.open(document.querySelector('pre'));</script></body></html>`);
                return;
            }
            const relative = new URL(request.url, origin).pathname;
            const filename = path.resolve(repository, '.' + relative);
            if (!filename.startsWith(mediaRoot + path.sep)) { response.writeHead(404).end(); return; }
            // Reproduce VS Code: a worker cannot load/import an extension URL.
            // The containing Webview can fetch the complete bundle as bytes.
            if (/pdf\.(?:worker|renderer)\.mjs$/.test(filename) &&
                ['worker', 'script'].includes(request.headers['sec-fetch-dest'])) { response.writeHead(403).end(); return; }
            response.setHeader('Content-Type', /\.m?js$/.test(filename) ? 'text/javascript' : filename.endsWith('.css') ? 'text/css' : filename.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream');
            response.end(await fs.readFile(filename));
        } catch { response.writeHead(404).end(); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    origin = `http://127.0.0.1:${server.address().port}`;
    const webview = { cspSource: origin, asWebviewUri: target => ({ toString: () => origin + '/media/' + path.relative(mediaRoot, target.fsPath).replace(/\\/g, '/') }) };
    html = getPdfPreviewHtml(webview, uri(repository));
    const nonce = /nonce="([^"]+)"/.exec(html)[1];
    const bridge = `window.hostMessages=[];window.previewErrors=[];window.workerUrls=[];window.pdfWarnings=[];
        window.applyPreviewTheme=(name)=>{
            const palette=name==='light'?['#ffffff','#24292f','#57606a','#f6f8fa','#d0d7de','#eaeef2']:
                name==='contrast'?['#000000','#ffffff','#ffffff','#000000','#ffffff','#333333']:
                ['#1e1e1e','#cccccc','#9d9d9d','#252526','#313131','#2a2d2e'];
            const [background,foreground,muted,surface,border,hover]=palette;
            Object.entries({'--vscode-editor-background':background,'--vscode-editor-foreground':foreground,'--vscode-foreground':foreground,'--vscode-descriptionForeground':muted,'--vscode-editorWidget-background':surface,'--vscode-editorWidget-border':border,'--vscode-editorGroup-border':border,'--vscode-list-hoverBackground':hover,'--vscode-dropdown-background':surface,'--vscode-button-background':'#0e639c','--vscode-button-hoverBackground':'#1177bb','--vscode-button-foreground':'#ffffff','--vscode-focusBorder':name==='contrast'?'#f38518':'#007fd4','--vscode-contrastBorder':name==='contrast'?'#ffffff':border}).forEach(([key,value])=>document.documentElement.style.setProperty(key,value));
            document.body.classList.toggle('vscode-high-contrast',name==='contrast');
        };
        window.applyPreviewTheme('dark');
        window.hostState=${JSON.stringify(state)};
        window.previewStart=performance.now();
        const NativeWorker=window.Worker;
        window.Worker=class extends NativeWorker{constructor(url,options){window.workerUrls.push(String(url));super(url,options);}};
        const originalWarn=console.warn.bind(console);console.warn=(...args)=>{window.pdfWarnings.push(args.map(String).join(' '));originalWarn(...args);};
        window.addEventListener('error',e=>window.previewErrors.push(e.message));
        window.addEventListener('unhandledrejection',e=>window.previewErrors.push(String(e.reason)));
        window.acquireVsCodeApi=()=>({postMessage(message){
            window.hostMessages.push(message);
            if(message.type==='ready'){
                window.hostState={...window.hostState,busy:true};
                window.postMessage(window.hostState,'*');
                window.initialPdf=${JSON.stringify({ type: 'pdf', sessionId: state.sessionId, revision: 0, data: result.bytes.toString('base64'), boundaries: result.boundaries })};
            }
            if(message.type==='displayed'&&message.revision===window.hostState.revision){
                if(message.revision===0)window.thumbnailsAtFirstDisplay=document.querySelectorAll('#thumbnails canvas').length;
                window.firstPageMs=performance.now()-window.previewStart;window.postMessage({...window.hostState,canExport:true},'*');
            }
        }});`;
    html = html.replace('<script type="module"', `<script nonce="${nonce}">${bridge}</script><script type="module"`);
    const browser = await openPdfBrowser(await findPdfBrowser(browserPath));
    t.after(() => browser.dispose());
    const { connection } = browser;
    const { targetId } = await connection.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await connection.send('Target.attachToTarget', { targetId, flatten: true });
    await connection.send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 1000, deviceScaleFactor: 1, mobile: false }, sessionId);
    await connection.send('Page.navigate', { url: origin }, sessionId);
    const evaluate = async expression => {
        const response = await connection.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
        if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
        return response.result.value;
    };
    const waitFor = async expression => {
        for (let attempt = 0; attempt < 200; attempt++) {
            if (await evaluate(expression)) return;
            await new Promise(resolve => setTimeout(resolve, 30));
        }
        assert.fail(`Preview timed out: ${expression}; ${JSON.stringify(await evaluate('window.previewErrors'))}`);
    };
    await waitFor('!!window.initialPdf&&!document.getElementById("preview-loading").hidden');
    assert.equal(await evaluate('document.querySelectorAll(".pdf-page canvas").length'), 0);
    assert.deepEqual(await evaluate(`(()=>{const style=getComputedStyle(document.querySelector('#preview-loading .pdf-loading-spinner'));return [style.width,style.height,style.animationName,style.animationDuration];})()`), ['24px','24px','manuldown-loading-spin','0.8s'], 'Initial PDF preparation uses the editor startup spinner');
    assert.equal(await evaluate('document.querySelector("#preview-loading .pdf-loading-spinner").getAnimations().some(animation=>animation.playState==="running")'), true);
    const loadingScreenshot = await connection.send('Page.captureScreenshot', {format:'png'}, sessionId);
    await fs.writeFile(path.join(artifactDirectory,'preview-loading.png'),Buffer.from(loadingScreenshot.data,'base64'));
    await connection.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]},sessionId);
    assert.equal(await evaluate('getComputedStyle(document.querySelector("#preview-loading .pdf-loading-spinner")).animationName'), 'none');
    await connection.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]},sessionId);
    await evaluate(`window.postMessage({...window.hostState,busy:false,error:'Could not prepare the PDF.'},'*')`);
    await waitFor('document.getElementById("preview-loading").hidden&&!document.getElementById("error").hidden');
    await evaluate(`window.previewStart=performance.now();window.hostState={...window.hostState,busy:false};window.postMessage(window.hostState,'*');window.postMessage(window.initialPdf,'*')`);
    let displayed = false;
    for (let attempt = 0; attempt < 200; attempt++) {
        displayed = await evaluate('window.hostMessages?.some(m=>m.type==="displayed") || false');
        if (displayed) break;
        await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(displayed, true, JSON.stringify(await evaluate('({errors:window.previewErrors,messages:window.hostMessages,status:document.getElementById("status")?.textContent})')));
    assert.equal(await evaluate('document.getElementById("export").disabled'), false);
    assert.ok(await evaluate('document.querySelectorAll(".pdf-page canvas").length') >= 1);
    assert.equal(await evaluate('document.querySelectorAll(".break-guide").length'), 0, 'Normal preview has no editing controls');
    const workerUrls = await evaluate('window.workerUrls');
    assert.equal(workerUrls.length, 2, 'Both parser and renderer run in real workers');
    assert.ok(workerUrls.every(url => url.startsWith('blob:')), 'Workers load complete Blob bundles');
    assert.deepEqual(await evaluate('window.pdfWarnings'), [], 'No worker fallback or loading warnings');
    console.log(`PDF first-page display: ${Math.round(await evaluate('window.firstPageMs'))} ms`);
    assert.equal(await evaluate('document.getElementById("document-name").textContent'), 'document.md');
    assert.equal(await evaluate('document.documentElement.lang'), 'en');
    assert.equal(await evaluate('/[\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Han}]/u.test(document.body.textContent)'), false, 'Static and runtime PDF controls use English');
    assert.equal(await evaluate('document.getElementById("page-number").value'), '1');
    assert.equal(await evaluate('document.getElementById("activity-indicator").hidden'), true);
    assert.equal(await evaluate('document.getElementById("preview-loading").hidden'), true, 'Loading feedback disappears once the first PDF page is displayed');
    await evaluate(`window.postMessage({...window.hostState,saving:true,canExport:false},'*')`);
    await waitFor('!document.getElementById("activity-indicator").hidden');
    assert.equal(await evaluate('document.getElementById("preview-loading").hidden'), true, 'Saving uses the footer indicator without covering the preview');
    await evaluate(`window.postMessage({...window.hostState,canExport:true},'*')`);
    await waitFor('document.getElementById("activity-indicator").hidden');
    assert.equal(await evaluate('document.getElementById("previous-page").disabled'), true);
    assert.ok(await evaluate('document.querySelector(".preview-toolbar").getBoundingClientRect().height') <= 44, 'Normal mode uses a compact toolbar');
    await evaluate('document.getElementById("next-page").click()');
    await waitFor('document.getElementById("page-number").value==="2"');
    await evaluate('document.getElementById("previous-page").click()');
    await waitFor('document.getElementById("page-number").value==="1"');
    await evaluate(`document.getElementById('page-number').focus();document.getElementById('page-number').value='3';document.getElementById('page-number').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))`);
    await waitFor('document.getElementById("page-number").value==="3"');
    assert.equal(await evaluate('document.activeElement.id'), 'pages');
    await evaluate(`document.getElementById('page-number').value='999';document.getElementById('page-number').dispatchEvent(new Event('change'))`);
    await waitFor('document.getElementById("next-page").disabled');
    assert.equal(await evaluate('Number(document.getElementById("page-number").value)'), await evaluate('document.querySelectorAll(".pdf-page").length'), 'Page input clamps to the last page');
    await evaluate(`document.getElementById('page-number').value='';document.getElementById('page-number').dispatchEvent(new Event('change'))`);
    assert.notEqual(await evaluate('document.getElementById("page-number").value'), '', 'An empty page input restores the current page');
    await evaluate(`document.getElementById('page-number').value='1';document.getElementById('page-number').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))`);
    await evaluate(`document.getElementById('zoom').value='0.25';document.getElementById('zoom').dispatchEvent(new Event('change'))`);
    await evaluate(`(async()=>{const area=document.getElementById('pages');area.scrollTop+=document.querySelector('.pdf-page[data-page="1"]').getBoundingClientRect().bottom-area.getBoundingClientRect().top-24;await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));})()`);
    assert.equal(await evaluate('document.getElementById("page-number").value'), '1', 'A small part of page one at the viewport top stays current even when later pages are more visible');
    assert.equal(await evaluate('document.querySelector(".pdf-thumbnail[aria-current=page]").dataset.page'), '1');
    await evaluate(`(async()=>{const area=document.getElementById('pages');area.scrollTop+=document.querySelector('.pdf-page[data-page="2"]').getBoundingClientRect().top-area.getBoundingClientRect().top-20;await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));})()`);
    assert.equal(await evaluate('document.getElementById("page-number").value'), '2', 'When the viewport top is in a page gap, the following page is current');
    await evaluate(`(async()=>{const area=document.getElementById('pages');area.scrollTop+=document.querySelector('.pdf-page[data-page="2"]').getBoundingClientRect().top-area.getBoundingClientRect().top;await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));})()`);
    assert.equal(await evaluate('document.getElementById("page-number").value'), '2', 'The page touching the top edge is current');
    await evaluate(`document.getElementById('page-number').value='999';document.getElementById('page-number').dispatchEvent(new Event('change'))`);
    await waitFor('Number(document.getElementById("page-number").value)===document.querySelectorAll(".pdf-page").length');
    assert.ok(Math.abs(await evaluate(`document.querySelector('.pdf-page:last-child').getBoundingClientRect().top-document.getElementById('pages').getBoundingClientRect().top`) - 38) <= 1, 'Navigation can align a short last page at the top');
    await evaluate(`document.getElementById('page-number').value='1';document.getElementById('page-number').dispatchEvent(new Event('change'))`);
    await evaluate('document.getElementById("zoom-actual").click()');
    assert.equal(await evaluate('document.getElementById("zoom").value'), '1');
    await evaluate('document.getElementById("zoom-in").click()');
    assert.equal(await evaluate('document.getElementById("zoom").value'), '1.25');
    assert.equal(await evaluate('document.getElementById("zoom-level").textContent'), '125%', 'The compact zoom display matches the preset');
    await evaluate('document.getElementById("zoom-out").click()');
    assert.equal(await evaluate('document.getElementById("zoom").value'), '1');
    await evaluate(`document.getElementById('pages').dispatchEvent(new KeyboardEvent('keydown',{key:'f',bubbles:true}))`);
    assert.equal(await evaluate('document.getElementById("zoom").value'), 'fit');
    assert.equal(await evaluate('document.getElementById("zoom-fit").getAttribute("aria-pressed")'), 'true');
    assert.equal(await evaluate('window.thumbnailsAtFirstDisplay'), 0, 'Main PDF content displays before thumbnail rendering starts');
    assert.equal(await evaluate('document.querySelectorAll(".pdf-thumbnail").length'), await evaluate('document.querySelectorAll(".pdf-page").length'));
    await waitFor(`!!document.querySelector('.pdf-thumbnail[data-page="1"] canvas')`);
    await waitFor(`document.querySelector('.pdf-thumbnail[data-page="3"]').dataset.rendered==='true'`);
    assert.equal(await evaluate('document.querySelector(".pdf-thumbnail[aria-current=page]").dataset.page'), '1');
    assert.equal(await evaluate(`(() => {const canvas=document.querySelector('.pdf-thumbnail canvas');return canvas.width<=256&&canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data.some((value,index)=>index%4!==3&&value<240);})()`), true, 'Thumbnails contain actual PDF content at a bounded resolution');
    await evaluate(`window.firstThumbnailCanvas=document.querySelector('.pdf-thumbnail[data-page="1"] canvas')`);
    const thumbnailBox = await evaluate(`(() => {const r=document.querySelector('.pdf-thumbnail[data-page="3"]').getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};})()`);
    await connection.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...thumbnailBox }, sessionId);
    await connection.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...thumbnailBox }, sessionId);
    await connection.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...thumbnailBox }, sessionId);
    await waitFor(`document.querySelector('.pdf-thumbnail[aria-current=page]').dataset.page==='3'&&document.querySelector('.pdf-page[data-page="3"]').classList.contains('page-rendered')`);
    assert.ok(Math.abs(await evaluate(`document.querySelector('.pdf-page[data-page="3"]').getBoundingClientRect().top-document.getElementById('pages').getBoundingClientRect().top`) - 38) <= 1, 'Clicking a thumbnail aligns the requested page in the main preview');
    await evaluate(`document.querySelector('.pdf-page[data-page="4"]').scrollIntoView({block:'start'})`);
    await waitFor('document.querySelector(".pdf-thumbnail[aria-current=page]").dataset.page==="4"');
    assert.equal(await evaluate('document.getElementById("page-number").value'), '4');
    assert.equal(await evaluate(`(() => {const area=document.getElementById('thumbnails').getBoundingClientRect();const selected=document.querySelector('.pdf-thumbnail[aria-current=page]').getBoundingClientRect();return selected.top>=area.top&&selected.bottom<=area.bottom;})()`), true, 'Scrolling the document keeps the current thumbnail in view');
    await evaluate('document.querySelector(".pdf-thumbnail[aria-current=page]").focus()');
    await connection.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 }, sessionId);
    await connection.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 }, sessionId);
    await waitFor('document.querySelector(".pdf-thumbnail[aria-current=page]").dataset.page==="5"');
    assert.equal(await evaluate('document.activeElement.dataset.page'), '5');
    await connection.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Home', code: 'Home', windowsVirtualKeyCode: 36 }, sessionId);
    await connection.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Home', code: 'Home', windowsVirtualKeyCode: 36 }, sessionId);
    await waitFor('document.querySelector(".pdf-thumbnail[aria-current=page]").dataset.page==="1"');
    const narrowPageWidth = await evaluate('document.querySelector(".pdf-page").getBoundingClientRect().width');
    await evaluate('document.getElementById("toggle-thumbnails").click()');
    assert.equal(await evaluate('document.getElementById("thumbnail-panel").hidden'), true);
    assert.equal(await evaluate('document.getElementById("toggle-thumbnails").getAttribute("aria-expanded")'), 'false');
    assert.ok(await evaluate('document.querySelector(".pdf-page").getBoundingClientRect().width') > narrowPageWidth, 'Hiding thumbnails gives fit-width pages the available space');
    await evaluate('document.getElementById("toggle-thumbnails").click()');
    assert.equal(await evaluate('document.getElementById("thumbnail-panel").hidden'), false);
    assert.equal(await evaluate(`document.querySelector('.pdf-thumbnail[data-page="1"] canvas')===window.firstThumbnailCanvas`), true, 'Zooming the main preview reuses thumbnail bitmaps');
    // Reuse the same workers for a new PDF, and resize in the precise interval
    // between its canvas being installed and its first frame being ready.
    await evaluate(`(() => {
        const oldCanvas=document.querySelector('.pdf-page canvas');
        const watcher=new MutationObserver(()=>{
            const canvas=document.querySelector('.pdf-page canvas');
            if(canvas&&canvas!==oldCanvas){watcher.disconnect();window.resizedDuringLoad=true;document.getElementById('zoom').dispatchEvent(new Event('change'));}
        });
        watcher.observe(document.getElementById('pages'),{childList:true,subtree:true});
        window.hostState={...window.hostState,revision:1,canExport:false};
        window.postMessage(window.hostState,'*');
        window.postMessage(${JSON.stringify({ type: 'pdf', sessionId: state.sessionId, revision: 1, data: result.bytes.toString('base64'), boundaries: result.boundaries })},'*');
    })()`);
    let redisplayed = false;
    for (let attempt = 0; attempt < 100; attempt++) {
        redisplayed = await evaluate('window.hostMessages.some(message=>message.type==="displayed"&&message.revision===1)');
        if (redisplayed) break;
        await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(await evaluate('window.resizedDuringLoad'), true, JSON.stringify(await evaluate('({errors:window.previewErrors,messages:window.hostMessages,status:document.getElementById("status").textContent})')));
    assert.equal(redisplayed, true, 'Resizing during first rendering must not lose the display acknowledgement');
    assert.equal(await evaluate('window.workerUrls.length'), 2, 'The preview reuses its workers across PDFs');
    assert.deepEqual(await evaluate('window.pdfWarnings'), []);
    assert.equal(await evaluate('document.getElementById("export").disabled'), false);
    await evaluate(`document.getElementById('break-panel').click();document.getElementById('finish-breaks').click()`);
    assert.equal(await evaluate('document.getElementById("break-panel").getAttribute("aria-pressed")'), 'false');
    assert.equal(await evaluate('document.getElementById("break-tools").hidden'), true);
    assert.equal(await evaluate('document.activeElement.id'), 'break-panel', 'Done returns keyboard focus to the editing toggle');
    const section = content.blocks.find(block => block.label === 'Next section');
    await evaluate(`document.getElementById('break-panel').click();document.querySelector('[data-boundary="${section.id}"]').closest('.pdf-page').scrollIntoView({block:'start'})`);
    await waitFor(`document.querySelector('[data-boundary="${section.id}"]').closest('.pdf-page').classList.contains('page-rendered')`);
    await evaluate(`document.querySelector('[data-boundary="${section.id}"]').scrollIntoView({block:'center'})`);
    assert.equal(await evaluate('document.getElementById("break-panel").getAttribute("aria-pressed")'), 'true');
    assert.equal(await evaluate('document.querySelectorAll(".break-guide").length'), insertionCount);
    const automaticStarts = result.boundaries.filter(boundary => boundary.atPageStart);
    assert.ok(automaticStarts.length > 0, 'The fixture includes a block already starting an automatic page');
    for (const boundary of automaticStarts) assert.equal(await evaluate(`!!document.querySelector('[data-boundary="${boundary.id}"]')`), false, 'No insertion line before a block already at the page start');
    await connection.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 20, y: 20 }, sessionId);
    assert.equal(await evaluate('Array.from(document.querySelectorAll(".break-insert")).every(button=>!button.textContent&&!button.children.length&&!button.hasAttribute("title"))'), true, 'Insertion positions show only a line, without icons, labels or tooltips');
    assert.equal(await evaluate('Array.from(document.querySelectorAll(".break-guide")).every(guide=>getComputedStyle(guide,"::before").opacity==="0.55")'), true, 'Available positions use faint horizontal lines');
    assert.equal(await evaluate('document.getElementById("reset-breaks").textContent'), 'Clear all');
    const targetBox = await evaluate(`(() => {const guide=document.querySelector('[data-boundary-focus="${section.id}"]');const r=guide.getBoundingClientRect();window.targetOffset=guide.closest('.pdf-page').getBoundingClientRect().top+Number(guide.dataset.sourceTop);return {x:r.left+r.width*.75,y:r.top+r.height/2};})()`);
    await connection.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...targetBox }, sessionId);
    assert.equal(await evaluate('Array.from(document.querySelectorAll(".break-guide")).filter(guide=>getComputedStyle(guide,"::before").opacity==="1").length'), 1, 'Only the hovered insertion line is emphasized');
    assert.match(await evaluate(`document.querySelector('[data-boundary="${section.id}"]').getAttribute('aria-label')`), /Insert page break before Next section/);
    assert.equal(await evaluate(`document.elementFromPoint(${targetBox.x},${targetBox.y + 35}).tagName`), 'CANVAS', 'The editing overlay does not intercept document interaction outside block gaps');
    const insertScreenshot = await connection.send('Page.captureScreenshot', { format: 'png' }, sessionId);
    await fs.writeFile(path.join(artifactDirectory, 'page-break-insert.png'), Buffer.from(insertScreenshot.data, 'base64'));
    await connection.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...targetBox }, sessionId);
    await connection.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...targetBox }, sessionId);
    assert.ok((await evaluate('window.hostMessages')).some(message => message.type === 'break' && message.enabled && message.id === section.id));
    assert.equal(await evaluate('document.getElementById("break-feedback-text").textContent'), 'Updating preview…');
    assert.equal(await evaluate('document.getElementById("break-feedback").hidden'), true, 'Pending edits use the shared loading feedback before showing the Undo confirmation');
    assert.equal(await evaluate(`document.querySelector('[data-boundary="${section.id}"]').disabled`), true, 'Repeated edits are disabled while repaginating');
    await evaluate(`window.hostState={...window.hostState,revision:2,breaks:[${JSON.stringify(section.id)}],busy:true,canExport:false};window.postMessage(window.hostState,'*')`);
    await waitFor('document.getElementById("pages").getAttribute("aria-busy")==="true"');
    assert.equal(await evaluate('!document.getElementById("preview-loading").hidden&&document.getElementById("preview-loading").classList.contains("is-refreshing")'), true, 'Regeneration shows a compact loading indicator alongside the existing PDF');
    assert.ok(await evaluate('document.querySelectorAll(".pdf-page canvas").length')>0);
    assert.equal(await evaluate('getComputedStyle(document.getElementById("preview-loading")).pointerEvents'), 'none');
    const refreshingScreenshot = await connection.send('Page.captureScreenshot', {format:'png'}, sessionId);
    await fs.writeFile(path.join(artifactDirectory,'preview-refreshing.png'),Buffer.from(refreshingScreenshot.data,'base64'));
    assert.equal(await evaluate('document.querySelectorAll(".break-guide").length'), insertionCount, 'The old PDF keeps its source guides while updating');
    assert.equal(await evaluate('document.querySelectorAll(".manual-break").length'), 0, 'The new break is not drawn at the old PDF position');
    const adjusted = await generate(content.html, { breaks: [section.id] });
    const adjustedPages = await readPdf(adjusted.bytes);
    assert.match(adjustedPages[adjusted.boundaries.find(boundary => boundary.id === section.id).page - 1].text, /^Next section/);
    const updatePreview = async (revision, generated, breaks) => {
        await evaluate(`window.hostState={...window.hostState,revision:${revision},breaks:${JSON.stringify(breaks)},busy:false,canUndo:true,canRedo:true,canExport:false};window.postMessage(window.hostState,'*');window.postMessage(${JSON.stringify({ type: 'pdf', sessionId: state.sessionId, revision, data: generated.bytes.toString('base64'), boundaries: generated.boundaries })},'*');`);
        await waitFor(`window.hostMessages.some(message=>message.type==='displayed'&&message.revision===${revision})`);
        await waitFor('!document.getElementById("export").disabled');
        assert.equal(await evaluate('document.getElementById("preview-loading").hidden'), true);
        assert.equal(await evaluate('document.querySelectorAll(".pdf-thumbnail").length'), await evaluate('document.querySelectorAll(".pdf-page").length'), 'Repagination updates thumbnail count with the displayed PDF');
    };
    await updatePreview(2, adjusted, [section.id]);
    assert.equal(await evaluate('document.querySelectorAll(".manual-break").length'), 1);
    const anchorDelta = await evaluate(`(() => {const guide=document.querySelector('[data-boundary-focus="${section.id}"]');return guide.closest('.pdf-page').getBoundingClientRect().top+Number(guide.dataset.sourceTop)-window.targetOffset;})()`);
    assert.ok(Math.abs(anchorDelta) < 4, `Clicked content stays at the same viewport position after repagination: ${anchorDelta}px`);
    assert.equal(await evaluate('document.getElementById("break-feedback-text").textContent'), 'Page break added.');
    assert.equal(await evaluate('document.getElementById("break-count").textContent'), '1 manual break');
    assert.equal(await evaluate('document.activeElement.dataset.boundaryFocus'), section.id, 'Insertion focuses the position, not the destructive Remove button');
    assert.equal(await evaluate('document.querySelector(".break-remove").textContent'), 'Remove page break');
    assert.equal(await evaluate(`(() => {const button=document.querySelector('.break-remove').getBoundingClientRect();const guide=document.querySelector('.manual-break').getBoundingClientRect();return Math.abs(button.left+button.width/2-guide.left-guide.width/2)<1;})()`), true, 'The removal action is centered on the manual-break line');
    assert.deepEqual(await evaluate(`['.break-remove','#finish-breaks'].map(selector=>{const style=getComputedStyle(document.querySelector(selector));return [style.fontSize,style.minHeight,style.borderRadius];})`), [['12px','28px','4px'],['12px','28px','4px']], 'Removal uses the shared preview control design');
    const beforeRemoveClick = (await evaluate('window.hostMessages')).length;
    await evaluate('document.querySelector(".manual-break").click()');
    assert.equal((await evaluate('window.hostMessages')).length, beforeRemoveClick, 'Only the explicit removal action deletes a manual break');
    assert.equal(await evaluate(`(() => {const guide=document.querySelector('.manual-break').getBoundingClientRect();const page=document.querySelector('.manual-break').closest('.pdf-page').getBoundingClientRect();return guide.bottom<page.top;})()`), true, 'Manual controls sit in the page gap, away from the document');
    await evaluate(`document.querySelector('.break-remove').dispatchEvent(new MouseEvent('click',{bubbles:true,detail:2}))`);
    assert.equal((await evaluate('window.hostMessages')).length, beforeRemoveClick, 'A second click cannot immediately reverse insertion');
    assert.equal(await evaluate(`!document.querySelector('.break-remove').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',repeat:true,cancelable:true}))`), true, 'Holding Enter does not repeatedly toggle a break');
    await evaluate('document.getElementById("zoom").value="1.25";document.getElementById("zoom").dispatchEvent(new Event("change"))');
    await waitFor(`document.querySelector('[data-boundary="${section.id}"]').closest('.pdf-page').classList.contains('page-rendered')`);
    assert.equal(await evaluate('document.querySelectorAll(".manual-break").length'), 1, 'Guides follow zoom without changing source anchors');
    const editingScreenshot = await connection.send('Page.captureScreenshot', { format: 'png' }, sessionId);
    await fs.writeFile(path.join(artifactDirectory, 'page-break-editing.png'), Buffer.from(editingScreenshot.data, 'base64'));
    await fs.writeFile(path.join(artifactDirectory, 'page-break-adjusted.pdf'), adjusted.bytes);
    await evaluate('document.getElementById("undo-break").click()');
    assert.equal((await evaluate('window.hostMessages')).at(-1).type, 'undo');
    assert.equal(await evaluate('document.getElementById("break-feedback").hidden'), true);
    await updatePreview(3, result, []);
    assert.equal(await evaluate('document.querySelectorAll(".manual-break").length'), 0);
    await evaluate('document.getElementById("redo").click()');
    assert.equal((await evaluate('window.hostMessages')).at(-1).type, 'redo');
    await updatePreview(4, adjusted, [section.id]);
    await evaluate(`document.querySelector('[data-boundary="${section.id}"]').click()`);
    assert.ok((await evaluate('window.hostMessages')).some(message => message.type === 'break' && message.enabled === false && message.id === section.id));
    await updatePreview(5, result, []);
    assert.equal(await evaluate('document.getElementById("break-feedback-text").textContent'), 'Page break removed.');
    await evaluate('document.getElementById("orientation").value="landscape";document.getElementById("orientation").dispatchEvent(new Event("change"))');
    assert.ok((await evaluate('window.hostMessages')).some(message => message.type === 'layout' && message.layout.landscape));
    await evaluate('document.getElementById("break-panel").click();document.getElementById("layout-panel").open=false');
    assert.equal(await evaluate('document.querySelectorAll(".break-guide").length'), 0, 'Turning edit mode off removes all editing controls');
    assert.equal(await evaluate('document.getElementById("break-feedback").hidden'), true);
    // A long document must not allocate a canvas for every thumbnail. Browse
    // the sidebar independently, then replace it with a shorter landscape PDF.
    const { PDFDocument } = require('pdf-lib');
    const longPdf = await PDFDocument.create();
    for (let number = 1; number <= 100; number++) {
        longPdf.addPage([595, 842]).drawText(`Page ${number}`, { x: 40, y: 780, size: 24 });
    }
    await updatePreview(6, { bytes: Buffer.from(await longPdf.save()), boundaries: [] }, []);
    assert.equal(await evaluate('document.querySelectorAll(".pdf-thumbnail").length'), 100);
    await waitFor('document.querySelector(".pdf-thumbnail[aria-current=page]").dataset.rendered==="true"');
    assert.ok(await evaluate('document.querySelectorAll("#thumbnails canvas").length') < 12, 'Only thumbnails near the sidebar viewport render initially');
    const mainScroll = await evaluate('document.getElementById("pages").scrollTop');
    for (const number of [20, 40, 60, 80, 100]) {
        await evaluate(`document.querySelector('.pdf-thumbnail[data-page="${number}"]').scrollIntoView({block:'center'})`);
        await waitFor(`document.querySelector('.pdf-thumbnail[data-page="${number}"]').dataset.rendered==='true'`);
    }
    assert.equal(await evaluate('document.getElementById("pages").scrollTop'), mainScroll, 'Scrolling thumbnails does not move the main document');
    assert.ok(await evaluate('document.querySelectorAll("#thumbnails canvas").length') <= 24, 'Thumbnail bitmap memory is bounded after browsing many pages');
    await evaluate(`document.querySelector('.pdf-thumbnail[data-page="100"]').click()`);
    await waitFor(`document.querySelector('.pdf-thumbnail[aria-current=page]').dataset.page==='100'&&document.querySelector('.pdf-page[data-page="100"]').classList.contains('page-rendered')`);
    const landscapePdf = await PDFDocument.create();
    for (let number = 1; number <= 2; number++) landscapePdf.addPage([792, 612]).drawText(`Landscape ${number}`, { x: 40, y: 550 });
    await updatePreview(7, { bytes: Buffer.from(await landscapePdf.save()), boundaries: [] }, []);
    assert.equal(await evaluate('document.querySelectorAll(".pdf-thumbnail").length'), 2);
    assert.equal(await evaluate(`(() => {const box=document.querySelector('.thumbnail-sheet').getBoundingClientRect();return box.width>box.height;})()`), true, 'Thumbnail shape follows landscape pages');
    assert.ok(await evaluate('Number(document.querySelector(".pdf-thumbnail[aria-current=page]").dataset.page)') <= 2, 'Selection stays valid when page count decreases');
    await connection.send('Emulation.setDeviceMetricsOverride', { width: 450, height: 900, deviceScaleFactor: 1, mobile: false }, sessionId);
    await waitFor('document.getElementById("thumbnail-panel").getBoundingClientRect().width===112');
    assert.equal(await evaluate('document.documentElement.scrollWidth<=window.innerWidth'), true, 'The sidebar and preview fit a narrow panel');
    await evaluate('document.getElementById("zoom-fit").click()');
    await evaluate(`document.getElementById('page-number').value='1';document.getElementById('page-number').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));document.getElementById('next-page').click()`);
    await waitFor('document.getElementById("page-number").value==="2"');
    assert.equal(await evaluate('document.querySelector(".pdf-thumbnail[aria-current=page]").dataset.page'), '2', 'Page navigation keeps the requested selection when multiple pages fit in view');
    await evaluate('document.getElementById("break-panel").click();document.querySelector("#layout-panel summary").click()');
    const smallPopover = await evaluate(`(() => {const box=document.querySelector('.popover').getBoundingClientRect();return {left:box.left,right:box.right,bottom:box.bottom};})()`);
    assert.ok(smallPopover.left >= 0 && smallPopover.right <= 450 && smallPopover.bottom < 900, 'Layout settings remain accessible in a narrow panel');
    await evaluate(`document.querySelector('#layout-panel summary').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
    assert.equal(await evaluate('document.getElementById("layout-panel").open'), false);
    assert.equal(await evaluate('document.getElementById("break-panel").getAttribute("aria-pressed")'), 'true');
    await evaluate(`document.getElementById('pages').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
    assert.equal(await evaluate('document.getElementById("break-panel").getAttribute("aria-pressed")'), 'false');
    await connection.send('Emulation.setDeviceMetricsOverride', { width: 360, height: 800, deviceScaleFactor: 1, mobile: false }, sessionId);
    await waitFor('document.querySelector(".pdf-page").getBoundingClientRect().width<=document.getElementById("pages").clientWidth-24');
    assert.equal(await evaluate(`['toggle-thumbnails','layout-panel','break-panel','reload','export','previous-page','page-number','next-page','zoom-out','zoom','zoom-in','zoom-fit'].every(id=>{const box=document.getElementById(id).getBoundingClientRect();return box.width>0&&box.left>=0&&box.right<=window.innerWidth;})`), true, 'Core controls fit at 360px without clipping');
    const smallScreenshot = await connection.send('Page.captureScreenshot', { format: 'png' }, sessionId);
    await fs.writeFile(path.join(artifactDirectory, 'preview-narrow.png'), Buffer.from(smallScreenshot.data, 'base64'));
    await evaluate(`window.postMessage({...window.hostState,busy:true,canExport:false},'*')`);
    await waitFor('!document.getElementById("preview-loading").hidden');
    assert.equal(await evaluate(`(()=>{const loading=document.getElementById('preview-loading').getBoundingClientRect();const area=document.getElementById('pages').getBoundingClientRect();return loading.left>=area.left&&loading.right<=area.right&&loading.height>=28;})()`), true, 'Loading feedback remains visible within the document area in a narrow panel');
    await evaluate(`window.postMessage({...window.hostState,canExport:true},'*')`);
    await waitFor('document.getElementById("preview-loading").hidden');
    await updatePreview(8, adjusted, [section.id]);
    await evaluate(`document.getElementById('break-panel').click();document.querySelector('.manual-break').closest('.pdf-page').scrollIntoView({block:'start'})`);
    await waitFor(`document.querySelector('.manual-break').closest('.pdf-page').classList.contains('page-rendered')`);
    await evaluate(`document.querySelector('.manual-break').scrollIntoView({block:'center'})`);
    assert.equal(await evaluate(`['undo','redo','reset-breaks','finish-breaks'].every(id=>{const box=document.getElementById(id).getBoundingClientRect();return box.width>0&&box.left>=0&&box.right<=window.innerWidth;})`), true, 'Break editing actions fit a 360px panel');
    assert.equal(await evaluate(`(() => {const button=document.querySelector('.break-remove').getBoundingClientRect();const page=document.querySelector('.manual-break').closest('.pdf-page').getBoundingClientRect();return button.left>=page.left&&button.right<=page.right;})()`), true, 'The removal action fits a narrow PDF page');
    const overlappingTargets = await evaluate(`Array.from(document.querySelectorAll('.page-rendered .break-overlay')).flatMap(layer=>{
        const guides=Array.from(layer.querySelectorAll('.break-guide:not(.manual-break)')).sort((a,b)=>Number(a.dataset.sourceTop)-Number(b.dataset.sourceTop));
        return guides.flatMap((guide,index)=>index&&guide.getBoundingClientRect().top<guides[index-1].getBoundingClientRect().bottom-.1?[{before:guides[index-1].getAttribute('aria-label'),after:guide.getAttribute('aria-label'),top:guide.dataset.sourceTop,previousTop:guides[index-1].dataset.sourceTop}]:[]);
    })`);
    assert.deepEqual(overlappingTargets, [], 'Insertion targets do not overlap at small zooms');
    const narrowEditing = await connection.send('Page.captureScreenshot', { format: 'png' }, sessionId);
    await fs.writeFile(path.join(artifactDirectory, 'page-break-narrow.png'), Buffer.from(narrowEditing.data, 'base64'));
    await evaluate('document.getElementById("reset-breaks").click()');
    assert.equal((await evaluate('window.hostMessages')).at(-1).type, 'resetBreaks');
    await updatePreview(9, result, []);
    assert.equal(await evaluate('document.querySelectorAll(".manual-break").length'), 0);
    assert.equal(await evaluate('document.getElementById("break-feedback-text").textContent'), 'Page breaks cleared.');
    await evaluate('document.getElementById("finish-breaks").click()');
    await connection.send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 1000, deviceScaleFactor: 1, mobile: false }, sessionId);
    await updatePreview(10, result, []);
    await evaluate(`document.querySelector('.pdf-thumbnail[data-page="1"]').click()`);
    await waitFor(`document.querySelector('.pdf-page[data-page="1"]').classList.contains('page-rendered')&&document.querySelector('.pdf-thumbnail[data-page="1"]').dataset.rendered==='true'`);
    await evaluate(`window.hostState={...window.hostState,stale:true,canExport:false};window.postMessage(window.hostState,'*')`);
    await waitFor('!document.getElementById("stale").hidden');
    assert.equal(await evaluate('document.getElementById("export").disabled'), true);
    await evaluate('document.getElementById("reload-latest").click()');
    assert.equal((await evaluate('window.hostMessages')).at(-1).type, 'reload');
    assert.equal(await evaluate('document.getElementById("preview-loading").hidden'), true, 'A changed document does not show an endless spinner');
    await evaluate(`window.postMessage({...window.hostState,reloading:true,busy:true},'*')`);
    await waitFor('!document.getElementById("preview-loading").hidden');
    await evaluate(`window.hostState={...window.hostState,stale:false,canExport:true};window.postMessage(window.hostState,'*')`);
    await waitFor('document.getElementById("stale").hidden');
    // Previously saved manual breaks can coincide with an automatic page start.
    // They remain removable, then leave no redundant insertion line or lost focus.
    const pinnedStart = automaticStarts[0];
    const pinned = await generate(content.html, { breaks: [pinnedStart.id] });
    await updatePreview(11, pinned, [pinnedStart.id]);
    await evaluate(`document.getElementById('break-panel').click();document.querySelector('[data-boundary="${pinnedStart.id}"]').closest('.pdf-page').scrollIntoView({block:'start'})`);
    await waitFor(`document.querySelector('[data-boundary="${pinnedStart.id}"]').closest('.pdf-page').classList.contains('page-rendered')`);
    assert.equal(await evaluate(`document.querySelector('[data-boundary="${pinnedStart.id}"]').className`), 'break-remove');
    await evaluate(`document.querySelector('[data-boundary="${pinnedStart.id}"]').click()`);
    await updatePreview(12, result, []);
    assert.equal(await evaluate(`!!document.querySelector('[data-boundary="${pinnedStart.id}"]')`), false, 'Removing a saved break at a natural page start leaves no redundant insertion line');
    assert.equal(await evaluate('document.activeElement.id'), 'pages', 'Focus returns to the document when the insertion position no longer exists');
    await evaluate(`document.getElementById('finish-breaks').click();document.querySelector('.pdf-thumbnail[data-page="1"]').click()`);
    await waitFor(`document.querySelector('.pdf-page[data-page="1"]').classList.contains('page-rendered')`);
    for (const theme of ['light', 'contrast', 'dark']) {
        await evaluate(`window.applyPreviewTheme('${theme}')`);
        const themedScreenshot = await connection.send('Page.captureScreenshot', { format: 'png' }, sessionId);
        await fs.writeFile(path.join(artifactDirectory, `preview-${theme}.png`), Buffer.from(themedScreenshot.data, 'base64'));
    }
    assert.deepEqual(await evaluate('window.previewErrors'), []);
    assert.equal(await evaluate('window.workerUrls.length'), 2);
    const screenshot = await connection.send('Page.captureScreenshot', { format: 'png' }, sessionId);
    await fs.writeFile(path.join(artifactDirectory, 'preview.png'), Buffer.from(screenshot.data, 'base64'));
    await fs.writeFile(path.join(artifactDirectory, 'preview.pdf'), result.bytes);
    const chromeMetrics = `(() => {
        const style=(selector,properties)=>{const value=getComputedStyle(document.querySelector(selector));return properties.map(property=>value[property]);};
        return {button:style('.md-preview-zoom button',['fontSize','fontFamily','fontWeight','minHeight','width','padding','borderRadius']),
            toolbar:style('.md-preview-toolbar',['minHeight','padding','gap']),
            footer:style('.md-preview-footer',['padding','borderTopWidth']),
            scale:style('.md-preview-scale',['fontSize','minWidth','padding','fontVariantNumeric']),
            divider:style('.md-preview-divider',['width','height','margin'])};
    })()`;
    const pdfChrome = await evaluate(chromeMetrics);
    await t.test('Mermaid retains its shared control styles and zoom behavior', async () => {
        const { targetId: diagramTarget } = await connection.send('Target.createTarget', { url: 'about:blank' });
        const { sessionId: diagramSession } = await connection.send('Target.attachToTarget', { targetId: diagramTarget, flatten: true });
        await connection.send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 800, deviceScaleFactor: 1, mobile: false }, diagramSession);
        await connection.send('Page.navigate', { url: origin + '/mermaid-preview' }, diagramSession);
        const diagramValue = async expression => {
            const response = await connection.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, diagramSession);
            if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
            return response.result.value;
        };
        for (let attempt = 0; attempt < 100; attempt++) {
            if (await diagramValue('!!window.viewer?.width')) break;
            await new Promise(resolve => setTimeout(resolve, 20));
        }
        assert.equal(await diagramValue('document.querySelector(".mermaid-viewer").open'), true);
        assert.deepEqual(await diagramValue(`(() => {const style=getComputedStyle(document.querySelector('.mermaid-viewer button'));return [style.fontSize,style.minHeight,style.borderRadius];})()`), ['12px', '28px', '4px']);
        assert.deepEqual(await diagramValue(chromeMetrics), pdfChrome, 'PDF and Mermaid use identical control, toolbar, footer and zoom metrics');
        await diagramValue(`document.querySelector('[data-action="actual"]').click();document.querySelector('[data-action="zoom-in"]').click()`);
        assert.equal(await diagramValue('document.querySelector(".mermaid-viewer-scale").textContent'), '125%');
        await diagramValue(`document.querySelector('[data-action="fit"]').click()`);
        assert.equal(await diagramValue('document.querySelector("[data-action=fit]").getAttribute("aria-pressed")'), 'true');
        const diagramScreenshot = await connection.send('Page.captureScreenshot', { format: 'png' }, diagramSession);
        await fs.writeFile(path.join(artifactDirectory, 'mermaid-shared-controls.png'), Buffer.from(diagramScreenshot.data, 'base64'));
        await diagramValue(`document.querySelector('.mermaid-viewer').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
        assert.equal(await diagramValue('document.querySelector(".mermaid-viewer")'), null);
        await connection.send('Target.closeTarget', { targetId: diagramTarget });
    });
});
