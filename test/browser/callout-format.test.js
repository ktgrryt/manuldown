const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { loadPdfModules, uri } = require('../helpers/pdf-modules');

const repository = path.resolve(__dirname, '../..');

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

test('callout format controls align with the title and preserve editing, history and keyboard access', { timeout: 30_000 }, async t => {
    const { MarkdownEditorProvider, MarkdownDocument } = loadEditorModules();
    const { openPdfBrowser, findPdfBrowser } = loadPdfModules();
    const source = '# Callouts\n\n:::note warn\nPlease check the **configuration** before continuing.\n:::\n\n> [!TIP]\n> You can choose a format from the menu.\n';
    const document = { uri: uri('/workspace/callouts.md'), getText: () => source };
    const content = new MarkdownDocument(document).toHtml();
    const provider = new MarkdownEditorProvider({ extensionUri: uri(repository), extensionMode: 2 });
    let html, origin;
    const server = http.createServer(async (request, response) => {
        try {
            if (request.url === '/') { response.setHeader('Content-Type', 'text/html'); response.end(html); return; }
            const filename = path.resolve(repository, '.' + new URL(request.url, origin).pathname);
            if (!filename.startsWith(path.join(repository, 'media') + path.sep)) { response.writeHead(404).end(); return; }
            response.setHeader('Content-Type', filename.endsWith('.css') ? 'text/css' : filename.endsWith('.js') ? 'text/javascript' : 'application/octet-stream');
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
        window.acquireVsCodeApi=()=>({getState(){},setState(state){return state;},postMessage(message){
            hostMessages.push(message);
            if(message.type==='ready')setTimeout(()=>window.postMessage({type:'init',content:${JSON.stringify(content)}},'*'),0);
            if(message.type==='update')setTimeout(()=>window.postMessage({type:'updateApplied',revision:message.revision},'*'),0);
        }});
        document.documentElement.style.cssText='--vscode-editor-background:#1e1e1e;--vscode-editor-foreground:#cccccc;--vscode-foreground:#cccccc;--vscode-descriptionForeground:#999999;--vscode-editorWidget-background:#252526;--vscode-editorGroup-border:#454545;--vscode-focusBorder:#007fd4;--vscode-list-hoverBackground:#2a2d2e;--vscode-textLink-foreground:#4daafc';`;
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
    const click = async (selector, atStart = false) => {
        const point = await evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.left+${atStart ? '6' : 'r.width/2'},y:r.top+r.height/2};})()`);
        await connection.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point }, sessionId);
        await connection.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point }, sessionId);
    };
    const key = async (name, code, virtualKey, modifiers = 0) => {
        await connection.send('Input.dispatchKeyEvent', { type: 'keyDown', key: name, code, windowsVirtualKeyCode: virtualKey, modifiers }, sessionId);
        await connection.send('Input.dispatchKeyEvent', { type: 'keyUp', key: name, code, windowsVirtualKeyCode: virtualKey, modifiers }, sessionId);
    };
    const settle = () => evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
    const reset = async (value = source) => {
        const rendered = new MarkdownDocument({ ...document, getText: () => value }).toHtml();
        await evaluate(`window.postMessage({type:'init',content:${JSON.stringify(rendered)}},'*')`);
        await settle();
        await evaluate(`document.getElementById('editor').scrollTop=0`);
    };
    const selectBodyStart = async () => {
        await evaluate(`(()=>{const paragraph=document.querySelector('.mdw-callout-content p'),range=document.createRange();range.setStart(paragraph.firstChild,0);range.collapse(true);document.getElementById('editor').focus();getSelection().removeAllRanges();getSelection().addRange(range);})()`);
        await settle();
    };
    await connection.send('Emulation.setDeviceMetricsOverride', { width: 1000, height: 650, deviceScaleFactor: 1, mobile: false }, sessionId);
    await connection.send('Page.navigate', { url: origin }, sessionId);
    await waitFor(`document.body.dataset.editorState==='ready'&&document.querySelectorAll('.mdw-callout-format-toggle').length===2`);
    assert.equal(await evaluate(`(()=>{const button=document.querySelector('.mdw-callout-format-toggle'),icon=document.querySelector('.toolbar-overflow-toggle .md-icon');return button.textContent===''&&getComputedStyle(button,'::before').maskImage===getComputedStyle(icon).maskImage;})()`), true);
    const artifacts = await fs.mkdtemp(path.join(os.tmpdir(), 'manuldown-callout-'));
    for (const width of [1000, 360]) {
        await connection.send('Emulation.setDeviceMetricsOverride', { width, height: 650, deviceScaleFactor: 1, mobile: false }, sessionId);
        const geometry = await evaluate(`(()=>{const block=document.querySelector('.mdw-callout'),title=block.querySelector('.mdw-callout-title').getBoundingClientRect(),button=block.querySelector('.mdw-callout-format-toggle').getBoundingClientRect(),r=block.getBoundingClientRect();return {aligned:Math.abs(title.top-button.top)<3,separate:title.right<button.left,right:r.right-button.right};})()`);
        assert.equal(geometry.aligned, true); assert.equal(geometry.separate, true);
        assert.ok(geometry.right >= 0 && geometry.right <= 16);
        await click('.mdw-callout-format-toggle');
        await waitFor(`!!document.querySelector('.mdw-callout-format-picker')`);
        assert.equal(await evaluate(`(()=>{const r=document.querySelector('.mdw-callout-format-picker').getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight;})()`), true);
        const screenshot = await connection.send('Page.captureScreenshot', { format: 'png' }, sessionId);
        await fs.writeFile(path.join(artifacts, `menu-${width}.png`), Buffer.from(screenshot.data, 'base64'));
        await key('Escape', 'Escape', 27);
        assert.equal(await evaluate(`document.activeElement.matches('.mdw-callout-format-toggle')`), true);
    }
    await click('.mdw-callout-format-toggle');
    await click('[data-callout-dialect="github"]');
    await waitFor(`document.querySelector('.mdw-callout').dataset.mdwCalloutType==='WARNING'`);
    await waitFor(`hostMessages.some(message=>message.type==='update')`);
    assert.equal(await evaluate(`document.querySelector('.mdw-callout-title').textContent`), 'WARNING');
    assert.equal(await evaluate(`document.querySelector('.mdw-callout-content strong').textContent`), 'configuration');
    const savedHtml = await evaluate(`hostMessages.filter(message=>message.type==='update').at(-1).content`);
    assert.doesNotMatch(savedHtml, /mdw-callout-format-toggle/);
    assert.equal(provider.htmlToMarkdown(savedHtml, document), source.replace(':::note warn\nPlease check the **configuration** before continuing.\n:::', '> [!WARNING]\n> Please check the **configuration** before continuing.'));
    await evaluate(`document.getElementById('editor').focus()`);
    await evaluate(`window.postMessage({type:'historyCommand',direction:'undo'},'*')`);
    await waitFor(`document.querySelector('.mdw-callout').dataset.mdwCalloutType==='warn'`);
    await evaluate(`window.postMessage({type:'historyCommand',direction:'redo'},'*')`);
    await waitFor(`document.querySelector('.mdw-callout').dataset.mdwCalloutType==='WARNING'`);
    await evaluate(`(()=>{const text=document.querySelector('.mdw-callout-content p').firstChild,range=document.createRange();range.setStart(text,0);range.collapse(true);document.getElementById('editor').focus();getSelection().removeAllRanges();getSelection().addRange(range);})()`);
    await key('ArrowUp', 'ArrowUp', 38);
    assert.equal(await evaluate(`!!document.querySelector('.mdw-callout-title.nav-selected')`), true);
    await key('ArrowRight', 'ArrowRight', 39);
    assert.equal(await evaluate(`document.activeElement.matches('.mdw-callout-format-toggle')&&getSelection().rangeCount===0`), true);
    await key('ArrowLeft', 'ArrowLeft', 37);
    assert.equal(await evaluate(`!!document.querySelector('.mdw-callout-title.nav-selected')`), true);
    await key('ArrowRight', 'ArrowRight', 39);
    await key('Enter', 'Enter', 13);
    await waitFor(`!!document.querySelector('.mdw-callout-format-picker')`);
    await key('ArrowDown', 'ArrowDown', 40);
    await key('Enter', 'Enter', 13);
    await waitFor(`document.querySelector('.mdw-callout').dataset.mdwCalloutType==='warn'`);
    assert.equal(await evaluate(`document.activeElement.matches('.mdw-callout-format-toggle')`), true);
    await key('ArrowDown', 'ArrowDown', 40);
    assert.equal(await evaluate(`document.activeElement.id==='editor'&&!!getSelection().anchorNode.parentElement.closest('.mdw-callout-content')`), true);
    await click('.mdw-callout-title');
    assert.deepEqual(await evaluate(`Array.from(document.querySelectorAll('.mdw-callout-type-picker [data-callout-type]'),option=>option.dataset.calloutType)`), ['info', 'warn', 'alert']);
    await key('Escape', 'Escape', 27);
    await t.test('Tab and Shift+Tab close either picker with a usable editor cursor', async () => {
        for (const selector of ['.mdw-callout-title', '.mdw-callout-format-toggle']) {
            for (const modifiers of [0, 8]) {
                await reset();
                await click(selector);
                await key('Tab', 'Tab', 9, modifiers);
                assert.equal(await evaluate(`!document.querySelector('.mdw-callout-type-picker,.mdw-callout-format-picker')`), true);
                const state = await evaluate(`(()=>{const selection=getSelection(),active=document.activeElement,editor=document.getElementById('editor');return {focused:active.id||active.className,usable:editor.contains(active)&&(active.matches('.mdw-callout-format-toggle')||(selection.rangeCount>0&&editor.contains(selection.anchorNode)))};})()`);
                assert.equal(state.usable, true, `${selector}, modifiers=${modifiers}: ${JSON.stringify(state)}`);
            }
        }
    });
    await t.test('repeated movement between title, format control and body retains the cursor without edits', async () => {
        await reset(); await selectBodyStart();
        const before = await evaluate(`document.querySelector('.mdw-callout-content').innerHTML`);
        for (let step = 0; step < 8; step++) {
            await key('ArrowUp', 'ArrowUp', 38);
            assert.equal(await evaluate(`!!document.querySelector('.mdw-callout-title.nav-selected')`), true);
            await key('ArrowRight', 'ArrowRight', 39);
            assert.equal(await evaluate(`document.activeElement.matches('.mdw-callout-format-toggle')&&getSelection().rangeCount===0`), true);
            await key('ArrowDown', 'ArrowDown', 40);
            assert.equal(await evaluate(`getSelection().isCollapsed&&!!getSelection().anchorNode.parentElement.closest('.mdw-callout-content')`), true);
        }
        assert.equal(await evaluate(`document.querySelector('.mdw-callout-content').innerHTML`), before);
    });
    await t.test('Backspace, Delete and typing on the format control do not alter the callout', async () => {
        await reset(); await click('.mdw-callout-format-toggle'); await key('Escape', 'Escape', 27);
        const before = await evaluate(`document.querySelector('.mdw-callout').outerHTML`);
        await key('Backspace', 'Backspace', 8); await key('Delete', 'Delete', 46);
        await connection.send('Input.insertText', { text: 'X' }, sessionId);
        assert.equal(await evaluate(`document.querySelector('.mdw-callout').outerHTML`), before);
        assert.deepEqual(await evaluate('window.editorErrors'), []);
    });
    for (const [name, body] of [
        ['empty paragraph', ''], ['list', '- First\n- Second'], ['task list', '- [ ] First\n- [x] Second'],
        ['code', '```js\nconst value = 1;\n```'], ['quote', '> First\n> Second'],
        ['nested callout', '> [!TIP]\n> Inner body.'], ['table', '| Head |\n| --- |\n| Cell |'],
    ]) {
        await t.test(`the format control leads to editable content${name === 'nested callout' ? ' beside read-only nested source' : ': ' + name}`, async () => {
            await reset(`:::note warn\n${body}\n:::\n`);
            await click('.mdw-callout-format-toggle'); await key('Escape', 'Escape', 27);
            await key('ArrowDown', 'ArrowDown', 40);
            if (name === 'nested callout') {
                assert.equal(await evaluate(`document.querySelectorAll('.mdw-callout-title.nav-selected').length`), 0);
                assert.equal(await evaluate(`document.querySelectorAll('[data-mdw-callout="true"]').length`), 1);
                assert.equal(await evaluate(`!!document.querySelector('[data-mdw-opaque-kind="callout-source"]')`), true);
            }
            const state = await evaluate(`(()=>{const selection=getSelection(),editor=document.getElementById('editor'),node=selection.anchorNode,element=node?.nodeType===1?node:node?.parentElement;return {focused:document.activeElement.id,tag:element?.tagName,usable:document.activeElement===editor&&selection.isCollapsed&&!!element?.closest('.mdw-callout-content')&&!element?.closest('[contenteditable="false"]')};})()`);
            assert.equal(state.usable, true, JSON.stringify(state));
            await connection.send('Input.insertText', { text: 'X' }, sessionId);
            assert.equal(await evaluate(`document.querySelector('.mdw-callout-content').textContent.includes('X')`), true);
            assert.deepEqual(await evaluate('window.editorErrors'), []);
        });
    }
    await t.test('clicking body text dismisses the picker and keeps typing in that body', async () => {
        await reset(); await click('.mdw-callout-format-toggle');
        await click('.mdw-callout-content p', true);
        assert.equal(await evaluate(`!document.querySelector('.mdw-callout-format-picker')`), true);
        await connection.send('Input.insertText', { text: 'X' }, sessionId);
        assert.equal(await evaluate(`document.querySelector('.mdw-callout-content p').textContent.includes('X')`), true);
    });
    await t.test('Undo while the picker is open closes stale controls and keeps the cursor usable', async () => {
        await reset(); await click('.mdw-callout-format-toggle'); await click('[data-callout-dialect="github"]');
        await click('.mdw-callout-format-toggle');
        await evaluate(`window.postMessage({type:'historyCommand',direction:'undo'},'*')`);
        await waitFor(`document.querySelector('.mdw-callout').dataset.mdwCalloutType==='warn'`);
        assert.equal(await evaluate(`!document.querySelector('.mdw-callout-format-picker')`), true);
        await selectBodyStart(); await key('ArrowUp', 'ArrowUp', 38); await key('ArrowRight', 'ArrowRight', 39);
        assert.equal(await evaluate(`document.activeElement.matches('.mdw-callout-format-toggle')`), true);
    });
    await t.test('moving down from a format control at the viewport edge reveals the body caret', async () => {
        await reset('Before.\n\n'.repeat(25) + ':::note warn\nBody at the edge.\n:::\n');
        await evaluate(`(()=>{const editor=document.getElementById('editor'),button=document.querySelector('.mdw-callout-format-toggle'),edge=editor.getBoundingClientRect().bottom;editor.scrollTop+=button.getBoundingClientRect().bottom-edge+12;})()`);
        await click('.mdw-callout-format-toggle'); await key('Escape', 'Escape', 27);
        await key('ArrowDown', 'ArrowDown', 40); await settle();
        const state = await evaluate(`(()=>{const selection=getSelection(),caret=selection.getRangeAt(0).getBoundingClientRect(),editor=document.getElementById('editor').getBoundingClientRect();return {caretTop:caret.top,caretBottom:caret.bottom,editorTop:editor.top,editorBottom:editor.bottom,visible:caret.top>=editor.top&&caret.bottom<=editor.bottom};})()`);
        assert.equal(state.visible, true, JSON.stringify(state));
    });
    await t.test('Tab and Shift+Tab traverse the header controls and return to editable content', async () => {
        await reset(); await selectBodyStart(); await key('ArrowUp', 'ArrowUp', 38);
        await key('Tab', 'Tab', 9);
        assert.equal(await evaluate(`document.activeElement.matches('.mdw-callout-format-toggle')`), true);
        await key('Tab', 'Tab', 9, 8);
        assert.equal(await evaluate(`!!document.querySelector('.mdw-callout-title.nav-selected')`), true);
        await key('Tab', 'Tab', 9, 8);
        assert.equal(await evaluate(`getSelection().isCollapsed&&getSelection().anchorNode.parentElement.tagName==='H1'`), true);
        await key('ArrowDown', 'ArrowDown', 40); await key('Tab', 'Tab', 9); await key('Tab', 'Tab', 9);
        await connection.send('Input.insertText', { text: 'X' }, sessionId);
        assert.equal(await evaluate(`document.querySelector('.mdw-callout-content p').textContent.startsWith('X')`), true);
    });
    await t.test('Mac cursor shortcuts can leave a focused format button without losing the cursor', async () => {
        if (await evaluate(`document.body.dataset.platform!=='mac'`)) return;
        for (const [name, code, virtualKey, target] of [
            ['b', 'KeyB', 66, 'title'], ['f', 'KeyF', 70, 'body'], ['n', 'KeyN', 78, 'body'], ['p', 'KeyP', 80, 'heading'],
        ]) {
            await reset(); await click('.mdw-callout-format-toggle'); await key('Escape', 'Escape', 27);
            await key(name, code, virtualKey, 2);
            const result = await evaluate(`(()=>{const selection=getSelection(),node=selection.anchorNode,element=node?.nodeType===1?node:node?.parentElement;return {focused:document.activeElement.id,rangeCount:selection.rangeCount,title:!!document.querySelector('.mdw-callout-title.nav-selected'),body:!!element?.closest('.mdw-callout-content'),heading:element?.tagName==='H1'};})()`);
            assert.equal(result.focused, 'editor', `${name}: ${JSON.stringify(result)}`);
            assert.equal(result[target], true, `${name}: ${JSON.stringify(result)}`);
        }
    });
    for (const [service, header] of [
        ['github', '> [!NOTE]'], ['qiita', ':::note info'], ['zenn', ':::message'],
        ['obsidian', '> [!note]'], ['container', ':::info'], ['mkdocs', '!!! note'],
    ]) {
        await t.test(`/callout inserts the configured ${service} format with an editable body`, async () => {
            await reset('\n');
            await evaluate(`window.postMessage({type:'settings',settings:{calloutDefaultService:${JSON.stringify(service)}}},'*')`);
            await settle();
            await evaluate(`(()=>{const editor=document.getElementById('editor'),range=document.createRange();range.selectNodeContents(editor);range.collapse(false);editor.focus();getSelection().removeAllRanges();getSelection().addRange(range);})()`);
            await connection.send('Input.insertText', { text: '/callout' }, sessionId);
            await waitFor(`Array.from(document.querySelectorAll('.slash-command-menu:not(.insert-command-menu) .slash-command-name')).some(item=>item.textContent==='/callout')`);
            await key('Enter', 'Enter', 13); await settle();
            const state = await evaluate(`(()=>{const block=document.querySelector('.mdw-callout'),selection=getSelection(),node=selection.anchorNode,element=node?.nodeType===1?node:node?.parentElement;return {header:block?atob(block.dataset.mdwCalloutHeader):null,editable:document.activeElement.id==='editor'&&selection.isCollapsed&&!!element?.closest('.mdw-callout-content'),text:document.getElementById('editor').textContent};})()`);
            assert.equal(state.header, header, JSON.stringify(state));
            assert.equal(state.editable, true, JSON.stringify(state));
            assert.doesNotMatch(state.text, /\/callout/);
            await connection.send('Input.insertText', { text: 'New body.' }, sessionId);
            assert.equal(await evaluate(`document.querySelector('.mdw-callout-content').textContent`), 'New body.');
        });
    }
    await t.test('changing the default affects the next insertion while keeping existing callouts and Undo/Redo', async () => {
        await reset(':::note warn\nExisting body.\n:::\n\nAfter.\n');
        await evaluate(`window.postMessage({type:'settings',settings:{calloutDefaultService:'zenn'}},'*')`); await settle();
        await evaluate(`(()=>{const editor=document.getElementById('editor'),paragraph=editor.lastElementChild,range=document.createRange();range.selectNodeContents(paragraph);range.collapse(false);editor.focus();getSelection().removeAllRanges();getSelection().addRange(range);window.postMessage({type:'openInsertMenu'},'*');})()`);
        await waitFor(`document.querySelector('.insert-command-menu')?.style.display==='flex'`);
        await connection.send('Input.insertText', { text: 'callout' }, sessionId);
        await key('Enter', 'Enter', 13); await settle();
        assert.deepEqual(await evaluate(`Array.from(document.querySelectorAll('.mdw-callout'),block=>atob(block.dataset.mdwCalloutHeader))`), [':::note warn', ':::message']);
        await evaluate(`window.postMessage({type:'historyCommand',direction:'undo'},'*')`);
        await waitFor(`document.querySelectorAll('.mdw-callout').length===1`);
        assert.match(await evaluate(`document.getElementById('editor').textContent`), /After\./);
        await evaluate(`window.postMessage({type:'historyCommand',direction:'redo'},'*')`);
        await waitFor(`document.querySelectorAll('.mdw-callout').length===2`);
        await settle();
        await connection.send('Input.insertText', { text: 'Redo body.' }, sessionId);
        const state = await evaluate(`(()=>{const selection=getSelection(),node=selection.anchorNode;return {body:document.querySelectorAll('.mdw-callout-content')[1].textContent,focused:document.activeElement.id,anchor:node?.parentElement.outerHTML,html:document.getElementById('editor').innerHTML};})()`);
        assert.equal(state.body, 'Redo body.', JSON.stringify(state));
    });
    await t.test('callout insertion is unavailable in lists and literal code contexts', async () => {
        for (const markdown of ['- Item\n', '```text\nLiteral\n```\n']) {
            await reset(markdown);
            await evaluate(`(()=>{const editor=document.getElementById('editor'),node=editor.querySelector('li,pre code').firstChild,range=document.createRange();range.setStart(node,node.length);range.collapse(true);editor.focus();getSelection().removeAllRanges();getSelection().addRange(range);})()`);
            await connection.send('Input.insertText', { text: ' /callout' }, sessionId);
            assert.equal(await evaluate(`Array.from(document.querySelectorAll('.slash-command-menu:not(.insert-command-menu) .slash-command-name')).some(item=>item.textContent==='/callout'&&item.closest('.slash-command-menu').style.display!=='none')`), false);
            assert.equal(await evaluate(`document.querySelectorAll('.mdw-callout').length`), 0);
        }
    });
    await connection.send('Emulation.setDeviceMetricsOverride', { width: 1000, height: 650, deviceScaleFactor: 1, mobile: false }, sessionId);
    await t.test('callouts cannot be inserted inside another callout', async () => {
        await reset(':::note warn\nBody.\n:::\n');
        await selectBodyStart();
        await connection.send('Input.insertText', { text: '/callout' }, sessionId);
        await settle();
        assert.equal(await evaluate(`Array.from(document.querySelectorAll('.slash-command-name')).some(item=>item.textContent==='/callout'&&item.closest('.slash-command-menu').style.display!=='none')`), false);
        assert.equal(await evaluate(`document.querySelectorAll('[data-mdw-callout="true"]').length`), 1);
        await evaluate(`window.postMessage({type:'openInsertMenu'},'*')`);
        await waitFor(`document.querySelector('.insert-command-menu')?.style.display==='flex'`);
        await connection.send('Input.insertText', { text: 'callout' }, sessionId);
        await settle();
        assert.equal(await evaluate(`document.querySelectorAll('.insert-command-menu .slash-command-item').length`), 0);
        await key('Escape', 'Escape', 27);
    });
    await t.test('quote shortcuts stop at two levels and toolbar wrapping cannot add a third', async () => {
        for (const depth of [1, 2]) {
            await reset(`${'> '.repeat(depth)}Body.\n`);
            await evaluate(`(()=>{const editor=document.getElementById('editor'),node=editor.querySelector('p').firstChild,range=document.createRange();range.setStart(node,0);range.collapse(true);editor.focus();getSelection().removeAllRanges();getSelection().addRange(range);})()`);
            await connection.send('Input.insertText', { text: '>' }, sessionId);
            await connection.send('Input.insertText', { text: ' ' }, sessionId);
            await settle();
            assert.equal(await evaluate(`document.querySelectorAll('#editor blockquote').length`), 2);
            assert.equal(await evaluate(`!!document.querySelector('#editor blockquote blockquote blockquote')`), false);
            if (depth === 2) {
                assert.match(await evaluate(`document.getElementById('editor').textContent`), /> Body\./);
                await click('[data-command="quote"]'); await settle();
                assert.equal(await evaluate(`document.querySelectorAll('#editor blockquote').length`), 2);
            }
        }
    });
    await t.test('rich paste into a second-level quotation retains text without adding more levels', async () => {
        await reset('> > Body.\n');
        await evaluate(`(()=>{const editor=document.getElementById('editor'),paragraph=editor.querySelector('p'),range=document.createRange();range.selectNodeContents(paragraph);range.collapse(false);editor.focus();getSelection().removeAllRanges();getSelection().addRange(range);const data=new DataTransfer();data.setData('text/html','<blockquote><blockquote><p><strong>Inserted.</strong></p></blockquote></blockquote>');data.setData('text/plain','Inserted.');editor.dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}));})()`);
        await settle();
        assert.equal(await evaluate(`!!document.querySelector('#editor blockquote blockquote blockquote')`), false);
        assert.match(await evaluate(`document.getElementById('editor').textContent`), /Inserted\./);
    });
    assert.deepEqual(await evaluate('window.editorErrors'), []);
    t.diagnostic(`Callout screenshots: ${artifacts}`);
});
