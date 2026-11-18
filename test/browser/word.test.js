const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { unzipSync, strFromU8 } = require('fflate');
const { loadPdfModules, uri } = require('../helpers/pdf-modules');

test('Word embeds rendered diagrams, visual math and WebP, and keeps a failed diagram as source', async () => {
    let parts;
    const notices = [];
    const { exportWord } = loadPdfModules({
        window: {
            showSaveDialog: async () => uri('/workspace/word.docx'),
            showWarningMessage: message => notices.push(message),
            showInformationMessage: message => notices.push(message),
        },
        workspace: {
            getConfiguration: () => ({ get: () => process.env.MANULDOWN_PDF_BROWSER || '' }),
            fs: {
                writeFile: async (_file, bytes) => { parts = unzipSync(bytes); },
                rename: async () => {}, delete: async () => {},
            },
        },
    });
    const diagram = '```mermaid\nflowchart LR\nA[入力] --> B[出力]\n```';
    const source = ['# 実験', '$x^2$ と $\\textcolor{red}{x^2}$', diagram, '![写真|96](photo.webp)',
        '```mermaid\ninvalid diagram\n```', diagram, '![ベクトル図](figure.svg)'].join('\n\n');
    const webp = 'data:image/webp;base64,UklGRigAAABXRUJQVlA4TBsAAAAvH8ADEA8wJlM9PPMf8BAIJPlLD7BARP+jeAEA';
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40"><rect width="80" height="40" fill="blue"/></svg>';
    await exportWord(uri(path.resolve(__dirname, '../..')), uri('/workspace/word.md'), async () => ({ source }),
        async name => name.endsWith('.webp') ? webp : 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64'));
    const body = strFromU8(parts['word/document.xml']);
    assert.equal((body.match(/<w:drawing>/g) || []).length, 5);
    assert.match(body, /<m:sSup>/);
    assert.match(body, /<wp:extent cx="914400" cy="457200"/);
    assert.match(body, /<asvg:svgBlip\b/);
    assert.match(body, /<w:t[^>]*>invalid diagram<\/w:t>/);
    assert.doesNotMatch(body, /<w:t[^>]*>flowchart LR/);
    const pngs = Object.entries(parts).filter(([name]) => name.startsWith('word/media/') && name.endsWith('.png'))
        .map(([, bytes]) => Buffer.from(bytes));
    assert.ok(pngs.some(bytes => bytes.readUInt32BE(16) >= 300), 'diagram captured at print resolution');
    assert.ok(pngs.some(bytes => bytes.readUInt32BE(16) === 64 && bytes.readUInt32BE(20) === 32), 'WebP aspect ratio retained');
    assert.match(notices.join(' '), /Mermaid source kept: invalid diagram/);
    assert.doesNotMatch(notices.join(' '), /could not be converted|flowchart LR|simplified styling/);
});
