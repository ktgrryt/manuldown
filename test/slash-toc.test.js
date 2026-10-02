const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const domino = require('@mixmark-io/domino');

const source = fs.readFileSync(path.join(__dirname, '..', 'media', 'modules', 'MarkdownHeadingSlug.js'), 'utf8');
const modulePromise = import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

async function createToc(html) {
    const { createMarkdownTableOfContents } = await modulePromise;
    const document = domino.createWindow(`<div id="editor">${html}</div>`).document;
    const headings = document.querySelectorAll('h1, h2, h3, h4, h5, h6');
    return { headings: Array.from(headings), toc: createMarkdownTableOfContents(headings, document) };
}

function hierarchy(list) {
    return Array.from(list.children).map(item => ({
        text: item.firstChild.textContent,
        children: item.querySelector('ul') ? hierarchy(item.querySelector('ul')) : []
    }));
}

test('/toc preserves heading order and nesting, including skipped levels', async () => {
    const { toc } = await createToc('<h2>First</h2><h4>Child</h4><h5>Deep</h5><h3>Sibling</h3><h2>Second</h2><h1>Last</h1>');
    assert.deepEqual(hierarchy(toc), [
        { text: 'First', children: [
            { text: 'Child', children: [{ text: 'Deep', children: [] }] },
            { text: 'Sibling', children: [] }
        ] },
        { text: 'Second', children: [] },
        { text: 'Last', children: [] }
    ]);
});

test('/toc links every heading, including Japanese and duplicate titles, to its stable ID', async () => {
    const { headings, toc } = await createToc('<h1>文書</h1><h2>TODO項目</h2><h2>TODO項目</h2><h2>TODO項目-1</h2><h3>!!!</h3>');
    const links = Array.from(toc.querySelectorAll('a'));
    assert.deepEqual(links.map(link => link.getAttribute('href')), [
        '#文書', '#todo項目', '#todo項目-1', '#todo項目-1-1', '#heading-4'
    ]);
    links.forEach((link, index) => assert.equal(link.getAttribute('href').slice(1), headings[index].id));
});

test('/toc omits empty headings without changing fragment fallback IDs', async () => {
    const { toc } = await createToc('<h1> </h1><h2><br></h2><h3>!!!</h3>');
    assert.equal(toc.querySelectorAll('li').length, 1);
    assert.equal(toc.querySelector('a').getAttribute('href'), '#heading-2');
});

test('/toc returns no list for documents without titled headings', async () => {
    for (const html of ['<p>Body only</p>', '<h1><br></h1><h2> </h2>']) {
        assert.equal((await createToc(html)).toc, null);
    }
});

test('/toc uses heading text safely without copying formatting or nested links', async () => {
    const { toc } = await createToc('<h2><strong>A &amp; B</strong> <a href="https://example.com">[link]</a> &lt;img&gt;</h2>');
    assert.equal(toc.querySelector('a').textContent, 'A & B [link] <img>');
    assert.equal(toc.querySelectorAll('a').length, 1);
    assert.equal(toc.querySelectorAll('strong, img').length, 0);
    assert.equal(toc.querySelector('a').getAttribute('href'), '#a-b-link-img');
});

test('/toc includes all headings rather than the link suggestion limit', async () => {
    const { toc } = await createToc(Array.from({ length: 35 }, (_, i) => `<h2>Section ${i}</h2>`).join(''));
    assert.equal(toc.querySelectorAll('a').length, 35);
});
