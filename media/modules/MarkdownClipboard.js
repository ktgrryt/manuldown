// @ts-nocheck
import { DOMUtils } from './DOMUtils.js';

/** Build a standalone Markdown-conversion snapshot without changing the editor. */
export function createMarkdownClipboardHtml(editor, range, footnoteManager) {
    if (!range || range.collapsed || !editor.contains(range.commonAncestorContainer)) return '';

    const document = editor.ownerDocument;
    const domUtils = new DOMUtils(editor);
    const originalRoot = range.commonAncestorContainer;
    const copiedRoot = originalRoot.cloneNode(true);
    const copies = new Map();
    const offsets = new Map();
    const copyState = (original, copied) => {
        copies.set(original, copied);
        if (original.nodeType === 3) {
            const anchorOffset = domUtils.getCaretAnchorOffset(original);
            if (anchorOffset >= 0) {
                copied.nodeValue = domUtils.getTextWithoutCaretAnchors(original);
                offsets.set(original, anchorOffset);
            }
        } else if (original.nodeType === 1) {
            if (original.contains(range.startContainer) || original.contains(range.endContainer)) {
                copied.removeAttribute('data-mdw-opaque-source');
                copied.removeAttribute('data-mdw-opaque-kind');
                if (original.tagName === 'CODE') {
                    for (const name of ['data-mdw-code-whitespace', 'data-mdw-code-leading', 'data-mdw-code-trailing']) {
                        copied.removeAttribute(name);
                    }
                }
            }
            if (original.matches('input[type="checkbox"]')) {
                if (original.checked) copied.setAttribute('checked', '');
                else copied.removeAttribute('checked');
            }
            if (original.tagName === 'LI' && original.parentElement?.tagName === 'OL') {
                const list = original.parentElement;
                const index = Array.from(list.children).indexOf(original);
                const start = parseInt(list.getAttribute('start') || '1', 10) || 1;
                copied.setAttribute('data-mdw-copy-list-number', String(start + index));
            }
        }
        Array.from(original.childNodes || []).forEach((child, index) => copyState(child, copied.childNodes[index]));
    };
    copyState(originalRoot, copiedRoot);
    const copiedRange = document.createRange();
    const copiedOffset = (node, offset) => offset - (offsets.has(node) && offsets.get(node) < offset ? 1 : 0);
    copiedRange.setStart(copies.get(range.startContainer), copiedOffset(range.startContainer, range.startOffset));
    copiedRange.setEnd(copies.get(range.endContainer), copiedOffset(range.endContainer, range.endOffset));

    let fragment = copiedRange.cloneContents();
    let ancestor = originalRoot.nodeType === 1 ? originalRoot : originalRoot.parentElement;
    while (ancestor && ancestor !== editor) {
        // Text inside a cell or a note body is standalone prose when copied.
        if (/^(TD|TH)$/.test(ancestor.tagName) || ancestor.classList.contains('mdw-footnote-content')) break;
        const shell = ancestor.cloneNode(false);
        if (/^H[1-6]$/.test(ancestor.tagName) &&
            fragment.textContent !== domUtils.getTextWithoutCaretAnchors(ancestor)) {
            ancestor = ancestor.parentElement;
            continue;
        }
        // Partial ancestors cannot restore the source/whitespace of unselected text.
        shell.removeAttribute('data-mdw-opaque-source');
        shell.removeAttribute('data-mdw-opaque-kind');
        if (shell.tagName === 'CODE') {
            for (const name of ['data-mdw-code-whitespace', 'data-mdw-code-leading', 'data-mdw-code-trailing']) {
                shell.removeAttribute(name);
            }
        }
        shell.appendChild(fragment);
        fragment = shell;
        if (ancestor.tagName === 'LI') {
            const checkbox = Array.from(ancestor.children).find(child => child.matches('input[type="checkbox"]'));
            if (checkbox && !shell.querySelector('input[type="checkbox"]')) {
                const copy = checkbox.cloneNode(true);
                if (checkbox.checked) copy.setAttribute('checked', '');
                else copy.removeAttribute('checked');
                shell.insertBefore(copy, shell.firstChild);
            }
            if (ancestor.parentElement?.tagName === 'OL') {
                const list = ancestor.parentElement;
                const start = parseInt(list.getAttribute('start') || '1', 10) || 1;
                shell.setAttribute('data-mdw-copy-list-number', String(start + Array.from(list.children).indexOf(ancestor)));
            }
        }
        // Start a copied nested list at its selected level, without empty parents.
        if (/^(UL|OL|PRE)$/.test(ancestor.tagName)) break;
        ancestor = ancestor.parentElement;
    }

    const wrapper = document.createElement('div');
    wrapper.appendChild(fragment);
    footnoteManager.appendClipboardDefinitions(wrapper);
    Array.from(wrapper.querySelectorAll('ol')).forEach(list => {
        const number = list.firstElementChild?.getAttribute('data-mdw-copy-list-number');
        if (number) list.setAttribute('start', number);
    });
    wrapper.querySelectorAll('[data-mdw-copy-list-number]').forEach(node => node.removeAttribute('data-mdw-copy-list-number'));
    return new DOMUtils(wrapper).getCleanedHTML();
}
