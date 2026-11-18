const assert = require('node:assert/strict');
const test = require('node:test');
const { openEditor } = require('../helpers/browser-editor');

test('footnote caret correction preserves native lines, neighboring paragraphs and the viewport', { timeout: 30_000 }, async t => {
    const source = 'Body[^a] and second[^b] with another[^a].\n\n[^a]: aaa\n\n[^b]: test\n';
    const { evaluate, waitFor, key, settle, reset, select, requestedAssets, connection, sessionId } = await openEditor(t, source);
    const editorAsset = requestedAssets.find(asset => asset.pathname === '/media/editor.js');
    const footnoteAsset = requestedAssets.find(asset => asset.pathname === '/media/modules/FootnoteManager.js');
    assert.ok(editorAsset?.search.includes('v='));
    assert.equal(footnoteAsset?.search, editorAsset.search, 'Reopening the editor must load the updated footnote module');
    const shortSource = 'Body[^a] and second[^b].\n\n[^a]: First note.\n\n[^b]: Last note.\n';
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
