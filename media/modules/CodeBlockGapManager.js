// @ts-nocheck
// Empty code-block boundary paragraphs are caret positions, not document edits.
export class CodeBlockGapManager {
    constructor(editor) {
        this.editor = editor;
    }

    isEmpty(paragraph) {
        return (paragraph.textContent || '').replace(/[\u200B\u2060\uFEFF]/g, '') === '' &&
            !paragraph.querySelector('img,hr,table,pre,ul,ol,input,blockquote');
    }

    isEditorUi(node) {
        return node.nodeType === Node.ELEMENT_NODE && (
            node.getAttribute('data-exclude-from-markdown') === 'true' ||
            node.getAttribute('aria-hidden') === 'true' ||
            node.classList.contains('md-table-insert-line')
        );
    }

    adjacentNode(node, direction) {
        let sibling = direction === 'up' ? node.previousSibling : node.nextSibling;
        while (sibling) {
            if (sibling.nodeType === Node.TEXT_NODE) {
                if ((sibling.textContent || '').replace(/[\u200B\u2060\uFEFF\u00A0\s]/g, '') !== '') {
                    return sibling;
                }
            } else if (sibling.nodeType === Node.ELEMENT_NODE && !this.isEditorUi(sibling)) {
                return sibling;
            }
            sibling = direction === 'up' ? sibling.previousSibling : sibling.nextSibling;
        }
        return null;
    }

    isFootnoteBoundary(anchor, adjacent, direction) {
        // Top-level footnotes follow the body, so a last body code block still
        // needs an input position before them. Do not split two note bodies.
        return direction === 'down' && anchor.parentElement === this.editor &&
            !anchor.hasAttribute('data-mdw-footnote-definition') &&
            adjacent?.nodeType === Node.ELEMENT_NODE &&
            adjacent.hasAttribute('data-mdw-footnote-definition');
    }

    moveUpFromFootnote(selection, isFirstLine) {
        if (!selection?.isCollapsed || !selection.rangeCount) return false;
        const range = selection.getRangeAt(0);
        const element = range.startContainer.nodeType === Node.ELEMENT_NODE
            ? range.startContainer : range.startContainer.parentElement;
        const content = element?.closest('.mdw-footnote-content');
        const definition = content?.parentElement;
        if (!definition?.hasAttribute('data-mdw-footnote-definition') ||
            definition.parentElement !== this.editor ||
            element.closest('pre, table, [contenteditable="false"], [data-exclude-from-markdown="true"]')) return false;

        const previous = this.adjacentNode(definition, 'up');
        if (previous?.nodeType !== Node.ELEMENT_NODE ||
            previous.hasAttribute('data-mdw-footnote-definition')) return false;
        if (previous.getAttribute('data-mdw-code-gap') === 'true' && this.isEmpty(previous)) {
            return isFirstLine(range, content) && this.placeCaret(previous, selection);
        }

        const blocks = previous.querySelectorAll('pre');
        const pre = previous.tagName === 'PRE' ? previous : blocks[blocks.length - 1];
        if (!pre?.querySelector('code') || pre.closest('[data-mdw-footnote-definition]')) return false;
        // A code block nested in a quote/list must be the final body content.
        // Otherwise Up should visit the text that follows it.
        let anchor = pre;
        while (anchor !== previous) {
            if (this.adjacentNode(anchor, 'down')) return false;
            anchor = anchor.parentElement;
        }
        return isFirstLine(range, content) && this.moveToGap(pre, 'down', selection);
    }

    moveToGap(pre, direction, selection, allowLabelSelection = false) {
        if (!pre || pre.tagName !== 'PRE' || !pre.querySelector('code') ||
            !this.editor.contains(pre) || !selection || (!selection.isCollapsed && !allowLabelSelection)) {
            return false;
        }
        const adjacent = this.adjacentNode(pre, direction);
        if (adjacent && adjacent.nodeType === Node.ELEMENT_NODE &&
            adjacent.getAttribute('data-mdw-code-gap') === 'true' && this.isEmpty(adjacent)) {
            return this.placeCaret(adjacent, selection);
        }

        let anchor = pre;
        if (adjacent) {
            // Existing empty paragraphs are already valid input positions. Only
            // adjacent code, read-only content or footnotes need a new boundary paragraph.
            const isCode = adjacent.nodeType === Node.ELEMENT_NODE &&
                adjacent.tagName === 'PRE' && adjacent.querySelector('code');
            const isReadOnly = adjacent.nodeType === Node.ELEMENT_NODE &&
                adjacent.getAttribute('contenteditable') === 'false';
            if (!isCode && !isReadOnly && !this.isFootnoteBoundary(anchor, adjacent, direction)) return false;
        } else {
            // A nested container boundary is not a document boundary if content
            // follows/precedes that container anywhere on the way to the editor.
            while (anchor.parentElement && anchor.parentElement !== this.editor) {
                anchor = anchor.parentElement;
                const containerAdjacent = this.adjacentNode(anchor, direction);
                if (containerAdjacent && !this.isFootnoteBoundary(anchor, containerAdjacent, direction)) return false;
            }
            if (anchor.parentElement !== this.editor) return false;
        }

        const paragraph = document.createElement('p');
        paragraph.setAttribute('data-mdw-code-gap', 'true');
        paragraph.textContent = '\u200B';
        paragraph.firstChild.mdwCaretAnchor = { character: '\u200B', text: '\u200B', offset: 0 };
        anchor.parentElement.insertBefore(paragraph, direction === 'up' ? anchor : anchor.nextSibling);
        return this.placeCaret(paragraph, selection);
    }

    placeCaret(paragraph, selection) {
        const range = document.createRange();
        range.setStart(paragraph.firstChild || paragraph, paragraph.firstChild ? 1 : 0);
        range.collapse(true);
        selection.removeAllRanges();
        selection.addRange(range);
        if (typeof this.editor.focus === 'function') this.editor.focus();
        return true;
    }

    commitAtSelection(selection, beforeCommit = null) {
        if (!selection || !selection.rangeCount) return;
        const range = selection.getRangeAt(0);
        this.editor.querySelectorAll('[data-mdw-code-gap="true"]').forEach(paragraph => {
            if (paragraph.contains(range.startContainer)) {
                if (beforeCommit) beforeCommit();
                paragraph.removeAttribute('data-mdw-code-gap');
            }
        });
    }

    reconcile(selection, composing = false) {
        if (composing) return;
        const range = selection && selection.rangeCount ? selection.getRangeAt(0) : null;
        this.editor.querySelectorAll('[data-mdw-code-gap="true"]').forEach(paragraph => {
            if (!this.isEmpty(paragraph)) {
                paragraph.removeAttribute('data-mdw-code-gap');
                return;
            }
            const containsCaret = range && (
                paragraph.contains(range.startContainer) || paragraph.contains(range.endContainer)
            );
            if (!containsCaret) paragraph.remove();
        });
    }
}
