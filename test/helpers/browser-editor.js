const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const Module = require('node:module');
const path = require('node:path');
const { loadPdfModules, uri } = require('./pdf-modules');

const repository = path.resolve(__dirname, '../..');
const mediaRoot = path.join(repository, 'media');

function loadEditorModules() {
    const original = Module._load;
    const vscode = {
        Uri: { file: uri, joinPath: (base, ...parts) => uri(path.join(base.path, ...parts)) },
        ExtensionMode: { Production: 1, Development: 2 },
        workspace: { getConfiguration: () => ({ get: (_key, fallback) => fallback }) },
    };
    Module._load = function (name, ...args) {
        return name === 'vscode' ? vscode : original.call(this, name, ...args);
    };
    try {
        return {
            MarkdownEditorProvider: require(repository + '/out/editor/MarkdownEditorProvider').MarkdownEditorProvider,
            MarkdownDocument: require(repository + '/out/editor/MarkdownDocument').MarkdownDocument,
        };
    } finally { Module._load = original; }
}

async function openEditor(t, source, options = {}) {
    const { MarkdownEditorProvider, MarkdownDocument } = loadEditorModules();
    const { openPdfBrowser, findPdfBrowser } = loadPdfModules();
    const document = { uri: uri('/workspace/notes.md'), getText: () => source };
    const content = new MarkdownDocument(document).toHtml();
    const provider = new MarkdownEditorProvider({ extensionUri: uri(repository), extensionMode: 2 });
    let html;
    let origin;
    const requestedAssets = [];
    const server = http.createServer(async (request, response) => {
        try {
            response.setHeader('Cache-Control', 'no-store');
            if (request.url === '/') {
                response.setHeader('Content-Type', 'text/html');
                response.end(html);
                return;
            }
            const asset = new URL(request.url, origin);
            requestedAssets.push(asset);
            const filename = path.resolve(repository, '.' + asset.pathname);
            if (!filename.startsWith(mediaRoot + path.sep)) { response.writeHead(404).end(); return; }
            response.setHeader('Content-Type', filename.endsWith('.css') ? 'text/css' : /\.m?js$/.test(filename) ? 'text/javascript' : 'application/octet-stream');
            response.end(await fs.readFile(filename));
        } catch { response.writeHead(404).end(); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    origin = `http://127.0.0.1:${server.address().port}`;
    html = provider.getHtmlForWebview({
        cspSource: origin,
        asWebviewUri: target => ({ toString: () => origin + '/' + path.relative(repository, target.fsPath).replace(/\\/g, '/') }),
    });
    const nonce = /nonce="([^"]+)"/.exec(html)[1];
    const bridge = `window.editorErrors=[];window.hostMessages=[];
        window.addEventListener('error',event=>editorErrors.push(event.message));
        window.addEventListener('unhandledrejection',event=>editorErrors.push(String(event.reason)));
        window.acquireVsCodeApi=()=>({getState(){return window.bridgeState;},setState(state){window.bridgeState=state;return state;},postMessage(message){
            hostMessages.push(message);
            if(message.type==='ready')setTimeout(()=>window.postMessage({type:'init',content:${JSON.stringify(content)}},'*'),0);
            if(message.type==='update')setTimeout(()=>window.postMessage({type:'updateApplied',revision:message.revision},'*'),0);
        }});
        document.documentElement.style.cssText='--vscode-editor-background:#0d1117;--vscode-editor-foreground:#c9d1d9;--vscode-foreground:#c9d1d9;--vscode-textLink-foreground:#58a6ff;--vscode-descriptionForeground:#8b949e;--vscode-editorWidget-background:#161b22;--vscode-editorGroup-border:#30363d;--vscode-focusBorder:#58a6ff;--vscode-errorForeground:#f85149;--vscode-list-hoverBackground:#21262d;--vscode-button-secondaryBackground:#30363d;--vscode-button-secondaryForeground:#f0f6fc;--vscode-button-secondaryHoverBackground:#484f58';`;
    html = html.replace('<script type="module"', `<script nonce="${nonce}">${bridge}</script><script type="module"`);
    const browser = await openPdfBrowser(await findPdfBrowser(process.env.MANULDOWN_PDF_BROWSER || ''));
    t.after(() => browser.dispose());
    const connection = browser.connection;
    const { targetId } = await connection.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await connection.send('Target.attachToTarget', { targetId, flatten: true });
    const evaluate = async expression => {
        const result = await connection.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
        if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
        return result.result.value;
    };
    const waitFor = async expression => {
        for (let attempt = 0; attempt < 200; attempt++) {
            if (await evaluate(expression)) return;
            await new Promise(resolve => setTimeout(resolve, 25));
        }
        assert.fail(`Editor timed out: ${expression}; ${JSON.stringify(await evaluate('window.editorErrors'))}`);
    };
    const key = async (name, code, virtualKey, modifiers = 0) => {
        await connection.send('Input.dispatchKeyEvent', { type: 'keyDown', key: name, code, windowsVirtualKeyCode: virtualKey, modifiers }, sessionId);
        await connection.send('Input.dispatchKeyEvent', { type: 'keyUp', key: name, code, windowsVirtualKeyCode: virtualKey, modifiers }, sessionId);
    };
    await connection.send('Emulation.setDeviceMetricsOverride', { width: 1000, height: 650, deviceScaleFactor: 1, mobile: false }, sessionId);
    if (options.platform) {
        const { userAgent } = await connection.send('Browser.getVersion');
        await connection.send('Emulation.setUserAgentOverride', { userAgent, platform: options.platform }, sessionId);
    }
    await connection.send('Page.navigate', { url: origin }, sessionId);
    await waitFor(`document.body.dataset.editorState==='ready'`);
    const settle = () => evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
    const reset = async value => {
        const rendered = new MarkdownDocument({getText:()=>value,uri:uri('/workspace/notes.md')}).toHtml();
        await evaluate(`window.postMessage({type:'init',content:${JSON.stringify(rendered)}},'*')`);
        await settle();
        // The init message installs table controls and normalizes the DOM asynchronously.
        await waitFor("document.querySelectorAll('#editor > .md-table-insert-line').length === 2");
    };
    const select = async expression => {
        await evaluate(`(()=>{const [node,offset]=${expression},range=document.createRange();range.setStart(node,offset);range.collapse(true);
            document.getElementById('editor').focus();getSelection().removeAllRanges();getSelection().addRange(range);})()`);
        await settle();
    };
    return { evaluate, waitFor, key, settle, reset, select, requestedAssets, connection, sessionId };
}

module.exports = { openEditor };
