const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { loadPdfModules, uri } = require('../helpers/pdf-modules');

function loadEditorModules() {
    const original = Module._load;
    const vscode = {
        Uri: { file: uri, joinPath: (base, ...parts) => uri(path.join(base.path, ...parts)) },
        workspace: { getConfiguration: () => ({ get: (_key, fallback) => fallback }) },
        ExtensionMode: { Development: 2 },
    };
    Module._load = function (name, ...args) {
        return name === 'vscode' ? vscode : original.call(this, name, ...args);
    };
    try {
        return {
            MarkdownDocument: require('../../out/editor/MarkdownDocument').MarkdownDocument,
            MarkdownEditorProvider: require('../../out/editor/MarkdownEditorProvider').MarkdownEditorProvider,
        };
    } finally { Module._load = original; }
}

test('HTML previews render static HTML/CSS only after opt-in, without editing the document', { timeout: 30_000 }, async t => {
    const { MarkdownDocument, MarkdownEditorProvider } = loadEditorModules();
    const { findPdfBrowser, openPdfBrowser } = loadPdfModules();
    const repository = path.resolve(__dirname, '../..');
    const requests = [];
    let html;
    let origin;
    const server = http.createServer(async (request, response) => {
        response.setHeader('Cache-Control', 'no-store');
        if (request.url === '/') { response.setHeader('Content-Type', 'text/html'); response.end(html); return; }
        requests.push(request.url);
        const filename = path.resolve(repository, '.' + new URL(request.url, origin).pathname);
        if (!filename.startsWith(path.join(repository, 'media') + path.sep)) { response.writeHead(404).end(); return; }
        try {
            response.setHeader('Content-Type', filename.endsWith('.css') ? 'text/css' : /\.m?js$/.test(filename) ? 'text/javascript' : 'application/octet-stream');
            response.end(await fs.readFile(filename));
        } catch { response.writeHead(404).end(); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    origin = `http://127.0.0.1:${port}`;
    const remote = `http://localhost:${port}`;
    const source = [
        '<!DOCTYPE html><html><head><style>',
        `@import url("${remote}/preview-leak.css");`,
        'body { margin: 0; padding: 24px; background: rgb(238, 242, 255); font: 16px system-ui; }',
        '#editor { display: none !important; }',
        '.card { border: 2px solid #6366f1; padding: 24px; border-radius: 12px; background: white; }',
        'h1 { color: rgb(79, 70, 229); }',
        '</style></head><body><div class="card">',
        '<h1 id="preview-title">HTML preview 日本語</h1><p>HTML and CSS inside a code block.</p>',
        '<button onclick="document.body.dataset.handlerRan=\'yes\'">Example button</button>',
        '</div>',
        '<script>document.body.dataset.scriptRan="yes"; parent.document.body.dataset.previewEscaped="yes";</script>',
        `<img src="${remote}/preview-leak.png" onerror="document.body.dataset.handlerRan='yes'">`,
        `<form action="${remote}/preview-leak-form"><button>Submit</button></form>`,
        `<iframe src="${remote}/preview-leak-frame"></iframe>`,
        '</body></html>',
    ].join('\n');
    const markdown = '# HTML preview\n\n```html\n' + source + '\n```\n\nAfter preview.\n';
    const document = { getText: () => markdown, uri: uri('/workspace/notes.md') };
    const provider = new MarkdownEditorProvider({ extensionUri: uri(repository), extensionMode: 2 });
    html = provider.getHtmlForWebview({
        cspSource: origin,
        asWebviewUri: target => ({ toString: () => origin + '/' + path.relative(repository, target.fsPath).replace(/\\/g, '/') }),
    });
    const nonce = /nonce="([^"]+)"/.exec(html)[1];
    const bridge = `window.editorErrors=[];window.hostMessages=[];
        window.addEventListener('error',e=>editorErrors.push(e.message));
        window.addEventListener('unhandledrejection',e=>editorErrors.push(String(e.reason)));
        window.acquireVsCodeApi=()=>({getState(){},setState(){},postMessage(m){
            hostMessages.push(m);
            if(m.type==='ready')setTimeout(()=>window.postMessage({type:'init',content:${JSON.stringify(new MarkdownDocument(document).toHtml())}},'*'),0);
            if(m.type==='update')setTimeout(()=>window.postMessage({type:'updateApplied',revision:m.revision},'*'),0);
        }});`;
    html = html.replace('<script type="module"', `<script nonce="${nonce}">${bridge}</script><script type="module"`);
    let browser;
    t.after(async () => {
        await browser?.dispose();
        await new Promise(resolve => server.close(resolve));
    });
    browser = await openPdfBrowser(await findPdfBrowser(process.env.MANULDOWN_PDF_BROWSER || ''));
    const connection = browser.connection;
    const { targetId } = await connection.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await connection.send('Target.attachToTarget', { targetId, flatten: true });
    const evaluateIn = async (expression, session = sessionId, contextId) => {
        const result = await connection.send('Runtime.evaluate', {
            expression, returnByValue: true, awaitPromise: true, ...(contextId ? { contextId } : {}),
        }, session);
        if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
        return result.result.value;
    };
    const evaluate = expression => evaluateIn(expression);
    const waitFor = async expression => {
        for (let attempt = 0; attempt < 200; attempt++) {
            if (await evaluate(expression)) return;
            await new Promise(resolve => setTimeout(resolve, 25));
        }
        assert.fail(`Timed out: ${expression}; ${JSON.stringify(await evaluate('editorErrors'))}`);
    };
    const settle = () => evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
    const click = async selector => {
        const { x, y } = await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
        await connection.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 }, sessionId);
        await connection.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 }, sessionId);
        await settle();
    };
    const key = async (name, code, windowsVirtualKeyCode) => {
        const text = name === 'Enter' ? '\r' : name === ' ' ? ' ' : '';
        await connection.send('Input.dispatchKeyEvent', { type: 'keyDown', key: name, code, windowsVirtualKeyCode, text }, sessionId);
        await connection.send('Input.dispatchKeyEvent', { type: 'keyUp', key: name, code, windowsVirtualKeyCode }, sessionId);
        await settle();
    };
    const previewEvaluator = async () => {
        const { root } = await connection.send('DOM.getDocument', {}, sessionId);
        const { nodeId } = await connection.send('DOM.querySelector', { nodeId: root.nodeId, selector: '.html-preview iframe' }, sessionId);
        const { node } = await connection.send('DOM.describeNode', { nodeId }, sessionId);
        const { targetInfos } = await connection.send('Target.getTargets');
        if (targetInfos.some(target => target.targetId === node.frameId)) {
            const { sessionId: previewSession } = await connection.send('Target.attachToTarget', { targetId: node.frameId, flatten: true });
            return expression => evaluateIn(expression, previewSession);
        }
        const { executionContextId } = await connection.send('Page.createIsolatedWorld', { frameId: node.frameId }, sessionId);
        return expression => evaluateIn(expression, sessionId, executionContextId);
    };
    await connection.send('Page.enable', {}, sessionId);
    await connection.send('Target.setDiscoverTargets', { discover: true });
    await connection.send('Emulation.setDeviceMetricsOverride', { width: 1000, height: 800, deviceScaleFactor: 1, mobile: false }, sessionId);
    await connection.send('Page.navigate', { url: origin }, sessionId);
    await waitFor(`document.body.dataset.editorState==='ready'`);
    await settle();
    const snapshot = async id => {
        await evaluate(`window.postMessage({type:'prepareSyncSnapshot',reason:'editorSwitch',requestId:${JSON.stringify(id)}},'*')`);
        await waitFor(`hostMessages.some(m=>m.type==='syncSnapshot'&&m.requestId===${JSON.stringify(id)})`);
        return evaluate(`hostMessages.find(m=>m.type==='syncSnapshot'&&m.requestId===${JSON.stringify(id)}).content`);
    };
    const savedBefore = await snapshot('before');

    await t.test('HTML remains editable code by default, without loading a frame', async () => {
        assert.equal(await evaluate(`document.querySelector('pre').dataset.htmlView`), 'code');
        assert.equal(await evaluate(`document.querySelector('.code-block-preview-toggle').getAttribute('aria-checked')`), 'false');
        assert.equal(await evaluate(`getComputedStyle(document.querySelector('pre > code')).display`), 'block');
        assert.equal(await evaluate(`document.querySelector('iframe')===null`), true);
        assert.equal(await evaluate(`document.querySelector('pre > code').textContent.trimEnd()`), source);
    });
    await t.test('opting in displays styled HTML under the existing webview CSP', async () => {
        await click('.code-block-preview-toggle');
        await waitFor(`document.querySelector('iframe')?.getAttribute('srcdoc')?.includes('preview-title')`);
        const preview = await previewEvaluator();
        assert.equal(await preview(`document.getElementById('preview-title')?.textContent`), 'HTML preview 日本語');
        assert.equal(await preview(`getComputedStyle(document.getElementById('preview-title')).color`), 'rgb(79, 70, 229)');
        assert.equal(await preview(`getComputedStyle(document.body).backgroundColor`), 'rgb(238, 242, 255)');
        assert.equal(await evaluate(`getComputedStyle(document.getElementById('editor')).display==='none'`), false);
        assert.equal(await evaluate(`getComputedStyle(document.querySelector('pre > code')).display`), 'none');
        assert.equal(await evaluate(`document.querySelector('iframe').contentDocument`), null, 'sandbox has an opaque origin');
        assert.equal(await evaluate(`getComputedStyle(document.querySelector('.html-preview')).resize`), 'vertical');
        assert.equal(await snapshot('preview'), savedBefore);
        const artifacts = await fs.mkdtemp(path.join(os.tmpdir(), 'manuldown-html-preview-'));
        const { data } = await connection.send('Page.captureScreenshot', { format: 'png' }, sessionId);
        await fs.writeFile(path.join(artifacts, 'preview.png'), Buffer.from(data, 'base64'));
        t.diagnostic(`HTML preview screenshot: ${path.join(artifacts, 'preview.png')}`);
    });
    await t.test('source scripts, handlers, forms and remote resources remain inert', async () => {
        const preview = await previewEvaluator();
        await preview(`document.querySelector('button').click(); document.querySelector('form').requestSubmit();`);
        await settle();
        assert.equal(await preview(`document.body.dataset.scriptRan || document.body.dataset.handlerRan || null`), null);
        assert.equal(await evaluate(`document.body.dataset.previewEscaped || null`), null);
        assert.deepEqual(requests.filter(url => url.includes('preview-leak')), []);
    });
    await t.test('native keyboard toggles retain focus and reload the latest edited source', async () => {
        await evaluate(`document.querySelector('.code-block-preview-toggle').focus()`);
        await key('Enter', 'Enter', 13);
        assert.equal(await evaluate(`document.querySelector('iframe')===null`), true);
        assert.equal(await evaluate(`document.activeElement.matches('.code-block-preview-toggle')`), true);
        const updated = '<h1 id="preview-title" style="color:green">Updated HTML</h1>\n';
        await evaluate(`document.querySelector('pre > code').textContent=${JSON.stringify(updated)}`);
        await key(' ', 'Space', 32);
        await waitFor(`document.querySelector('iframe')?.getAttribute('srcdoc')?.includes('Updated HTML')`);
        const preview = await previewEvaluator();
        assert.equal(await preview(`document.getElementById('preview-title')?.textContent`), 'Updated HTML');
        assert.equal(await evaluate(`document.activeElement.matches('.code-block-preview-toggle')`), true);
        assert.equal(await evaluate(`getSelection().rangeCount`), 0);
        await key(' ', 'Space', 32);
        assert.equal(await evaluate(`document.querySelector('iframe')===null`), true);
        assert.equal(await evaluate(`document.querySelector('pre > code').textContent`), updated);
    });
    assert.deepEqual(await evaluate('editorErrors'), []);
});
