// @ts-nocheck
/**
 * TeX formulas. KaTeX draws each formula in a shadow root, so the editable DOM
 * keeps only the TeX text that is saved as Markdown, and history snapshots,
 * cloned selections and saved HTML never contain KaTeX markup.
 */
const FORMULA_SELECTOR = 'span[data-mdw-math]';

const KATEX_OPTIONS = {
    throwOnError: false,
    errorColor: 'var(--vscode-errorForeground, #f14c4c)',
    strict: 'ignore',
    // Commands such as \href and \includegraphics stay disabled.
    trust: false,
    maxSize: 100,
    maxExpand: 1000,
};

const SHADOW_STYLES = `
:host([data-mdw-math="inline"]) .output {
    display: inline-block;
}
.output.is-pending,
.output.is-error {
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 0.9em;
    white-space: pre-wrap;
}
.output.is-pending { opacity: 0.7; }
.output.is-error { color: var(--vscode-errorForeground, #f14c4c); }
.output.is-empty { font-style: italic; opacity: 0.6; }
.output.is-active,
.output.is-selected {
    outline: 1px solid var(--vscode-focusBorder, #007fd4);
    outline-offset: 1px;
    border-radius: 2px;
}
.output.is-selected {
    background-color: var(--vscode-editor-selectionBackground, #add6ff);
}
/* The whole formula has its own selection background. Suppress the native
   text selection inside KaTeX so each glyph is not highlighted again. */
.output.is-selected::selection,
.output.is-selected *::selection {
    background-color: transparent;
    color: inherit;
}
.katex-display {
    margin: 0;
    padding: 2px 0;
    overflow-x: auto;
    overflow-y: hidden;
}
`;

function isZeroWidthText(value) {
    return /^[​⁠﻿]*$/.test(value || '');
}

export class MathManager {
    constructor(editor, stateManager, { onChange = () => {}, scriptSrc = '', styleHref = '', moveVertically = null } = {}) {
        this.editor = editor;
        this.stateManager = stateManager;
        this.onChange = onChange;
        this.scriptSrc = scriptSrc;
        this.styleHref = styleHref;
        this.moveVertically = moveVertically;
        this.loadState = 'idle';
        this.observer = null;
        this.popover = null;
        this.session = null;
        this.selectedFormula = null;
        this.pointerDown = null;
    }

    get document() {
        return this.editor.ownerDocument;
    }

    get window() {
        return this.editor.ownerDocument.defaultView;
    }

    getRange() {
        const selection = this.window.getSelection();
        return selection && selection.rangeCount ? selection.getRangeAt(0) : null;
    }

    /** False while the editor is read-only because its document failed to load. */
    isEditable() {
        return this.editor.getAttribute('contenteditable') !== 'false';
    }

    /** The formula containing node, if any. */
    getFormula(node) {
        const element = node?.nodeType === 1 ? node : node?.parentElement;
        const formula = element?.closest?.(FORMULA_SELECTOR);
        return formula && this.editor.contains(formula) ? formula : null;
    }

    createFormula(tex, mode = 'inline') {
        const formula = this.document.createElement('span');
        formula.className = 'mdw-math';
        formula.setAttribute('data-mdw-math', mode === 'display' ? 'display' : 'inline');
        formula.setAttribute('contenteditable', 'false');
        formula.textContent = tex;
        return formula;
    }

    /** The Markdown for a formula, used as its plain-text clipboard form. */
    toMarkdown(formula) {
        const tex = (formula.textContent || '').trim();
        return formula.getAttribute('data-mdw-math') === 'display' ? `$$${tex}$$` : `$${tex}$`;
    }

    // ---- KaTeX ----------------------------------------------------------

    /** Load KaTeX once. Returns false when it cannot become available. */
    requestLibrary() {
        if (this.window.katex) {
            this.loadState = 'loaded';
            return true;
        }
        if (this.loadState === 'loading') return true;
        if (this.loadState === 'failed' || !this.scriptSrc) {
            this.loadState = 'failed';
            return false;
        }
        const document = this.document;
        const script = document.createElement('script');
        script.src = this.scriptSrc;
        const nonce = document.querySelector('body > script[nonce]')?.nonce;
        if (nonce) script.nonce = nonce;
        script.addEventListener('load', () => {
            this.loadState = this.window.katex ? 'loaded' : 'failed';
            this.renderAll();
        });
        script.addEventListener('error', () => {
            this.loadState = 'failed';
            this.renderAll();
        });
        this.loadState = 'loading';
        document.head.appendChild(script);
        if (this.styleHref) {
            // Chromium ignores @font-face inside shadow roots, so the page
            // itself declares the KaTeX fonts.
            const link = document.createElement('link');
            link.rel = 'stylesheet';
            link.href = this.styleHref;
            document.head.appendChild(link);
        }
        return true;
    }

    /** Draw tex into target's shadow root. */
    render(target, tex, displayMode) {
        target.mdwMath = { tex, displayMode, loadState: this.loadState };
        if (typeof target.attachShadow !== 'function') return false;
        const document = this.document;
        const root = target.shadowRoot || target.attachShadow({ mode: 'open' });
        let output = root.querySelector('.output');
        if (!output) {
            const style = document.createElement('style');
            style.textContent = SHADOW_STYLES;
            root.appendChild(style);
            if (this.styleHref) {
                const link = document.createElement('link');
                link.rel = 'stylesheet';
                link.href = this.styleHref;
                root.appendChild(link);
            }
            output = document.createElement('span');
            root.appendChild(output);
        }
        const active = output.classList.contains('is-active');
        const selected = output.classList.contains('is-selected');
        output.className = active ? 'output is-active' : 'output';
        output.classList.toggle('is-selected', selected);
        output.removeAttribute('title');
        const katex = this.window.katex;
        if (tex.trim() === '') {
            output.classList.add('is-empty');
            output.textContent = displayMode ? 'Empty formula' : 'Math';
        } else if (!katex) {
            const loading = this.requestLibrary();
            output.classList.add(loading ? 'is-pending' : 'is-error');
            output.textContent = tex;
            if (!loading) output.title = 'KaTeX could not be loaded.';
        } else {
            try {
                output.innerHTML = katex.renderToString(tex, { ...KATEX_OPTIONS, displayMode });
            } catch (error) {
                output.classList.add('is-error');
                output.textContent = tex;
                output.title = String(error?.message || error);
            }
        }
        // Rendering may finish after the library loads; the state is current now.
        target.mdwMath.loadState = this.loadState;
        return true;
    }

    renderFormula(formula, force = false) {
        const tex = formula.textContent || '';
        const displayMode = formula.getAttribute('data-mdw-math') === 'display';
        const state = formula.mdwMath;
        if (!force && formula.shadowRoot && state && state.tex === tex &&
            state.displayMode === displayMode && state.loadState === this.loadState) {
            return;
        }
        this.render(formula, tex, displayMode);
    }

    renderAll() {
        this.editor.querySelectorAll(FORMULA_SELECTOR).forEach(formula => this.renderFormula(formula));
        // Math code-block previews keep what CodeBlockManager last drew.
        this.editor.querySelectorAll('.math-preview').forEach(preview => {
            if (preview.mdwMath) this.render(preview, preview.mdwMath.tex, preview.mdwMath.displayMode);
        });
        if (this.session) this.showError(this.session.formula);
    }

    /**
     * Load, history restores, paste and Markdown shortcuts all add formulas as
     * plain DOM. Render whatever appears or changes, wherever it came from.
     */
    observe() {
        if (this.observer || typeof MutationObserver === 'undefined') return;
        this.observer = new MutationObserver(mutations => {
            const formulas = new Set();
            for (const mutation of mutations) {
                const owner = this.getFormula(mutation.target);
                if (owner) formulas.add(owner);
                for (const node of mutation.addedNodes || []) {
                    if (node.nodeType !== 1) continue;
                    if (node.matches(FORMULA_SELECTOR)) formulas.add(node);
                    node.querySelectorAll(FORMULA_SELECTOR).forEach(formula => formulas.add(formula));
                }
            }
            formulas.forEach(formula => {
                if (formula.isConnected) this.renderFormula(formula);
            });
        });
        this.observer.observe(this.editor, { childList: true, characterData: true, subtree: true });
    }

    setup() {
        this.observe();
        this.renderAll();
        this.editor.addEventListener('mousedown', event => {
            this.pointerDown = event.button === 0 && event.detail <= 1 &&
                !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey && this.isEditable()
                ? { x: event.clientX, y: event.clientY, moved: false,
                    formula: this.getFormulaRightEdgeAtPoint(event.clientX, event.clientY, event.target) }
                : null;
            if (event.button !== 0 || !this.getFormula(event.target)) return;
            // Keep the native caret out of the formula's hidden TeX text.
            event.preventDefault();
            event.stopImmediatePropagation();
        }, true);
        this.document.addEventListener('mousemove', event => {
            const pointer = this.pointerDown;
            if (pointer && Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y) > 3) {
                pointer.moved = true;
            }
        });
        this.editor.addEventListener('click', event => {
            const pointer = this.pointerDown;
            this.pointerDown = null;
            if (event.detail === 1 && pointer?.formula && !pointer.moved &&
                Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y) <= 3 &&
                !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey && this.isEditable()) {
                event.preventDefault();
                event.stopImmediatePropagation();
                // Focus first: leaving a TeX input may commit or remove its formula.
                this.editor.focus({ preventScroll: true });
                if (this.editor.contains(pointer.formula)) this.placeCaretBeside(pointer.formula, false);
                this.syncSelection();
                return;
            }
            const formula = this.getFormula(event.target);
            if (!formula) return;
            event.preventDefault();
            event.stopImmediatePropagation();
            this.edit(formula);
        }, true);
        this.editor.addEventListener('scroll', () => this.positionPopover(), { passive: true });
        this.window.addEventListener('resize', () => this.positionPopover());
        this.document.addEventListener('selectionchange', () => this.syncSelection());
        this.editor.addEventListener('focusin', () => this.syncSelection());
        this.editor.addEventListener('focusout', () => this.setSelectedFormula(null));
    }

    // ---- Inserting and editing -------------------------------------------

    canInsert(range = this.getRange()) {
        if (!range || !this.isEditable() ||
            !this.editor.contains(range.startContainer) || !this.editor.contains(range.endContainer)) {
            return false;
        }
        return [range.startContainer, range.endContainer].every(node => {
            const element = node.nodeType === 1 ? node : node.parentElement;
            return !element.closest('pre, code, [contenteditable="false"]');
        });
    }

    /**
     * Insert a formula at the caret and open its editor. A selection within one
     * line becomes the TeX of the formula instead.
     */
    insert() {
        const range = this.getRange();
        if (!this.canInsert(range)) return false;
        const blockOf = node => (node.nodeType === 1 ? node : node.parentElement)
            .closest('p, li, td, th, h1, h2, h3, h4, h5, h6, blockquote, div');
        const selected = range.collapsed ? '' : range.toString().replace(/[​⁠﻿]/g, '');
        const convert = selected.trim() !== '' && !/[\r\n]/.test(selected) &&
            blockOf(range.startContainer) === blockOf(range.endContainer);
        this.closeEditor({ restoreCaret: false });
        this.stateManager.saveState();
        const insertion = range.cloneRange();
        if (convert) insertion.deleteContents();
        else insertion.collapse(false);
        const formula = this.createFormula(convert ? selected.trim() : '');
        const block = blockOf(insertion.startContainer);
        if (block && block !== this.editor && block.textContent === '' &&
            block.childNodes.length === 1 && block.firstChild.nodeName === 'BR') {
            // An empty line's placeholder break would become a hard break.
            block.firstChild.remove();
            block.appendChild(formula);
        } else {
            insertion.insertNode(formula);
        }
        this.renderFormula(formula);
        this.placeCaretBeside(formula, false);
        if (convert) {
            this.stateManager.commitStateAfterChange();
            this.onChange();
        } else {
            this.edit(formula, { isNew: true, historyOpen: true });
            this.onChange();
        }
        return true;
    }

    edit(formula, { isNew = false, historyOpen = false } = {}) {
        if (!formula || !this.editor.contains(formula) || !this.isEditable()) return false;
        if (this.session) {
            if (this.session.formula === formula) return true;
            this.closeEditor({ restoreCaret: false });
        }
        const popover = this.ensurePopover();
        const input = popover.querySelector('.math-popover-input');
        const caret = this.document.createRange();
        this.setCaretAtFormulaEdge(caret, formula, false);
        this.session = {
            formula,
            original: formula.textContent || '',
            isNew,
            historyOpen,
            changeSelection: this.stateManager.saveRange?.(caret) || null,
        };
        input.value = this.session.original;
        popover.hidden = false;
        this.setSelectedFormula(null);
        this.setActive(formula, true);
        this.resizeInput(input);
        this.showError(formula);
        this.positionPopover();
        input.focus({ preventScroll: true });
        input.setSelectionRange(input.value.length, input.value.length);
        return true;
    }

    /**
     * Close the editor. Edits are already in the document; cancelling restores
     * the original TeX, and an empty formula is removed.
     */
    closeEditor({ commit = true, remove = false, restoreCaret = true } = {}) {
        const session = this.session;
        if (!session) return false;
        this.session = null;
        if (this.popover) this.popover.hidden = true;
        const { formula } = session;
        this.setActive(formula, false);
        const caret = this.document.createRange();
        let hasCaret = false;
        if (formula.isConnected && this.editor.contains(formula)) {
            const shouldRemove = remove || (commit ? (formula.textContent || '').trim() === '' : session.isNew);
            if (shouldRemove) {
                if (!session.historyOpen) {
                    this.stateManager.beginChangeAtSelection(session.changeSelection);
                    session.historyOpen = true;
                }
                this.setCaretAtFormulaEdge(caret, formula, true);
                const block = formula.parentElement;
                formula.remove();
                if (block && block !== this.editor && block.textContent === '' && !block.firstElementChild) {
                    block.appendChild(this.document.createElement('br'));
                    caret.setStart(block, 0);
                    caret.collapse(true);
                }
            } else {
                if (!commit && formula.textContent !== session.original) {
                    formula.textContent = session.original;
                }
                this.setCaretAtFormulaEdge(caret, formula, false);
            }
            hasCaret = true;
        }
        if (session.historyOpen) {
            this.stateManager.commitStateAfterChange({
                changeSelection: hasCaret ? this.stateManager.saveRange?.(caret) || null : null,
            });
            this.onChange();
        }
        if (restoreCaret && hasCaret) {
            this.editor.focus({ preventScroll: true });
            const selection = this.window.getSelection();
            selection.removeAllRanges();
            selection.addRange(caret);
        }
        return true;
    }

    /** Hide the editor of a formula that is no longer in the document. */
    dismissEditor() {
        if (!this.session) return;
        this.session = null;
        if (this.popover) this.popover.hidden = true;
    }

    handleInput() {
        const session = this.session;
        if (!session) return;
        if (!session.formula.isConnected) {
            // An external update replaced the document under the editor.
            this.closeEditor({ commit: false, restoreCaret: false });
            return;
        }
        const input = this.popover.querySelector('.math-popover-input');
        if (!session.historyOpen) {
            this.stateManager.beginChangeAtSelection(session.changeSelection);
            session.historyOpen = true;
        }
        // The formula in the document is the live preview.
        session.formula.textContent = input.value;
        this.renderFormula(session.formula);
        this.resizeInput(input);
        this.showError(session.formula);
        this.positionPopover();
        this.onChange();
    }

    handleInputKeydown(event) {
        if (event.isComposing || event.keyCode === 229) return;
        if (event.key === 'Enter' && !event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey) {
            event.preventDefault();
            event.stopPropagation();
            this.closeEditor({ commit: true });
        } else if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            this.closeEditor({ commit: false });
        }
    }

    ensurePopover() {
        if (this.popover) return this.popover;
        const document = this.document;
        const popover = document.createElement('div');
        popover.className = 'math-popover';
        popover.setAttribute('role', 'dialog');
        popover.setAttribute('aria-label', 'Edit formula');
        popover.hidden = true;
        popover.innerHTML = `
            <textarea class="math-popover-input" rows="1" spellcheck="false" autocomplete="off" autocapitalize="off" aria-label="TeX formula" placeholder="TeX, e.g. E = mc^2"></textarea>
            <div class="math-popover-error" role="status" hidden></div>
            <div class="math-popover-footer">
                <span class="math-popover-hint">Enter to finish, Esc to cancel</span>
                <button type="button" class="link-popover-btn danger" data-action="remove">Remove</button>
                <button type="button" class="link-popover-btn primary" data-action="done">Done</button>
            </div>
        `;
        const input = popover.querySelector('.math-popover-input');
        input.addEventListener('input', () => this.handleInput());
        input.addEventListener('keydown', event => this.handleInputKeydown(event));
        input.addEventListener('blur', event => {
            if (popover.contains(event.relatedTarget)) return;
            // Clicking elsewhere finishes editing without moving that click's caret.
            this.closeEditor({ commit: true, restoreCaret: false });
        });
        popover.addEventListener('mousedown', event => {
            if (event.target.closest('button')) event.preventDefault();
        });
        popover.addEventListener('click', event => {
            const action = event.target.closest('button')?.getAttribute('data-action');
            if (action === 'done') this.closeEditor({ commit: true });
            else if (action === 'remove') this.closeEditor({ commit: true, remove: true });
        });
        document.body.appendChild(popover);
        this.popover = popover;
        return popover;
    }

    resizeInput(input) {
        input.style.height = 'auto';
        input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
    }

    showError(formula) {
        const element = this.popover?.querySelector('.math-popover-error');
        if (!element) return;
        const tex = formula.textContent || '';
        const katex = this.window.katex;
        let message = '';
        if (katex && tex.trim() !== '') {
            try {
                katex.renderToString(tex, {
                    ...KATEX_OPTIONS,
                    throwOnError: true,
                    displayMode: formula.getAttribute('data-mdw-math') === 'display',
                });
            } catch (error) {
                message = String(error?.message || error).replace(/^KaTeX parse error:\s*/, '');
            }
        }
        element.textContent = message;
        element.hidden = message === '';
    }

    positionPopover() {
        const session = this.session;
        const popover = this.popover;
        if (!session || !popover || popover.hidden) return;
        const rect = session.formula.getBoundingClientRect();
        const margin = 8;
        const gap = 6;
        const width = popover.offsetWidth;
        const height = popover.offsetHeight;
        const left = Math.max(margin, Math.min(rect.left, this.window.innerWidth - width - margin));
        let top = rect.bottom + gap;
        if (top + height > this.window.innerHeight - margin && rect.top - gap - height >= margin) {
            top = rect.top - gap - height;
        }
        popover.style.left = `${left}px`;
        popover.style.top = `${Math.max(margin, top)}px`;
    }

    setActive(formula, active) {
        formula.shadowRoot?.querySelector('.output')?.classList.toggle('is-active', active);
    }

    setSelectedFormula(formula) {
        this.selectedFormula?.shadowRoot?.querySelector('.output')?.classList.remove('is-selected');
        this.selectedFormula = formula;
        formula?.shadowRoot?.querySelector('.output')?.classList.add('is-selected');
    }

    syncSelection() {
        const focused = this.editor.contains(this.document.activeElement);
        this.setSelectedFormula(focused && !this.session ? this.getSelectedFormula(this.getRange()) : null);
    }

    // ---- Caret movement and deletion -------------------------------------

    /** A small strip at the right edge, plus blank space after a line's last formula. */
    getFormulaRightEdgeAtPoint(x, y, target) {
        const element = target?.nodeType === 1 ? target : target?.parentElement;
        if (!element || !this.editor.contains(element)) return null;
        const clickedFormula = this.getFormula(element);
        if (!clickedFormula && element.closest('a, button, input, textarea, select, pre, code, [contenteditable="false"]')) {
            return null;
        }
        const block = element.closest('p, li, td, th, h1, h2, h3, h4, h5, h6, blockquote, div');
        if (!block || !this.editor.contains(block)) return null;
        let pointRange;
        const candidates = [];
        for (const formula of block.querySelectorAll('span[data-mdw-math="inline"]')) {
            // KaTeX can extend above and below the host span's text line box.
            const output = formula.shadowRoot?.querySelector('.output') || formula;
            const rect = output.getBoundingClientRect();
            const hostRect = formula.getBoundingClientRect();
            if (rect.width <= 0 || y < Math.min(rect.top, hostRect.top) - 2 ||
                y > Math.max(rect.bottom, hostRect.bottom) + 2 || x < rect.right - Math.min(4, rect.width / 4)) continue;
            if (x > rect.right + 6) {
                if (clickedFormula) continue;
                if (pointRange === undefined) {
                    pointRange = this.document.caretRangeFromPoint?.(x, y) || null;
                    if (!pointRange && this.document.caretPositionFromPoint) {
                        const position = this.document.caretPositionFromPoint(x, y);
                        if (position) {
                            pointRange = this.document.createRange();
                            pointRange.setStart(position.offsetNode, position.offset);
                            pointRange.collapse(true);
                        }
                    }
                }
                // Chrome sometimes puts clicks in trailing space before an atomic
                // formula. Only correct that boundary, never later visible text.
                if (this.getFormula(pointRange?.startContainer) !== formula &&
                    this.getAdjacentFormula(pointRange, 'forward') !== formula &&
                    this.getAdjacentFormula(pointRange, 'backward') !== formula) continue;
            }
            candidates.push({ formula, distance: Math.abs(x - rect.right) });
        }
        candidates.sort((a, b) => a.distance - b.distance);
        return candidates[0]?.formula || null;
    }

    setCaretAtFormulaEdge(range, formula, atStart) {
        const sibling = atStart ? formula.previousSibling : formula.nextSibling;
        if (sibling?.nodeType === 3 && sibling.textContent.length > 0) {
            range.setStart(sibling, atStart ? sibling.textContent.length : 0);
        } else if (atStart) {
            range.setStartBefore(formula);
        } else {
            range.setStartAfter(formula);
        }
        range.collapse(true);
    }

    placeCaretBeside(formula, atStart) {
        const selection = this.window.getSelection();
        if (!selection) return;
        const caret = this.document.createRange();
        this.setCaretAtFormulaEdge(caret, formula, atStart);
        selection.removeAllRanges();
        selection.addRange(caret);
    }

    /** The formula the caret touches in direction, across zero-width text. */
    getAdjacentFormula(range, direction) {
        if (!range || !range.collapsed || !this.editor.contains(range.startContainer)) return null;
        const backward = direction === 'backward';
        const isBoundary = node => node === this.editor ||
            /^(?:P|DIV|LI|H[1-6]|TD|TH|BLOCKQUOTE|PRE|CODE)$/.test(node.tagName || '');
        const sibling = node => backward ? node.previousSibling : node.nextSibling;
        let container = range.startContainer;
        let candidate;
        if (container.nodeType === 3) {
            const remaining = backward ? container.textContent.slice(0, range.startOffset)
                : container.textContent.slice(range.startOffset);
            if (!isZeroWidthText(remaining)) return null;
            candidate = sibling(container);
        } else {
            candidate = container.childNodes[range.startOffset + (backward ? -1 : 0)];
        }
        while (container && this.editor.contains(container)) {
            if (!candidate) {
                if (isBoundary(container)) return null;
                candidate = sibling(container);
                container = container.parentNode;
                continue;
            }
            if (candidate.nodeType === 3) {
                if (!isZeroWidthText(candidate.textContent)) return null;
                candidate = sibling(candidate);
                continue;
            }
            if (candidate.nodeType !== 1) return null;
            if (candidate.matches(FORMULA_SELECTOR)) return candidate;
            if (isBoundary(candidate) || /^(?:BR|IMG|INPUT|HR)$/.test(candidate.tagName) ||
                candidate.getAttribute('contenteditable') === 'false') return null;
            if (candidate.firstChild) {
                container = candidate;
                candidate = backward ? candidate.lastChild : candidate.firstChild;
            } else {
                candidate = sibling(candidate);
            }
        }
        return null;
    }

    /** The formula that is the whole of a selection, if any. */
    getSelectedFormula(range) {
        if (!range || range.collapsed || !this.editor.contains(range.startContainer) ||
            !this.editor.contains(range.endContainer)) return null;
        const startFormula = this.getFormula(range.startContainer);
        if (startFormula && startFormula === this.getFormula(range.endContainer)) return startFormula;
        if (range.startContainer === range.endContainer && range.startContainer.nodeType === 1) {
            const selected = Array.from(range.startContainer.childNodes).slice(range.startOffset, range.endOffset)
                .filter(node => node.nodeType !== 3 || !isZeroWidthText(node.textContent));
            if (selected.length === 1 && selected[0].nodeType === 1 && selected[0].matches(FORMULA_SELECTOR)) {
                return selected[0];
            }
        }
        // Chromium can express that selection with the end of the preceding
        // text and the start of the following text.
        const start = { startContainer: range.startContainer, startOffset: range.startOffset, collapsed: true };
        const end = { startContainer: range.endContainer, startOffset: range.endOffset, collapsed: true };
        const formula = this.getAdjacentFormula(start, 'forward');
        return formula && this.getAdjacentFormula(end, 'backward') === formula ? formula : null;
    }

    /** Stop on the whole formula before moving to the text on either side. */
    moveAcrossFormula(selection, direction) {
        if (!selection?.rangeCount) return false;
        const range = selection.getRangeAt(0);
        if (!this.editor.contains(range.startContainer)) return false;
        const formula = range.collapsed
            ? this.getFormula(range.startContainer) || this.getAdjacentFormula(range, direction)
            : this.getSelectedFormula(range);
        if (!formula) return false;
        const caret = this.document.createRange();
        if (range.collapsed) caret.selectNode(formula);
        else this.setCaretAtFormulaEdge(caret, formula, direction === 'backward');
        selection.removeAllRanges();
        selection.addRange(caret);
        this.syncSelection();
        return true;
    }

    /** Native caret probes can land in a formula's hidden text: move it beside. */
    normalizeCaret() {
        const range = this.getRange();
        if (!range?.collapsed || !this.editor.contains(range.startContainer)) return false;
        const formula = this.getFormula(range.startContainer);
        if (!formula) return false;
        this.placeCaretBeside(formula, range.startOffset === 0);
        return true;
    }

    removeFormula(formula) {
        const block = formula.parentElement;
        this.stateManager.saveState();
        const caret = this.document.createRange();
        this.setCaretAtFormulaEdge(caret, formula, true);
        formula.remove();
        if (block && block !== this.editor && this.editor.contains(block) &&
            block.textContent.replace(/[​⁠﻿]/g, '') === '' && !block.firstElementChild) {
            block.appendChild(this.document.createElement('br'));
            caret.setStart(block, 0);
            caret.collapse(true);
        }
        const selection = this.window.getSelection();
        selection.removeAllRanges();
        selection.addRange(caret);
        this.stateManager.commitStateAfterChange();
        this.onChange();
        return true;
    }

    handleKeydown(event, isMac = false) {
        if (event.defaultPrevented || event.isComposing || event.keyCode === 229 ||
            event.metaKey || event.altKey) return false;
        const key = event.key?.toLowerCase();
        const selection = this.window.getSelection();
        const range = this.getRange();
        const verticalDirection = !event.shiftKey && (
            (!event.ctrlKey && event.key === 'ArrowUp') || (isMac && event.ctrlKey && key === 'p')
        ) ? 'up' : !event.shiftKey && (
            (!event.ctrlKey && event.key === 'ArrowDown') || (isMac && event.ctrlKey && key === 'n')
        ) ? 'down' : null;
        if (verticalDirection && this.moveVertically?.(selection, verticalDirection)) {
            event.preventDefault();
            event.stopPropagation();
            return true;
        }
        const direction = !event.shiftKey && (
            (!event.ctrlKey && event.key === 'ArrowLeft') || (isMac && event.ctrlKey && key === 'b')
        ) ? 'backward' : !event.shiftKey && (
            (!event.ctrlKey && event.key === 'ArrowRight') || (isMac && event.ctrlKey && key === 'f')
        ) ? 'forward' : null;
        if (direction) {
            if (!this.moveAcrossFormula(selection, direction)) return false;
            event.preventDefault();
            event.stopPropagation();
            return true;
        }
        if (event.key === 'Enter' && !event.shiftKey && !event.ctrlKey) {
            const formula = this.getSelectedFormula(range);
            if (!formula || !this.edit(formula)) return false;
            event.preventDefault();
            event.stopPropagation();
            return true;
        }
        const ctrlH = isMac && event.ctrlKey && !event.shiftKey && key === 'h';
        if (event.ctrlKey && !ctrlH) return false;
        const deleteDirection = event.key === 'Backspace' || ctrlH ? 'backward'
            : event.key === 'Delete' ? 'forward' : null;
        if (!deleteDirection) return false;
        const formula = this.getSelectedFormula(range) || this.getAdjacentFormula(range, deleteDirection);
        if (!formula) return false;
        event.preventDefault();
        event.stopPropagation();
        return this.removeFormula(formula);
    }

    // ---- Clipboard -------------------------------------------------------

    /**
     * Pasted HTML is sanitized, which removes the attributes that make a span
     * a formula. A formula is only TeX text, so keep it as a placeholder and
     * restore it afterwards, wherever the HTML came from.
     */
    prepareClipboardImport(html) {
        const template = this.document.createElement('template');
        template.innerHTML = html;
        const prefix = `mdw-clipboard-math-${Math.random().toString(36).slice(2)}-`;
        const formulas = [];
        Array.from(template.content.querySelectorAll(FORMULA_SELECTOR)).forEach(node => {
            const placeholder = this.document.createElement('span');
            placeholder.id = `${prefix}${formulas.length}`;
            formulas.push({
                id: placeholder.id,
                tex: node.textContent || '',
                mode: node.getAttribute('data-mdw-math'),
            });
            node.replaceWith(placeholder);
        });
        const blocks = [];
        template.content.querySelectorAll('pre > code[data-mdw-math-delimiter="$$"]').forEach(code => {
            code.id = `${prefix}block-${blocks.length}`;
            blocks.push(code.id);
        });
        if (formulas.length === 0 && blocks.length === 0) return { html, formulas, blocks };
        return { html: template.innerHTML, formulas, blocks };
    }

    restoreClipboardImport(container, prepared) {
        const find = id => Array.from(container.querySelectorAll('[id]')).find(node => node.id === id);
        for (const { id, tex, mode } of prepared.formulas) {
            find(id)?.replaceWith(this.createFormula(tex, mode));
        }
        for (const id of prepared.blocks) {
            const code = find(id);
            if (!code) continue;
            code.removeAttribute('id');
            if (code.parentElement?.tagName === 'PRE') code.setAttribute('data-mdw-math-delimiter', '$$');
        }
    }
}
