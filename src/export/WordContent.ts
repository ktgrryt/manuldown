import * as path from 'path';
import { runInNewContext } from 'vm';
import { readExportAsset } from './BrowserPdfRenderer';
import type { WordFigure } from './WordFigures';

type PrismHighlighter = {
    languages: Record<string, unknown>;
    highlight: (text: string, grammar: object, language: string) => string;
};

function prepareAlignment(math: any, preview: any, source: string): void {
    const table = math.querySelector('mtable[columnspacing~="0em"][columnalign]');
    if (!table) { return; }
    const annotation = math.querySelector('annotation');
    // A Word matrix can align the left and right sides independently, including in
    // readers that print the literal & from Word's equation-array alignment points.
    const aligned = /^\s*\\begin\{(aligned|align\*)\}([\s\S]*?)\\end\{\1\}\s*$/.exec(source);
    if (aligned && !/^\s*\[/.test(aligned[2]) && !table.querySelector('.mml-eqn-num')) {
        const columns = table.getAttribute('columnalign').trim().split(/\s+/).map((value: string) => value[0]).join('');
        annotation.textContent = `\\begin{array}{${columns}}${aligned[2]}\\end{array}`;
        return;
    }
    annotation.remove();
    // KaTeX's MathML leaves equation numbers to CSS and omits explicit row tags.
    // Copy the labels from its presentation tree into their own editable cells.
    const tags = preview.querySelectorAll('.katex-tag > .vlist-t > .vlist-r:first-child > .vlist > span');
    let automatic = 0;
    for (const [index, row] of Array.from<any>(table.children).entries()) {
        for (const glue of Array.from<any>(row.querySelectorAll('.mtr-glue'))) { glue.remove(); }
        const number = row.querySelector('.mml-eqn-num');
        const tag = tags[index];
        if (number && tag) {
            const text = math.ownerDocument.createElementNS(math.namespaceURI, 'mtext');
            text.textContent = tag.querySelector('.eqn-num') ? `(${++automatic})` : tag.textContent;
            number.appendChild(text);
        }
    }
}

async function prepareEquations(root: any, mediaRoot: string, figures: WordFigure[]): Promise<void> {
    const formulas = Array.from<any>(root.querySelectorAll('[data-mdw-math], pre > code[class~="language-math" i]'));
    if (!formulas.length) { return; }
    const katex: typeof import('katex') = require(path.join(mediaRoot, 'vendor/katex/katex.min.js'));
    const { latexToMath } = await import('docx/math');
    for (const formula of formulas) {
        const fenced = formula.tagName === 'CODE';
        const display = fenced || formula.getAttribute('data-mdw-math') === 'display';
        const source = String(formula.textContent).replace(/\n$/, '');
        // A block-level span also works for $$...$$ between words, without an HTML parser
        // implicitly closing the surrounding paragraph or dropping its following text.
        const wrapper = root.ownerDocument.createElement('span');
        if (display) { wrapper.className = 'word-display-equation'; }
        (fenced ? formula.parentElement : formula).replaceWith(wrapper);
        try {
            wrapper.innerHTML = katex.renderToString(source, {
                output: display ? 'htmlAndMathml' : 'mathml', displayMode: display, throwOnError: true, trust: false,
                strict: 'ignore', maxSize: 100, maxExpand: 1000,
            });
            const math = wrapper.querySelector('math');
            // The wrapper supplies the paragraph. docx/html reads the TeX annotation for
            // native Word structures and uses the expanded MathML for unfamiliar macros.
            math.removeAttribute('display');
            prepareAlignment(math, wrapper, source);
            wrapper.textContent = '';
            wrapper.appendChild(math);
            // Word's importer drops colours and ruled array lines. Its MathML fallback
            // also flattens enclosures such as a cancellation inside a user-defined macro.
            let needsPicture = !!math.querySelector('[mathcolor], [mathbackground], mtable[columnlines], mtable[rowlines]');
            if (math.querySelector('menclose, mpadded')) {
                try { latexToMath(source); } catch {
                    needsPicture = true;
                    // A flattened cancellation or an empty rule would change the meaning.
                    // Keep the TeX available if the illustration cannot be made.
                    wrapper.textContent = source;
                }
            }
            if (needsPicture) {
                figures.push({ kind: display ? 'display-math' : 'inline-math', source, element: wrapper });
            }
        } catch {
            // The native parser also accepts some TeX beyond KaTeX. If both fail,
            // docx/html retains the source and reports the formula through onWarning.
            wrapper.textContent = '';
            const literal = root.ownerDocument.createElement('span');
            literal.setAttribute('data-latex', source);
            literal.textContent = source;
            wrapper.appendChild(literal);
        }
    }
}

export async function prepareWordContent(root: any, mediaRoot: string): Promise<WordFigure[]> {
    const figures: WordFigure[] = [];
    await prepareEquations(root, mediaRoot, figures);
    const codeBlocks = Array.from<any>(root.querySelectorAll('pre > code'));
    // The shipped bundle contains the same language grammars as the editor. Its global
    // Prism lives in a private context, outside VS Code's shared extension-host globals.
    let prism: PrismHighlighter | undefined;
    for (const code of codeBlocks) {
        const source = String(code.textContent).replace(/\n$/, '');
        code.textContent = source;
        const language = /\blanguage-([\w-]+)/i.exec(code.className)?.[1].toLowerCase();
        if (language === 'mermaid') {
            figures.push({ kind: 'diagram', source, element: code.parentElement });
        } else if (language && !code.parentElement.hasAttribute('data-mdw-opaque-kind')) {
            prism ??= runInNewContext(await readExportAsset(mediaRoot, 'vendor/prism.bundle.js') + '\n;Prism', {}) as PrismHighlighter;
            const grammar = prism.languages[language];
            if (grammar && typeof grammar === 'object' && Object.prototype.hasOwnProperty.call(prism.languages, language)) {
                try {
                    code.innerHTML = prism.highlight(source, grammar, language);
                    if (code.textContent !== source) { code.textContent = source; }
                } catch { code.textContent = source; }
            }
        }
    }
    for (const image of Array.from<any>(root.querySelectorAll('img'))) {
        const source = image.getAttribute('src');
        if (source && !/^data:image\/(?:png|jpe?g|gif|bmp)[;,]/i.test(source)) {
            figures.push({ kind: 'image', source, element: image });
        }
    }
    for (const blank of Array.from<any>(root.querySelectorAll('p[data-mdw-blankline]'))) {
        blank.textContent = ''; // An empty Word paragraph already occupies one line.
    }
    // docx/html matches fragment links against decoded IDs and expects notes after their references.
    for (const note of Array.from<any>(root.querySelectorAll('[data-mdw-footnote-definition]'))) {
        note.id = decodeURIComponent(note.id);
        note.setAttribute('role', 'doc-footnote');
        root.appendChild(note);
    }
    const firstReferences = new Map<string, string>();
    for (const ref of Array.from<any>(root.querySelectorAll('[data-mdw-footnote-ref]'))) {
        ref.id = decodeURIComponent(ref.id);
        const label = ref.getAttribute('data-mdw-footnote-ref');
        const first = firstReferences.get(label);
        if (first) {
            // A second Word footnote would duplicate the body and renumber every later note.
            ref.querySelector('a').setAttribute('href', '#' + encodeURIComponent(first));
        } else {
            ref.setAttribute('role', 'doc-noteref');
            firstReferences.set(label, ref.id);
        }
    }
    return figures;
}
