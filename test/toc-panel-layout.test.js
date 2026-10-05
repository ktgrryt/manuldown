const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const layoutSource = fs.readFileSync(
    path.join(__dirname, '..', 'media', 'modules', 'TocPanelLayout.js'),
    'utf8'
);
const layoutModulePromise = import(
    `data:text/javascript;base64,${Buffer.from(layoutSource).toString('base64')}`
);

test('the panel starts to shrink when the body would be under 400px', async () => {
    const { TOC_BODY_MIN_WIDTH } = await layoutModulePromise;

    assert.equal(TOC_BODY_MIN_WIDTH, 400);
});

test('the panel keeps its width while the body is at least 400px wide', async () => {
    const { fitTocPanelWidth } = await layoutModulePromise;

    assert.equal(fitTocPanelWidth(1200, 150), 150);
    assert.equal(fitTocPanelWidth(550, 150), 150);
});

test('a narrower editor shrinks the panel first, then the body', async () => {
    const { fitTocPanelWidth } = await layoutModulePromise;

    for (const containerWidth of [549, 520, 480, 401]) {
        const panelWidth = fitTocPanelWidth(containerWidth, 150);
        assert.ok(panelWidth > 0 && panelWidth < 150);
        assert.equal(containerWidth - panelWidth, 400, `body width at ${containerWidth}px`);
    }
    assert.equal(fitTocPanelWidth(400, 150), 0);
    assert.equal(fitTocPanelWidth(300, 150), 0);
    assert.equal(fitTocPanelWidth(0, 150), 0);
});

test('the 400px body threshold does not depend on the chosen panel width', async () => {
    const { fitTocPanelWidth } = await layoutModulePromise;

    assert.equal(fitTocPanelWidth(600, 200), 200);
    assert.equal(fitTocPanelWidth(550, 200), 150);
    assert.equal(fitTocPanelWidth(400, 200), 0);
    assert.equal(fitTocPanelWidth(500, 100), 100);
    assert.equal(fitTocPanelWidth(450, 100), 50);
    assert.equal(fitTocPanelWidth(880, 480), 480);
    assert.equal(fitTocPanelWidth(800, 480), 400);
    assert.equal(fitTocPanelWidth(200, 0), 0);
});

test('a chosen width is rendered as chosen at any editor width', async () => {
    const { fitTocBodyMinWidth, fitTocPanelWidth } = await layoutModulePromise;

    for (const containerWidth of [120, 300, 400, 550, 800, 1000]) {
        for (let width = 0; width <= Math.min(480, containerWidth); width += 10) {
            const bodyMinWidth = fitTocBodyMinWidth(containerWidth, width);
            assert.equal(
                fitTocPanelWidth(containerWidth, width, bodyMinWidth),
                width,
                `${width}px panel in a ${containerWidth}px editor`
            );
        }
    }
});

test('only a width that leaves the body under 400px sets a body limit', async () => {
    const { fitTocBodyMinWidth } = await layoutModulePromise;

    assert.equal(fitTocBodyMinWidth(500, 100), null);
    assert.equal(fitTocBodyMinWidth(500, 120), 380);
    assert.equal(fitTocBodyMinWidth(400, 200), 200);
    assert.equal(fitTocBodyMinWidth(400, 400), 0);
    assert.equal(fitTocBodyMinWidth(700, 480), 220);
});

test('a body limit keeps the body width while the panel shrinks and grows back', async () => {
    const { fitTocPanelWidth } = await layoutModulePromise;
    const bodyMinWidth = 200;

    assert.equal(fitTocPanelWidth(400, 200, bodyMinWidth), 200);
    assert.equal(fitTocPanelWidth(350, 200, bodyMinWidth), 150);
    assert.equal(fitTocPanelWidth(200, 200, bodyMinWidth), 0);
    assert.equal(fitTocPanelWidth(150, 200, bodyMinWidth), 0);
    assert.equal(fitTocPanelWidth(350, 200, bodyMinWidth), 150);
    assert.equal(fitTocPanelWidth(1000, 200, bodyMinWidth), 200);
});

test('a body limit never protects the body more than 400px', async () => {
    const { fitTocPanelWidth } = await layoutModulePromise;

    assert.equal(fitTocPanelWidth(500, 150, 450), 100);
});

test('the body limit is released once the body can be 400px again', async () => {
    const { releaseTocBodyMinWidth } = await layoutModulePromise;

    assert.equal(releaseTocBodyMinWidth(400, 200, 200), 200);
    assert.equal(releaseTocBodyMinWidth(599, 200, 200), 200);
    assert.equal(releaseTocBodyMinWidth(600, 200, 200), null);
    assert.equal(releaseTocBodyMinWidth(300, 150, null), null);
});
