// @ts-nocheck
/** Editable footnotes, with numbering derived from reference order. */
export class FootnoteManager {
    constructor(editor, stateManager, { onChange = () => {} } = {}) {
        this.editor = editor;
        this.stateManager = stateManager;
        this.onChange = onChange;
        this.lastReferences = new Map();
        this.referencesBeforeDelete = null;
    }

    decodeLabel(key) {
        try {
            const label = decodeURIComponent(key || '');
            return /^[^\[\]\s\\]+$/.test(label) ? label : null;
        } catch {
            return null;
        }
    }

    getRange() {
        const selection = this.editor.ownerDocument.defaultView.getSelection();
        return selection && selection.rangeCount ? selection.getRangeAt(0) : null;
    }

    canInsert(range = this.getRange()) {
        if (!range || !this.editor.contains(range.startContainer) || !this.editor.contains(range.endContainer)) return false;
        return [range.startContainer, range.endContainer].every(node => {
            const element = node.nodeType === 1 ? node : node.parentElement;
            return !element.closest('pre, code, a, [contenteditable="false"], [data-mdw-footnote-definition]');
        });
    }

    appendClipboardDefinitions(wrapper) {
        const included = new Set(Array.from(wrapper.querySelectorAll('div[data-mdw-footnote-definition]'))
            .map(node => node.getAttribute('data-mdw-footnote-definition')));
        const references = Array.from(wrapper.querySelectorAll('sup[data-mdw-footnote-ref]'));
        const definitions = new Map(Array.from(this.editor.querySelectorAll('div[data-mdw-footnote-definition]'))
            .map(node => [node.getAttribute('data-mdw-footnote-definition'), node]));
        const attachments = this.editor.ownerDocument.createElement('div');
        attachments.setAttribute('data-mdw-clipboard-footnotes', 'true');
        for (const reference of references) {
            const key = reference.getAttribute('data-mdw-footnote-ref');
            const definition = definitions.get(key);
            if (included.has(key) || !definition) continue;
            const clone = definition.cloneNode(true);
            clone.querySelectorAll('[data-exclude-from-markdown="true"]').forEach(node => node.remove());
            attachments.appendChild(clone);
            included.add(key);
            clone.querySelectorAll('div[data-mdw-footnote-definition]').forEach(node => included.add(node.getAttribute('data-mdw-footnote-definition')));
            clone.querySelectorAll('sup[data-mdw-footnote-ref]').forEach(node => references.push(node));
        }
        if (attachments.firstChild) wrapper.appendChild(attachments);
    }

    prepareClipboardImport(html) {
        const document = this.editor.ownerDocument;
        const template = document.createElement('template');
        template.innerHTML = html;
        const references = [];
        const definitions = [];
        const prefix = `mdw-clipboard-footnote-${Math.random().toString(36).slice(2)}-`;
        const canonicalKey = value => {
            const label = this.decodeLabel(value);
            try { return label ? encodeURIComponent(label) : null; }
            catch { return null; }
        };
        let index = 0;
        for (const reference of Array.from(template.content.querySelectorAll('sup[data-mdw-footnote-ref]'))) {
            const key = canonicalKey(reference.getAttribute('data-mdw-footnote-ref'));
            if (!key) continue;
            const marker = prefix + index++;
            const placeholder = document.createElement('span');
            placeholder.id = marker;
            reference.replaceWith(placeholder);
            references.push({ key, marker });
        }
        // Move note bodies out of the selection before sanitizing. Descendants
        // come first so nested definitions become separate notes, not UI text.
        const bodies = [];
        for (const definition of Array.from(template.content.querySelectorAll('div[data-mdw-footnote-definition]')).reverse()) {
            const key = canonicalKey(definition.getAttribute('data-mdw-footnote-definition'));
            const content = Array.from(definition.children).find(node => node.classList.contains('mdw-footnote-content'));
            if (!key || !content) continue;
            const marker = prefix + index++;
            const body = document.createElement('div');
            body.id = marker;
            while (content.firstChild) body.appendChild(content.firstChild);
            definition.remove();
            bodies.push(body);
            definitions.push({ key, marker });
        }
        template.content.querySelectorAll('[data-mdw-clipboard-footnotes]').forEach(node => node.remove());
        bodies.reverse().forEach(body => template.content.appendChild(body));
        return { html: template.innerHTML, references, definitions: definitions.reverse() };
    }

    restoreClipboardImport(container, prepared, reuseExisting = false) {
        const document = this.editor.ownerDocument;
        const placeholders = new Map(Array.from(container.querySelectorAll('[id]')).map(node => [node.id, node]));
        const existing = new Map(Array.from(this.editor.querySelectorAll('div[data-mdw-footnote-definition]'))
            .map(node => [node.getAttribute('data-mdw-footnote-definition'), node]));
        const occupied = new Set(Array.from(this.editor.querySelectorAll('[data-mdw-footnote-ref], [data-mdw-footnote-definition]'))
            .map(node => node.getAttribute('data-mdw-footnote-ref') || node.getAttribute('data-mdw-footnote-definition')));
        const mapping = new Map();
        const referenced = new Set(prepared.references.map(reference => reference.key));
        let nextLabel = 1;
        for (const { key } of prepared.references.concat(prepared.definitions)) {
            if (mapping.has(key)) continue;
            let target = key;
            // Untrusted/cross-editor HTML cannot bind to or overwrite an
            // existing note. Only an exact local clipboard match may reuse it.
            if (!(reuseExisting && referenced.has(key)) && occupied.has(target)) {
                while (occupied.has(String(nextLabel))) nextLabel++;
                target = String(nextLabel++);
            }
            mapping.set(key, target);
            occupied.add(target);
        }
        const imports = [];
        const imported = new Set();
        for (const { key, marker } of prepared.definitions) {
            const body = placeholders.get(marker);
            if (!body) continue;
            body.remove();
            const target = mapping.get(key);
            if ((reuseExisting && referenced.has(key) && existing.has(target)) || imported.has(target)) continue;
            const definition = document.createElement('div');
            definition.className = 'mdw-footnote-definition';
            definition.setAttribute('data-mdw-footnote-definition', target);
            const content = document.createElement('div');
            content.className = 'mdw-footnote-content';
            while (body.firstChild) content.appendChild(body.firstChild);
            if (!content.firstChild) {
                const paragraph = document.createElement('p');
                paragraph.appendChild(document.createElement('br'));
                content.appendChild(paragraph);
            }
            definition.appendChild(content);
            imports.push(definition);
            imported.add(target);
        }
        for (const { key, marker } of prepared.references) {
            const placeholder = placeholders.get(marker);
            if (!placeholder) continue;
            const reference = document.createElement('sup');
            reference.className = 'mdw-footnote-ref';
            reference.setAttribute('data-mdw-footnote-ref', mapping.get(key));
            reference.setAttribute('contenteditable', 'false');
            const link = document.createElement('a');
            link.textContent = '1';
            reference.appendChild(link);
            placeholder.replaceWith(reference);
        }
        return imports;
    }

    setup() {
        const getControl = event => event.target.closest?.('[data-mdw-footnote-ref], [data-mdw-footnote-backref], [data-mdw-footnote-delete]');
        this.editor.addEventListener('mousedown', event => {
            if (!getControl(event)) return;
            event.preventDefault();
            event.stopImmediatePropagation();
        }, true);
        this.editor.addEventListener('click', event => {
            const control = getControl(event);
            if (!control) return;
            event.preventDefault();
            event.stopImmediatePropagation();
            if (control.hasAttribute('data-mdw-footnote-delete')) this.remove(control.getAttribute('data-mdw-footnote-delete'));
            else if (control.hasAttribute('data-mdw-footnote-ref')) this.goToDefinition(control);
            else this.goToReference(control.getAttribute('data-mdw-footnote-backref'));
        }, true);
        this.refresh();
    }

    refresh() {
        const numbers = new Map();
        const counts = new Map();
        const references = Array.from(this.editor.querySelectorAll('sup[data-mdw-footnote-ref]'));
        const definitions = Array.from(this.editor.querySelectorAll('div[data-mdw-footnote-definition]'));
        const defined = new Set(definitions.map(node => node.getAttribute('data-mdw-footnote-definition')));
        const ordered = references.filter(node => !node.closest('[data-mdw-footnote-definition]'))
            .concat(references.filter(node => node.closest('[data-mdw-footnote-definition]')));
        const setAttribute = (node, name, value) => {
            if (node.getAttribute(name) !== value) node.setAttribute(name, value);
        };
        for (const reference of ordered) {
            const key = reference.getAttribute('data-mdw-footnote-ref');
            const label = this.decodeLabel(key);
            if (!label) continue;
            if (!numbers.has(key)) numbers.set(key, numbers.size + 1);
            const count = (counts.get(key) || 0) + 1;
            counts.set(key, count);
            setAttribute(reference, 'id', `mdw-fnref-${key}-${count}`);
            const link = reference.querySelector('a');
            if (link) {
                const number = String(numbers.get(key));
                if (link.textContent !== number) link.textContent = number;
                setAttribute(link, 'href', `#mdw-fn-${key}`);
                setAttribute(link, 'title', defined.has(key) ? `Footnote ${label}` : `Missing footnote: ${label}`);
            }
            reference.classList.toggle('mdw-footnote-missing', !defined.has(key));
        }
        for (const definition of definitions) {
            const key = definition.getAttribute('data-mdw-footnote-definition');
            const label = this.decodeLabel(key);
            if (!label) continue;
            setAttribute(definition, 'id', `mdw-fn-${key}`);
            let content = Array.from(definition.children).find(node => node.classList.contains('mdw-footnote-content'));
            if (!content) {
                // Native selection deletion can discard an empty editing wrapper.
                content = this.editor.ownerDocument.createElement('div');
                content.className = 'mdw-footnote-content';
                const paragraph = this.editor.ownerDocument.createElement('p');
                paragraph.appendChild(this.editor.ownerDocument.createElement('br'));
                content.appendChild(paragraph);
                definition.insertBefore(content, definition.querySelector('[data-mdw-footnote-delete]'));
            }
            const paragraph = content.firstElementChild;
            if (paragraph?.tagName === 'P' && paragraph.textContent.replace(/[\u200B\u2060\uFEFF]/g, '') === '' && !paragraph.firstElementChild) {
                paragraph.appendChild(this.editor.ownerDocument.createElement('br'));
            }
            const range = this.getRange();
            if (range?.collapsed && range.startContainer === definition &&
                content.textContent.replace(/[\u200B\u2060\uFEFF\r\n]/g, '') === '' &&
                !content.querySelector('img, input, pre, code, ul, ol, table, hr, [data-mdw-footnote-ref], [data-mdw-opaque-source]')) {
                // Chromium can leave a caret outside the body after selecting
                // and deleting all its text. Keep subsequent edits inside it.
                this.placeCaret(content, true);
            }
            let backref = definition.querySelector('[data-mdw-footnote-backref]');
            if (!backref) {
                backref = this.editor.ownerDocument.createElement('a');
                backref.className = 'mdw-footnote-backref';
                backref.setAttribute('data-mdw-footnote-backref', key);
                backref.setAttribute('data-exclude-from-markdown', 'true');
                backref.setAttribute('contenteditable', 'false');
                definition.insertBefore(backref, definition.firstChild);
            }
            const text = `${numbers.get(key) || `[${label}]`} ↩`;
            if (backref.textContent !== text) backref.textContent = text;
            setAttribute(backref, 'href', `#mdw-fnref-${key}-1`);
            setAttribute(backref, 'title', 'Back to reference');
            if (!definition.querySelector('[data-mdw-footnote-delete]')) {
                const remove = this.editor.ownerDocument.createElement('a');
                remove.className = 'mdw-footnote-delete';
                remove.setAttribute('data-mdw-footnote-delete', key);
                remove.setAttribute('data-exclude-from-markdown', 'true');
                remove.setAttribute('contenteditable', 'false');
                remove.setAttribute('href', `#mdw-fn-${key}`);
                remove.setAttribute('title', 'Delete footnote and its references');
                remove.setAttribute('aria-label', `Delete footnote ${label}`);
                remove.textContent = '×';
                definition.appendChild(remove);
            }
        }
        this.sortDefinitions(definitions, numbers);
    }

    sortDefinitions(definitions, numbers) {
        const groups = new Map();
        for (const definition of definitions) {
            const parent = definition.parentNode;
            if (!groups.has(parent)) groups.set(parent, []);
            groups.get(parent).push(definition);
        }
        const selection = this.editor.ownerDocument.defaultView.getSelection();
        const range = this.getRange();
        const savedRange = range && this.editor.contains(range.startContainer) && this.editor.contains(range.endContainer)
            ? { start: range.startContainer, startOffset: range.startOffset, end: range.endContainer, endOffset: range.endOffset,
                anchor: selection.anchorNode, anchorOffset: selection.anchorOffset,
                focus: selection.focusNode, focusOffset: selection.focusOffset }
            : null;
        let changed = false;
        for (const [parent, siblings] of groups) {
            const sorted = siblings.slice().sort((a, b) =>
                (numbers.get(a.getAttribute('data-mdw-footnote-definition')) ?? Infinity) -
                (numbers.get(b.getAttribute('data-mdw-footnote-definition')) ?? Infinity));
            if (siblings.every((node, index) => node === sorted[index])) continue;
            // Keep non-footnote blocks in their existing positions.
            const slots = siblings.map(node => {
                const slot = this.editor.ownerDocument.createComment('footnote-slot');
                parent.replaceChild(slot, node);
                return slot;
            });
            slots.forEach((slot, index) => parent.replaceChild(sorted[index], slot));
            changed = true;
        }
        if (changed && savedRange) {
            // Moving a contenteditable node resets native range boundaries.
            // Restore them on the same text nodes, including backward selections.
            if (savedRange.anchor && savedRange.focus && selection.setBaseAndExtent) {
                selection.setBaseAndExtent(savedRange.anchor, savedRange.anchorOffset, savedRange.focus, savedRange.focusOffset);
            } else {
                const restored = this.editor.ownerDocument.createRange();
                restored.setStart(savedRange.start, savedRange.startOffset);
                restored.setEnd(savedRange.end, savedRange.endOffset);
                selection.removeAllRanges();
                selection.addRange(restored);
            }
        }
    }

    insert() {
        const range = this.getRange();
        if (!this.canInsert(range)) return false;
        const document = this.editor.ownerDocument;
        const keys = new Set(Array.from(this.editor.querySelectorAll('[data-mdw-footnote-ref], [data-mdw-footnote-definition]'))
            .map(node => node.getAttribute('data-mdw-footnote-ref') || node.getAttribute('data-mdw-footnote-definition')));
        let label = 1;
        while (keys.has(String(label))) label++;
        const key = String(label);
        this.stateManager.saveState();
        // Annotate selected text by inserting immediately after it.
        const insertionRange = range.cloneRange();
        insertionRange.collapse(false);
        const reference = document.createElement('sup');
        reference.className = 'mdw-footnote-ref';
        reference.setAttribute('data-mdw-footnote-ref', key);
        reference.setAttribute('contenteditable', 'false');
        reference.appendChild(document.createElement('a'));
        insertionRange.insertNode(reference);

        const definition = document.createElement('div');
        definition.className = 'mdw-footnote-definition';
        definition.setAttribute('data-mdw-footnote-definition', key);
        const content = document.createElement('div');
        content.className = 'mdw-footnote-content';
        const paragraph = document.createElement('p');
        paragraph.appendChild(document.createElement('br'));
        content.appendChild(paragraph);
        definition.appendChild(content);
        this.editor.appendChild(definition);
        this.refresh();
        this.placeCaret(content, true);
        this.stateManager.commitStateAfterChange();
        this.onChange();
        return true;
    }

    placeCaret(node, atStart) {
        const document = this.editor.ownerDocument;
        const selection = document.defaultView.getSelection();
        if (!selection) return;
        const range = document.createRange();
        this.editor.focus({ preventScroll: true });
        if (atStart) {
            this.setCaretAtContentEdge(range, node, true);
        } else {
            range.setStartAfter(node);
            range.collapse(true);
        }
        selection.removeAllRanges();
        selection.addRange(range);
        this.revealCaretTarget(atStart ? node.firstElementChild || node : node, range);
    }

    setCaretAtContentEdge(range, content, atStart) {
        let target = content;
        while (target.nodeType === 1) {
            const children = Array.from(target.childNodes).filter(child => {
                if (child.nodeType === 1) return child.getAttribute('contenteditable') !== 'false' &&
                    child.getAttribute('data-exclude-from-markdown') !== 'true';
                if (child.nodeType !== 3) return false;
                if (!child.textContent) return false;
                // HTML indentation between blocks is not an editing position.
                return !/^(DIV|UL|OL|BLOCKQUOTE)$/.test(target.tagName) || !/^\s*$/.test(child.textContent);
            });
            const child = atStart ? children[0] : children[children.length - 1];
            if (!child || /^(BR|IMG|HR|INPUT)$/.test(child.tagName || '')) break;
            target = child;
        }
        range.setStart(target, atStart ? 0 : target.nodeType === 3 ? target.textContent.length : target.childNodes.length);
        range.collapse(true);
    }

    setCaretAtReferenceEdge(range, reference, atStart) {
        const sibling = atStart ? reference.previousSibling : reference.nextSibling;
        if (sibling?.nodeType === 3 && sibling.textContent.length > 0) {
            range.setStart(sibling, atStart ? sibling.textContent.length : 0);
        } else if (atStart) {
            range.setStartBefore(reference);
        } else {
            range.setStartAfter(reference);
        }
        range.collapse(true);
    }

    moveAcrossReference(selection, direction) {
        if (!selection?.rangeCount) return false;
        const range = selection.getRangeAt(0);
        if (!this.editor.contains(range.startContainer)) return false;
        const element = range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement;
        const reference = range.collapsed
            ? element.closest('sup[data-mdw-footnote-ref]') || this.getAdjacentReference(range, direction)
            : this.getSelectedReference(range);
        if (!reference) return false;
        const caret = this.editor.ownerDocument.createRange();
        this.setCaretAtReferenceEdge(caret, reference, direction === 'backward');
        selection.removeAllRanges();
        selection.addRange(caret);
        return true;
    }

    normalizeCaret() {
        const range = this.getRange();
        if (!range?.collapsed || !this.editor.contains(range.startContainer)) return false;
        const node = range.startContainer;
        const element = node.nodeType === 1 ? node : node.parentElement;
        const reference = element.closest('sup[data-mdw-footnote-ref]');
        if (reference) {
            // Native caret probes can land inside the read-only number. Keep
            // that position beside the reference instead of at the editor end.
            const selection = this.editor.ownerDocument.defaultView.getSelection();
            const corrected = this.editor.ownerDocument.createRange();
            this.setCaretAtReferenceEdge(corrected, reference, range.startOffset === 0);
            selection.removeAllRanges();
            selection.addRange(corrected);
            return true;
        }
        const definition = element.closest('[data-mdw-footnote-definition]');
        if (!definition) return false;
        const content = definition.querySelector('.mdw-footnote-content');
        if (!content) return false;
        const control = element.closest('[contenteditable="false"], [data-exclude-from-markdown="true"]');
        const layoutBoundary = /^(DIV|UL|OL|BLOCKQUOTE)$/.test(element.tagName) &&
            (node.nodeType === 1 || /^\s*$/.test(node.textContent));
        if (content.contains(node) && !control && !layoutBoundary) return false;

        // Generic block navigation can land in the number/delete controls or
        // flex/list wrappers. Chromium cannot paint an editable caret there.
        let atStart = !element.closest('[data-mdw-footnote-delete]');
        let target = content;
        if (content.contains(node) && !control) {
            target = element;
            const children = Array.from(element.childNodes);
            const next = node.nodeType === 1 ? children[range.startOffset] : node;
            if (next && (next.nodeType === 1 || (next.nodeType === 3 && !/^\s*$/.test(next.textContent)))) {
                target = next;
            } else {
                atStart = range.startOffset < children.length;
            }
        } else if (node === definition) {
            atStart = range.startOffset <= Array.from(definition.childNodes).indexOf(content);
        }
        const corrected = this.editor.ownerDocument.createRange();
        this.setCaretAtContentEdge(corrected, target, atStart);
        if (corrected.startContainer === node && corrected.startOffset === range.startOffset) return false;
        const selection = this.editor.ownerDocument.defaultView.getSelection();
        selection.removeAllRanges();
        selection.addRange(corrected);
        const caretElement = corrected.startContainer.nodeType === 1 ? corrected.startContainer : corrected.startContainer.parentElement;
        this.revealCaretTarget(caretElement, corrected);
        return true;
    }

    revealCaretTarget(node, range = null) {
        if (!node.getBoundingClientRect || !this.editor.getBoundingClientRect || this.editor.clientHeight <= 0) return;
        const editorRect = this.editor.getBoundingClientRect();
        const caretRect = Array.from(range?.getClientRects?.() || []).find(rect => rect.height > 0);
        const targetRect = caretRect || node.getBoundingClientRect();
        const style = this.editor.ownerDocument.defaultView.getComputedStyle(this.editor);
        const topInset = Math.max(16, parseFloat(style.paddingTop) || 0);
        const maxScrollTop = Math.max(0, this.editor.scrollHeight - this.editor.clientHeight);
        const top = Math.max(0, Math.min(maxScrollTop,
            this.editor.scrollTop + targetRect.top - editorRect.top - topInset));
        // Scroll the editor alone. Native scrollIntoView can move its ancestors,
        // and a smooth scroll can be interrupted by caret visibility updates.
        this.editor.scrollTo({ top, behavior: 'instant' });
    }

    goToDefinition(reference) {
        const key = reference.getAttribute('data-mdw-footnote-ref');
        const definition = Array.from(this.editor.querySelectorAll('[data-mdw-footnote-definition]'))
            .find(node => node.getAttribute('data-mdw-footnote-definition') === key);
        const content = definition?.querySelector('.mdw-footnote-content');
        if (!content) return false;
        this.lastReferences.set(key, reference);
        this.placeCaret(content, true);
        return true;
    }

    goToReference(key) {
        let reference = this.lastReferences.get(key);
        if (!reference || !this.editor.contains(reference)) {
            reference = Array.from(this.editor.querySelectorAll('[data-mdw-footnote-ref]'))
                .find(node => node.getAttribute('data-mdw-footnote-ref') === key);
        }
        if (!reference) return false;
        this.placeCaret(reference, false);
        return true;
    }

    getAdjacentReference(range, direction) {
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
            if (!/^[\u200B\u2060\uFEFF]*$/.test(remaining)) return null;
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
                if (!/^[\u200B\u2060\uFEFF]*$/.test(candidate.textContent)) return null;
                candidate = sibling(candidate);
                continue;
            }
            if (candidate.nodeType !== 1) return null;
            if (candidate.matches('sup[data-mdw-footnote-ref]')) return candidate;
            if (isBoundary(candidate) || /^(?:BR|IMG|INPUT|HR)$/.test(candidate.tagName) ||
                candidate.getAttribute('contenteditable') === 'false') return null;
            if (candidate.firstChild) {
                container = candidate;
                candidate = backward ? candidate.lastChild : candidate.firstChild;
            } else candidate = sibling(candidate);
        }
        return null;
    }

    getSelectedReference(range) {
        if (!range || range.collapsed || !this.editor.contains(range.startContainer) ||
            !this.editor.contains(range.endContainer)) return null;
        const elementFor = node => node.nodeType === 1 ? node : node.parentElement;
        const startReference = elementFor(range.startContainer).closest('sup[data-mdw-footnote-ref]');
        const endReference = elementFor(range.endContainer).closest('sup[data-mdw-footnote-ref]');
        if (startReference && startReference === endReference) return startReference;
        if (range.startContainer === range.endContainer && range.startContainer.nodeType === 1) {
            const selected = Array.from(range.startContainer.childNodes).slice(range.startOffset, range.endOffset)
                .filter(node => node.nodeType !== 3 || !/^[\u200B\u2060\uFEFF]*$/.test(node.textContent));
            if (selected.length === 1 && selected[0].nodeType === 1 &&
                selected[0].matches('sup[data-mdw-footnote-ref]')) return selected[0];
        }
        // Chromium can express a selection of just the number using the end
        // of the preceding text and the start of the following text.
        const start = { startContainer: range.startContainer, startOffset: range.startOffset, collapsed: true };
        const end = { startContainer: range.endContainer, startOffset: range.endOffset, collapsed: true };
        const reference = this.getAdjacentReference(start, 'forward');
        if (reference && this.getAdjacentReference(end, 'backward') === reference) return reference;
        return null;
    }

    deleteReferenceAtCaret(direction) {
        const range = this.getRange();
        const reference = this.getSelectedReference(range) || this.getAdjacentReference(range, direction);
        if (!reference) return false;
        const key = reference.getAttribute('data-mdw-footnote-ref');
        if (!this.decodeLabel(key)) return false;
        const document = this.editor.ownerDocument;
        const selection = document.defaultView.getSelection();
        const caret = document.createRange();
        const block = reference.closest('p, div, li, h1, h2, h3, h4, h5, h6, td, th');
        let inlineParent = reference.parentElement;
        this.stateManager.saveState();
        caret.setStartBefore(reference);
        caret.collapse(true);
        reference.remove();
        while (inlineParent && inlineParent !== block &&
            /^(?:A|SPAN|STRONG|B|EM|I|S|DEL|STRIKE|SUP|SUB|MARK)$/.test(inlineParent.tagName) &&
            /^[\u200B\u2060\uFEFF]*$/.test(inlineParent.textContent) &&
            !inlineParent.querySelector('img, br, code, input, [contenteditable="false"]')) {
            const parent = inlineParent.parentElement;
            caret.setStartBefore(inlineParent);
            inlineParent.remove();
            inlineParent = parent;
        }
        this.removeUnusedDefinitions(new Set([key]));
        if (block && block !== this.editor && this.editor.contains(block) &&
            block.textContent.replace(/[\u200B\u2060\uFEFF]/g, '') === '' &&
            !block.querySelector('img, input, pre, code, ul, ol, table, hr, [data-mdw-footnote-ref], [data-mdw-opaque-source]')) {
            while (block.firstChild) block.removeChild(block.firstChild);
            block.appendChild(document.createElement('br'));
            caret.selectNodeContents(block);
            caret.collapse(true);
        }
        if (!this.editor.contains(caret.startContainer)) {
            caret.selectNodeContents(this.editor);
            caret.collapse(true);
        }
        selection.removeAllRanges();
        selection.addRange(caret);
        this.refresh();
        this.stateManager.commitStateAfterChange();
        this.cancelPendingDelete();
        this.onChange();
        return true;
    }

    handleKeydown(event, isMac = false) {
        if (event.defaultPrevented || event.isComposing || event.keyCode === 229 ||
            event.metaKey || event.altKey) return false;
        const key = event.key?.toLowerCase();
        const horizontalDirection = !event.shiftKey && (
            (!event.ctrlKey && event.key === 'ArrowLeft') || (isMac && event.ctrlKey && key === 'b')
        ) ? 'backward' : !event.shiftKey && (
            (!event.ctrlKey && event.key === 'ArrowRight') || (isMac && event.ctrlKey && key === 'f')
        ) ? 'forward' : null;
        if (horizontalDirection && this.moveAcrossReference(this.editor.ownerDocument.defaultView.getSelection(), horizontalDirection)) {
            event.preventDefault();
            event.stopPropagation();
            return true;
        }
        const ctrlH = isMac && event.ctrlKey && !event.shiftKey && event.key?.toLowerCase() === 'h';
        if (event.ctrlKey && !ctrlH) return false;
        const direction = event.key === 'Backspace' || ctrlH ? 'backward' : event.key === 'Delete' ? 'forward' : null;
        if (!direction) return false;
        if (this.preventFootnoteBoundaryDeletion(event, direction, true)) return true;
        this.captureReferencesBeforeDelete();
        if (!this.deleteReferenceAtCaret(direction)) return false;
        event.preventDefault();
        event.stopPropagation();
        return true;
    }

    handleBeforeInput(event) {
        if (event.defaultPrevented || event.isComposing) return false;
        const boundaryDirection = event.inputType?.endsWith('Backward') ? 'backward'
            : event.inputType?.endsWith('Forward') ? 'forward' : null;
        if (event.cancelable !== false && boundaryDirection && this.preventFootnoteBoundaryDeletion(event, boundaryDirection)) return true;
        if (typeof event.inputType === 'string' && event.inputType.startsWith('delete')) {
            this.captureReferencesBeforeDelete();
        }
        if (event.cancelable === false) return false;
        const direction = event.inputType === 'deleteContentBackward' ? 'backward'
            : event.inputType === 'deleteContentForward' ? 'forward' : null;
        if (!direction || !this.deleteReferenceAtCaret(direction)) return false;
        event.preventDefault();
        event.stopPropagation();
        return true;
    }

    preventFootnoteBoundaryDeletion(event, direction, allowBlockConversion = false) {
        const range = this.getRange();
        if (!range?.collapsed || !this.editor.contains(range.startContainer)) return false;
        let node = range.startContainer;
        const element = node.nodeType === 1 ? node : node.parentElement;
        const content = element.closest('.mdw-footnote-content');
        if (!content || !content.closest('[data-mdw-footnote-definition]')) return false;
        const backward = direction === 'backward';
        const meaningful = child => {
            if (child.nodeType === 3) {
                const pattern = child.parentNode === content ? /^[\s\u200B\u2060\uFEFF]*$/ : /^[\u200B\u2060\uFEFF]*$/;
                return !pattern.test(child.textContent);
            }
            const placeholderBreak = child.tagName === 'BR' && Array.from(child.parentNode.childNodes).every(node =>
                node === child || (node.nodeType === 3 && /^[\u200B\u2060\uFEFF]*$/.test(node.textContent)));
            return child.nodeType === 1 && !placeholderBreak;
        };
        if (node.nodeType === 3) {
            const text = backward ? node.textContent.slice(0, range.startOffset) : node.textContent.slice(range.startOffset);
            if (!/^[\u200B\u2060\uFEFF]*$/.test(text)) return false;
        } else {
            const children = Array.from(node.childNodes);
            if ((backward ? children.slice(0, range.startOffset) : children.slice(range.startOffset)).some(meaningful)) return false;
        }
        while (node !== content) {
            let sibling = backward ? node.previousSibling : node.nextSibling;
            while (sibling) {
                if (meaningful(sibling)) return false;
                sibling = backward ? sibling.previousSibling : sibling.nextSibling;
            }
            node = node.parentNode;
        }
        // Backspace/Ctrl+H at the first structured line has an editor
        // handler that converts its block within the same note.
        // Keep the native beforeinput guard when no such handler runs.
        const structuredBlock = element.closest('li, blockquote, pre, h1, h2, h3, h4, h5, h6');
        if (backward && allowBlockConversion && structuredBlock && content.contains(structuredBlock)) return false;
        // Keep the note body separate from its navigation/delete controls.
        event.preventDefault();
        event.stopPropagation();
        this.cancelPendingDelete();
        return true;
    }

    captureReferencesBeforeDelete() {
        this.referencesBeforeDelete = new Set(Array.from(this.editor.querySelectorAll('sup[data-mdw-footnote-ref]'))
            .map(node => node.getAttribute('data-mdw-footnote-ref')));
    }

    cancelPendingDelete() {
        this.referencesBeforeDelete = null;
    }

    removeUnusedDefinitions(keys) {
        const remaining = new Set(Array.from(this.editor.querySelectorAll('sup[data-mdw-footnote-ref]'))
            .map(node => node.getAttribute('data-mdw-footnote-ref')));
        for (const definition of Array.from(this.editor.querySelectorAll('[data-mdw-footnote-definition]'))) {
            const key = definition.getAttribute('data-mdw-footnote-definition');
            if (keys.has(key) && !remaining.has(key)) {
                definition.remove();
                this.lastReferences.delete(key);
            }
        }
    }

    reconcileReferenceDeletion() {
        if (!this.referencesBeforeDelete) return;
        const previous = this.referencesBeforeDelete;
        this.cancelPendingDelete();
        // Only remove notes whose references this edit deleted. Definitions
        // that were already unreferenced when the file loaded are preserved.
        this.removeUnusedDefinitions(previous);
    }

    remove(key) {
        const definitions = Array.from(this.editor.querySelectorAll('[data-mdw-footnote-definition]'))
            .filter(node => node.getAttribute('data-mdw-footnote-definition') === key);
        if (definitions.length === 0) return false;
        const references = Array.from(this.editor.querySelectorAll('sup[data-mdw-footnote-ref]'))
            .filter(node => node.getAttribute('data-mdw-footnote-ref') === key);
        this.stateManager.saveState();
        if (references.length) this.placeCaret(references[0], false);
        else {
            const selection = this.editor.ownerDocument.defaultView.getSelection();
            const range = this.editor.ownerDocument.createRange();
            range.setStartBefore(definitions[0]);
            range.collapse(true);
            this.editor.focus();
            selection.removeAllRanges();
            selection.addRange(range);
        }
        for (const node of references.concat(definitions)) node.remove();
        this.lastReferences.delete(key);
        this.refresh();
        this.stateManager.commitStateAfterChange();
        this.onChange();
        return true;
    }
}
