const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');
const { loadPdfModules, uri } = require('../helpers/pdf-modules');

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

test('footnote caret correction preserves native lines, neighboring paragraphs and the viewport', { timeout: 30_000 }, async t => {
    const { MarkdownEditorProvider, MarkdownDocument } = loadEditorModules();
    const { openPdfBrowser, findPdfBrowser } = loadPdfModules();
    const source = 'Body[^a] and second[^b] with another[^a].\n\n[^a]: aaa\n\n[^b]: test\n';
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
    const key = async (name, code, virtualKey) => {
        await connection.send('Input.dispatchKeyEvent', { type: 'keyDown', key: name, code, windowsVirtualKeyCode: virtualKey }, sessionId);
        await connection.send('Input.dispatchKeyEvent', { type: 'keyUp', key: name, code, windowsVirtualKeyCode: virtualKey }, sessionId);
    };
    await connection.send('Emulation.setDeviceMetricsOverride', { width: 1000, height: 650, deviceScaleFactor: 1, mobile: false }, sessionId);
    await connection.send('Page.navigate', { url: origin }, sessionId);
    await waitFor(`document.body.dataset.editorState==='ready'`);
    const editorAsset = requestedAssets.find(asset => asset.pathname === '/media/editor.js');
    const footnoteAsset = requestedAssets.find(asset => asset.pathname === '/media/modules/FootnoteManager.js');
    assert.ok(editorAsset?.search.includes('v='));
    assert.equal(footnoteAsset?.search, editorAsset.search, 'Reopening the editor must load the updated footnote module');
    const shortSource = 'Body[^a] and second[^b].\n\n[^a]: First note.\n\n[^b]: Last note.\n';
    const settle = () => evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
    const reset = async value => {
        const rendered = new MarkdownDocument({getText:()=>value,uri:uri('/workspace/notes.md')}).toHtml();
        await evaluate(`window.postMessage({type:'init',content:${JSON.stringify(rendered)}},'*')`);
        await settle();
    };
    const select = async expression => {
        await evaluate(`(()=>{const [node,offset]=${expression},range=document.createRange();range.setStart(node,offset);range.collapse(true);
            document.getElementById('editor').focus();getSelection().removeAllRanges();getSelection().addRange(range);})()`);
        await settle();
    };
    await t.test('empty breaks and native DIV lines remain valid editing positions', async () => {
        for (const body of ['<br>', '<div><br></div>', '<div>Before</div><div><br></div><div>After</div>']) {
            await reset(shortSource);
            await evaluate(`document.querySelector('[data-mdw-footnote-definition="a"] .mdw-footnote-content').innerHTML=${JSON.stringify(body)}`);
            await select(`(()=>{const content=document.querySelector('[data-mdw-footnote-definition="a"] .mdw-footnote-content');
                const target=content.children.length>1?content.children[1]:content.firstElementChild.tagName==='DIV'?content.firstElementChild:content;
                return [target,0];})()`);
            assert.notEqual(await evaluate(`getSelection().anchorNode.nodeName`), 'BR', 'A caret beside a break must not be moved into it');
            await connection.send('Input.insertText', {text:'X'}, sessionId);
            await settle();
            assert.equal(await evaluate(`document.querySelector('[data-mdw-footnote-definition="a"] .mdw-footnote-content').textContent`),
                body.includes('Before') ? 'BeforeXAfter' : 'X');
        }
        await reset(shortSource);
        await evaluate(`document.querySelector('[data-mdw-footnote-definition="a"] .mdw-footnote-content').innerHTML='<div id="native-spaces">    </div><p>After</p>'`);
        await select(`[document.getElementById('native-spaces').firstChild,2]`);
        assert.equal(await evaluate(`getSelection().anchorNode===document.getElementById('native-spaces').firstChild&&getSelection().anchorOffset===2`), true);
    });
    await t.test('inter-paragraph whitespace resolves locally instead of jumping to a note edge', async () => {
        await reset(shortSource);
        const body = '\n<p id="first-paragraph">First</p>\n\n<p id="second-paragraph">Second</p>\n';
        await evaluate(`document.querySelector('[data-mdw-footnote-definition="a"] .mdw-footnote-content').innerHTML=${JSON.stringify(body)}`);
        await select(`[document.getElementById('first-paragraph').nextSibling,1]`);
        assert.equal(await evaluate(`getSelection().anchorNode===document.getElementById('second-paragraph').firstChild&&getSelection().anchorOffset===0`), true);
        await select(`[document.querySelector('[data-mdw-footnote-definition="a"] .mdw-footnote-content').lastChild,0]`);
        assert.equal(await evaluate(`getSelection().anchorNode===document.getElementById('second-paragraph').firstChild&&getSelection().anchorOffset===6`), true);
    });
    await t.test('ordinary movement from a visible note number preserves the scroll position', async () => {
        const longSource = Array.from({length:40},(_,index)=>'Body paragraph '+index+' abcdefghij.').join('\n\n') +
            '[^a]\n\n[^a]: First note.\n\n[^b]: Last note.\n';
        for (const [label,name,virtualKey] of [['a','ArrowRight',39],['a','Escape',27],['b','ArrowDown',40]]) {
            await reset(longSource);
            await select(`[document.querySelector('[data-mdw-footnote-definition="${label}"] p').firstChild,0]`);
            await key('ArrowLeft','ArrowLeft',37);
            await waitFor(`document.activeElement.getAttribute('data-mdw-footnote-backref')==='${label}'`);
            await evaluate(`(()=>{const editor=document.getElementById('editor'),note=document.querySelector('[data-mdw-footnote-definition="${label}"]');
                editor.scrollTop+=note.getBoundingClientRect().top-350;})()`);
            await settle();
            const scrollTop = await evaluate(`document.getElementById('editor').scrollTop`);
            await key(name,name,virtualKey);
            await settle();
            assert.equal(await evaluate(`document.querySelector('[data-mdw-footnote-definition="${label}"] .mdw-footnote-content').contains(getSelection().anchorNode)`), true);
            const afterScroll = await evaluate(`document.getElementById('editor').scrollTop`);
            assert.ok(Math.abs(afterScroll-scrollTop)<=1, `${name} moved a visible note from scroll ${scrollTop} to ${afterScroll}`);
        }
    });
    assert.equal(await evaluate(`document.querySelectorAll('[data-mdw-footnote-delete]').length`),0);
    assert.deepEqual(await evaluate('editorErrors'), []);
});
