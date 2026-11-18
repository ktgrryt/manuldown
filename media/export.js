// Renders the shared Markdown output in PDF and standalone HTML pages.
window.manulPdfReady = (async () => {
    const root = document.getElementById('pdf-content');
    const config = window.manulPdfConfig;
    const warnings = [];
    const deadline = (promise, label) => Promise.race([promise, new Promise((_, reject) => {
        setTimeout(() => reject(new Error(`${label} timed out. Please try again.`)), 20000);
    })]);
    const formula = (node, tex, displayMode) => {
        try {
            node.innerHTML = window.katex.renderToString(tex, {
                displayMode, throwOnError: true, trust: false, strict: 'ignore', maxSize: 100, maxExpand: 1000,
            });
        } catch {
            node.textContent = tex;
            warnings.push(`Formula could not be rendered: ${tex.slice(0, 80)}`);
        }
    };
    for (const node of root.querySelectorAll('[data-mdw-math]')) {
        formula(node, node.textContent, node.getAttribute('data-mdw-math') === 'display');
    }
    for (const code of root.querySelectorAll('pre > code.language-math')) {
        const block = document.createElement('div');
        block.className = 'export-math';
        const id = code.parentElement.getAttribute('data-export-block');
        if (id) block.setAttribute('data-export-block', id);
        formula(block, code.textContent, true);
        code.parentElement.replaceWith(block);
    }
    if (window.Prism) {
        for (const code of root.querySelectorAll('pre > code')) {
            if (!code.classList.contains('language-mermaid')) window.Prism.highlightElement(code);
        }
    }
    await deadline(document.fonts.ready, 'Font loading');
    if (window.mermaid) {
        window.mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'default',
            fontFamily: window.getComputedStyle(document.body).fontFamily });
        let sequence = 0;
        for (const code of root.querySelectorAll('pre > code.language-mermaid')) {
            const container = document.createElement('div');
            container.className = 'export-diagram';
            const id = code.parentElement.getAttribute('data-export-block');
            if (id) container.setAttribute('data-export-block', id);
            try {
                const { svg } = await deadline(window.mermaid.render(`pdf-diagram-${sequence++}`, code.textContent), 'Diagram rendering');
                container.innerHTML = svg;
                // Diagram directives must not introduce external resource loads.
                for (const element of container.querySelectorAll('[href], [xlink\\:href]')) {
                    for (const name of ['href', 'xlink:href']) {
                        const value = element.getAttribute(name);
                        if (value && !value.startsWith('#')) element.removeAttribute(name);
                    }
                }
                code.parentElement.replaceWith(container);
            } catch {
                warnings.push(`Diagram could not be rendered: ${code.textContent.slice(0, 80)}`);
            }
        }
        // Mermaid may append a diagnostic SVG on a syntax error.
        for (const child of [...document.body.children]) {
            if (child !== root && child.tagName !== 'SCRIPT') child.remove();
        }
    }
    await deadline(Promise.all([...root.querySelectorAll('img')].map(image => new Promise(resolve => {
        if (image.complete) return resolve();
        image.addEventListener('load', resolve, { once: true });
        image.addEventListener('error', resolve, { once: true });
    }))), 'Image loading');
    for (const image of root.querySelectorAll('img')) {
        if (!image.naturalWidth) {
            const alt = document.createElement('span');
            alt.className = 'export-missing-image';
            alt.textContent = `[Image unavailable: ${image.alt || 'image'}]`;
            image.replaceWith(alt);
            warnings.push('An image could not be decoded. Its alternative text is shown.');
        }
    }
    await deadline(document.fonts.ready, 'Font loading');
    if (config.format === 'html') return [...new Set(warnings)];
    for (const node of root.querySelectorAll('pre, li, blockquote, .mdw-callout')) {
        if (node.getBoundingClientRect().height < config.height * .4) node.classList.add('export-keep');
    }
    for (const id of config.breaks) {
        const node = [...root.children].find(child => child.getAttribute('data-export-block') === id);
        if (node && node !== root.firstElementChild) node.classList.add('export-break');
    }
    if (config.probePrefix) {
        const blocks = [...root.querySelectorAll(':scope > .export-block')];
        for (const [index, block] of blocks.entries()) {
            const probe = document.createElement('a');
            probe.className = 'export-boundary-probe';
            probe.href = config.probePrefix + block.getAttribute('data-export-block');
            probe.setAttribute('aria-hidden', 'true');
            block.prepend(probe);
            if (blocks[index + 1]) {
                const end = document.createElement('a');
                end.className = 'export-boundary-probe export-boundary-end-probe';
                end.href = config.probePrefix + blocks[index + 1].getAttribute('data-export-block') + '/previous-end';
                end.setAttribute('aria-hidden', 'true');
                block.appendChild(end);
            }
        }
    }
    for (const row of root.querySelectorAll('tr')) {
        if (row.getBoundingClientRect().height > config.height - 2) {
            throw new Error('A table row is taller than one page. Use landscape, narrower margins, or shorten that row.');
        }
    }
    for (const node of root.querySelectorAll('.katex-display, .export-diagram, pre, table')) {
        if (node.scrollWidth > config.width + 3) {
            throw new Error('Some content is wider than the page. Try landscape or narrower margins.');
        }
    }
    return [...new Set(warnings)];
})();
