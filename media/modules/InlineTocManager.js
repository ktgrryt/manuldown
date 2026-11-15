// @ts-nocheck
import { createMarkdownTableOfContents } from './MarkdownHeadingSlug.js';

const TOC_SELECTOR = '[data-mdw-toc="true"]';
const isEmptyText = value => /^[\s\u200b\u2060\ufeff]*$/.test(value || '');

/** A generated, indivisible table of contents inside the editable document. */
export class InlineTocManager {
    constructor(editor, options = {}) {
        this.editor = editor;
        this.beforeChange = options.beforeChange || (() => {});
        this.onChange = options.onChange || (() => {});
        this.onNavigate = options.onNavigate || null;
        this.getCaretRect = options.getCaretRect || (range => range.getBoundingClientRect?.());
        this.isMac = !!options.isMac;
        this.initialized = false;
        this.pointerSelecting = false;
        this.composing = false;
    }

    get document() { return this.editor.ownerDocument; }
    get window() { return this.document.defaultView; }

    getBlock(node) {
        const element = node?.nodeType === 1 ? node : node?.parentElement;
        const block = element?.closest?.(TOC_SELECTOR);
        return block && this.editor.contains(block) ? block : null;
    }

    getItem(node) {
        const element = node?.nodeType === 1 ? node : node?.parentElement;
        const link = element?.closest?.('a[href]');
        return link && this.getBlock(link) ? link : null;
    }

    getFocusedItem() {
        const range = this.getRange();
        if (range && !range.collapsed) return null;
        const focused = this.getItem(this.document.activeElement);
        if (focused) return focused;
        return range?.collapsed ? this.getItem(range.startContainer) : null;
    }

    focusItem(block, index = 0) {
        const items = Array.from(block.querySelectorAll('a[href]'));
        const item = items[Math.max(0, Math.min(index, items.length - 1))];
        if (!item || !this.editor.contains(block)) return false;
        items.forEach(link => link.setAttribute('tabindex', link === item ? '0' : '-1'));
        item.focus?.({ preventScroll: true });
        const selection = this.window.getSelection?.();
        if (selection) {
            const range = this.document.createRange();
            range.selectNodeContents(item);
            range.collapse(true);
            selection.removeAllRanges();
            selection.addRange(range);
        }
        this.syncSelection();
        item.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
        return true;
    }

    activateItem(item) {
        const href = item.getAttribute('href') || '';
        if (this.onNavigate) this.onNavigate(href);
        else {
            let id = href.slice(1);
            try { id = decodeURIComponent(id); } catch (_error) { /* Preserve literal fragments. */ }
            const heading = this.document.getElementById(id);
            if (heading && this.editor.contains(heading)) {
                this.editor.focus?.({ preventScroll: true });
                const range = this.document.createRange();
                range.selectNodeContents(heading);
                range.collapse(true);
                const selection = this.window.getSelection?.();
                selection?.removeAllRanges();
                selection?.addRange(range);
                heading.scrollIntoView?.({ block: 'start' });
            }
        }
        this.syncSelection();
        return true;
    }

    moveItem(item, step) {
        const block = this.getBlock(item);
        const items = Array.from(block.querySelectorAll('a[href]'));
        const index = items.indexOf(item) + step;
        return index < 0 || index >= items.length
            ? this.placeBeside(block, index < 0) : this.focusItem(block, index);
    }

    createBlock() {
        const block = this.document.createElement('div');
        this.prepareBlock(block);
        this.renderBlock(block, this.getHeadings());
        return block;
    }

    prepareBlock(block) {
        const attributes = {
            'data-mdw-toc': 'true', contenteditable: 'false', tabindex: '0',
            role: 'group', 'aria-label': 'Table of contents'
        };
        for (const [name, value] of Object.entries(attributes)) {
            if (block.getAttribute(name) !== value) block.setAttribute(name, value);
        }
        if (!block.classList.contains('mdw-toc-block')) block.classList.add('mdw-toc-block');
    }

    getHeadings() {
        return Array.from(this.editor.querySelectorAll('h1, h2, h3, h4, h5, h6')).filter(heading =>
            !heading.closest(`${TOC_SELECTOR}, [data-mdw-opaque-source], [data-exclude-from-markdown="true"]`));
    }

    renderBlock(block, headings) {
        const activeItem = this.getFocusedItem();
        const activeIndex = activeItem && block.contains(activeItem)
            ? Array.from(block.querySelectorAll('a[href]')).indexOf(activeItem) : -1;
        const activeHref = activeIndex >= 0 ? activeItem.getAttribute('href') : null;
        let contents = createMarkdownTableOfContents(headings, this.document);
        if (!contents) {
            contents = this.document.createElement('p');
            contents.className = 'mdw-toc-empty';
            contents.textContent = 'No headings yet';
        }
        Array.from(contents.querySelectorAll('a[href]')).forEach(item => item.setAttribute('tabindex', '-1'));
        const comparable = block.cloneNode(true);
        Array.from(comparable.querySelectorAll('a[href]')).forEach(item => item.setAttribute('tabindex', '-1'));
        if (comparable.innerHTML === contents.outerHTML) return false;
        // The selection stays on the object's outer boundaries; replacing its
        // derived list does not change the caret or create an undo step.
        block.innerHTML = contents.outerHTML;
        if (activeIndex >= 0) {
            const nextIndex = Array.from(block.querySelectorAll('a[href]'))
                .findIndex(item => item.getAttribute('href') === activeHref);
            if (!this.focusItem(block, nextIndex >= 0 ? nextIndex : activeIndex)) this.select(block);
        }
        return true;
    }

    refresh() {
        const headings = this.getHeadings();
        let changed = false;
        for (const block of Array.from(this.editor.querySelectorAll(TOC_SELECTOR))) {
            if (block.closest('[data-mdw-opaque-source]')) continue;
            this.prepareBlock(block);
            changed = this.renderBlock(block, headings) || changed;
        }
        return changed;
    }

    setup() {
        if (this.initialized) return;
        this.initialized = true;
        this.editor.addEventListener('mousedown', event => {
            if (event.button === 0) this.pointerSelecting = true;
            const block = this.getBlock(event.target);
            if (!block || event.button !== 0 || event.shiftKey) return;
            // The general text-selection handler must not place a caret in the
            // generated list. Links still activate in the delegated click below.
            event.preventDefault();
            event.stopImmediatePropagation();
            const item = this.getItem(event.target);
            if (item) this.focusItem(block, Array.from(block.querySelectorAll('a[href]')).indexOf(item));
            else this.select(block);
        }, true);
        this.editor.addEventListener('click', event => {
            const block = this.getBlock(event.target);
            if (!block) return;
            const link = event.target.closest?.('a[href]');
            event.preventDefault();
            event.stopImmediatePropagation();
            if (event.shiftKey) {
                this.normalizeSelection();
                this.syncSelection();
                return;
            }
            if (link && block.contains(link)) {
                if (event.metaKey || event.ctrlKey) this.activateItem(link);
                else this.focusItem(block, Array.from(block.querySelectorAll('a[href]')).indexOf(link));
            } else this.select(block);
        }, true);
        this.editor.addEventListener('focusin', event => {
            if (event.target.matches?.(TOC_SELECTOR)) {
                if (!this.focusItem(event.target)) this.select(event.target);
            } else {
                const item = this.getItem(event.target);
                const range = this.getRange();
                if (item && (!range?.collapsed || this.getItem(range.startContainer) !== item)) {
                    const block = this.getBlock(item);
                    this.focusItem(block, Array.from(block.querySelectorAll('a[href]')).indexOf(item));
                }
            }
        });
        for (const type of ['paste', 'cut', 'drop']) {
            this.editor.addEventListener(type, event => {
                if (!this.getFocusedItem() && !(type === 'drop' && this.getItem(event.target))) return;
                event.preventDefault();
                event.stopImmediatePropagation();
            }, true);
        }
        this.document.addEventListener('mouseup', () => {
            this.pointerSelecting = false;
            if (!this.composing) this.normalizeSelection();
            this.syncSelection();
        }, true);
        this.editor.addEventListener('compositionstart', () => { this.composing = true; });
        this.editor.addEventListener('compositionend', () => { this.composing = false; });
        this.document.addEventListener('selectionchange', () => {
            // Let native drag selection grow normally, then snap its endpoints
            // to object boundaries on release. Keyboard selection snaps at once.
            if (!this.pointerSelecting && !this.composing) this.normalizeSelection();
            this.syncSelection();
        });
        this.refresh();
    }

    getRange() {
        const selection = this.window.getSelection?.();
        return selection?.rangeCount === 1 ? selection.getRangeAt(0) : null;
    }

    normalizeSelection() {
        const selection = this.window.getSelection?.();
        const range = this.getRange();
        if (!range || !this.editor.contains(range.startContainer) ||
            !this.editor.contains(range.endContainer)) return false;
        // A collapsed range is the navigation cursor, never an editable range.
        if (range.collapsed && this.getItem(range.startContainer)) {
            const item = this.getItem(range.startContainer);
            // Generic browser navigation can land inside a read-only link
            // without focusing it, leaving no visible navigation cursor.
            if (this.document.activeElement === item) return false;
            const block = this.getBlock(item);
            return this.focusItem(block, Array.from(block.querySelectorAll('a[href]')).indexOf(item));
        }
        const startBlock = this.getBlock(range.startContainer);
        const endBlock = this.getBlock(range.endContainer);
        if (!startBlock && !endBlock) return false;
        const backward = !range.collapsed && selection.anchorNode === range.endContainer &&
            selection.anchorOffset === range.endOffset;
        const expanded = range.cloneRange();
        if (startBlock) expanded.setStartBefore(startBlock);
        if (endBlock) expanded.setEndAfter(endBlock);
        // Only expand the endpoint that entered an object: surrounding selected
        // text remains part of the native replacement/delete operation.
        if (typeof selection.setBaseAndExtent === 'function') {
            selection.setBaseAndExtent(
                backward ? expanded.endContainer : expanded.startContainer,
                backward ? expanded.endOffset : expanded.startOffset,
                backward ? expanded.startContainer : expanded.endContainer,
                backward ? expanded.startOffset : expanded.endOffset
            );
        } else {
            selection.removeAllRanges();
            selection.addRange(expanded);
        }
        return true;
    }

    getSelectedBlock(range = this.getRange()) {
        if (!range || range.collapsed || !this.editor.contains(range.startContainer) ||
            !this.editor.contains(range.endContainer)) return null;
        const inside = this.getBlock(range.startContainer);
        if (inside && inside === this.getBlock(range.endContainer)) return inside;
        if (range.startContainer === range.endContainer && range.startContainer.nodeType === 1) {
            const nodes = Array.from(range.startContainer.childNodes).slice(range.startOffset, range.endOffset)
                .filter(node => node.nodeType !== 3 || !isEmptyText(node.textContent));
            if (nodes.length === 1 && nodes[0].nodeType === 1 && nodes[0].matches(TOC_SELECTOR)) return nodes[0];
        }
        return null;
    }

    syncSelection() {
        const selected = this.getSelectedBlock();
        const range = this.getRange();
        for (const block of Array.from(this.editor.querySelectorAll(TOC_SELECTOR))) {
            const index = Array.from(block.parentNode.childNodes).indexOf(block);
            const covered = !range?.collapsed && typeof range?.isPointInRange === 'function' &&
                range.isPointInRange(block.parentNode, index) && range.isPointInRange(block.parentNode, index + 1);
            block.classList.toggle('md-block-whole-selected', block === selected || !!covered);
        }
    }

    select(block) {
        const selection = this.window.getSelection?.();
        if (!selection || !this.editor.contains(block)) return false;
        // A mouse click may originate in another input. Focus the editor before
        // setting its range, but preserve the object's own native Tab focus.
        this.editor.focus?.({ preventScroll: true });
        const range = this.document.createRange();
        range.selectNode(block);
        selection.removeAllRanges();
        selection.addRange(range);
        this.syncSelection();
        return true;
    }

    getAdjacentBlock(range, direction) {
        if (!range?.collapsed || !this.editor.contains(range.startContainer)) return null;
        const inside = this.getBlock(range.startContainer);
        if (inside) return inside;
        const backward = direction === 'backward';
        let container = range.startContainer;
        let candidate;
        if (container.nodeType === 3) {
            const remainder = backward ? container.textContent.slice(0, range.startOffset)
                : container.textContent.slice(range.startOffset);
            if (remainder.replace(/[\u200b\u2060\ufeff]/g, '') !== '') return null;
            candidate = backward ? container.previousSibling : container.nextSibling;
        } else {
            candidate = container.childNodes[range.startOffset + (backward ? -1 : 0)];
        }
        while (container && this.editor.contains(container)) {
            if (!candidate) {
                if (container === this.editor || /^(?:LI|TD|TH|PRE|CODE)$/.test(container.tagName || '')) return null;
                candidate = backward ? container.previousSibling : container.nextSibling;
                container = container.parentNode;
                continue;
            }
            if ((candidate.nodeType === 3 && isEmptyText(candidate.textContent)) ||
                (candidate.nodeType === 1 && candidate.tagName === 'BR')) {
                candidate = backward ? candidate.previousSibling : candidate.nextSibling;
                continue;
            }
            return candidate.nodeType === 1 && candidate.matches(TOC_SELECTOR) ? candidate : null;
        }
        return null;
    }

    getVerticalAdjacentBlock(range, direction, onInteriorLine = null) {
        if (!range?.collapsed || !this.editor.contains(range.startContainer)) return null;
        const element = range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement;
        if (element?.closest('td, th, pre, [contenteditable="false"]')) return null;
        if (range.startContainer === this.editor) return this.getAdjacentBlock(range, direction);
        const backward = direction === 'backward';
        let block = element?.closest('p, h1, h2, h3, h4, h5, h6, li, div, blockquote');
        if (block === this.editor) block = range.startContainer;
        if (!block) return null;
        let boundary = block;
        let adjacent = null;
        while (boundary && boundary !== this.editor) {
            let sibling = backward ? boundary.previousSibling : boundary.nextSibling;
            while (sibling && ((sibling.nodeType === 3 && isEmptyText(sibling.textContent)) ||
                (sibling.nodeType === 1 && sibling.getAttribute('data-exclude-from-markdown') === 'true'))) {
                sibling = backward ? sibling.previousSibling : sibling.nextSibling;
            }
            if (sibling) {
                if (sibling.nodeType === 1 && sibling.matches(TOC_SELECTOR)) adjacent = sibling;
                break;
            }
            boundary = boundary.parentNode;
        }
        if (!adjacent) return null;

        const contents = range.cloneRange();
        contents.selectNodeContents(block);
        // A collapsed P/DIV boundary often has a zero rectangle in Chromium.
        // Measure the rendered text and BRs instead, including empty last lines.
        const rects = Array.from(contents.getClientRects?.() || []).filter(rect => rect.height > 0);
        const caretRect = this.getNavigationCaretRect(range);
        if (caretRect?.height && rects.length) {
            const top = caretRect.top;
            const bottom = caretRect.bottom ?? top + caretRect.height;
            const otherLine = rects.some(rect => backward
                ? (rect.bottom ?? rect.top + rect.height) < top - 1
                : rect.top > bottom + 1);
            if (otherLine) {
                onInteriorLine?.(block, adjacent);
                return null;
            }
            return adjacent;
        }
        // Geometry may be unavailable in an empty/offscreen document. Retain
        // logical boundaries only when they cannot skip an explicit blank line.
        const breaks = block.nodeType === 1 && block.querySelector('br');
        if (breaks && !isEmptyText(block.textContent)) return null;
        return this.getAdjacentBlock(range, direction) === adjacent ? adjacent : null;
    }

    getNavigationCaretRect(range) {
        const direct = range.getBoundingClientRect?.();
        if (direct?.height > 0) return direct;
        const probe = range.cloneRange();
        const measure = (node, atEnd) => {
            if (node.nodeType === 3) {
                const length = node.textContent.length;
                if (!length) return null;
                probe.setStart(node, atEnd ? length - 1 : 0);
                probe.setEnd(node, atEnd ? length : 1);
                const rect = probe.getBoundingClientRect?.();
                return rect?.height > 0 ? rect : null;
            }
            if (node.nodeType !== 1 || node.getAttribute('data-exclude-from-markdown') === 'true') return null;
            if (node.tagName === 'BR' || node.getAttribute('contenteditable') === 'false' || node.tagName === 'IMG') {
                const rect = node.getBoundingClientRect?.();
                return rect?.height > 0 ? rect : null;
            }
            const children = Array.from(node.childNodes);
            if (atEnd) children.reverse();
            for (const child of children) {
                const rect = measure(child, atEnd);
                if (rect) return rect;
            }
            return null;
        };
        const container = range.startContainer;
        if (container.nodeType === 3) return this.getCaretRect(range);
        // Never use the paragraph's bounding box for an element-boundary caret:
        // it covers every wrapped line and would jump over intervening lines.
        for (let index = range.startOffset; index < container.childNodes.length; index++) {
            const rect = measure(container.childNodes[index], false);
            if (rect) return rect;
        }
        for (let index = range.startOffset - 1; index >= 0; index--) {
            const rect = measure(container.childNodes[index], true);
            if (rect) return rect;
        }
        return null;
    }

    moveWithinNeighboringBlock(block, toc, direction) {
        const selection = this.window.getSelection?.();
        if (typeof selection?.modify !== 'function') return false;
        selection.modify('move', direction, 'line');
        const after = this.getRange();
        if (after?.collapsed && (after.startContainer === block || block.contains(after.startContainer))) return true;
        // Read-only blocks can be skipped by native navigation too. If the
        // browser crosses the boundary, stop on the TOC rather than past it.
        return this.focusItem(toc, direction === 'backward' ? Number.MAX_SAFE_INTEGER : 0) || this.select(toc);
    }

    placeBeside(block, before) {
        const selection = this.window.getSelection?.();
        if (!selection) return false;
        this.editor.focus?.({ preventScroll: true });
        const range = this.document.createRange();
        const sibling = before ? block.previousElementSibling : block.nextElementSibling;
        if (sibling && /^(?:P|H[1-6])$/.test(sibling.tagName) &&
            sibling.getAttribute('contenteditable') !== 'false') {
            range.selectNodeContents(sibling);
            range.collapse(!before);
        } else {
            if (before) range.setStartBefore(block);
            else range.setStartAfter(block);
            range.collapse(true);
        }
        selection.removeAllRanges();
        selection.addRange(range);
        this.syncSelection();
        return true;
    }

    moveAcross(selection, direction) {
        if (selection?.rangeCount !== 1) return false;
        const item = this.getFocusedItem();
        if (item) return this.moveItem(item, direction === 'backward' ? -1 : 1);
        const range = selection.getRangeAt(0);
        const selected = this.getSelectedBlock(range);
        if (selected) return this.placeBeside(selected, direction === 'backward');
        const adjacent = this.getAdjacentBlock(range, direction);
        return adjacent ? this.select(adjacent) : false;
    }

    removeBlock(block) {
        if (!this.editor.contains(block)) return false;
        this.beforeChange();
        const range = this.document.createRange();
        range.setStartBefore(block);
        range.collapse(true);
        block.remove();
        if (!this.editor.firstChild) {
            const paragraph = this.document.createElement('p');
            paragraph.appendChild(this.document.createElement('br'));
            this.editor.appendChild(paragraph);
            range.setStart(paragraph, 0);
        }
        const selection = this.window.getSelection?.();
        selection?.removeAllRanges();
        selection?.addRange(range);
        this.syncSelection();
        this.onChange();
        return true;
    }

    insertParagraphAfter(block) {
        let paragraph = block.nextElementSibling;
        let changed = false;
        if (!paragraph || paragraph.tagName !== 'P') {
            this.beforeChange();
            paragraph = this.document.createElement('p');
            paragraph.appendChild(this.document.createElement('br'));
            block.parentNode.insertBefore(paragraph, block.nextSibling);
            changed = true;
        }
        const handled = this.placeBeside(block, false);
        if (changed) this.onChange();
        return handled;
    }

    handleKeyDown(event) {
        if (event.defaultPrevented || event.isComposing || this.composing || event.keyCode === 229 ||
            event.metaKey || event.altKey || this.editor.getAttribute('contenteditable') === 'false') return false;
        const key = String(event.key || '').toLowerCase();
        const control = event.ctrlKey && this.isMac;
        const focusedItem = this.getFocusedItem();
        if (focusedItem) {
            let handled = false;
            const backward = (!event.ctrlKey && ['ArrowLeft', 'ArrowUp'].includes(event.key)) ||
                (control && ['b', 'p'].includes(key));
            const forward = (!event.ctrlKey && ['ArrowRight', 'ArrowDown'].includes(event.key)) ||
                (control && ['f', 'n'].includes(key));
            if (!event.shiftKey && (backward || forward)) handled = this.moveItem(focusedItem, backward ? -1 : 1);
            else if (event.key === 'Tab' && !event.ctrlKey) handled = this.moveItem(focusedItem, event.shiftKey ? -1 : 1);
            else if (event.key === 'Enter' && !event.ctrlKey) handled = this.activateItem(focusedItem);
            else if (event.key === 'Home' || event.key === 'End') {
                handled = this.focusItem(this.getBlock(focusedItem), event.key === 'Home' ? 0 : Number.MAX_SAFE_INTEGER);
            } else if (['Backspace', 'Delete', 'Escape'].includes(event.key) || (control && key === 'h')) {
                handled = this.select(this.getBlock(focusedItem));
            } else if (!event.ctrlKey) {
                // Read-only item navigation must not reach the generic list or
                // text-editing handlers, including Shift+arrow and IME startup.
                handled = true;
            }
            if (handled) { event.preventDefault(); event.stopPropagation(); }
            return handled;
        }
        if (event.key === 'Backspace' || event.key === 'Delete' || (control && key === 'h')) {
            this.normalizeSelection();
        }
        const direction = !event.shiftKey && ((!event.ctrlKey && event.key === 'ArrowLeft') || (control && key === 'b'))
            ? 'backward' : !event.shiftKey && ((!event.ctrlKey && event.key === 'ArrowRight') || (control && key === 'f'))
                ? 'forward' : null;
        const selection = this.window.getSelection?.();
        const selected = this.getSelectedBlock();
        let handled = false;
        if (direction) handled = this.moveAcross(selection, direction);
        else if (selected && !event.shiftKey && ((!event.ctrlKey && event.key === 'ArrowUp') || (control && key === 'p'))) {
            handled = this.focusItem(selected, Number.MAX_SAFE_INTEGER) || this.placeBeside(selected, true);
        } else if (selected && !event.shiftKey && ((!event.ctrlKey && event.key === 'ArrowDown') || (control && key === 'n'))) {
            handled = this.focusItem(selected) || this.placeBeside(selected, false);
        } else if (selected && event.key === 'Enter' && !event.ctrlKey) {
            handled = this.focusItem(selected) || this.insertParagraphAfter(selected);
        } else if (!event.shiftKey && ((!event.ctrlKey && ['ArrowUp', 'ArrowDown'].includes(event.key)) ||
            (control && ['p', 'n'].includes(key)))) {
            const backward = event.key === 'ArrowUp' || key === 'p';
            const direction = backward ? 'backward' : 'forward';
            const adjacent = this.getVerticalAdjacentBlock(this.getRange(), direction, (block, toc) => {
                handled = this.moveWithinNeighboringBlock(block, toc, direction);
            });
            if (adjacent) handled = this.focusItem(adjacent, backward ? Number.MAX_SAFE_INTEGER : 0) || this.select(adjacent);
        }
        else if (!event.ctrlKey || (control && key === 'h')) {
            const deletion = event.key === 'Backspace' || (control && key === 'h') ? 'backward'
                : event.key === 'Delete' ? 'forward' : null;
            if (deletion) {
                if (selected) handled = this.removeBlock(selected);
                else {
                    const adjacent = this.getAdjacentBlock(this.getRange(), deletion);
                    if (adjacent) handled = this.select(adjacent);
                }
            }
        }
        if (handled) {
            event.preventDefault();
            event.stopPropagation();
        }
        return handled;
    }

    handleBeforeInput(event) {
        if (event.defaultPrevented || event.isComposing || this.composing || this.editor.getAttribute('contenteditable') === 'false') return false;
        if (this.getFocusedItem()) {
            event.preventDefault();
            event.stopPropagation();
            return true;
        }
        this.normalizeSelection();
        const range = this.getRange();
        const selected = this.getSelectedBlock(range);
        if (event.inputType?.startsWith('delete')) {
            const direction = /Backward$/.test(event.inputType) ? 'backward' : 'forward';
            const target = selected || this.getAdjacentBlock(range, direction);
            if (!target) return false;
            event.preventDefault();
            event.stopPropagation();
            return this.removeBlock(target);
        }
        return false;
    }
}
