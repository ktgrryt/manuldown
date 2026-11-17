const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');
const { loadPdfModules, uri } = require('../helpers/pdf-modules');
const { projectEditorText } = require('../../out/editor/EditorSelection');
const { createWindow } = require('@mixmark-io/domino');

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
            MarkdownSelectionMap: require('../../out/editor/MarkdownSelection').MarkdownSelectionMap,
        };
    } finally { Module._load = original; }
}

test('editor switches preserve caret, backward selection, viewport and pending input in Chromium', { timeout: 30_000 }, async t => {
    const { MarkdownDocument, MarkdownEditorProvider, MarkdownSelectionMap } = loadEditorModules();
    const { findPdfBrowser, openPdfBrowser } = loadPdfModules();
    const repository = path.resolve(__dirname, '../..');
    const documentFor = source => new MarkdownDocument({ getText: () => source, uri: uri('/workspace/notes.md') });
    const initialSource = Array.from({ length: 40 }, (_, index) => `Paragraph ${index}.`).join('\n\n') + '\n\n**Target paragraph** here.\n';
    const initialOffset = initialSource.indexOf('Target') + 4;
    const initialSelection = new MarkdownSelectionMap(documentFor(initialSource), initialSource)
        .toRendered({ anchor: initialOffset, active: initialOffset });
    let html;
    let origin;
    const server = http.createServer(async (request, response) => {
        response.setHeader('Cache-Control', 'no-store');
        if (request.url === '/') { response.setHeader('Content-Type', 'text/html'); response.end(html); return; }
        const filename = path.resolve(repository, '.' + new URL(request.url, origin).pathname);
        if (!filename.startsWith(path.join(repository, 'media') + path.sep)) { response.writeHead(404).end(); return; }
        try {
            response.setHeader('Content-Type', filename.endsWith('.css') ? 'text/css' : /\.m?js$/.test(filename) ? 'text/javascript' : 'application/octet-stream');
            response.end(await fs.readFile(filename));
        } catch { response.writeHead(404).end(); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    origin = `http://127.0.0.1:${server.address().port}`;
    const provider = new MarkdownEditorProvider({ extensionUri: uri(repository), extensionMode: 2 });
    html = provider.getHtmlForWebview({
        cspSource: origin,
        asWebviewUri: target => ({ toString: () => origin + '/' + path.relative(repository, target.fsPath).replace(/\\/g, '/') }),
    });
    const nonce = /nonce="([^"]+)"/.exec(html)[1];
    const bridge = `window.editorErrors=[];window.hostMessages=[];
        window.selectionModule=import('/media/vendor/editor-selection.bundle.js');
        window.addEventListener('error',e=>editorErrors.push(e.message));
        window.addEventListener('unhandledrejection',e=>editorErrors.push(String(e.reason)));
        window.acquireVsCodeApi=()=>({getState(){return window.bridgeState;},setState(s){window.bridgeState=s;},postMessage(m){
            hostMessages.push(m);
            if(m.type==='ready')setTimeout(()=>window.postMessage({type:'init',content:${JSON.stringify(documentFor(initialSource).toHtml())},selection:${JSON.stringify(initialSelection)}},'*'),0);
            if(m.type==='update')setTimeout(()=>window.postMessage({type:'updateApplied',revision:m.revision},'*'),0);
        }});`;
    html = html.replace('<script type="module"', `<script nonce="${nonce}">${bridge}</script><script type="module"`);
    const browser = await openPdfBrowser(await findPdfBrowser(process.env.MANULDOWN_PDF_BROWSER || ''));
    t.after(() => browser.dispose());
    const connection = browser.connection;
    const { targetId } = await connection.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await connection.send('Target.attachToTarget', { targetId, flatten: true });
    const evaluate = async expression => {
        const result = await connection.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
        if (result.exceptionDetails) { throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text); }
        return result.result.value;
    };
    const waitFor = async expression => {
        for (let attempt = 0; attempt < 200; attempt++) {
            if (await evaluate(expression)) { return; }
            await new Promise(resolve => setTimeout(resolve, 25));
        }
        assert.fail(`Timed out: ${expression}; ${JSON.stringify(await evaluate('editorErrors'))}`);
    };
    const settle = () => evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
    const snapshot = async () => {
        const id = `switch-${Date.now()}`;
        await evaluate(`window.postMessage({type:'prepareSyncSnapshot',reason:'editorSwitch',requestId:${JSON.stringify(id)}},'*')`);
        await waitFor(`hostMessages.some(m=>m.type==='syncSnapshot'&&m.requestId===${JSON.stringify(id)})`);
        return evaluate(`hostMessages.find(m=>m.type==='syncSnapshot'&&m.requestId===${JSON.stringify(id)})`);
    };
    await connection.send('Emulation.setDeviceMetricsOverride', { width: 1000, height: 650, deviceScaleFactor: 1, mobile: false }, sessionId);
    await connection.send('Page.navigate', { url: origin }, sessionId);
    await waitFor(`document.body.dataset.editorState==='ready'`);
    await settle();
    assert.equal(await evaluate('getSelection().anchorNode.textContent'), 'Target paragraph');
    assert.equal(await evaluate('getSelection().anchorOffset'), 4);
    assert.ok(await evaluate(`document.getElementById('editor').scrollTop>0`), 'The restored caret is brought into view');
    assert.deepEqual(new MarkdownSelectionMap(documentFor(initialSource), initialSource).toSource((await snapshot()).selection),
        { anchor: initialOffset, active: initialOffset });
    assert.equal(await evaluate(`hostMessages.some(m=>m.type==='update')`), false, 'Restoring a selection does not edit the document');
    await evaluate('getSelection().removeAllRanges()');
    assert.deepEqual(new MarkdownSelectionMap(documentFor(initialSource), initialSource).toSource((await snapshot()).selection),
        { anchor: initialOffset, active: initialOffset }, 'The last caret survives focus moving to a native editor-title button');
    const backward = { anchor: initialOffset, active: initialSource.indexOf('Paragraph 1.') + 3 };
    await evaluate(`window.postMessage({type:'restoreEditorSelection',selection:${JSON.stringify(new MarkdownSelectionMap(documentFor(initialSource), initialSource).toRendered(backward))}},'*')`);
    await settle();
    assert.match(await evaluate('getSelection().focusNode.textContent'), /Paragraph 1\./);
    assert.ok(await evaluate(`document.getElementById('editor').scrollTop<200`), 'A backward selection reveals its active edge');

    const cases = [
        ['Before.\n\n**太字の日本語😀**と_斜体_。\n', '太字の日本語', 3],
        ['- [ ] First\n- [x] Second\n  - Nested item\n\nAfter.\n', 'Nested item', 4],
        ['```js\n\nconst message = "日本語😀";\nconsole.log(message);\n\n```\n\nAfter.\n', 'message', 3],
        ['| Name | Value |\n| --- | --- |\n| Apple | Banana |\n\nAfter.\n', 'Banana', 3],
        ['Body[^b] and second[^a].\n\n[^a]: Alpha note.\n\n[^b]: Beta note.\n\nAfter.\n', 'Alpha note', 4],
        ['> [!NOTE]\n> Callout content.\n\nAfter.\n', 'Callout content', 7],
        ['```mermaid\ngraph TD\nA-->B\n```\n\nAfter diagram.\n', 'After diagram', 5],
        ['```mermaid\ngraph TD\nA-->B\n```\n\nAfter diagram.\n', 'graph TD', 4],
        ['```math\nx^2+y^2\n```\n\nAfter formula.\n', 'x^2+y^2', 4],
        ['$$\nx^2+y^2\n$$\n\nAfter formula.\n', 'After formula', 5],
        ['First.\n\nSecond.\n\nThird paragraph.\n', 'Third paragraph', 5],
    ];
    for (const [source, needle, delta] of cases) {
        const document = documentFor(source);
        const map = new MarkdownSelectionMap(document, source);
        const content = document.toHtml();
        await evaluate(`window.postMessage({type:'init',content:${JSON.stringify(content)}},'*')`);
        await evaluate('new Promise(r=>setTimeout(r,150))');
        const canonicalBefore = projectEditorText(createWindow(`<div id="root">${content}</div>`).document.getElementById('root')).text;
        const browserBefore = await evaluate(`window.selectionModule.then(m=>m.projectEditorText(document.getElementById('editor')).text)`);
        assert.equal(browserBefore, canonicalBefore, `${needle}: ${await evaluate(`document.getElementById('editor').innerHTML`)}`);
        const sourceSelection = { anchor: source.indexOf(needle) + delta, active: source.indexOf(needle) + 1 };
        await evaluate(`window.postMessage({type:'restoreEditorSelection',selection:${JSON.stringify(map.toRendered(sourceSelection))}},'*')`);
        await settle();
        assert.equal(await evaluate('getSelection().toString()'), needle.slice(1, delta), needle);
        const current = await snapshot();
        assert.deepEqual(map.toSource(current.selection), sourceSelection, needle);
        // The same projection must describe both the decorated browser DOM and
        // the host's renderer, including checkboxes and code highlighting.
        const canonical = projectEditorText(createWindow(`<div id="root">${content}</div>`).document.getElementById('root')).text;
        const actual = await evaluate(`window.selectionModule.then(m=>m.projectEditorText(document.getElementById('editor')).text)`);
        assert.equal(actual, canonical, needle);
    }

    await evaluate(`(()=>{const p=document.querySelector('#editor > p:last-of-type');p.textContent='Third paragraph typed now.';
        const r=document.createRange();r.setStart(p.firstChild,25);r.collapse(true);getSelection().removeAllRanges();getSelection().addRange(r);
        document.getElementById('editor').dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:'now.'}));})()`);
    const latest = await snapshot();
    assert.match(latest.content, /typed now\./);
    assert.ok(latest.revision > 0);
    assert.deepEqual(await evaluate('editorErrors'), []);
});
