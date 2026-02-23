// @ts-nocheck
/**
 * カーソル管理モジュール
 * カーソルの移動（上下左右、行頭行末）を担当
 */

export class CursorManager {
    constructor(editor, domUtils) {
        this.editor = editor;
        this.domUtils = domUtils;
        this._forwardImageStep = null;
        this._pendingForwardInlineCodeEntry = null;
    }

    _isRangeAtCodeBlockEnd(codeBlock, range) {
        if (!codeBlock || !range) {
            return false;
        }
        try {
            const endRange = document.createRange();
            endRange.selectNodeContents(codeBlock);
            endRange.collapse(false);
            return range.compareBoundaryPoints(Range.START_TO_START, endRange) === 0 &&
                range.compareBoundaryPoints(Range.END_TO_END, endRange) === 0;
        } catch (e) {
            return false;
        }
    }

    _serializedEndsWithNewline(node) {
        if (!node) {
            return false;
        }
        if (node.nodeType === Node.TEXT_NODE) {
            return (node.textContent || '').endsWith('\n');
        }
        if (node.nodeType !== Node.ELEMENT_NODE) {
            return false;
        }
        if (node.tagName === 'BR') {
            return true;
        }
        const children = node.childNodes;
        if (!children || children.length === 0) {
            return node.tagName === 'DIV' || node.tagName === 'P';
        }
        const lastChild = children[children.length - 1];
        const childEndsWithNewline = this._serializedEndsWithNewline(lastChild);
        if (node.tagName === 'DIV' || node.tagName === 'P') {
            return true;
        }
        return childEndsWithNewline;
    }

    _debugInlineNav(_event, _detail = {}) {
        // no-op: inline navigation debug telemetry disabled
    }

    _getTrailingNewlineCount(text) {
        if (!text) {
            return 0;
        }
        let count = 0;
        for (let i = text.length - 1; i >= 0 && text[i] === '\n'; i--) {
            count++;
        }
        return count;
    }

    _getInlineCodeCursorInfo(range, codeElement) {
        if (!range || !codeElement) {
            return null;
        }
        try {
            const tempRange = document.createRange();
            tempRange.selectNodeContents(codeElement);
            tempRange.setEnd(range.startContainer, range.startOffset);
            const offset = tempRange.toString().replace(/[\u200B\uFEFF]/g, '').length;
            const total = (codeElement.textContent || '').replace(/[\u200B\uFEFF]/g, '').length;
            return { offset, total };
        } catch (e) {
            return null;
        }
    }

    _getFirstNonZwspOffset(text) {
        if (!text) {
            return null;
        }
        for (let i = 0; i < text.length; i++) {
            if (text[i] !== '\u200B' && text[i] !== '\uFEFF') {
                return i;
            }
        }
        return null;
    }

    _getLastNonZwspOffset(text) {
        if (!text) {
            return null;
        }
        for (let i = text.length - 1; i >= 0; i--) {
            if (text[i] !== '\u200B' && text[i] !== '\uFEFF') {
                return i;
            }
        }
        return null;
    }

    _isInlineBoundaryChar(char) {
        return char === '\u200B' || char === '\uFEFF';
    }

    _isIgnorableTextNode(node) {
        if (!node || node.nodeType !== Node.TEXT_NODE) {
            return false;
        }
        const parent = node.parentElement;
        if (!parent) {
            return true;
        }
        let current = parent;
        while (current) {
            if (this._isNavigationExcludedElement(current)) {
                return true;
            }
            if (current === this.editor) {
                break;
            }
            current = current.parentElement;
        }
        if (parent === this.editor) {
            return true;
        }
        const rawText = node.textContent || '';
        const text = rawText.replace(/[\u200B\u00A0\uFEFF]/g, '');
        if (text.trim() !== '') {
            return false;
        }
        if (rawText.includes('\u00A0')) {
            const listItem = this.domUtils.getParentElement(node, 'LI');
            if (listItem) {
                if (listItem.getAttribute('data-preserve-empty') === 'true') {
                    return false;
                }
                const hasNestedList = listItem.querySelector('ul, ol') !== null;
                if (hasNestedList) {
                    return false;
                }
            }
            if (parent.tagName === 'P') {
                const hasListChild = parent.querySelector('ul, ol') !== null;
                if (hasListChild) {
                    return false;
                }
            }
        }
        const listItem = this.domUtils.getParentElement(node, 'LI');
        if (listItem) {
            const checkbox = listItem.querySelector(':scope > input[type="checkbox"]');
            if (checkbox) {
                let current = node.parentElement;
                let inSublist = false;
                while (current && current !== listItem) {
                    if (current.tagName === 'UL' || current.tagName === 'OL') {
                        inSublist = true;
                        break;
                    }
                    current = current.parentElement;
                }
                if (!inSublist) {
                    const position = checkbox.compareDocumentPosition(node);
                    if (position & Node.DOCUMENT_POSITION_FOLLOWING) {
                        return false;
                    }
                }
            }
        }
        return true;
    }

    _isInlineCodeBoundaryPlaceholder(node) {
        if (!node || node.nodeType !== Node.TEXT_NODE) {
            return false;
        }
        const rawText = node.textContent || '';
        // Accept both legacy ZWSP placeholders and empty-text anchors.
        if (rawText !== '' && rawText.replace(/[\u200B\uFEFF]/g, '') !== '') {
            return false;
        }

        const isInlineCodeElement = (candidate) => {
            if (!candidate || candidate.nodeType !== Node.ELEMENT_NODE || candidate.tagName !== 'CODE') {
                return false;
            }
            return !this.domUtils.getParentElement(candidate, 'PRE');
        };

        return isInlineCodeElement(node.previousSibling) || isInlineCodeElement(node.nextSibling);
    }

    _isNavigationExcludedElement(element) {
        if (!element || element.nodeType !== Node.ELEMENT_NODE) {
            return false;
        }
        if (element.classList?.contains('md-table-insert-line')) {
            return true;
        }
        if (element.getAttribute?.('data-exclude-from-markdown') === 'true') {
            return true;
        }
        if (element.getAttribute?.('contenteditable') === 'false') {
            return true;
        }
        if (element.getAttribute?.('aria-hidden') === 'true') {
            return true;
        }
        return false;
    }

    _isIgnorableBoundaryNode(node) {
        if (!node) {
            return true;
        }
        if (node.nodeType === Node.TEXT_NODE) {
            return this._isIgnorableTextNode(node);
        }
        if (node.nodeType !== Node.ELEMENT_NODE) {
            return true;
        }
        if (node.tagName === 'BR') {
            return true;
        }
        return this._isNavigationExcludedElement(node);
    }

    _insertTextNodeIntoListItem(listItem, textNode) {
        if (!listItem || !textNode) {
            return;
        }
        const checkbox = listItem.querySelector(':scope > input[type="checkbox"]');
        const firstSublist = Array.from(listItem.children).find(
            child => child.tagName === 'UL' || child.tagName === 'OL'
        );

        if (checkbox) {
            const afterCheckbox = checkbox.nextSibling;
            if (afterCheckbox) {
                listItem.insertBefore(textNode, afterCheckbox);
                return;
            }
            if (firstSublist) {
                listItem.insertBefore(textNode, firstSublist);
                return;
            }
            listItem.appendChild(textNode);
            return;
        }

        if (firstSublist) {
            listItem.insertBefore(textNode, firstSublist);
            return;
        }
        if (listItem.firstChild) {
            listItem.insertBefore(textNode, listItem.firstChild);
        } else {
            listItem.appendChild(textNode);
        }
    }

    _placeCursorInEmptyListItem(listItem, selection, direction = 'down') {
        if (!listItem || !selection) {
            return false;
        }

        const range = document.createRange();
        const checkbox = listItem.querySelector(':scope > input[type="checkbox"]');

        if (checkbox && checkbox.parentElement === listItem) {
            let directTextNode = null;
            let current = checkbox.nextSibling;
            while (current) {
                if (current.nodeType === Node.TEXT_NODE) {
                    directTextNode = current;
                    break;
                }
                if (current.nodeType === Node.ELEMENT_NODE) {
                    if (current.tagName === 'UL' || current.tagName === 'OL') {
                        break;
                    }
                    const candidate = this._getFirstNavigableTextNode(current);
                    if (candidate) {
                        directTextNode = candidate;
                        break;
                    }
                }
                current = current.nextSibling;
            }

            if (directTextNode) {
                const text = directTextNode.textContent || '';
                if (direction === 'up') {
                    const lastNonZwsp = this._getLastNonZwspOffset(text);
                    const targetOffset = lastNonZwsp === null ? 0 : Math.min(text.length, lastNonZwsp + 1);
                    range.setStart(directTextNode, targetOffset);
                } else {
                    const firstNonZwsp = this._getFirstNonZwspOffset(text);
                    const targetOffset = firstNonZwsp === null ? 0 : firstNonZwsp;
                    range.setStart(directTextNode, targetOffset);
                }
            } else {
                const childIndex = Array.prototype.indexOf.call(listItem.childNodes, checkbox);
                const targetOffset = Math.max(0, Math.min(listItem.childNodes.length, childIndex + 1));
                range.setStart(listItem, targetOffset);
            }
        } else {
            let directTextNode = null;
            const childNodes = listItem.childNodes ? Array.from(listItem.childNodes) : [];
            const nestedListIndex = childNodes.findIndex(
                child => child.nodeType === Node.ELEMENT_NODE &&
                    (child.tagName === 'UL' || child.tagName === 'OL')
            );

            // 空のliでは element-level の offset 配置だと親li側へ見かけ上ジャンプすることがあるため、
            // 直接テキストノード（なければZWSPアンカー）へカーソルを置く。
            for (const child of childNodes) {
                if (child.nodeType === Node.ELEMENT_NODE &&
                    (child.tagName === 'UL' || child.tagName === 'OL')) {
                    break;
                }
                if (child.nodeType === Node.TEXT_NODE) {
                    directTextNode = child;
                    break;
                }
                if (child.nodeType === Node.ELEMENT_NODE) {
                    const candidate = this.domUtils.getFirstTextNode(child);
                    if (candidate) {
                        directTextNode = candidate;
                        break;
                    }
                }
            }

            if (!directTextNode) {
                const anchorNode = document.createTextNode('\u200B');
                const nestedListNode = nestedListIndex >= 0 ? childNodes[nestedListIndex] : null;
                if (nestedListNode) {
                    listItem.insertBefore(anchorNode, nestedListNode);
                } else if (listItem.firstChild) {
                    listItem.insertBefore(anchorNode, listItem.firstChild);
                } else {
                    listItem.appendChild(anchorNode);
                }
                directTextNode = anchorNode;
            } else if ((directTextNode.textContent || '') === '') {
                directTextNode.textContent = '\u200B';
            }

            if (directTextNode) {
                const text = directTextNode.textContent || '';
                if (direction === 'up') {
                    const lastNonZwsp = this._getLastNonZwspOffset(text);
                    const targetOffset = lastNonZwsp === null ? 0 : Math.min(text.length, lastNonZwsp + 1);
                    range.setStart(directTextNode, targetOffset);
                } else {
                    const firstNonZwsp = this._getFirstNonZwspOffset(text);
                    const targetOffset = firstNonZwsp === null ? 0 : firstNonZwsp;
                    range.setStart(directTextNode, targetOffset);
                }
            } else {
                // フォールバック（基本的には到達しない）
                const targetOffset = nestedListIndex >= 0 ? nestedListIndex : 0;
                range.setStart(listItem, targetOffset);
            }
        }

        range.collapse(true);
        selection.removeAllRanges();
        selection.addRange(range);
        return true;
    }

    _getNextNavigableElementSibling(element) {
        let next = element ? element.nextElementSibling : null;
        while (next && this._isNavigationExcludedElement(next)) {
            next = next.nextElementSibling;
        }
        return next;
    }

    _getPrevNavigableElementSibling(element) {
        let prev = element ? element.previousElementSibling : null;
        while (prev && this._isNavigationExcludedElement(prev)) {
            prev = prev.previousElementSibling;
        }
        return prev;
    }

    _getLastNavigableChildElement(element) {
        if (!element) {
            return null;
        }
        let child = element.lastElementChild;
        while (child && this._isNavigationExcludedElement(child)) {
            child = child.previousElementSibling;
        }
        return child;
    }

    _selectCodeBlockLanguageLabel(pre, selection) {
        if (!pre || pre.tagName !== 'PRE') {
            return false;
        }
        const label = pre.querySelector('.code-block-language');
        const code = pre.querySelector('code');
        if (!label || !code) {
            return false;
        }
        if (label.classList.contains('editing')) {
            return false;
        }
        if (this.editor) {
            this.editor.querySelectorAll('.code-block-language.nav-selected').forEach(el => {
                if (el !== label) {
                    el.classList.remove('nav-selected');
                }
            });
        }
        label.classList.add('nav-selected');
        const range = document.createRange();
        range.selectNode(label);
        selection.removeAllRanges();
        selection.addRange(range);
        return true;
    }

    _getFirstNavigableTextNode(element) {
        if (!element) {
            return null;
        }
        const walker = document.createTreeWalker(
            element,
            NodeFilter.SHOW_TEXT,
            {
                acceptNode: (node) => {
                    return this._isIgnorableTextNode(node)
                        ? NodeFilter.FILTER_SKIP
                        : NodeFilter.FILTER_ACCEPT;
                }
            }
        );
        return walker.nextNode();
    }

    _getLeadingInlineCodeElement(block) {
        if (!block || block.nodeType !== Node.ELEMENT_NODE || !this.domUtils.isBlockElement(block)) {
            return null;
        }
        const children = Array.from(block.childNodes || []);
        for (const child of children) {
            if (!child) continue;
            if (child.nodeType === Node.TEXT_NODE) {
                const raw = child.textContent || '';
                if (raw.replace(/[\u200B\uFEFF\u00A0\s]/g, '') === '') {
                    continue;
                }
                return null;
            }
            if (child.nodeType !== Node.ELEMENT_NODE) {
                continue;
            }
            if (this._isNavigationExcludedElement(child)) {
                continue;
            }
            if (child.tagName === 'BR') {
                continue;
            }
            if (child.tagName === 'CODE' && !this.domUtils.getParentElement(child, 'PRE')) {
                return child;
            }
            return null;
        }
        return null;
    }

    _placeCursorBeforeLeadingInlineCode(block, selection) {
        if (!selection || !block) {
            return false;
        }
        const code = this._getLeadingInlineCodeElement(block);
        return this._placeCursorBeforeInlineCodeElement(code, selection);
    }

    _placeCursorBeforeInlineCodeElement(code, selection) {
        if (!selection || !code || code.nodeType !== Node.ELEMENT_NODE || code.tagName !== 'CODE') {
            return false;
        }
        if (this.domUtils.getParentElement(code, 'PRE')) {
            return false;
        }
        if (!code.parentElement) {
            return false;
        }
        const parent = code.parentElement;
        const prevSibling = code.previousSibling;
        let anchor = null;
        if (prevSibling &&
            prevSibling.nodeType === Node.TEXT_NODE &&
            this._isInlineCodeBoundaryPlaceholder(prevSibling)) {
            anchor = prevSibling;
            // Keep an explicit non-rendering anchor so WebView does not normalize
            // outside-left directly into inline-code start.
            if ((anchor.textContent || '') !== '\uFEFF') {
                anchor.textContent = '\uFEFF';
            }
        } else {
            anchor = document.createTextNode('\uFEFF');
            parent.insertBefore(anchor, code);
        }
        const range = document.createRange();
        range.setStart(anchor, (anchor.textContent || '').length);
        range.collapse(true);
        selection.removeAllRanges();
        selection.addRange(range);
        this._setPendingForwardInlineCodeEntry(code, anchor, range.startOffset);
        this._debugInlineNav('set-outside-left', {
            containerType: range.startContainer?.nodeType,
            offset: range.startOffset
        });
        return true;
    }

    _getTrailingInlineCodeElement(block) {
        if (!block || block.nodeType !== Node.ELEMENT_NODE || !this.domUtils.isBlockElement(block)) {
            return null;
        }
        const children = Array.from(block.childNodes || []);
        for (let i = children.length - 1; i >= 0; i--) {
            const child = children[i];
            if (!child) continue;
            if (child.nodeType === Node.TEXT_NODE) {
                const raw = child.textContent || '';
                if (raw.replace(/[\u200B\uFEFF\u00A0\s]/g, '') === '') {
                    continue;
                }
                return null;
            }
            if (child.nodeType !== Node.ELEMENT_NODE) {
                continue;
            }
            if (this._isNavigationExcludedElement(child)) {
                continue;
            }
            if (child.tagName === 'BR') {
                continue;
            }
            if (child.tagName === 'CODE' && !this.domUtils.getParentElement(child, 'PRE')) {
                return child;
            }
            return null;
        }
        return null;
    }

    _placeCursorAfterTrailingInlineCode(block, selection) {
        if (!selection || !block) {
            return false;
        }
        const code = this._getTrailingInlineCodeElement(block);
        if (!code || !code.parentElement) {
            return false;
        }
        const parent = code.parentElement;
        const hasOnlyCaretPlaceholders = (text) => {
            return (text || '').replace(/[\u200B\uFEFF\u00A0\s]/g, '') === '';
        };

        let anchor = null;
        const nextSibling = code.nextSibling;
        if (nextSibling &&
            nextSibling.nodeType === Node.TEXT_NODE &&
            hasOnlyCaretPlaceholders(nextSibling.textContent)) {
            anchor = nextSibling;
            if ((anchor.textContent || '').length === 0) {
                anchor.textContent = '\u200B';
            }
        } else {
            anchor = document.createTextNode('\u200B');
            if (nextSibling) {
                parent.insertBefore(anchor, nextSibling);
            } else {
                parent.appendChild(anchor);
            }
        }

        const range = document.createRange();
        range.setStart(anchor, (anchor.textContent || '').length);
        range.collapse(true);
        selection.removeAllRanges();
        selection.addRange(range);
        return true;
    }

    _getNestedListContainer(listItem) {
        if (!listItem) {
            return null;
        }
        const directList = Array.from(listItem.children).find(
            child => child.tagName === 'UL' || child.tagName === 'OL'
        );
        if (directList) {
            return directList;
        }
        const descendantList = listItem.querySelector('ul, ol');
        if (descendantList) {
            return descendantList;
        }
        const next = listItem.nextElementSibling;
        if (next && (next.tagName === 'UL' || next.tagName === 'OL')) {
            return next;
        }
        return null;
    }

    _getListItemFromContainer(container, offset, direction) {
        if (!container) {
            return null;
        }
        const findListItemAroundIndex = (nodes, index, searchDirection) => {
            if (!nodes || nodes.length === 0) {
                return null;
            }
            if (searchDirection === 'down') {
                for (let i = index; i < nodes.length; i++) {
                    const node = nodes[i];
                    if (node && node.nodeType === Node.ELEMENT_NODE && node.tagName === 'LI') {
                        return node;
                    }
                }
                for (let i = index - 1; i >= 0; i--) {
                    const node = nodes[i];
                    if (node && node.nodeType === Node.ELEMENT_NODE && node.tagName === 'LI') {
                        return node;
                    }
                }
                return null;
            }
            for (let i = index; i >= 0; i--) {
                const node = nodes[i];
                if (node && node.nodeType === Node.ELEMENT_NODE && node.tagName === 'LI') {
                    return node;
                }
            }
            for (let i = index + 1; i < nodes.length; i++) {
                const node = nodes[i];
                if (node && node.nodeType === Node.ELEMENT_NODE && node.tagName === 'LI') {
                    return node;
                }
            }
            return null;
        };
        if (container.nodeType === Node.ELEMENT_NODE &&
            (container.tagName === 'UL' || container.tagName === 'OL')) {
            const children = Array.from(container.childNodes);
            const parentListItem = this.domUtils.getParentElement(container, 'LI');

            const listItemChildren = children.filter(
                child => child && child.nodeType === Node.ELEMENT_NODE && child.tagName === 'LI'
            );

            if (direction === 'up' && parentListItem && offset <= 0) {
                const firstChildListItem = listItemChildren.length > 0 ? listItemChildren[0] : null;
                if (firstChildListItem) {
                    const selection = window.getSelection();
                    if (selection && selection.rangeCount > 0) {
                        const activeRange = selection.getRangeAt(0);
                        if (activeRange.collapsed &&
                            activeRange.startContainer === container &&
                            activeRange.startOffset === offset) {
                            const caretRect = this._getCaretRect(activeRange);
                            const firstChildRect = firstChildListItem.getBoundingClientRect
                                ? firstChildListItem.getBoundingClientRect()
                                : null;
                            if (caretRect && firstChildRect &&
                                Number.isFinite(caretRect.top) &&
                                Number.isFinite(firstChildRect.top) &&
                                caretRect.top >= firstChildRect.top - 2) {
                                return firstChildListItem;
                            }
                        }
                    }
                }
                return parentListItem;
            }

            if (direction === 'down' && parentListItem && offset >= children.length) {
                return parentListItem;
            }

            if (direction === 'down') {
                const start = Math.max(0, Math.min(offset, children.length));
                for (let i = start; i < children.length; i++) {
                    const child = children[i];
                    if (child && child.nodeType === Node.ELEMENT_NODE && child.tagName === 'LI') {
                        return child;
                    }
                }
                for (let i = start - 1; i >= 0; i--) {
                    const child = children[i];
                    if (child && child.nodeType === Node.ELEMENT_NODE && child.tagName === 'LI') {
                        return child;
                    }
                }
            } else {
                const start = Math.min(offset - 1, children.length - 1);
                for (let i = start; i >= 0; i--) {
                    const child = children[i];
                    if (child && child.nodeType === Node.ELEMENT_NODE && child.tagName === 'LI') {
                        return child;
                    }
                }
                for (let i = Math.max(0, start + 1); i < children.length; i++) {
                    const child = children[i];
                    if (child && child.nodeType === Node.ELEMENT_NODE && child.tagName === 'LI') {
                        return child;
                    }
                }
            }

            if (parentListItem) {
                return parentListItem;
            }
        }
        // キャレットが UL/OL 直下の空白テキストノードにある場合でも、
        // 近傍の LI を解決してリスト境界ナビゲーションを維持する。
        const parentList = container.parentElement;
        if (parentList && (parentList.tagName === 'UL' || parentList.tagName === 'OL')) {
            const siblings = Array.from(parentList.childNodes || []);
            const boundaryIndex = siblings.indexOf(container);
            if (boundaryIndex >= 0) {
                if (direction === 'down') {
                    const candidate = findListItemAroundIndex(siblings, boundaryIndex + 1, 'down');
                    if (candidate) {
                        return candidate;
                    }
                } else {
                    const candidate = findListItemAroundIndex(siblings, boundaryIndex - 1, 'up');
                    if (candidate) {
                        return candidate;
                    }
                }
            }
            const parentListItem = this.domUtils.getParentElement(parentList, 'LI');
            if (parentListItem) {
                return parentListItem;
            }
        }
        return this.domUtils.getParentElement(container, 'LI');
    }

    _getNextNavigableElementInDocument(element) {
        let current = element;
        while (current && current !== this.editor) {
            const next = this._getNextNavigableElementSibling(current);
            if (next) {
                return next;
            }
            current = current.parentElement;
        }
        return null;
    }

    _getPrevNavigableElementInDocument(element) {
        let current = element;
        while (current && current !== this.editor) {
            const prev = this._getPrevNavigableElementSibling(current);
            if (prev) {
                let candidate = prev;
                let child = this._getLastNavigableChildElement(candidate);
                while (child) {
                    candidate = child;
                    child = this._getLastNavigableChildElement(candidate);
                }
                return candidate;
            }
            current = current.parentElement;
        }
        return null;
    }

    _normalizeSelectionAtEditorEnd(range) {
        const selection = window.getSelection();
        if (!selection || !range) {
            return;
        }
        const container = range.startContainer;
        if (container && container.nodeType === Node.TEXT_NODE && !this._isIgnorableTextNode(container)) {
            const newRange = document.createRange();
            const maxOffset = (container.textContent || '').length;
            newRange.setStart(container, Math.min(range.startOffset, maxOffset));
            newRange.collapse(true);
            selection.removeAllRanges();
            selection.addRange(newRange);
            return;
        }
        const element = container && container.nodeType === Node.ELEMENT_NODE ? container : null;
        let targetText = null;
        if (element) {
            targetText = this._getLastNavigableTextNode(element);
        }
        if (!targetText) {
            targetText = this._getLastNavigableTextNode(this.editor);
        }
        if (targetText) {
            const newRange = document.createRange();
            newRange.setStart(targetText, targetText.textContent.length);
            newRange.collapse(true);
            selection.removeAllRanges();
            selection.addRange(newRange);
        }
    }

    _normalizeSelectionForNavigation(selection) {
        if (!selection || !selection.rangeCount) {
            return false;
        }
        const range = selection.getRangeAt(0);
        const container = range.startContainer;
        const element = container && container.nodeType === Node.ELEMENT_NODE ? container : container?.parentElement;
        const isInlineCodeBoundaryPlaceholder =
            container && container.nodeType === Node.TEXT_NODE && this._isInlineCodeBoundaryPlaceholder(container);
        let invalid = false;

        if (!this.editor.contains(container)) {
            invalid = true;
        } else if (container.nodeType === Node.TEXT_NODE &&
            this._isIgnorableTextNode(container) &&
            !isInlineCodeBoundaryPlaceholder) {
            // リストアイテム内のプレースホルダーテキスト（&nbsp;等）は
            // ナビゲーション上は有効な位置として扱う（エディタ末尾にジャンプさせない）
            const listItemForNormalize = this.domUtils.getParentElement(container, 'LI');
            const listContainerForNormalize =
                this.domUtils.getParentElement(container, 'UL') ||
                this.domUtils.getParentElement(container, 'OL');
            // Ctrl+K直後の空段落など、ブロック要素内のプレースホルダーは
            // 有効なキャレット位置として扱う（末尾への誤補正を防ぐ）。
            let blockForNormalize = container.parentElement;
            let hasExcludedAncestor = false;
            while (blockForNormalize && blockForNormalize !== this.editor && !this.domUtils.isBlockElement(blockForNormalize)) {
                if (this._isNavigationExcludedElement(blockForNormalize)) {
                    hasExcludedAncestor = true;
                    break;
                }
                blockForNormalize = blockForNormalize.parentElement;
            }
            const hasValidBlockContext =
                !hasExcludedAncestor &&
                !!blockForNormalize &&
                blockForNormalize !== this.editor &&
                !this._isNavigationExcludedElement(blockForNormalize);

            if (!listItemForNormalize && !listContainerForNormalize && !hasValidBlockContext) {
                invalid = true;
            }
        } else if (element) {
            let current = element;
            while (current && current !== this.editor) {
                if (this._isNavigationExcludedElement(current)) {
                    invalid = true;
                    break;
                }
                current = current.parentElement;
            }
        }

        if (invalid) {
            this._normalizeSelectionAtEditorEnd(range);
            return true;
        }
        return false;
    }

    _getNextSiblingForNavigation(node) {
        const isBlockBoundary = (element) => {
            if (!element || element.nodeType !== Node.ELEMENT_NODE) {
                return false;
            }
            if (this.domUtils.isBlockElement(element)) {
                return true;
            }
            return element.tagName === 'LI' ||
                element.tagName === 'TD' ||
                element.tagName === 'TH' ||
                element.tagName === 'TR' ||
                element.tagName === 'PRE';
        };
        const getValidSibling = (start) => {
            let sibling = start;
            while (sibling) {
                if (sibling.nodeType === Node.TEXT_NODE) {
                    if (!this._isIgnorableTextNode(sibling)) {
                        return sibling;
                    }
                } else if (sibling.nodeType === Node.ELEMENT_NODE) {
                    if (!this._isNavigationExcludedElement(sibling)) {
                        // 水平線も有効なナビゲーションターゲットとして返す
                        return sibling;
                    }
                }
                sibling = sibling.nextSibling;
            }
            return null;
        };

        let current = node;
        while (current && current !== this.editor) {
            const sibling = getValidSibling(current.nextSibling);
            if (sibling) {
                return sibling;
            }
            const parent = current.parentElement;
            if (!parent || parent === this.editor || isBlockBoundary(parent)) {
                break;
            }
            current = parent;
        }
        return null;
    }

    _getPrevSiblingForNavigation(node) {
        const isBlockBoundary = (element) => {
            if (!element || element.nodeType !== Node.ELEMENT_NODE) {
                return false;
            }
            if (this.domUtils.isBlockElement(element)) {
                return true;
            }
            return element.tagName === 'LI' ||
                element.tagName === 'TD' ||
                element.tagName === 'TH' ||
                element.tagName === 'TR' ||
                element.tagName === 'PRE';
        };
        const getValidSibling = (start) => {
            let sibling = start;
            while (sibling) {
                if (sibling.nodeType === Node.TEXT_NODE) {
                    if (!this._isIgnorableTextNode(sibling)) {
                        return sibling;
                    }
                } else if (sibling.nodeType === Node.ELEMENT_NODE) {
                    if (!this._isNavigationExcludedElement(sibling)) {
                        // 水平線も有効なナビゲーションターゲットとして返す
                        return sibling;
                    }
                }
                sibling = sibling.previousSibling;
            }
            return null;
        };

        let current = node;
        while (current && current !== this.editor) {
            const sibling = getValidSibling(current.previousSibling);
            if (sibling) {
                return sibling;
            }
            const parent = current.parentElement;
            if (!parent || parent === this.editor || isBlockBoundary(parent)) {
                break;
            }
            current = parent;
        }
        return null;
    }

    _getImageFromNavigationCandidate(node) {
        if (!node) {
            return null;
        }
        if (node.nodeType === Node.ELEMENT_NODE && node.tagName === 'IMG') {
            return node;
        }
        if (node.nodeType !== Node.ELEMENT_NODE) {
            return null;
        }
        if (this._isNavigationExcludedElement(node)) {
            return null;
        }

        const getMeaningfulChildren = (element) => {
            return Array.from(element.childNodes || []).filter((child) => {
                if (child.nodeType === Node.TEXT_NODE) {
                    return !this._isIgnorableTextNode(child);
                }
                if (child.nodeType === Node.ELEMENT_NODE) {
                    if (this._isNavigationExcludedElement(child)) return false;
                    if (child.tagName === 'BR') return false;
                    return true;
                }
                return false;
            });
        };

        let current = node;
        let depth = 0;
        while (current && current.nodeType === Node.ELEMENT_NODE && depth < 8) {
            if (current.tagName === 'IMG') {
                return current;
            }
            const meaningfulChildren = getMeaningfulChildren(current);
            if (meaningfulChildren.length !== 1) {
                return null;
            }
            const next = meaningfulChildren[0];
            if (next.nodeType !== Node.ELEMENT_NODE) {
                return null;
            }
            current = next;
            depth++;
        }

        return current && current.nodeType === Node.ELEMENT_NODE && current.tagName === 'IMG'
            ? current
            : null;
    }

    _getFirstMeaningfulNode(node) {
        if (!node) {
            return null;
        }
        if (node.nodeType === Node.TEXT_NODE) {
            return this._isIgnorableTextNode(node) ? null : node;
        }
        if (node.nodeType !== Node.ELEMENT_NODE) {
            return null;
        }
        if (this._isNavigationExcludedElement(node) || node.tagName === 'BR') {
            return null;
        }
        if (node.tagName === 'IMG') {
            return node;
        }
        for (const child of Array.from(node.childNodes || [])) {
            const candidate = this._getFirstMeaningfulNode(child);
            if (candidate) {
                return candidate;
            }
        }
        return null;
    }

    _getLastMeaningfulNode(node) {
        if (!node) {
            return null;
        }
        if (node.nodeType === Node.TEXT_NODE) {
            return this._isIgnorableTextNode(node) ? null : node;
        }
        if (node.nodeType !== Node.ELEMENT_NODE) {
            return null;
        }
        if (this._isNavigationExcludedElement(node) || node.tagName === 'BR') {
            return null;
        }
        if (node.tagName === 'IMG') {
            return node;
        }
        const children = Array.from(node.childNodes || []);
        for (let i = children.length - 1; i >= 0; i--) {
            const candidate = this._getLastMeaningfulNode(children[i]);
            if (candidate) {
                return candidate;
            }
        }
        return null;
    }

    _getLeadingImageInBlock(block) {
        if (!block || block.nodeType !== Node.ELEMENT_NODE) {
            return null;
        }
        const first = this._getFirstMeaningfulNode(block);
        if (first && first.nodeType === Node.ELEMENT_NODE && first.tagName === 'IMG') {
            return first;
        }
        return null;
    }

    _getTrailingImageInBlock(block) {
        if (!block || block.nodeType !== Node.ELEMENT_NODE) {
            return null;
        }
        const last = this._getLastMeaningfulNode(block);
        if (last && last.nodeType === Node.ELEMENT_NODE && last.tagName === 'IMG') {
            return last;
        }
        return null;
    }

    _getImageAheadFromCollapsedRange(range) {
        if (!range || !range.collapsed) {
            return null;
        }
        const container = range.startContainer;
        const offset = range.startOffset;

        if (container.nodeType === Node.TEXT_NODE) {
            const text = container.textContent || '';
            let probeOffset = Math.max(0, Math.min(offset, text.length));
            while (probeOffset < text.length && this._isInlineBoundaryChar(text[probeOffset])) {
                probeOffset++;
            }
            if (probeOffset < text.length) {
                return null;
            }
            const sibling = this._getNextSiblingForNavigation(container);
            return this._getImageFromNavigationCandidate(sibling);
        }

        if (container.nodeType !== Node.ELEMENT_NODE) {
            return null;
        }

        let candidate = container.childNodes[offset] || null;
        while (candidate) {
            if (this._isIgnorableBoundaryNode(candidate)) {
                candidate = candidate.nextSibling;
                continue;
            }
            break;
        }

        return this._getImageFromNavigationCandidate(candidate);
    }

    _getImageBehindFromCollapsedRange(range) {
        if (!range || !range.collapsed) {
            return null;
        }
        const container = range.startContainer;
        const offset = range.startOffset;

        if (container.nodeType === Node.TEXT_NODE) {
            const text = container.textContent || '';
            let probeOffset = Math.max(0, Math.min(offset, text.length));
            while (probeOffset > 0 && this._isInlineBoundaryChar(text[probeOffset - 1])) {
                probeOffset--;
            }
            if (probeOffset > 0) {
                return null;
            }
            const sibling = this._getPrevSiblingForNavigation(container);
            return this._getImageFromNavigationCandidate(sibling);
        }

        if (container.nodeType !== Node.ELEMENT_NODE) {
            return null;
        }

        let index = offset - 1;
        let candidate = index >= 0 ? container.childNodes[index] : null;
        while (candidate) {
            if (this._isIgnorableBoundaryNode(candidate)) {
                index--;
                candidate = index >= 0 ? container.childNodes[index] : null;
                continue;
            }
            break;
        }

        return this._getImageFromNavigationCandidate(candidate);
    }

    _getSelectedImageNode(range) {
        if (!range || range.collapsed) {
            return null;
        }
        if (range.startContainer !== range.endContainer) {
            return null;
        }
        if (range.startContainer.nodeType !== Node.ELEMENT_NODE) {
            return null;
        }

        const container = range.startContainer;

        if (range.endOffset === range.startOffset + 1) {
            const selected = container.childNodes[range.startOffset];
            const selectedImage = this._getImageFromNavigationCandidate(selected);
            if (selectedImage) {
                return selectedImage;
            }
        }

        // Some engines can report "whole wrapper selected" for image-only wrappers.
        const isWholeContainerSelection =
            container !== this.editor &&
            range.startOffset === 0 &&
            range.endOffset === (container.childNodes ? container.childNodes.length : 0);
        if (isWholeContainerSelection) {
            const wrappedImage = this._getImageFromNavigationCandidate(container);
            if (wrappedImage) {
                return wrappedImage;
            }
        }

        return null;
    }

    _setForwardImageStep(image, container, offset) {
        if (!image || !container || typeof offset !== 'number') {
            this._forwardImageStep = null;
            return;
        }
        this._forwardImageStep = {
            image,
            container,
            offset
        };
    }

    _clearForwardImageStep() {
        this._forwardImageStep = null;
    }

    _setPendingForwardInlineCodeEntry(code, container = null, offset = null) {
        if (!code) {
            this._pendingForwardInlineCodeEntry = null;
            return;
        }
        this._pendingForwardInlineCodeEntry = {
            code,
            container,
            offset: typeof offset === 'number' ? offset : null
        };
    }

    _clearPendingForwardInlineCodeEntry() {
        this._pendingForwardInlineCodeEntry = null;
    }

    _getInlineCodeStartTextPosition(code) {
        if (!code || code.nodeType !== Node.ELEMENT_NODE || code.tagName !== 'CODE') {
            return null;
        }
        const textNodes = this.domUtils.getTextNodes(code);
        if (!textNodes || textNodes.length === 0) {
            return null;
        }
        for (const textNode of textNodes) {
            const text = textNode.textContent || '';
            const firstOffset = this._getFirstNonZwspOffset(text);
            if (firstOffset !== null) {
                return { node: textNode, offset: firstOffset };
            }
        }
        // Fallback: inline code that only has boundary chars/empty text.
        return { node: textNodes[0], offset: 0 };
    }

    _getInlineCodeAfterFirstCharPosition(code) {
        const startPos = this._getInlineCodeStartTextPosition(code);
        if (!startPos) {
            return null;
        }
        const text = startPos.node.textContent || '';
        const targetOffset = Math.min(startPos.offset + 1, text.length);
        return {
            node: startPos.node,
            offset: targetOffset
        };
    }

    _placeCursorInsideInlineCodeStart(code, selection) {
        if (!selection || !code || code.nodeType !== Node.ELEMENT_NODE || code.tagName !== 'CODE') {
            return false;
        }
        if (this.domUtils.getParentElement(code, 'PRE')) {
            return false;
        }

        // Keep a FEFF marker at the start and place the caret after it.
        // This makes inside-left visually distinct from outside-left across WebView engines.
        let firstTextNode = this.domUtils.getFirstTextNode(code);
        if (!firstTextNode) {
            firstTextNode = document.createTextNode('\uFEFF');
            code.insertBefore(firstTextNode, code.firstChild || null);
        } else {
            const raw = firstTextNode.textContent || '';
            if (!raw.startsWith('\uFEFF')) {
                firstTextNode.textContent = `\uFEFF${raw}`;
            } else {
                firstTextNode.textContent = raw.replace(/^\uFEFF+/, '\uFEFF');
            }
        }

        const range = document.createRange();
        range.setStart(firstTextNode, 1);
        range.collapse(true);
        selection.removeAllRanges();
        selection.addRange(range);
        const appliedRange = selection.rangeCount ? selection.getRangeAt(0) : range;
        this._debugInlineNav('set-inside-left', {
            containerType: appliedRange.startContainer?.nodeType,
            offset: appliedRange.startOffset,
            mode: 'feff-forced'
        });
        return true;
    }

    _isRangeOutsideLeftOfInlineCode(range, code) {
        if (!range || !range.collapsed || !code) {
            return false;
        }

        const container = range.startContainer;
        const offset = range.startOffset;
        if (container === code && offset === 0) {
            return false;
        }

        if (container && container.nodeType === Node.TEXT_NODE) {
            if (this._isInlineCodeBoundaryPlaceholder(container) && container.nextSibling === code) {
                return true;
            }
            const text = container.textContent || '';
            if (container.nextSibling === code) {
                // If the caret is inside trailing boundary chars (ZWSP/FEFF) just before code,
                // treat it as outside-left so the pending step can enter inside-left reliably.
                let trailingBoundaryStart = text.length;
                while (trailingBoundaryStart > 0 &&
                    this._isInlineBoundaryChar(text[trailingBoundaryStart - 1])) {
                    trailingBoundaryStart--;
                }
                if (offset >= trailingBoundaryStart) {
                    return true;
                }
            }
            return false;
        }

        if (!container || container.nodeType !== Node.ELEMENT_NODE) {
            return false;
        }

        const candidate = container.childNodes[offset] || null;
        if (candidate === code) {
            return true;
        }
        if (candidate &&
            candidate.nodeType === Node.TEXT_NODE &&
            this._isInlineCodeBoundaryPlaceholder(candidate) &&
            candidate.nextSibling === code) {
            return true;
        }
        return false;
    }

    _consumePendingForwardInlineCodeEntry(selection) {
        if (!selection || !selection.rangeCount) {
            this._clearPendingForwardInlineCodeEntry();
            return false;
        }

        const pending = this._pendingForwardInlineCodeEntry;
        const code = pending?.code || null;
        if (!code || !code.isConnected || this.domUtils.getParentElement(code, 'PRE')) {
            this._clearPendingForwardInlineCodeEntry();
            return false;
        }

        const range = selection.getRangeAt(0);
        const hasExactAnchor = !!pending &&
            pending.container &&
            typeof pending.offset === 'number';
        const matchesExactAnchor = hasExactAnchor &&
            range.startContainer === pending.container &&
            range.startOffset === pending.offset;
        const isRangeOutsideLeft = this._isRangeOutsideLeftOfInlineCode(range, code);
        const isPendingOutsideLeft = matchesExactAnchor || isRangeOutsideLeft;
        this._debugInlineNav('consume-pending-check', {
            hasExactAnchor,
            matchesExactAnchor,
            isRangeOutsideLeft,
            isPendingOutsideLeft,
            containerType: range.startContainer?.nodeType,
            offset: range.startOffset
        });
        if (isPendingOutsideLeft) {
            const placeholderAnchor = (
                range.startContainer &&
                range.startContainer.nodeType === Node.TEXT_NODE &&
                this._isInlineCodeBoundaryPlaceholder(range.startContainer) &&
                range.startContainer.nextSibling === code &&
                range.startContainer.parentNode
            ) ? range.startContainer : (
                hasExactAnchor &&
                pending.container &&
                pending.container.nodeType === Node.TEXT_NODE &&
                this._isInlineCodeBoundaryPlaceholder(pending.container) &&
                pending.container.nextSibling === code &&
                pending.container.parentNode
            ) ? pending.container : null;
            if (placeholderAnchor) {
                placeholderAnchor.remove();
            }
            this._clearPendingForwardInlineCodeEntry();
            this._debugInlineNav('consume-pending-enter-inside', {});
            return this._placeCursorInsideInlineCodeStart(code, selection);
        }

        const currentCode = this.domUtils.getParentElement(range.startContainer, 'CODE');
        if (currentCode === code) {
            const cursorInfo = this._getInlineCodeCursorInfo(range, code);
            const isNearInlineStart = !cursorInfo ||
                (typeof cursorInfo.offset === 'number' && cursorInfo.offset <= 1);
            if (isNearInlineStart) {
                this._clearPendingForwardInlineCodeEntry();
                this._debugInlineNav('consume-pending-enter-inside-normalized', {
                    offset: cursorInfo?.offset ?? null
                });
                // Already at inline start: clear pending and continue normal forward handling
                // so this keypress advances instead of becoming a visual no-op.
                return false;
            }
            this._clearPendingForwardInlineCodeEntry();
            this._debugInlineNav('consume-pending-inside-cleared', {
                offset: cursorInfo?.offset ?? null
            });
            return false;
        }

        // Pending boundary was abandoned by another movement path.
        this._clearPendingForwardInlineCodeEntry();
        this._debugInlineNav('consume-pending-cleared', {});
        return false;
    }

    _isSameForwardImageStep(image, container, offset) {
        if (!this._forwardImageStep) {
            return false;
        }
        return this._forwardImageStep.image === image &&
            this._forwardImageStep.container === container &&
            this._forwardImageStep.offset === offset;
    }

    _collapseRangeAfterNode(range, node) {
        if (!range || !node || !node.parentNode) {
            return false;
        }
        const parent = node.parentNode;
        const index = Array.prototype.indexOf.call(parent.childNodes, node);
        if (index < 0) {
            return false;
        }
        range.setStart(parent, index + 1);
        range.collapse(true);
        return true;
    }

    _collapseRangeBeforeNode(range, node) {
        if (!range || !node || !node.parentNode) {
            return false;
        }
        const parent = node.parentNode;
        const index = Array.prototype.indexOf.call(parent.childNodes, node);
        if (index < 0) {
            return false;
        }
        range.setStart(parent, index);
        range.collapse(true);
        return true;
    }

    _isCollapsedRangeAtNodeBoundary(range, node, boundary = 'after') {
        if (!range || !range.collapsed || !node || !node.parentNode) {
            return false;
        }
        const parent = node.parentNode;
        const index = Array.prototype.indexOf.call(parent.childNodes, node);
        if (index < 0) {
            return false;
        }
        const expectedOffset = boundary === 'before' ? index : index + 1;
        if (range.startContainer !== parent) {
            return false;
        }
        if (range.startOffset === expectedOffset) {
            return true;
        }

        if (boundary === 'after' && range.startOffset > expectedOffset) {
            for (let i = expectedOffset; i < range.startOffset; i++) {
                const between = parent.childNodes[i];
                if (!this._isIgnorableBoundaryNode(between)) {
                    return false;
                }
            }
            return true;
        }

        if (boundary === 'before' && range.startOffset < expectedOffset) {
            for (let i = range.startOffset; i < expectedOffset; i++) {
                const between = parent.childNodes[i];
                if (!this._isIgnorableBoundaryNode(between)) {
                    return false;
                }
            }
            return true;
        }

        return false;
    }

    _normalizeCollapsedImageAnchor(selection, direction = 'forward') {
        if (!selection || !selection.rangeCount || !selection.isCollapsed) {
            return false;
        }

        const range = selection.getRangeAt(0);
        const container = range.startContainer;
        if (!container || container.nodeType !== Node.ELEMENT_NODE || container.tagName !== 'IMG') {
            return false;
        }

        const normalizedRange = document.createRange();
        const moved = direction === 'backward'
            ? this._collapseRangeBeforeNode(normalizedRange, container)
            : this._collapseRangeAfterNode(normalizedRange, container);
        if (!moved) {
            return false;
        }

        selection.removeAllRanges();
        selection.addRange(normalizedRange);
        return true;
    }

    _adjustIntoInlineCodeBoundary(range, direction) {
        if (!range) {
            return false;
        }

        const container = range.startContainer;
        const offset = range.startOffset;
        const currentCode = this.domUtils.getParentElement(container, 'CODE');
        const currentPre = currentCode ? this.domUtils.getParentElement(currentCode, 'PRE') : null;
        if (currentCode && !currentPre) {
            return false;
        }
        if (container.nodeType === Node.TEXT_NODE) {
            return false;
        }
        let candidate = null;

        if (container.nodeType === Node.ELEMENT_NODE) {
            if (direction === 'forward') {
                candidate = container.childNodes[offset] || null;
            } else if (direction === 'backward') {
                candidate = offset > 0 ? container.childNodes[offset - 1] : null;
            }
        }

        while (candidate && candidate.nodeType === Node.TEXT_NODE &&
            (candidate.textContent || '').replace(/[\u200B\uFEFF]/g, '') === '') {
            candidate = direction === 'forward' ? candidate.nextSibling : candidate.previousSibling;
        }

        let codeElement = null;
        if (candidate) {
            if (candidate.nodeType === Node.ELEMENT_NODE && candidate.tagName === 'CODE') {
                codeElement = candidate;
            } else {
                codeElement = this.domUtils.getParentElement(candidate, 'CODE');
            }
        }

        if (!codeElement) {
            return false;
        }

        const preBlock = this.domUtils.getParentElement(codeElement, 'PRE');
        if (preBlock) {
            return false;
        }

        // Forward movement should stop at outside-left first; the next keypress enters inside-left.
        if (direction === 'forward') {
            this._setPendingForwardInlineCodeEntry(codeElement, container, offset);
            return false;
        }

        const textNode = this.domUtils.getLastTextNode(codeElement);
        if (!textNode) {
            return false;
        }

        const text = textNode.textContent || '';
        const targetOffset = this._getLastNonZwspOffset(text);
        if (targetOffset === null) {
            return false;
        }

        const finalOffset = Math.min(targetOffset + 1, text.length);
        range.setStart(textNode, finalOffset);
        range.collapse(true);
        return true;
    }

    _isRangeAtInlineCodeStart(range, codeElement) {
        if (!range || !codeElement) {
            return false;
        }
        try {
            const startRange = document.createRange();
            startRange.selectNodeContents(codeElement);
            startRange.collapse(true);
            return range.compareBoundaryPoints(Range.START_TO_START, startRange) === 0;
        } catch (e) {
            return false;
        }
    }

    _isRangeAtInlineCodeEnd(range, codeElement) {
        if (!range || !codeElement) {
            return false;
        }
        try {
            const endRange = document.createRange();
            endRange.selectNodeContents(codeElement);
            endRange.collapse(false);
            return range.compareBoundaryPoints(Range.START_TO_START, endRange) === 0;
        } catch (e) {
            return false;
        }
    }

    _isRangeNearInlineCodeEnd(range, codeElement) {
        if (!range || !codeElement || !range.collapsed) {
            return false;
        }
        const container = range.startContainer;
        const offset = range.startOffset;
        if (container === codeElement) {
            return offset >= (codeElement.childNodes ? codeElement.childNodes.length : 0);
        }
        if (container && container.nodeType === Node.TEXT_NODE && codeElement.contains(container)) {
            const text = container.textContent || '';
            if (text.length === 0) {
                return true;
            }
            // Safari/WebView can report one-char-short offset when a leading ZWSP exists.
            // Keep the tolerance only for that legacy layout.
            const threshold = this._isInlineBoundaryChar(text[0])
                ? Math.max(0, text.length - 1)
                : text.length;
            return offset >= threshold;
        }
        return false;
    }

    _getTextNodeInParentAfter(parent, startIndex) {
        if (!parent) {
            return null;
        }
        const childNodes = Array.from(parent.childNodes);
        for (let i = Math.max(0, startIndex); i < childNodes.length; i++) {
            const child = childNodes[i];
            if (child.nodeType === Node.TEXT_NODE) {
                if (!this._isIgnorableTextNode(child)) {
                    return child;
                }
            }
            if (child.nodeType === Node.ELEMENT_NODE) {
                const textNode = this._getFirstNavigableTextNode(child);
                if (textNode) {
                    return textNode;
                }
            }
        }
        return null;
    }

    _getTextNodeInParentBefore(parent, startIndex) {
        if (!parent) {
            return null;
        }
        const childNodes = Array.from(parent.childNodes);
        for (let i = Math.min(startIndex - 1, childNodes.length - 1); i >= 0; i--) {
            const child = childNodes[i];
            if (child.nodeType === Node.TEXT_NODE) {
                if (!this._isIgnorableTextNode(child)) {
                    return child;
                }
            }
            if (child.nodeType === Node.ELEMENT_NODE) {
                const textNode = this._getLastNavigableTextNode(child);
                if (textNode) {
                    return textNode;
                }
            }
        }
        return null;
    }

    _getTextNodeAfterPosition(container, offset) {
        if (!container) {
            return null;
        }
        if (container.nodeType !== Node.ELEMENT_NODE) {
            let next = this.domUtils.getNextTextNode(container);
            while (next && this._isIgnorableTextNode(next)) {
                next = this.domUtils.getNextTextNode(next);
            }
            return next;
        }

        const childNodes = Array.from(container.childNodes);
        for (let i = Math.max(0, offset); i < childNodes.length; i++) {
            const child = childNodes[i];
            if (child.nodeType === Node.TEXT_NODE) {
                if (!this._isIgnorableTextNode(child)) {
                    return child;
                }
            }
            if (child.nodeType === Node.ELEMENT_NODE) {
                const textNode = this._getFirstNavigableTextNode(child);
                if (textNode) {
                    return textNode;
                }
            }
        }

        let current = container;
        while (current && current !== this.editor) {
            let sibling = current.nextSibling;
            while (sibling) {
                if (sibling.nodeType === Node.TEXT_NODE) {
                    if (!this._isIgnorableTextNode(sibling)) {
                        return sibling;
                    }
                }
                if (sibling.nodeType === Node.ELEMENT_NODE) {
                    const textNode = this._getFirstNavigableTextNode(sibling);
                    if (textNode) {
                        return textNode;
                    }
                }
                sibling = sibling.nextSibling;
            }
            current = current.parentElement;
        }

        return null;
    }

    _getTextNodeBeforePosition(container, offset) {
        if (!container) {
            return null;
        }
        if (container.nodeType !== Node.ELEMENT_NODE) {
            let prev = this.domUtils.getPreviousTextNode(container);
            while (prev && this._isIgnorableTextNode(prev)) {
                prev = this.domUtils.getPreviousTextNode(prev);
            }
            return prev;
        }
        const childNodes = Array.from(container.childNodes);
        for (let i = Math.min(offset - 1, childNodes.length - 1); i >= 0; i--) {
            const child = childNodes[i];
            if (child.nodeType === Node.TEXT_NODE) {
                if (!this._isIgnorableTextNode(child)) {
                    return child;
                }
            }
            if (child.nodeType === Node.ELEMENT_NODE) {
                const textNode = this._getLastNavigableTextNode(child);
                if (textNode) {
                    return textNode;
                }
            }
        }

        let current = container;
        while (current && current !== this.editor) {
            let sibling = current.previousSibling;
            while (sibling) {
                if (sibling.nodeType === Node.TEXT_NODE) {
                    if (!this._isIgnorableTextNode(sibling)) {
                        return sibling;
                    }
                }
                if (sibling.nodeType === Node.ELEMENT_NODE) {
                    const textNode = this._getLastNavigableTextNode(sibling);
                    if (textNode) {
                        return textNode;
                    }
                }
                sibling = sibling.previousSibling;
            }
            current = current.parentElement;
        }

        return null;
    }

    _getDirectTextNodes(listItem) {
        if (!listItem) {
            return [];
        }
        const nodes = [];
        const walker = document.createTreeWalker(
            listItem,
            NodeFilter.SHOW_TEXT,
            {
                acceptNode: (node) => {
                    if (this._isIgnorableTextNode(node)) {
                        return NodeFilter.FILTER_SKIP;
                    }
                    let parent = node.parentElement;
                    while (parent && parent !== listItem) {
                        if (parent.tagName === 'UL' || parent.tagName === 'OL') {
                            return NodeFilter.FILTER_REJECT;
                        }
                        parent = parent.parentElement;
                    }
                    return NodeFilter.FILTER_ACCEPT;
                }
            }
        );
        let current = walker.nextNode();
        while (current) {
            nodes.push(current);
            current = walker.nextNode();
        }
        return nodes;
    }

    _getFirstDirectTextNode(listItem) {
        const nodes = this._getDirectTextNodes(listItem);
        return nodes.length ? nodes[0] : null;
    }

    _getLastDirectTextNode(listItem) {
        const nodes = this._getDirectTextNodes(listItem);
        return nodes.length ? nodes[nodes.length - 1] : null;
    }

    _getAdjacentListItem(listItem, direction) {
        if (!listItem) {
            return null;
        }
        const isList = (node) => node && (node.tagName === 'UL' || node.tagName === 'OL');
        const getFirstLiInList = (list) => {
            if (!list) {
                return null;
            }
            for (const child of list.children) {
                if (child.tagName === 'LI') {
                    return child;
                }
            }
            return null;
        };
        const getLastLiInList = (list) => {
            if (!list) {
                return null;
            }
            for (let i = list.children.length - 1; i >= 0; i--) {
                const child = list.children[i];
                if (child.tagName === 'LI') {
                    return child;
                }
            }
            return null;
        };
        const getLastDescendantLi = (li) => {
            let current = li;
            while (current) {
                const nestedList = this._getNestedListContainer(current);
                const lastChild = getLastLiInList(nestedList);
                if (!lastChild) {
                    break;
                }
                current = lastChild;
            }
            return current;
        };

        if (direction === 'prev') {
            let prev = listItem.previousElementSibling;
            while (prev) {
                if (prev.tagName === 'LI') {
                    return getLastDescendantLi(prev);
                }
                if (isList(prev)) {
                    const lastChild = getLastLiInList(prev);
                    if (lastChild) {
                        return getLastDescendantLi(lastChild);
                    }
                }
                prev = prev.previousElementSibling;
            }
            const parentList = listItem.parentElement;
            const parentLi = parentList ? this.domUtils.getParentElement(parentList, 'LI') : null;
            if (parentLi) {
                return parentLi;
            }
        }

        if (direction === 'next') {
            const nestedList = this._getNestedListContainer(listItem);
            const firstChild = getFirstLiInList(nestedList);
            if (firstChild) {
                return firstChild;
            }
            let next = listItem.nextElementSibling;
            while (next) {
                if (next.tagName === 'LI') {
                    return next;
                }
                if (isList(next)) {
                    const firstInList = getFirstLiInList(next);
                    if (firstInList) {
                        return firstInList;
                    }
                }
                next = next.nextElementSibling;
            }
            let parentList = listItem.parentElement;
            let parentLi = parentList ? this.domUtils.getParentElement(parentList, 'LI') : null;
            while (parentLi) {
                let nextSibling = parentLi.nextElementSibling;
                while (nextSibling) {
                    if (nextSibling.tagName === 'LI') {
                        return nextSibling;
                    }
                    if (isList(nextSibling)) {
                        const firstInList = getFirstLiInList(nextSibling);
                        if (firstInList) {
                            return firstInList;
                        }
                    }
                    nextSibling = nextSibling.nextElementSibling;
                }
                parentList = parentLi.parentElement;
                parentLi = parentList ? this.domUtils.getParentElement(parentList, 'LI') : null;
            }
        }

        return null;
    }

    _placeCursorInListItemAtX(listItem, currentX, direction, selection) {
        if (!listItem || !selection) {
            return false;
        }

        const textNodes = this._getDirectTextNodes(listItem);
        if (textNodes.length === 0) {
            return this._placeCursorInEmptyListItem(listItem, selection, direction);
        }

        // 末尾の空白のみテキストノードを除外（ネストされたリストとの間の空白で
        // fullRectやlastNodeが不正確になるのを防ぐ）
        const contentTextNodes = textNodes.filter((node, i) => {
            if (i === 0) return true; // 最初のノードは常に保持
            const text = (node.textContent || '').replace(/[\u200B\uFEFF\u00A0]/g, '').trim();
            if (text !== '') return true;
            // 空白ノードの後に非空白ノードがあるか確認
            for (let j = i + 1; j < textNodes.length; j++) {
                const laterText = (textNodes[j].textContent || '').replace(/[\u200B\uFEFF\u00A0]/g, '').trim();
                if (laterText !== '') return true;
            }
            return false;
        });
        const effectiveTextNodes = contentTextNodes.length > 0 ? contentTextNodes : textNodes;

        const firstNode = effectiveTextNodes[0];
        const lastNode = effectiveTextNodes[effectiveTextNodes.length - 1];
        const fullRange = document.createRange();
        fullRange.setStart(firstNode, 0);
        fullRange.setEnd(lastNode, lastNode.textContent.length);
        const fullRect = fullRange.getBoundingClientRect();

        const hasHorizontalBounds = !!(fullRect && fullRect.width > 0);
        const isRightOfText = hasHorizontalBounds && currentX >= (fullRect.right - 1);
        const isLeftOfText = hasHorizontalBounds && currentX <= (fullRect.left + 1);

        const allowVisualProbeAtCurrentX = !isRightOfText && (!isLeftOfText || direction === 'up');
        if (fullRect && fullRect.height > 0 && document.caretRangeFromPoint && allowVisualProbeAtCurrentX) {
            let probeX = currentX;
            if (direction === 'up' && isLeftOfText && hasHorizontalBounds) {
                const minProbeX = fullRect.left + 0.5;
                const maxProbeX = fullRect.right - 0.5;
                if (Number.isFinite(minProbeX) && Number.isFinite(maxProbeX) && maxProbeX >= minProbeX) {
                    probeX = Math.max(minProbeX, Math.min(maxProbeX, currentX));
                } else if (Number.isFinite(fullRect.left)) {
                    probeX = fullRect.left + 0.5;
                }
            }
            const centerY = fullRect.top + (fullRect.height / 2);
            const primaryY = direction === 'up'
                ? Math.max(fullRect.top + 2, fullRect.bottom - 4)
                : centerY;
            const secondaryY = direction === 'up'
                ? centerY
                : Math.min(fullRect.bottom - 2, fullRect.top + 4);
            const probeYs = [primaryY, secondaryY];

            for (const y of probeYs) {
                if (!Number.isFinite(y)) continue;
                const caretRange = document.caretRangeFromPoint(probeX, y);
                if (!caretRange || !listItem.contains(caretRange.startContainer)) {
                    continue;
                }
                const container = caretRange.startContainer;
                if (container.nodeType === Node.TEXT_NODE && effectiveTextNodes.includes(container)) {
                    selection.removeAllRanges();
                    selection.addRange(caretRange);
                    return true;
                }
            }
        }

        const getCaretBoundaryX = (node, offset) => {
            if (!node || node.nodeType !== Node.TEXT_NODE) {
                return null;
            }
            const text = node.textContent || '';
            if (text.length === 0) {
                return null;
            }
            const safeOffset = Math.max(0, Math.min(offset, text.length));
            try {
                const boundaryRange = document.createRange();
                if (safeOffset <= 0) {
                    boundaryRange.setStart(node, 0);
                    boundaryRange.setEnd(node, 1);
                    const rect = boundaryRange.getBoundingClientRect();
                    return rect && Number.isFinite(rect.left) ? rect.left : null;
                }
                if (safeOffset >= text.length) {
                    boundaryRange.setStart(node, text.length - 1);
                    boundaryRange.setEnd(node, text.length);
                    const rect = boundaryRange.getBoundingClientRect();
                    return rect && Number.isFinite(rect.right) ? rect.right : null;
                }
                boundaryRange.setStart(node, safeOffset - 1);
                boundaryRange.setEnd(node, safeOffset);
                const rect = boundaryRange.getBoundingClientRect();
                return rect && Number.isFinite(rect.right) ? rect.right : null;
            } catch (e) {
                return null;
            }
        };

        const resolveOffsetByHorizontalX = () => {
            if (!hasHorizontalBounds || !Number.isFinite(currentX)) {
                return null;
            }
            if (currentX <= fullRect.left || currentX >= fullRect.right) {
                return null;
            }

            const nodeInfos = [];
            for (const node of effectiveTextNodes) {
                const text = node.textContent || '';
                if (text.length === 0) continue;
                try {
                    const nodeRange = document.createRange();
                    nodeRange.selectNodeContents(node);
                    const rect = nodeRange.getBoundingClientRect();
                    if (!rect || !Number.isFinite(rect.left) || !Number.isFinite(rect.right)) {
                        continue;
                    }
                    nodeInfos.push({ node, left: rect.left, right: rect.right });
                } catch (e) {
                    // ignore
                }
            }

            if (nodeInfos.length === 0) {
                return null;
            }

            let targetInfo = nodeInfos.find(info => currentX >= info.left - 1 && currentX <= info.right + 1) || null;
            if (!targetInfo) {
                targetInfo = nodeInfos[0];
                let minDistance = Infinity;
                for (const info of nodeInfos) {
                    const distance = currentX < info.left
                        ? (info.left - currentX)
                        : (currentX > info.right ? (currentX - info.right) : 0);
                    if (distance < minDistance) {
                        minDistance = distance;
                        targetInfo = info;
                    }
                }
            }

            const text = targetInfo.node.textContent || '';
            if (text.length === 0) {
                return { node: targetInfo.node, offset: 0 };
            }

            let bestOffset = 0;
            let bestDistance = Infinity;
            for (let offset = 0; offset <= text.length; offset++) {
                const x = getCaretBoundaryX(targetInfo.node, offset);
                if (!Number.isFinite(x)) continue;
                const distance = Math.abs(x - currentX);
                if (distance < bestDistance) {
                    bestDistance = distance;
                    bestOffset = offset;
                }
            }

            return { node: targetInfo.node, offset: bestOffset };
        };

        let targetNode = firstNode;
        let targetOffset = 0;
        if (fullRect && fullRect.width > 0) {
            const resolvedByX = direction === 'down' ? resolveOffsetByHorizontalX() : null;
            if (resolvedByX) {
                targetNode = resolvedByX.node;
                targetOffset = resolvedByX.offset;
            } else if (currentX >= fullRect.right) {
                targetNode = lastNode;
                targetOffset = lastNode.textContent.length;
            } else if (currentX <= fullRect.left) {
                targetNode = firstNode;
                targetOffset = 0;
            } else if (direction === 'up') {
                targetNode = lastNode;
                targetOffset = lastNode.textContent.length;
            }
        } else if (direction === 'up') {
            targetNode = lastNode;
            targetOffset = lastNode.textContent.length;
        }

        const newRange = document.createRange();
        newRange.setStart(targetNode, targetOffset);
        newRange.collapse(true);
        selection.removeAllRanges();
        selection.addRange(newRange);
        return true;
    }

    _getLastNavigableTextNode(root) {
        const scope = root || this.editor;
        if (!scope) {
            return null;
        }
        const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT, null, false);
        let node = walker.nextNode();
        let last = null;
        while (node) {
            if (!this._isIgnorableTextNode(node)) {
                last = node;
            }
            node = walker.nextNode();
        }
        return last;
    }

    _buildLogicalEditorEndRange() {
        const endRange = document.createRange();
        if (!this.editor) {
            return endRange;
        }

        const lastText = this._getLastNavigableTextNode(this.editor);
        if (lastText) {
            let anchor = lastText.parentElement;
            while (anchor && anchor !== this.editor && !this.domUtils.isBlockElement(anchor)) {
                anchor = anchor.parentElement;
            }
            if (!anchor || anchor === this.editor) {
                anchor = lastText.parentElement || this.editor;
            }

            let trailing = anchor && anchor !== this.editor
                ? this._getNextNavigableElementInDocument(anchor)
                : null;

            if (!trailing) {
                endRange.setStart(lastText, (lastText.textContent || '').length);
                endRange.collapse(true);
                return endRange;
            }

            // 空段落など、末尾の非テキストブロックも論理終端として扱う
            while (true) {
                const next = this._getNextNavigableElementInDocument(trailing);
                if (!next) break;
                trailing = next;
            }

            const trailingText = this._getLastNavigableTextNode(trailing);
            if (trailingText) {
                endRange.setStart(trailingText, (trailingText.textContent || '').length);
            } else if (trailing.tagName === 'HR') {
                endRange.setStartAfter(trailing);
            } else {
                endRange.setStart(trailing, trailing.childNodes.length);
            }
            endRange.collapse(true);
            return endRange;
        }

        let lastNode = this.editor.lastChild;
        while (lastNode) {
            if (lastNode.nodeType === Node.TEXT_NODE) {
                if (!this._isIgnorableTextNode(lastNode)) {
                    break;
                }
            } else if (lastNode.nodeType === Node.ELEMENT_NODE) {
                if (!this._isNavigationExcludedElement(lastNode)) {
                    break;
                }
            }
            lastNode = lastNode.previousSibling;
        }

        if (!lastNode) {
            endRange.setStart(this.editor, 0);
            endRange.collapse(true);
            return endRange;
        }

        if (lastNode.nodeType === Node.TEXT_NODE) {
            endRange.setStart(lastNode, (lastNode.textContent || '').length);
        } else {
            endRange.setStartAfter(lastNode);
        }
        endRange.collapse(true);
        return endRange;
    }

    isAtLogicalEditorEnd(selection = window.getSelection()) {
        if (!selection || !selection.rangeCount || !selection.isCollapsed) {
            return false;
        }
        const range = selection.getRangeAt(0);
        if (!this.editor || !this.editor.contains(range.startContainer)) {
            return false;
        }

        const current = document.createRange();
        current.setStart(range.startContainer, range.startOffset);
        current.collapse(true);
        const endRange = this._buildLogicalEditorEndRange();

        try {
            return current.compareBoundaryPoints(Range.START_TO_START, endRange) >= 0;
        } catch (e) {
            return false;
        }
    }

    _getCaretRect(range) {
        if (!range) {
            return null;
        }
        const container = range.startContainer;
        if (container && container.nodeType === Node.TEXT_NODE) {
            const text = container.textContent || '';
            if (text.length > 0) {
                const offset = Math.max(0, Math.min(range.startOffset, text.length));
                if (offset > 0) {
                    const temp = document.createRange();
                    temp.setStart(container, offset - 1);
                    temp.setEnd(container, offset);
                    const rect = temp.getBoundingClientRect();
                    if (rect && (rect.width || rect.height)) {
                        // The caret is at the RIGHT edge of the preceding character
                        return {
                            left: rect.right, right: rect.right,
                            top: rect.top, bottom: rect.bottom,
                            width: 0, height: rect.height,
                            x: rect.right, y: rect.y
                        };
                    }
                }
                if (offset < text.length) {
                    const temp = document.createRange();
                    temp.setStart(container, offset);
                    temp.setEnd(container, offset + 1);
                    const rect = temp.getBoundingClientRect();
                    if (rect && (rect.width || rect.height)) {
                        // The caret is at the LEFT edge of the following character
                        return {
                            left: rect.left, right: rect.left,
                            top: rect.top, bottom: rect.bottom,
                            width: 0, height: rect.height,
                            x: rect.left, y: rect.y
                        };
                    }
                }
            }
        }
        const shouldSkipDirectRects = container === this.editor;
        const rects = !shouldSkipDirectRects && range.getClientRects ? range.getClientRects() : null;
        if (rects && rects.length > 0) {
            for (let i = 0; i < rects.length; i++) {
                const rect = rects[i];
                if (rect && (rect.width || rect.height)) {
                    return rect;
                }
            }
        }
        const element = container && container.nodeType === Node.TEXT_NODE
            ? container.parentElement
            : container;
        if (element === this.editor) {
            const childNodes = this.editor.childNodes ? Array.from(this.editor.childNodes) : [];
            const childCount = childNodes.length;
            const safeOffset = Math.max(0, Math.min(range.startOffset, childCount));
            const isSkippableBoundaryNode = (node) => {
                if (!node) {
                    return true;
                }
                if (node.nodeType === Node.TEXT_NODE) {
                    return this._isIgnorableTextNode(node);
                }
                if (node.nodeType === Node.ELEMENT_NODE) {
                    return this._isNavigationExcludedElement(node);
                }
                return true;
            };
            const getBoundaryRect = (node, atEnd) => {
                if (!node) {
                    return null;
                }
                try {
                    const temp = document.createRange();
                    if (node.nodeType === Node.TEXT_NODE) {
                        const text = node.textContent || '';
                        if (text.length > 0) {
                            if (atEnd) {
                                temp.setStart(node, text.length - 1);
                                temp.setEnd(node, text.length);
                            } else {
                                temp.setStart(node, 0);
                                temp.setEnd(node, 1);
                            }
                        } else {
                            temp.setStart(node, 0);
                            temp.collapse(true);
                        }
                    } else if (node.nodeType === Node.ELEMENT_NODE) {
                        temp.selectNodeContents(node);
                        temp.collapse(!atEnd);
                    } else {
                        return null;
                    }

                    const tempRects = temp.getClientRects ? temp.getClientRects() : null;
                    if (tempRects && tempRects.length > 0) {
                        return atEnd ? tempRects[tempRects.length - 1] : tempRects[0];
                    }
                } catch (e) {
                    // fall through to bounding rect
                }
                if (node.getBoundingClientRect) {
                    const rect = node.getBoundingClientRect();
                    if (rect && (rect.width || rect.height)) {
                        return rect;
                    }
                }
                return null;
            };
            const findBoundaryRect = (startIndex, step, atEnd) => {
                for (let i = startIndex; i >= 0 && i < childCount; i += step) {
                    const candidate = childNodes[i];
                    if (isSkippableBoundaryNode(candidate)) {
                        continue;
                    }
                    const rect = getBoundaryRect(candidate, atEnd);
                    if (rect && (rect.width || rect.height)) {
                        return rect;
                    }
                }
                return null;
            };

            return findBoundaryRect(safeOffset - 1, -1, true) ||
                findBoundaryRect(safeOffset, 1, false) ||
                null;
        }
        if (element && element.getBoundingClientRect) {
            return element.getBoundingClientRect();
        }
        return range.getBoundingClientRect ? range.getBoundingClientRect() : null;
    }

    getCodeBlockCursorOffset(codeBlock, range) {
        const startContainer = range.startContainer;
        const startOffset = range.startOffset;
        let offset = 0;
        let found = false;

        const serializeNode = (node) => {
            if (node.nodeType === Node.TEXT_NODE) {
                return node.textContent || '';
            }
            if (node.nodeType !== Node.ELEMENT_NODE) {
                return '';
            }
            const tagName = node.tagName;
            if (tagName === 'BR') {
                return '\n';
            }
            let text = '';
            node.childNodes.forEach(child => {
                text += serializeNode(child);
            });
            if ((tagName === 'DIV' || tagName === 'P') && !text.endsWith('\n')) {
                text += '\n';
            }
            return text;
        };

        const walk = (node) => {
            if (found) {
                return;
            }
            if (node === startContainer) {
                if (node.nodeType === Node.TEXT_NODE) {
                    offset += Math.min(startOffset, node.textContent.length);
                } else if (node.nodeType === Node.ELEMENT_NODE && node.tagName === 'BR') {
                    offset += 1;
                } else if (node.nodeType === Node.ELEMENT_NODE) {
                    const children = Array.from(node.childNodes);
                    const limit = Math.min(startOffset, children.length);
                    for (let i = 0; i < limit; i++) {
                        offset += serializeNode(children[i]).length;
                    }
                }
                found = true;
                return;
            }

            if (node.nodeType === Node.TEXT_NODE) {
                offset += node.textContent.length;
                return;
            }
            if (node.nodeType !== Node.ELEMENT_NODE) {
                return;
            }
            if (node.tagName === 'BR') {
                offset += 1;
                return;
            }

            const children = Array.from(node.childNodes);
            for (const child of children) {
                walk(child);
                if (found) {
                    return;
                }
            }

            if (node.tagName === 'DIV' || node.tagName === 'P') {
                const children = node.childNodes;
                const hasTrailingNewline = children && children.length > 0 &&
                    this._serializedEndsWithNewline(children[children.length - 1]);
                if (!hasTrailingNewline) {
                    offset += 1;
                }
            }
        };

        walk(codeBlock);
        if (!found) {
            try {
                if (codeBlock.contains(startContainer) || startContainer === codeBlock) {
                    const tempRange = document.createRange();
                    tempRange.selectNodeContents(codeBlock);
                    tempRange.setEnd(startContainer, startOffset);
                    offset = tempRange.toString().length;
                    found = true;
                }
            } catch (e) {
                return null;
            }
        }

        if (!found) {
            return null;
        }

        if (range.collapsed) {
            const endRange = document.createRange();
            endRange.selectNodeContents(codeBlock);
            endRange.collapse(false);
            if (range.compareBoundaryPoints(Range.START_TO_START, endRange) === 0) {
                const fullLength = serializeNode(codeBlock).length;
                if (offset < fullLength) {
                    offset = fullLength;
                }
            }
        }

        return offset;
    }

    getCodeBlockText(codeBlock) {
        const serializeNode = (node) => {
            if (node.nodeType === Node.TEXT_NODE) {
                return node.textContent || '';
            }
            if (node.nodeType !== Node.ELEMENT_NODE) {
                return '';
            }
            const tagName = node.tagName;
            if (tagName === 'BR') {
                return '\n';
            }
            let text = '';
            node.childNodes.forEach(child => {
                text += serializeNode(child);
            });
            if ((tagName === 'DIV' || tagName === 'P') && !text.endsWith('\n')) {
                text += '\n';
            }
            return text;
        };

        return serializeNode(codeBlock);
    }

    getCodeBlockLineInfo(text, cursorOffset) {
        const lines = text.split('\n');
        const lineStartOffsets = [];
        let offset = 0;
        let currentLineIndex = 0;
        let column = 0;
        let found = false;

        for (let i = 0; i < lines.length; i++) {
            lineStartOffsets.push(offset);
            const lineLength = lines[i].length;
            const lineEnd = offset + lineLength;
            if (!found && cursorOffset <= lineEnd) {
                currentLineIndex = i;
                column = cursorOffset - offset;
                found = true;
            }
            offset = lineEnd + 1;
        }

        if (!found && lines.length > 0) {
            currentLineIndex = lines.length - 1;
            column = lines[currentLineIndex].length;
        }
        return { lines, lineStartOffsets, currentLineIndex, column };
    }

    setCodeBlockCursorOffset(codeBlock, selection, offset) {
        const safeOffset = Math.max(0, offset);
        let currentOffset = 0;
        let placed = false;

        const placeRange = (range) => {
            selection.removeAllRanges();
            selection.addRange(range);
            placed = true;
        };

        const walk = (node) => {
            if (placed) {
                return;
            }
            if (node.nodeType === Node.TEXT_NODE) {
                const text = node.textContent || '';
                if (currentOffset + text.length >= safeOffset) {
                    const offsetInNode = Math.max(0, safeOffset - currentOffset);
                    const newRange = document.createRange();
                    newRange.setStart(node, offsetInNode);
                    newRange.collapse(true);
                    placeRange(newRange);
                    return;
                }
                currentOffset += text.length;
                return;
            }
            if (node.nodeType !== Node.ELEMENT_NODE) {
                return;
            }
            if (node.tagName === 'BR') {
                if (currentOffset + 1 >= safeOffset) {
                    const newRange = document.createRange();
                    if (safeOffset <= currentOffset) {
                        newRange.setStartBefore(node);
                    } else {
                        newRange.setStartAfter(node);
                    }
                    newRange.collapse(true);
                    placeRange(newRange);
                    return;
                }
                currentOffset += 1;
                return;
            }

            const children = Array.from(node.childNodes);
            for (const child of children) {
                walk(child);
                if (placed) {
                    return;
                }
            }

            if (node.tagName === 'DIV' || node.tagName === 'P') {
                const children = node.childNodes;
                const hasTrailingNewline = children && children.length > 0 &&
                    this._serializedEndsWithNewline(children[children.length - 1]);
                if (!hasTrailingNewline) {
                    if (currentOffset + 1 >= safeOffset) {
                        const newRange = document.createRange();
                        newRange.setStart(node, node.childNodes.length);
                        newRange.collapse(true);
                        placeRange(newRange);
                        return;
                    }
                    currentOffset += 1;
                }
            }
        };

        walk(codeBlock);
        if (placed) {
            return true;
        }

        const lastTextNode = this.domUtils.getLastTextNode(codeBlock);
        if (lastTextNode) {
            const newRange = document.createRange();
            newRange.setStart(lastTextNode, lastTextNode.textContent.length);
            newRange.collapse(true);
            selection.removeAllRanges();
            selection.addRange(newRange);
            return true;
        }

        if (codeBlock) {
            const newRange = document.createRange();
            newRange.setStart(codeBlock, codeBlock.childNodes.length);
            newRange.collapse(true);
            selection.removeAllRanges();
            selection.addRange(newRange);
            return true;
        }

        return false;
    }

    /**
     * カーソルを上に1行移動
     * @param {Function} notifyCallback - 変更を通知するコールバック
     */
    moveCursorUp(notifyCallback) {
        const selection = window.getSelection();
        if (!selection || !selection.rangeCount) return;
        this._clearForwardImageStep();
        this._normalizeSelectionForNavigation(selection);
        const range = selection.getRangeAt(0);
        const container = range.startContainer;
        const originContainer = range.startContainer;
        const originOffset = range.startOffset;
        const restoreOriginalCaret = () => {
            if (!originContainer || !this.editor || !this.editor.contains(originContainer)) {
                return false;
            }
            try {
                const restoreRange = document.createRange();
                if (originContainer.nodeType === Node.TEXT_NODE) {
                    const textLength = (originContainer.textContent || '').length;
                    restoreRange.setStart(originContainer, Math.max(0, Math.min(originOffset, textLength)));
                } else if (originContainer.nodeType === Node.ELEMENT_NODE) {
                    const childCount = originContainer.childNodes ? originContainer.childNodes.length : 0;
                    restoreRange.setStart(originContainer, Math.max(0, Math.min(originOffset, childCount)));
                } else {
                    return false;
                }
                restoreRange.collapse(true);
                selection.removeAllRanges();
                selection.addRange(restoreRange);
                return true;
            } catch (e) {
                return false;
            }
        };
        const getBlockFromContainer = (node, offset = null) => {
            if (node === this.editor) {
                const children = Array.from(this.editor.childNodes || []);
                if (children.length === 0) {
                    return null;
                }
                const safeOffset = Math.max(0, Math.min(
                    Number.isInteger(offset) ? offset : 0,
                    children.length - 1
                ));
                const directChild = children[safeOffset] || children[children.length - 1];
                if (directChild && directChild.nodeType === Node.ELEMENT_NODE && this.domUtils.isBlockElement(directChild)) {
                    return directChild;
                }
                if (directChild && directChild.nodeType === Node.TEXT_NODE) {
                    return directChild.parentElement && directChild.parentElement !== this.editor
                        ? directChild.parentElement
                        : null;
                }
            }
            let block = node && node.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
            while (block && block !== this.editor && !this.domUtils.isBlockElement(block)) {
                block = block.parentElement;
            }
            return block && block !== this.editor ? block : null;
        };
        const getEstimatedLineHeight = (node, fallbackRect = null) => {
            const block = getBlockFromContainer(node);
            let lineHeight = NaN;
            if (block && window.getComputedStyle) {
                const style = window.getComputedStyle(block);
                if (style) {
                    lineHeight = Number.parseFloat(style.lineHeight);
                    if (!Number.isFinite(lineHeight) || lineHeight <= 0) {
                        const fontSize = Number.parseFloat(style.fontSize);
                        if (Number.isFinite(fontSize) && fontSize > 0) {
                            lineHeight = fontSize * 1.6;
                        }
                    }
                }
            }
            if ((!Number.isFinite(lineHeight) || lineHeight <= 0) && fallbackRect) {
                const rectHeight = Number.parseFloat(fallbackRect.height);
                if (Number.isFinite(rectHeight) && rectHeight > 0) {
                    lineHeight = rectHeight;
                }
            }
            if (!Number.isFinite(lineHeight) || lineHeight <= 0) {
                lineHeight = 18;
            }
            return Math.max(14, Math.min(lineHeight, 72));
        };
        const getVisualCaretRectForRange = (targetRange) => {
            if (!targetRange) {
                return null;
            }
            const baseRect = this._getCaretRect(targetRange);
            if (!baseRect || !targetRange.collapsed) {
                return baseRect;
            }
            const containerNode = targetRange.startContainer;
            if (!containerNode || containerNode.nodeType !== Node.TEXT_NODE) {
                return baseRect;
            }
            const text = containerNode.textContent || '';
            const offset = Math.max(0, Math.min(targetRange.startOffset, text.length));
            if (offset <= 0 || offset >= text.length) {
                return baseRect;
            }
            try {
                const prevRange = document.createRange();
                prevRange.setStart(containerNode, offset - 1);
                prevRange.setEnd(containerNode, offset);
                const prevRect = prevRange.getBoundingClientRect();

                const nextRange = document.createRange();
                nextRange.setStart(containerNode, offset);
                nextRange.setEnd(containerNode, offset + 1);
                const nextRect = nextRange.getBoundingClientRect();

                if (!prevRect || !nextRect) {
                    return baseRect;
                }

                const prevTop = prevRect.top || prevRect.y || 0;
                const nextTop = nextRect.top || nextRect.y || 0;
                if (nextTop > prevTop + 2) {
                    return {
                        left: nextRect.left,
                        right: nextRect.left,
                        top: nextRect.top,
                        bottom: nextRect.bottom,
                        width: 0,
                        height: nextRect.height,
                        x: nextRect.left,
                        y: nextRect.y
                    };
                }
            } catch (e) {
                // ignore and use base rect
            }
            return baseRect;
        };
        const getVisualLinesForBlock = (block) => {
            if (!block || block === this.editor) {
                return [];
            }
            try {
                const probeRange = document.createRange();
                probeRange.selectNodeContents(block);
                const rawRects = Array.from(probeRange.getClientRects ? probeRange.getClientRects() : []);
                const rects = rawRects
                    .filter(rect => rect &&
                        Number.isFinite(rect.top) &&
                        Number.isFinite(rect.bottom) &&
                        Number.isFinite(rect.left) &&
                        Number.isFinite(rect.right) &&
                        (rect.width || rect.height))
                    .sort((a, b) => {
                        if (Math.abs(a.top - b.top) <= 1.5) {
                            return a.left - b.left;
                        }
                        return a.top - b.top;
                    });
                if (rects.length === 0) {
                    return [];
                }

                const lines = [];
                for (const rect of rects) {
                    const lastLine = lines.length > 0 ? lines[lines.length - 1] : null;
                    if (!lastLine || Math.abs(lastLine.top - rect.top) > 3) {
                        lines.push({
                            top: rect.top,
                            bottom: rect.bottom,
                            left: rect.left,
                            right: rect.right
                        });
                        continue;
                    }
                    lastLine.top = Math.min(lastLine.top, rect.top);
                    lastLine.bottom = Math.max(lastLine.bottom, rect.bottom);
                    lastLine.left = Math.min(lastLine.left, rect.left);
                    lastLine.right = Math.max(lastLine.right, rect.right);
                }
                return lines;
            } catch (e) {
                return [];
            }
        };
        const findLineStartCaretInBlock = (block, line) => {
            if (!block || !line) {
                return null;
            }

            const pickCandidate = (skipWhitespace) => {
                const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, null, false);
                let textNode;
                let best = null;
                let guard = 0;
                while (textNode = walker.nextNode()) {
                    const text = textNode.textContent || '';
                    if (text.length === 0) continue;
                    for (let i = 0; i < text.length; i++) {
                        guard++;
                        if (guard > 12000) {
                            return best;
                        }
                        const ch = text[i];
                        if (ch === '\n' || ch === '\r' || ch === '\u200B' || ch === '\uFEFF') {
                            continue;
                        }
                        if (skipWhitespace && /\s/.test(ch)) {
                            continue;
                        }
                        let charRect = null;
                        try {
                            const charRange = document.createRange();
                            charRange.setStart(textNode, i);
                            charRange.setEnd(textNode, i + 1);
                            charRect = charRange.getBoundingClientRect();
                        } catch (e) {
                            continue;
                        }
                        if (!charRect || !(charRect.width || charRect.height)) {
                            continue;
                        }
                        const charTop = charRect.top || charRect.y || 0;
                        const charBottom = charRect.bottom || (charRect.y + charRect.height) || charTop;
                        const overlapsTargetLine = charBottom >= line.top - 2 && charTop <= line.bottom + 2;
                        if (!overlapsTargetLine) {
                            continue;
                        }
                        const charLeft = charRect.left || charRect.x || 0;
                        if (!best || charLeft < best.left - 0.5 ||
                            (Math.abs(charLeft - best.left) <= 0.5 && charTop < best.top)) {
                            best = {
                                node: textNode,
                                offset: i,
                                left: charLeft,
                                top: charTop
                            };
                        }
                    }
                }
                return best;
            };

            return pickCandidate(true) || pickCandidate(false);
        };

        let currentListItem = this._getListItemFromContainer(container, range.startOffset, 'up') ||
            this.domUtils.getParentElement(container, 'LI');

        // コードブロック内かチェック
        const codeBlock = this.domUtils.getParentElement(container, 'CODE');
        const preBlock = codeBlock ? this.domUtils.getParentElement(codeBlock, 'PRE') : null;

        if (preBlock && codeBlock) {
            const text = this.getCodeBlockText(codeBlock);
            const cursorOffset = this.getCodeBlockCursorOffset(codeBlock, range);
            if (cursorOffset !== null) {
                const { lines, lineStartOffsets, currentLineIndex, column } =
                    this.getCodeBlockLineInfo(text, cursorOffset);

                if (currentLineIndex === 0) {
                    // コードブロックから出る
                    let prevElement = preBlock.previousSibling;

                    // 空白のみのテキストノードをスキップ
                    while (prevElement && prevElement.nodeType === 3 && prevElement.textContent.trim() === '') {
                        prevElement = prevElement.previousSibling;
                    }
                    while (prevElement && prevElement.nodeType === 1 && this._isNavigationExcludedElement(prevElement)) {
                        prevElement = prevElement.previousSibling;
                        while (prevElement && prevElement.nodeType === 3 && prevElement.textContent.trim() === '') {
                            prevElement = prevElement.previousSibling;
                        }
                    }

                    // 前の要素がある場合、そこにカーソルを移動
                    if (prevElement && prevElement.nodeType === 1) {
                        const newRange = document.createRange();
                        const lastNode = this.domUtils.getLastTextNode(prevElement);
                        if (lastNode) {
                            newRange.setStart(lastNode, lastNode.textContent.length);
                        } else {
                            newRange.setStart(prevElement, prevElement.childNodes.length);
                        }
                        newRange.collapse(true);
                        selection.removeAllRanges();
                        selection.addRange(newRange);
                    } else {
                        // 新しい段落を作成
                        const newP = document.createElement('p');
                        newP.appendChild(document.createElement('br'));

                        preBlock.parentElement.insertBefore(newP, preBlock);

                        const newRange = document.createRange();
                        newRange.setStart(newP, 0);
                        newRange.collapse(true);
                        selection.removeAllRanges();
                        selection.addRange(newRange);

                        if (notifyCallback) notifyCallback();
                    }

                    return;
                }

                const targetLineIndex = currentLineIndex - 1;
                const targetOffset = lineStartOffsets[targetLineIndex] +
                    Math.min(column, lines[targetLineIndex].length);
                if (this.setCodeBlockCursorOffset(codeBlock, selection, targetOffset)) {
                    return;
                }
            }
        }

        const tryMoveWithinCurrentBlockByVisualLine = () => {
            if (!range || !range.collapsed || !document.caretRangeFromPoint) {
                return false;
            }
            if (currentListItem || preBlock) {
                return false;
            }

            const currentBlock = getBlockFromContainer(range.startContainer, range.startOffset);
            if (!currentBlock || currentBlock === this.editor) {
                return false;
            }
            if (currentBlock.tagName === 'LI' ||
                currentBlock.tagName === 'PRE' ||
                currentBlock.tagName === 'TD' ||
                currentBlock.tagName === 'TH') {
                return false;
            }

            const lines = getVisualLinesForBlock(currentBlock);
            if (lines.length < 2) {
                return false;
            }

            const currentRect = getVisualCaretRectForRange(range);
            if (!currentRect) {
                return false;
            }
            const currentTop = currentRect.top || currentRect.y || 0;
            let currentIndex = 0;
            let minDistance = Infinity;
            for (let i = 0; i < lines.length; i++) {
                const distance = Math.abs(lines[i].top - currentTop);
                if (distance < minDistance) {
                    minDistance = distance;
                    currentIndex = i;
                }
            }
            if (currentIndex <= 0) {
                return false;
            }

            const currentLine = lines[currentIndex];
            const targetLine = lines[currentIndex - 1];
            if (!targetLine) {
                return false;
            }

            const currentX = currentRect.left || currentRect.x || 0;
            const atCurrentLineStart = !!currentLine && currentX <= (currentLine.left + 2);
            if (atCurrentLineStart) {
                const lineStartCaret = findLineStartCaretInBlock(currentBlock, targetLine);
                if (lineStartCaret) {
                    const startRange = document.createRange();
                    startRange.setStart(lineStartCaret.node, lineStartCaret.offset);
                    startRange.collapse(true);
                    selection.removeAllRanges();
                    selection.addRange(startRange);
                    return true;
                }
            }

            const targetHeight = Math.max(1, targetLine.bottom - targetLine.top);
            const targetY = targetLine.top + Math.max(1, Math.min(targetHeight * 0.5, targetHeight - 1));
            const xCandidates = atCurrentLineStart
                ? [
                    targetLine.left + 0.5,
                    targetLine.left + 1.5,
                    currentX,
                    currentX + 1
                ]
                : [
                    currentX + 1,
                    currentX,
                    targetLine.left + 1,
                    Math.min(targetLine.right - 1, Math.max(targetLine.left + 1, currentX + 8))
                ];
            const tried = new Set();
            let selectedRange = null;
            let selectedScore = Infinity;

            const trySelectRange = (probeRange) => {
                if (!probeRange || !this.editor.contains(probeRange.startContainer)) {
                    return false;
                }
                if (!currentBlock.contains(probeRange.startContainer)) {
                    return false;
                }
                const probeRect = getVisualCaretRectForRange(probeRange);
                if (!probeRect) {
                    return false;
                }
                const probeTop = probeRect.top || probeRect.y || 0;
                if (probeTop < targetLine.top - 3 || probeTop > targetLine.bottom + 3) {
                    return false;
                }
                const probeLeft = probeRect.left || probeRect.x || 0;
                const score = atCurrentLineStart ? probeLeft : Math.abs(probeLeft - currentX);
                if (!selectedRange || score < selectedScore) {
                    selectedRange = probeRange;
                    selectedScore = score;
                }
                return true;
            };

            for (const x of xCandidates) {
                if (!Number.isFinite(x)) continue;
                const key = Math.round(x * 10) / 10;
                if (tried.has(key)) continue;
                tried.add(key);
                const probeRange = document.caretRangeFromPoint(x, targetY);
                trySelectRange(probeRange);
            }

            if (atCurrentLineStart) {
                for (let dx = 0; dx <= 16; dx += 1) {
                    const probeRange = document.caretRangeFromPoint(targetLine.left + dx, targetY);
                    trySelectRange(probeRange);
                }
            }

            if (selectedRange) {
                selection.removeAllRanges();
                selection.addRange(selectedRange);
                return true;
            }
            return false;
        };
        if (tryMoveWithinCurrentBlockByVisualLine()) {
            return;
        }

        // 画像左エッジ（画像直前）からの↑は、画像選択に入らず前ブロック末尾へ移動する。
        // 上行 <-> 画像左エッジ の往復を安定化する。
        if (range.collapsed) {
            const imageAhead = this._getImageAheadFromCollapsedRange(range);
            if (imageAhead) {
                let imageBlock = imageAhead.nodeType === Node.ELEMENT_NODE ? imageAhead : imageAhead.parentElement;
                while (imageBlock && imageBlock !== this.editor && !this.domUtils.isBlockElement(imageBlock)) {
                    imageBlock = imageBlock.parentElement;
                }
                const boundaryNode = (imageBlock && imageBlock !== this.editor) ? imageBlock : imageAhead;
                const leadingImage = (imageBlock && imageBlock !== this.editor)
                    ? this._getLeadingImageInBlock(imageBlock)
                    : (imageAhead.parentElement === this.editor ? imageAhead : null);
                const isAtImageLeftEdge =
                    leadingImage === imageAhead &&
                    (
                        this._isCollapsedRangeAtNodeBoundary(range, imageAhead, 'before') ||
                        (boundaryNode !== imageAhead &&
                            this._isCollapsedRangeAtNodeBoundary(range, boundaryNode, 'before'))
                    );

                if (isAtImageLeftEdge) {
                    const prevElement = this._getPrevNavigableElementInDocument(boundaryNode);
                    if (prevElement) {
                        if (prevElement.tagName === 'PRE' && this._selectCodeBlockLanguageLabel(prevElement, selection)) {
                            return;
                        }
                        if (prevElement.tagName === 'HR') {
                            const hrRange = document.createRange();
                            hrRange.selectNode(prevElement);
                            selection.removeAllRanges();
                            selection.addRange(hrRange);
                            return;
                        }

                        const boundaryRect = boundaryNode.getBoundingClientRect
                            ? boundaryNode.getBoundingClientRect()
                            : null;
                        const rangeRect = getVisualCaretRectForRange(range);
                        const baseX = boundaryRect && Number.isFinite(boundaryRect.left)
                            ? boundaryRect.left + 1
                            : ((rangeRect ? (rangeRect.left || rangeRect.x || 0) : 0) + 1);

                        // If the previous target is a list (or inside a list), use list-specific
                        // vertical placement first so image-left-edge -> up lands on the last
                        // visual line of the list item instead of its first line.
                        const prevListItem = (() => {
                            if (!prevElement || prevElement.nodeType !== Node.ELEMENT_NODE) {
                                return null;
                            }
                            if (prevElement.tagName === 'LI') {
                                return prevElement;
                            }
                            if (prevElement.tagName === 'UL' || prevElement.tagName === 'OL') {
                                const listItems = prevElement.querySelectorAll('li');
                                return listItems.length > 0 ? listItems[listItems.length - 1] : null;
                            }
                            return this.domUtils.getParentElement(prevElement, 'LI');
                        })();
                        if (prevListItem && this._placeCursorInListItemAtX(prevListItem, baseX, 'up', selection)) {
                            return;
                        }

                        const prevLines = getVisualLinesForBlock(prevElement);
                        if (prevLines.length > 0 && document.caretRangeFromPoint) {
                            const targetLine = prevLines[prevLines.length - 1];
                            const targetHeight = Math.max(1, targetLine.bottom - targetLine.top);
                            const targetY = targetLine.top + Math.max(1, Math.min(targetHeight * 0.5, targetHeight - 1));
                            const xCandidates = [
                                Math.max(targetLine.left + 0.5, Math.min(targetLine.right - 0.5, baseX)),
                                targetLine.left + 0.5,
                                baseX
                            ];

                            let selectedRange = null;
                            let selectedScore = Infinity;
                            for (const x of xCandidates) {
                                if (!Number.isFinite(x)) {
                                    continue;
                                }
                                const probeRange = document.caretRangeFromPoint(x, targetY);
                                if (!probeRange || !prevElement.contains(probeRange.startContainer)) {
                                    continue;
                                }
                                const probeRect = getVisualCaretRectForRange(probeRange);
                                if (!probeRect) {
                                    continue;
                                }
                                const probeTop = probeRect.top || probeRect.y || 0;
                                if (probeTop < targetLine.top - 3 || probeTop > targetLine.bottom + 3) {
                                    continue;
                                }
                                const probeLeft = probeRect.left || probeRect.x || 0;
                                const score = Math.abs(probeLeft - baseX);
                                if (!selectedRange || score < selectedScore) {
                                    selectedRange = probeRange;
                                    selectedScore = score;
                                }
                            }

                            if (selectedRange) {
                                selection.removeAllRanges();
                                selection.addRange(selectedRange);
                                return;
                            }

                            const lineStartCaret = findLineStartCaretInBlock(prevElement, targetLine);
                            if (lineStartCaret) {
                                const startRange = document.createRange();
                                startRange.setStart(lineStartCaret.node, lineStartCaret.offset);
                                startRange.collapse(true);
                                selection.removeAllRanges();
                                selection.addRange(startRange);
                                return;
                            }
                        }

                        const newRange = document.createRange();
                        const lastNode = this._getLastNavigableTextNode(prevElement);
                        if (lastNode) {
                            newRange.setStart(lastNode, lastNode.textContent.length);
                        } else {
                            newRange.setStart(prevElement, prevElement.childNodes.length);
                        }
                        newRange.collapse(true);
                        selection.removeAllRanges();
                        selection.addRange(newRange);
                    }
                    return;
                }
            }
        }

        {
            const isEffectivelyEmptyBlock = (block) => {
                if (!block) return false;
                const text = (block.textContent || '').replace(/[\u200B\uFEFF\u00A0]/g, '').trim();
                if (text !== '') return false;
                const meaningfulChild = Array.from(block.childNodes).some(node => {
                    if (node.nodeType === Node.ELEMENT_NODE) {
                        if (node.tagName === 'BR') return false;
                        if (this._isNavigationExcludedElement(node)) return false;
                        return true;
                    }
                    if (node.nodeType === Node.TEXT_NODE) {
                        return !this._isIgnorableTextNode(node);
                    }
                    return false;
                });
                return !meaningfulChild;
            };

            let currentBlock = container.nodeType === Node.ELEMENT_NODE ? container : container.parentElement;
            if (currentBlock === this.editor) {
                const children = Array.from(this.editor.childNodes || []);
                const direct = children[range.startOffset] || null;
                if (direct && direct.nodeType === Node.ELEMENT_NODE &&
                    this.domUtils.isBlockElement(direct) &&
                    isEffectivelyEmptyBlock(direct)) {
                    currentBlock = direct;
                } else {
                    let index = range.startOffset;
                    if (index > 0) {
                        index = index - 1;
                    }
                    if (children.length === 0) {
                        index = -1;
                    } else if (index >= children.length) {
                        index = children.length - 1;
                    }
                    let candidate = null;
                    for (let i = index; i >= 0; i--) {
                        const node = children[i];
                        if (!node) continue;
                        if (node.nodeType === Node.TEXT_NODE) {
                            if (!this._isIgnorableTextNode(node)) {
                                candidate = node;
                                break;
                            }
                            continue;
                        }
                        if (node.nodeType === Node.ELEMENT_NODE) {
                            if (!this._isNavigationExcludedElement(node)) {
                                candidate = node;
                                break;
                            }
                        }
                    }
                    if (!candidate && index >= 0 && index < children.length) {
                        candidate = children[index];
                    }
                    if (candidate && candidate.nodeType === Node.TEXT_NODE) {
                        candidate = candidate.parentElement;
                    }
                    if (candidate && candidate.nodeType === Node.ELEMENT_NODE) {
                        currentBlock = candidate;
                    }
                }
            }
            while (currentBlock && currentBlock !== this.editor &&
                !this.domUtils.isBlockElement(currentBlock) &&
                currentBlock.tagName !== 'TD' && currentBlock.tagName !== 'TH') {
                currentBlock = currentBlock.parentElement;
            }
            if (currentBlock && currentBlock !== this.editor && currentBlock.tagName !== 'LI' && isEffectivelyEmptyBlock(currentBlock)) {
                // LIの場合はリスト固有のナビゲーション（_getAdjacentListItem）に任せる
                let prevElement = this._getPrevNavigableElementSibling(currentBlock);
                if (!prevElement) {
                    prevElement = this._getPrevNavigableElementInDocument(currentBlock);
                }
                if (prevElement) {
                    if (prevElement.tagName === 'UL' || prevElement.tagName === 'OL') {
                        const listItems = prevElement.querySelectorAll('li');
                        const targetLi = listItems.length > 0 ? listItems[listItems.length - 1] : null;
                        if (targetLi) {
                            let targetNode = this._getFirstDirectTextNode(targetLi) || this._getLastDirectTextNode(targetLi);
                            if (!targetNode) {
                                this._placeCursorInEmptyListItem(targetLi, selection, 'up');
                                return;
                            }
                            const newRange = document.createRange();
                            newRange.setStart(targetNode, 0);
                            newRange.collapse(true);
                            selection.removeAllRanges();
                            selection.addRange(newRange);
                            return;
                        }
                    }
                    if (prevElement.tagName === 'PRE' && this._selectCodeBlockLanguageLabel(prevElement, selection)) {
                        return;
                    }
                    if (prevElement.tagName === 'HR') {
                        const newRange = document.createRange();
                        newRange.selectNode(prevElement);
                        selection.removeAllRanges();
                        selection.addRange(newRange);
                        return;
                    }
                    // Empty line directly below an image should move to the image left edge.
                    // Placing the caret at element offset 0 can land before wrapper whitespace
                    // in some engines, which appears as jumping to the line above the image.
                    const imageTarget = this._getImageFromNavigationCandidate(prevElement);
                    if (imageTarget) {
                        const imageRange = document.createRange();
                        if (this._collapseRangeBeforeNode(imageRange, imageTarget)) {
                            selection.removeAllRanges();
                            selection.addRange(imageRange);
                            return;
                        }
                    }
                    const currentRectForEmptyUp = getVisualCaretRectForRange(range);
                    const baseXForEmptyUp = currentRectForEmptyUp
                        ? (currentRectForEmptyUp.left || currentRectForEmptyUp.x || 0)
                        : 0;

                    if (prevElement.tagName === 'LI' &&
                        this._placeCursorInListItemAtX(prevElement, baseXForEmptyUp, 'up', selection)) {
                        return;
                    }

                    // 空行から上移動する場合は、前ブロックの先頭ではなく最終表示行へ移動する。
                    const prevLines = getVisualLinesForBlock(prevElement);
                    if (prevLines.length > 0 && document.caretRangeFromPoint) {
                        const targetLine = prevLines[prevLines.length - 1];
                        const targetHeight = Math.max(1, targetLine.bottom - targetLine.top);
                        const targetY = targetLine.top + Math.max(1, Math.min(targetHeight * 0.5, targetHeight - 1));
                        const atTargetLineStart = baseXForEmptyUp <= (targetLine.left + 2);
                        const xCandidates = atTargetLineStart
                            ? [
                                targetLine.left + 0.5,
                                targetLine.left + 1.5,
                                baseXForEmptyUp,
                                baseXForEmptyUp + 1
                            ]
                            : [
                                Math.max(targetLine.left + 0.5, Math.min(targetLine.right - 0.5, baseXForEmptyUp)),
                                baseXForEmptyUp,
                                targetLine.left + 0.5
                            ];

                        let selectedRange = null;
                        let selectedScore = Infinity;
                        const tried = new Set();
                        for (const x of xCandidates) {
                            if (!Number.isFinite(x)) {
                                continue;
                            }
                            const key = Math.round(x * 10) / 10;
                            if (tried.has(key)) {
                                continue;
                            }
                            tried.add(key);
                            const probeRange = document.caretRangeFromPoint(x, targetY);
                            if (!probeRange || !prevElement.contains(probeRange.startContainer)) {
                                continue;
                            }
                            const probeRect = getVisualCaretRectForRange(probeRange);
                            if (!probeRect) {
                                continue;
                            }
                            const probeTop = probeRect.top || probeRect.y || 0;
                            if (probeTop < targetLine.top - 3 || probeTop > targetLine.bottom + 3) {
                                continue;
                            }
                            const probeLeft = probeRect.left || probeRect.x || 0;
                            const score = atTargetLineStart ? probeLeft : Math.abs(probeLeft - baseXForEmptyUp);
                            if (!selectedRange || score < selectedScore) {
                                selectedRange = probeRange;
                                selectedScore = score;
                            }
                        }

                        if (atTargetLineStart) {
                            const lineStartCaret = findLineStartCaretInBlock(prevElement, targetLine);
                            if (lineStartCaret) {
                                const startRange = document.createRange();
                                startRange.setStart(lineStartCaret.node, lineStartCaret.offset);
                                startRange.collapse(true);
                                selection.removeAllRanges();
                                selection.addRange(startRange);
                                return;
                            }
                        }

                        if (selectedRange) {
                            selection.removeAllRanges();
                            selection.addRange(selectedRange);
                            return;
                        }
                    }

                    const newRange = document.createRange();
                    const lastNode = this._getLastNavigableTextNode(prevElement);
                    if (lastNode) {
                        newRange.setStart(lastNode, 0);
                    } else {
                        newRange.setStart(prevElement, 0);
                    }
                    newRange.collapse(true);
                    selection.removeAllRanges();
                    selection.addRange(newRange);
                    return;
                }
            }
        }

        // デフォルトの動作：カーソルを上に移動
        let rect = getVisualCaretRectForRange(range);
        if (!rect) {
            return;
        }

        const estimatedLineHeight = getEstimatedLineHeight(range.startContainer, rect);
        const currentX = rect.left || rect.x || 0;
        const currentY = rect.top || rect.y || 0;
        const lineStep = estimatedLineHeight;
        const isCursorRightOfListItemText = (listItem, x) => {
            if (!listItem) {
                return false;
            }
            const firstNode = this._getFirstDirectTextNode(listItem);
            const lastNode = this._getLastDirectTextNode(listItem);
            if (!firstNode || !lastNode) {
                return true;
            }
            try {
                const textRange = document.createRange();
                textRange.setStart(firstNode, 0);
                textRange.setEnd(lastNode, (lastNode.textContent || '').length);
                const textRect = textRange.getBoundingClientRect();
                if (textRect && textRect.width > 0) {
                    return x > textRect.right + 1;
                }
            } catch (e) {
                return false;
            }
            return false;
        };

        // 空のリストアイテムでは _getCaretRect が要素全体の bounding rect を返すため、
        // elementFromPoint や caretRangeFromPoint による視覚ナビゲーションが不安定になる。
        // 構造ベースのナビゲーションを直接使用する。
        if (currentListItem && range.collapsed) {
            const directTextForEmpty = this._getFirstDirectTextNode(currentListItem);
            const hasRealText = directTextForEmpty &&
                (directTextForEmpty.textContent || '').replace(/[\u200B\uFEFF\u00A0]/g, '').trim() !== '';
            if (!hasRealText) {
                const prevListItem = this._getAdjacentListItem(currentListItem, 'prev');
                if (prevListItem) {
                    this._placeCursorInListItemAtX(prevListItem, currentX, 'up', selection);
                    return;
                }
            }
        }

        // DOMレンジが親LI境界に寄るケースがあるため、見た目位置からLIを再解決する。
        if (document.elementFromPoint) {
            const probeX = currentX + 1;
            const probeY = currentY + Math.max(1, Math.min(8, (rect.height || 16) * 0.5));
            const visualNode = document.elementFromPoint(probeX, probeY);
            if (visualNode && this.editor.contains(visualNode)) {
                const visualListItem =
                    (visualNode.nodeType === Node.ELEMENT_NODE && visualNode.tagName === 'LI')
                        ? visualNode
                        : this.domUtils.getParentElement(visualNode, 'LI');
                if (visualListItem) {
                    currentListItem = visualListItem;
                }
            }
        }

        const getVisualLinesForListItemText = (listItem) => {
            if (!listItem) {
                return [];
            }
            const textNodes = this._getDirectTextNodes(listItem);
            if (textNodes.length === 0) {
                return [];
            }
            const firstNode = textNodes[0];
            const lastNode = textNodes[textNodes.length - 1];
            try {
                const probeRange = document.createRange();
                probeRange.setStart(firstNode, 0);
                probeRange.setEnd(lastNode, (lastNode.textContent || '').length);
                const rawRects = Array.from(probeRange.getClientRects ? probeRange.getClientRects() : []);
                const rects = rawRects
                    .filter(r => r &&
                        Number.isFinite(r.top) &&
                        Number.isFinite(r.bottom) &&
                        Number.isFinite(r.left) &&
                        Number.isFinite(r.right) &&
                        (r.width || r.height))
                    .sort((a, b) => {
                        if (Math.abs(a.top - b.top) <= 1.5) {
                            return a.left - b.left;
                        }
                        return a.top - b.top;
                    });
                if (rects.length === 0) {
                    return [];
                }
                const lines = [];
                for (const rect of rects) {
                    const lastLine = lines.length > 0 ? lines[lines.length - 1] : null;
                    if (!lastLine || Math.abs(lastLine.top - rect.top) > 3) {
                        lines.push({
                            top: rect.top,
                            bottom: rect.bottom,
                            left: rect.left,
                            right: rect.right
                        });
                        continue;
                    }
                    lastLine.top = Math.min(lastLine.top, rect.top);
                    lastLine.bottom = Math.max(lastLine.bottom, rect.bottom);
                    lastLine.left = Math.min(lastLine.left, rect.left);
                    lastLine.right = Math.max(lastLine.right, rect.right);
                }
                return lines;
            } catch (e) {
                return [];
            }
        };
        const isRangeInsideDirectListText = (probeRange, listItem, textNodes) => {
            if (!probeRange || !listItem || !textNodes || textNodes.length === 0) {
                return false;
            }
            const startContainer = probeRange.startContainer;
            if (!startContainer || !listItem.contains(startContainer)) {
                return false;
            }
            if (startContainer.nodeType === Node.TEXT_NODE && textNodes.includes(startContainer)) {
                return true;
            }
            let current = startContainer.nodeType === Node.ELEMENT_NODE
                ? startContainer
                : startContainer.parentElement;
            while (current && current !== listItem) {
                if (current.tagName === 'UL' || current.tagName === 'OL') {
                    return false;
                }
                current = current.parentElement;
            }
            return current === listItem;
        };
        const findLineStartCaretInListItem = (listItem, textNodes, line) => {
            if (!listItem || !textNodes || textNodes.length === 0 || !line) {
                return null;
            }
            const pickCandidate = (skipWhitespace) => {
                let best = null;
                let guard = 0;
                for (const textNode of textNodes) {
                    const text = textNode.textContent || '';
                    if (text.length === 0) continue;
                    for (let i = 0; i < text.length; i++) {
                        guard++;
                        if (guard > 12000) {
                            return best;
                        }
                        const ch = text[i];
                        if (ch === '\n' || ch === '\r' || ch === '\u200B' || ch === '\uFEFF') {
                            continue;
                        }
                        if (skipWhitespace && /\s/.test(ch)) {
                            continue;
                        }
                        let charRect = null;
                        try {
                            const charRange = document.createRange();
                            charRange.setStart(textNode, i);
                            charRange.setEnd(textNode, i + 1);
                            charRect = charRange.getBoundingClientRect();
                        } catch (e) {
                            continue;
                        }
                        if (!charRect || !(charRect.width || charRect.height)) {
                            continue;
                        }
                        const charTop = charRect.top || charRect.y || 0;
                        const charBottom = charRect.bottom || (charRect.y + charRect.height) || charTop;
                        const overlapsTargetLine = charBottom >= line.top - 2 && charTop <= line.bottom + 2;
                        if (!overlapsTargetLine) {
                            continue;
                        }
                        const charLeft = charRect.left || charRect.x || 0;
                        if (!best || charLeft < best.left - 0.5 ||
                            (Math.abs(charLeft - best.left) <= 0.5 && charTop < best.top)) {
                            best = {
                                node: textNode,
                                offset: i,
                                left: charLeft,
                                top: charTop
                            };
                        }
                    }
                }
                return best;
            };
            return pickCandidate(true) || pickCandidate(false);
        };
        const tryMoveWithinCurrentListItemByVisualLine = () => {
            if (!range || !range.collapsed || !currentListItem || !document.caretRangeFromPoint) {
                return false;
            }
            const textNodes = this._getDirectTextNodes(currentListItem);
            if (textNodes.length === 0) {
                return false;
            }
            const lines = getVisualLinesForListItemText(currentListItem);
            if (lines.length < 2) {
                return false;
            }
            const currentRect = getVisualCaretRectForRange(range);
            if (!currentRect) {
                return false;
            }
            const currentTop = currentRect.top || currentRect.y || 0;
            let currentIndex = 0;
            let minDistance = Infinity;
            for (let i = 0; i < lines.length; i++) {
                const distance = Math.abs(lines[i].top - currentTop);
                if (distance < minDistance) {
                    minDistance = distance;
                    currentIndex = i;
                }
            }
            if (currentIndex <= 0) {
                return false;
            }

            const currentLine = lines[currentIndex];
            const targetLine = lines[currentIndex - 1];
            if (!targetLine) {
                return false;
            }
            const atCurrentLineStart = (currentRect.left || currentRect.x || 0) <= (currentLine.left + 2);
            if (atCurrentLineStart) {
                const lineStartCaret = findLineStartCaretInListItem(currentListItem, textNodes, targetLine);
                if (lineStartCaret) {
                    const startRange = document.createRange();
                    startRange.setStart(lineStartCaret.node, lineStartCaret.offset);
                    startRange.collapse(true);
                    selection.removeAllRanges();
                    selection.addRange(startRange);
                    return true;
                }
            }

            const currentCaretX = currentRect.left || currentRect.x || 0;
            const targetHeight = Math.max(1, targetLine.bottom - targetLine.top);
            const targetY = targetLine.top + Math.max(1, Math.min(targetHeight * 0.5, targetHeight - 1));
            const xCandidates = atCurrentLineStart
                ? [
                    targetLine.left + 0.5,
                    targetLine.left + 1.5,
                    currentCaretX,
                    currentCaretX + 1
                ]
                : [
                    currentCaretX + 1,
                    currentCaretX,
                    targetLine.left + 1,
                    Math.min(targetLine.right - 1, Math.max(targetLine.left + 1, currentCaretX + 8))
                ];
            const tried = new Set();
            let selectedRange = null;
            let selectedScore = Infinity;

            const trySelectRange = (probeRange) => {
                if (!probeRange || !this.editor.contains(probeRange.startContainer)) {
                    return false;
                }
                if (!isRangeInsideDirectListText(probeRange, currentListItem, textNodes)) {
                    return false;
                }
                const probeRect = getVisualCaretRectForRange(probeRange);
                if (!probeRect) {
                    return false;
                }
                const probeTop = probeRect.top || probeRect.y || 0;
                if (probeTop < targetLine.top - 3 || probeTop > targetLine.bottom + 3) {
                    return false;
                }
                const probeLeft = probeRect.left || probeRect.x || 0;
                const score = atCurrentLineStart ? probeLeft : Math.abs(probeLeft - currentCaretX);
                if (!selectedRange || score < selectedScore) {
                    selectedRange = probeRange;
                    selectedScore = score;
                }
                return true;
            };

            for (const x of xCandidates) {
                if (!Number.isFinite(x)) continue;
                const key = Math.round(x * 10) / 10;
                if (tried.has(key)) continue;
                tried.add(key);
                const probeRange = document.caretRangeFromPoint(x, targetY);
                trySelectRange(probeRange);
            }
            if (atCurrentLineStart) {
                for (let dx = 0; dx <= 16; dx += 1) {
                    const probeRange = document.caretRangeFromPoint(targetLine.left + dx, targetY);
                    trySelectRange(probeRange);
                }
            }

            if (selectedRange) {
                selection.removeAllRanges();
                selection.addRange(selectedRange);
                return true;
            }
            return false;
        };
        if (tryMoveWithinCurrentListItemByVisualLine()) {
            return;
        }

        const isListItemSingleVisualLine = (listItem) => {
            if (!listItem) return false;
            const firstDirectText = this._getFirstDirectTextNode(listItem);
            const lastDirectText = this._getLastDirectTextNode(listItem);
            if (!firstDirectText || !lastDirectText) return true;
            try {
                const probeRange = document.createRange();
                const firstText = firstDirectText.textContent || '';
                const startOffset = this._getFirstNonZwspOffset(firstText);
                probeRange.setStart(firstDirectText, startOffset !== null ? startOffset : 0);
                probeRange.setEnd(lastDirectText, (lastDirectText.textContent || '').length);
                const rects = Array.from(probeRange.getClientRects ? probeRange.getClientRects() : []);
                if (rects.length <= 1) {
                    return true;
                }
                const normalizedTops = [];
                for (const r of rects) {
                    if (!r || !Number.isFinite(r.top)) continue;
                    const isNewLine = normalizedTops.every(t => Math.abs(t - r.top) > 3);
                    if (isNewLine) {
                        normalizedTops.push(r.top);
                        if (normalizedTops.length > 1) {
                            return false;
                        }
                    }
                }
                return true;
            } catch (e) {
                return false;
            }
        };

        if (currentListItem && range.collapsed && isListItemSingleVisualLine(currentListItem)) {
            const prevListItem = this._getAdjacentListItem(currentListItem, 'prev');
            if (prevListItem && this._placeCursorInListItemAtX(prevListItem, currentX, 'up', selection)) {
                return;
            }
        }

        let moved = false;

        const tryMoveAt = (targetY) => {
            const elementAbove = document.elementFromPoint(currentX, targetY);
            // 水平線の場合は水平線全体を選択
            if (elementAbove && this.editor.contains(elementAbove) && elementAbove.tagName === 'HR') {
                const newRange = document.createRange();
                newRange.selectNode(elementAbove);
                selection.removeAllRanges();
                selection.addRange(newRange);
                return true;
            }
            if (elementAbove && this.editor.contains(elementAbove)) {
                const caretRange = document.caretRangeFromPoint(currentX, targetY);
                if (caretRange) {
                    const newRect = caretRange.getBoundingClientRect();
                    // 5px以上上に移動したか確認
                    if (newRect.top < currentY - 5) {
                        try {
                            // リストアイテムの場合、カーソル位置を調整
                            const targetContainer = caretRange.startContainer;
                            let targetListItem = this.domUtils.getParentElement(targetContainer, 'LI');
                            if (!targetListItem) {
                                targetListItem = this._getListItemFromContainer(
                                    targetContainer,
                                    caretRange.startOffset,
                                    'up'
                                );
                            }

                            if (targetListItem) {
                                // リストアイテムのテキスト部分（ネストされたリストを除く）のテキストノードを取得
                                const textNodes = [];
                                const walker = document.createTreeWalker(
                                    targetListItem,
                                    NodeFilter.SHOW_TEXT,
                                    {
                                        acceptNode: function (node) {
                                            // このテキストノードがネストされたリスト内にあるかチェック
                                            let parent = node.parentElement;
                                            while (parent && parent !== targetListItem) {
                                                if (parent.tagName === 'UL' || parent.tagName === 'OL') {
                                                    return NodeFilter.FILTER_REJECT;
                                                }
                                                parent = parent.parentElement;
                                            }
                                            // 空のテキストノードも受け入れる（カーソル配置用）
                                            return NodeFilter.FILTER_ACCEPT;
                                        }
                                    },
                                    false
                                );

                                let textNode;
                                while (textNode = walker.nextNode()) {
                                    textNodes.push(textNode);
                                }

                                if (textNodes.length > 0) {
                                    const firstTextNode = textNodes[0];
                                    const lastTextNode = textNodes[textNodes.length - 1];
                                    const placeAtListBoundaryByX = () => {
                                        let placeAtEnd = false;
                                        try {
                                            const listTextRange = document.createRange();
                                            listTextRange.setStart(firstTextNode, 0);
                                            listTextRange.setEnd(lastTextNode, (lastTextNode.textContent || '').length);
                                            const listTextRect = listTextRange.getBoundingClientRect();
                                            if (listTextRect && listTextRect.width > 0) {
                                                placeAtEnd = currentX >= listTextRect.right - 1;
                                            }
                                        } catch (e) {
                                            placeAtEnd = false;
                                        }
                                        if (placeAtEnd) {
                                            caretRange.setStart(lastTextNode, (lastTextNode.textContent || '').length);
                                        } else {
                                            caretRange.setStart(firstTextNode, 0);
                                        }
                                        caretRange.collapse(true);
                                    };

                                    if (targetContainer.nodeType !== 3) {
                                        placeAtListBoundaryByX();
                                    } else {
                                        const isInListItemText = textNodes.some(node => node === targetContainer);
                                        if (!isInListItemText) {
                                            placeAtListBoundaryByX();
                                        } else {
                                            const textRange = document.createRange();
                                            textRange.selectNodeContents(targetContainer);
                                            const textRect = textRange.getBoundingClientRect();
                                            if (currentX > textRect.right) {
                                                caretRange.setStart(lastTextNode, (lastTextNode.textContent || '').length);
                                                caretRange.collapse(true);
                                            }
                                        }
                                    }
                                } else {
                                    const newTextNode = document.createTextNode('');
                                    this._insertTextNodeIntoListItem(targetListItem, newTextNode);
                                    caretRange.setStart(newTextNode, 0);
                                    caretRange.collapse(true);
                                }
                            } else {
                                // 非リストブロック要素（見出し、段落等）の場合
                                // プローブYがマージン/パディング領域にある可能性があるため、
                                // テキスト行の中心Yで再プローブして正確なX位置を取得する
                                const lineCenterY = newRect.height > 0
                                    ? newRect.top + newRect.height / 2
                                    : newRect.top;
                                if (lineCenterY > 0 && Math.abs(lineCenterY - targetY) > 2) {
                                    const adjustedRange = document.caretRangeFromPoint(currentX, lineCenterY);
                                    if (adjustedRange && this.editor.contains(adjustedRange.startContainer)) {
                                        caretRange.setStart(adjustedRange.startContainer, adjustedRange.startOffset);
                                        caretRange.collapse(true);
                                    }
                                }
                            }

                            selection.removeAllRanges();
                            selection.addRange(caretRange);
                            return true;
                        } catch (e) {
                            return false;
                        }
                    }
                }
            }
            return false;
        };

        // 視覚的な移動を試みる
        for (let step = 1; step <= 6; step++) {
            const targetY = currentY - lineStep * step;
            if (targetY < 0) {
                break;
            }
            if (tryMoveAt(targetY)) {
                moved = true;
                break;
            }
        }

        // 先頭ブロックの先頭行ではこれ以上移動しない（ブラウザ実装依存のジャンプ防止）
        if (!moved) {
            let currentBlock = container.nodeType === Node.ELEMENT_NODE ? container : container.parentElement;
            while (currentBlock && currentBlock !== this.editor &&
                !this.domUtils.isBlockElement(currentBlock) &&
                currentBlock.tagName !== 'TD' && currentBlock.tagName !== 'TH') {
                currentBlock = currentBlock.parentElement;
            }
            if (currentBlock && currentBlock !== this.editor) {
                const prevElement = this._getPrevNavigableElementInDocument(currentBlock);
                if (!prevElement) {
                    const blockRect = currentBlock.getBoundingClientRect ? currentBlock.getBoundingClientRect() : null;
                    const topThreshold = Math.max(4, (lineStep * 0.6));
                    if (blockRect && currentY <= (blockRect.top + topThreshold)) {
                        return;
                    }
                }
            }
        }

        if (!moved && !currentListItem && selection.modify) {
            try {
                selection.modify('move', 'backward', 'line');
            } catch (e) {
                // ignore
            }
            const afterSelection = window.getSelection();
            if (afterSelection && afterSelection.rangeCount > 0) {
                const afterRange = afterSelection.getRangeAt(0);
                const movedByModify = (afterRange.startContainer !== originContainer ||
                    afterRange.startOffset !== originOffset ||
                    afterRange.endContainer !== originContainer ||
                    afterRange.endOffset !== originOffset);
                if (movedByModify && this.editor.contains(afterRange.startContainer)) {
                    const afterRect = getVisualCaretRectForRange(afterRange);
                    const afterY = afterRect ? (afterRect.top || afterRect.y || 0) : null;
                    const movedUpByModify = Number.isFinite(afterY) && afterY < (currentY - 2);
                    if (movedUpByModify) {
                        return;
                    }
                    restoreOriginalCaret();
                }
            }
        }

        if (!moved && currentListItem) {
            const prevListItem = this._getAdjacentListItem(currentListItem, 'prev');
            if (prevListItem) {
                if (this._placeCursorInListItemAtX(prevListItem, currentX, 'up', selection)) {
                    return;
                }
            }
        }

        // 視覚的な移動が失敗した場合、構造的な移動を試みる
        let fallbackBlock = null;
        if (!moved) {
            // 現在のブロック要素を特定
            let currentBlock = container;
            while (currentBlock && currentBlock !== this.editor && !this.domUtils.isBlockElement(currentBlock)) {
                currentBlock = currentBlock.parentElement;
            }
            fallbackBlock = currentBlock;

            // ブロックの先頭付近にいるかチェック
            let isAtTop = false;

            if (currentBlock && currentBlock !== this.editor && currentBlock.tagName !== 'TD' && currentBlock.tagName !== 'TH') {
                const blockRect = currentBlock.getBoundingClientRect();
                // CaretがBlock Top付近にあるか
                if (currentY - 20 <= blockRect.top || (currentY - blockRect.top) < 40) {
                    isAtTop = true;
                }
            } else {
                isAtTop = true;
            }

            if (isAtTop && currentBlock) {
                let prevElement = currentBlock.previousElementSibling;
                // 水平線の場合は水平線全体を選択
                if (prevElement && prevElement.tagName === 'HR') {
                    const newRange = document.createRange();
                    newRange.selectNode(prevElement);
                    selection.removeAllRanges();
                    selection.addRange(newRange);
                    return;
                }
                if (prevElement) {
                    // X位置を維持してカーソルを配置する
                    let placed = false;
                    const lastNode = this.domUtils.getLastTextNode(prevElement);
                    if (lastNode) {
                        const text = lastNode.textContent || '';
                        if (text.length > 0) {
                            // 最後の文字のrectからテキスト行のY中心を算出
                            const lastCharRange = document.createRange();
                            lastCharRange.setStart(lastNode, text.length - 1);
                            lastCharRange.setEnd(lastNode, text.length);
                            const lastCharRect = lastCharRange.getBoundingClientRect();
                            if (lastCharRect && lastCharRect.height > 0) {
                                const lineCenterY = lastCharRect.top + lastCharRect.height / 2;
                                const caretRange = document.caretRangeFromPoint(currentX, lineCenterY);
                                if (caretRange && prevElement.contains(caretRange.startContainer)) {
                                    const newRange = document.createRange();
                                    newRange.setStart(caretRange.startContainer, caretRange.startOffset);
                                    newRange.collapse(true);
                                    selection.removeAllRanges();
                                    selection.addRange(newRange);
                                    placed = true;
                                }
                            }
                        }
                    }
                    if (!placed) {
                        // フォールバック: テキスト末尾に配置
                        const newRange = document.createRange();
                        if (lastNode) {
                            newRange.setStart(lastNode, lastNode.textContent.length);
                        } else {
                            newRange.setStart(prevElement, prevElement.childNodes.length);
                        }
                        newRange.collapse(true);
                        selection.removeAllRanges();
                        selection.addRange(newRange);
                    }
                    moved = true;
                }
            }
        }

        if (moved) {
            const currentSelection = window.getSelection();
            if (!currentSelection || !currentSelection.rangeCount) {
                moved = false;
            } else {
                const currentRange = currentSelection.getRangeAt(0);
                if (currentRange.startContainer === originContainer &&
                    currentRange.startOffset === originOffset &&
                    currentRange.endContainer === originContainer &&
                    currentRange.endOffset === originOffset) {
                    moved = false;
                }
            }
        }

        if (!moved) {
            const anchor = fallbackBlock || (container.nodeType === Node.ELEMENT_NODE ? container : container.parentElement);
            const prevElement = anchor ? this._getPrevNavigableElementInDocument(anchor) : null;
            if (prevElement) {
                // X位置を維持してカーソルを配置する
                let placed = false;
                const lastNode = this._getLastNavigableTextNode(prevElement);
                if (lastNode) {
                    const text = lastNode.textContent || '';
                    if (text.length > 0) {
                        const lastCharRange = document.createRange();
                        lastCharRange.setStart(lastNode, text.length - 1);
                        lastCharRange.setEnd(lastNode, text.length);
                        const lastCharRect = lastCharRange.getBoundingClientRect();
                        if (lastCharRect && lastCharRect.height > 0) {
                            const lineCenterY = lastCharRect.top + lastCharRect.height / 2;
                            const caretRange = document.caretRangeFromPoint(currentX, lineCenterY);
                            if (caretRange && prevElement.contains(caretRange.startContainer)) {
                                const newRange = document.createRange();
                                newRange.setStart(caretRange.startContainer, caretRange.startOffset);
                                newRange.collapse(true);
                                selection.removeAllRanges();
                                selection.addRange(newRange);
                                placed = true;
                            }
                        }
                    }
                }
                if (!placed) {
                    const newRange = document.createRange();
                    if (lastNode) {
                        newRange.setStart(lastNode, lastNode.textContent.length);
                    } else {
                        newRange.setStart(prevElement, prevElement.childNodes.length);
                    }
                    newRange.collapse(true);
                    selection.removeAllRanges();
                    selection.addRange(newRange);
                }
                return;
            }

            const currentListItem = this._getListItemFromContainer(container, range.startOffset, 'up') ||
                this.domUtils.getParentElement(container, 'LI');
            if (currentListItem && currentListItem.parentElement) {
                const parentListItem = this.domUtils.getParentElement(currentListItem.parentElement, 'LI');
                if (parentListItem) {
                    let directTextNode = null;
                    for (let child of parentListItem.childNodes) {
                        if (child.nodeType === Node.TEXT_NODE) {
                            directTextNode = child;
                            break;
                        }
                        if (child.nodeType === Node.ELEMENT_NODE &&
                            child.tagName !== 'UL' && child.tagName !== 'OL') {
                            const candidate = this._getFirstNavigableTextNode(child);
                            if (candidate) {
                                directTextNode = candidate;
                                break;
                            }
                        }
                    }

                    if (!directTextNode) {
                        this._placeCursorInEmptyListItem(parentListItem, selection, 'up');
                        return;
                    }

                    const placeAtEnd = isCursorRightOfListItemText(parentListItem, currentX);
                    const targetTextNode = placeAtEnd
                        ? (this._getLastDirectTextNode(parentListItem) || directTextNode)
                        : directTextNode;
                    const targetOffset = placeAtEnd
                        ? (targetTextNode.textContent || '').length
                        : 0;
                    const newRange = document.createRange();
                    newRange.setStart(targetTextNode, targetOffset);
                    newRange.collapse(true);
                    selection.removeAllRanges();
                    selection.addRange(newRange);
                    return;
                }
            }

            const listContainer = this.domUtils.getParentElement(container, 'UL') ||
                this.domUtils.getParentElement(container, 'OL');
            if (listContainer && listContainer.parentElement) {
                let outerList = listContainer;
                while (outerList.parentElement && outerList.parentElement.tagName === 'LI') {
                    const parentLi = outerList.parentElement;
                    const parentList = parentLi.parentElement;
                    if (parentList && (parentList.tagName === 'UL' || parentList.tagName === 'OL')) {
                        outerList = parentList;
                    } else {
                        break;
                    }
                }

                const newP = document.createElement('p');
                newP.appendChild(document.createElement('br'));
                outerList.parentElement.insertBefore(newP, outerList);

                const newRange = document.createRange();
                newRange.setStart(newP, 0);
                newRange.collapse(true);
                selection.removeAllRanges();
                selection.addRange(newRange);
                if (notifyCallback) notifyCallback();
                return;
            }
        }
    }

    /**
     * カーソルを下に1行移動
     * @param {Function} notifyCallback - 変更を通知するコールバック
     */
    moveCursorDown(notifyCallback) {
        const selection = window.getSelection();
        if (!selection || !selection.rangeCount) return;
        this._clearForwardImageStep();
        let range = selection.getRangeAt(0);
        let container = range.startContainer;
        let originContainer = range.startContainer;
        let originOffset = range.startOffset;
        const restoreOriginalCaret = () => {
            if (!originContainer || !this.editor || !this.editor.contains(originContainer)) {
                return false;
            }
            try {
                const restoreRange = document.createRange();
                if (originContainer.nodeType === Node.TEXT_NODE) {
                    const textLength = (originContainer.textContent || '').length;
                    restoreRange.setStart(originContainer, Math.max(0, Math.min(originOffset, textLength)));
                } else if (originContainer.nodeType === Node.ELEMENT_NODE) {
                    const childCount = originContainer.childNodes ? originContainer.childNodes.length : 0;
                    restoreRange.setStart(originContainer, Math.max(0, Math.min(originOffset, childCount)));
                } else {
                    return false;
                }
                restoreRange.collapse(true);
                selection.removeAllRanges();
                selection.addRange(restoreRange);
                return true;
            } catch (e) {
                return false;
            }
        };
        const isEffectivelyEmptyBlock = (block) => {
            if (!block) return false;
            const text = (block.textContent || '').replace(/[\u200B\uFEFF\u00A0]/g, '').trim();
            if (text !== '') return false;
            const meaningfulChild = Array.from(block.childNodes).some(node => {
                if (node.nodeType === Node.ELEMENT_NODE) {
                    if (node.tagName === 'BR') return false;
                    if (this._isNavigationExcludedElement(node)) return false;
                    return true;
                }
                if (node.nodeType === Node.TEXT_NODE) {
                    return !this._isIgnorableTextNode(node);
                }
                return false;
            });
            return !meaningfulChild;
        };
        const getBlockFromContainer = (node, offset = null) => {
            if (node === this.editor) {
                const children = Array.from(this.editor.childNodes || []);
                if (children.length === 0) {
                    return null;
                }
                const safeOffset = Math.max(0, Math.min(
                    Number.isInteger(offset) ? offset : 0,
                    children.length - 1
                ));
                const directChild = children[safeOffset] || children[children.length - 1];
                if (directChild && directChild.nodeType === Node.ELEMENT_NODE && this.domUtils.isBlockElement(directChild)) {
                    return directChild;
                }
                if (directChild && directChild.nodeType === Node.TEXT_NODE) {
                    return directChild.parentElement && directChild.parentElement !== this.editor
                        ? directChild.parentElement
                        : null;
                }
            }
            let block = node && node.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
            while (block && block !== this.editor && !this.domUtils.isBlockElement(block)) {
                block = block.parentElement;
            }
            return block && block !== this.editor ? block : null;
        };
        const getEstimatedLineHeight = (node, fallbackRect = null) => {
            const block = getBlockFromContainer(node);
            let lineHeight = NaN;
            if (block && window.getComputedStyle) {
                const style = window.getComputedStyle(block);
                if (style) {
                    lineHeight = Number.parseFloat(style.lineHeight);
                    if (!Number.isFinite(lineHeight) || lineHeight <= 0) {
                        const fontSize = Number.parseFloat(style.fontSize);
                        if (Number.isFinite(fontSize) && fontSize > 0) {
                            lineHeight = fontSize * 1.6;
                        }
                    }
                }
            }
            if ((!Number.isFinite(lineHeight) || lineHeight <= 0) && fallbackRect) {
                const rectHeight = Number.parseFloat(fallbackRect.height);
                if (Number.isFinite(rectHeight) && rectHeight > 0) {
                    lineHeight = rectHeight;
                }
            }
            if (!Number.isFinite(lineHeight) || lineHeight <= 0) {
                lineHeight = 18;
            }
            return Math.max(14, Math.min(lineHeight, 72));
        };
        const getVisualCaretRectForRange = (targetRange) => {
            if (!targetRange) {
                return null;
            }
            const baseRect = this._getCaretRect(targetRange);
            if (!baseRect || !targetRange.collapsed) {
                return baseRect;
            }
            const containerNode = targetRange.startContainer;
            if (!containerNode || containerNode.nodeType !== Node.TEXT_NODE) {
                return baseRect;
            }
            const text = containerNode.textContent || '';
            const offset = Math.max(0, Math.min(targetRange.startOffset, text.length));
            if (offset <= 0 || offset >= text.length) {
                return baseRect;
            }
            try {
                const prevRange = document.createRange();
                prevRange.setStart(containerNode, offset - 1);
                prevRange.setEnd(containerNode, offset);
                const prevRect = prevRange.getBoundingClientRect();

                const nextRange = document.createRange();
                nextRange.setStart(containerNode, offset);
                nextRange.setEnd(containerNode, offset + 1);
                const nextRect = nextRange.getBoundingClientRect();

                if (!prevRect || !nextRect) {
                    return baseRect;
                }

                const prevTop = prevRect.top || prevRect.y || 0;
                const nextTop = nextRect.top || nextRect.y || 0;
                if (nextTop > prevTop + 2) {
                    // 折り返し行の先頭では、前文字（前行末）ではなく次文字の行を現在行として扱う。
                    return {
                        left: nextRect.left,
                        right: nextRect.left,
                        top: nextRect.top,
                        bottom: nextRect.bottom,
                        width: 0,
                        height: nextRect.height,
                        x: nextRect.left,
                        y: nextRect.y
                    };
                }
            } catch (e) {
                // ignore and use base rect
            }
            return baseRect;
        };
        const getTopLevelBlockForNavigation = (node, offset = null) => {
            if (!this.editor) {
                return null;
            }
            let current = null;
            if (node === this.editor) {
                const children = Array.from(this.editor.childNodes || []);
                if (children.length === 0) {
                    return null;
                }
                const safeOffset = Math.max(0, Math.min(
                    Number.isInteger(offset) ? offset : 0,
                    children.length
                ));
                current = safeOffset > 0
                    ? children[safeOffset - 1]
                    : children[0];
            } else {
                current = node && node.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
            }

            if (current && current.nodeType === Node.TEXT_NODE) {
                current = current.parentElement;
            }
            while (current && current !== this.editor && current.parentElement !== this.editor) {
                current = current.parentElement;
            }
            if (!current || current === this.editor || current.nodeType !== Node.ELEMENT_NODE) {
                return null;
            }
            if (this._isNavigationExcludedElement(current)) {
                return null;
            }
            return current;
        };
        const normalizeCollapsedBoundaryToTextNode = () => {
            if (!range || !range.collapsed) {
                return false;
            }
            const boundaryContainer = range.startContainer;
            if (!boundaryContainer || boundaryContainer.nodeType !== Node.ELEMENT_NODE) {
                return false;
            }
            if (boundaryContainer === this.editor) {
                return false;
            }

            const boundaryTag = boundaryContainer.tagName;
            if (boundaryTag === 'LI' ||
                boundaryTag === 'UL' ||
                boundaryTag === 'OL' ||
                boundaryTag === 'TABLE' ||
                boundaryTag === 'TR' ||
                boundaryTag === 'TD' ||
                boundaryTag === 'TH' ||
                boundaryTag === 'PRE' ||
                boundaryTag === 'CODE') {
                return false;
            }

            const maxOffset = boundaryContainer.childNodes
                ? boundaryContainer.childNodes.length
                : 0;
            const safeOffset = Math.max(0, Math.min(range.startOffset, maxOffset));

            let targetTextNode = this._getTextNodeInParentAfter(boundaryContainer, safeOffset);
            let targetOffset = 0;
            if (targetTextNode) {
                const text = targetTextNode.textContent || '';
                const firstOffset = this._getFirstNonZwspOffset(text);
                targetOffset = firstOffset !== null ? firstOffset : 0;
            } else {
                targetTextNode = this._getTextNodeInParentBefore(boundaryContainer, safeOffset);
                if (!targetTextNode) {
                    return false;
                }
                const text = targetTextNode.textContent || '';
                const lastOffset = this._getLastNonZwspOffset(text);
                targetOffset = lastOffset !== null ? Math.min(text.length, lastOffset + 1) : 0;
            }

            const normalizedRange = document.createRange();
            normalizedRange.setStart(targetTextNode, targetOffset);
            normalizedRange.collapse(true);
            selection.removeAllRanges();
            selection.addRange(normalizedRange);
            return true;
        };
        const resolveTrailingEmptyBlock = () => {
            let block = getBlockFromContainer(range.startContainer);
            if (!block && range.startContainer === this.editor) {
                const children = Array.from(this.editor.childNodes || []);
                let index = Math.min(range.startOffset, children.length) - 1;
                for (let i = index; i >= 0; i--) {
                    const node = children[i];
                    if (!node) continue;
                    if (node.nodeType === Node.TEXT_NODE) {
                        if (node.textContent.trim() === '') continue;
                        block = node.parentElement;
                        break;
                    }
                    if (node.nodeType === Node.ELEMENT_NODE) {
                        if (this._isNavigationExcludedElement(node)) continue;
                        if (this.domUtils.isBlockElement(node)) {
                            block = node;
                            break;
                        }
                    }
                }
            }
            if (!block) return null;
            if (!isEffectivelyEmptyBlock(block)) return null;
            if (this._getNextNavigableElementInDocument(block)) return null;
            return block;
        };
        if (resolveTrailingEmptyBlock()) {
            return;
        }

        this._normalizeSelectionForNavigation(selection);
        normalizeCollapsedBoundaryToTextNode();
        range = selection.getRangeAt(0);
        container = range.startContainer;
        originContainer = range.startContainer;
        originOffset = range.startOffset;
        const originCodeBlock = this.domUtils.getParentElement(container, 'CODE');
        const originPreBlock = originCodeBlock ? this.domUtils.getParentElement(originCodeBlock, 'PRE') : null;
        const originTopLevelBlock = getTopLevelBlockForNavigation(container, range.startOffset);
        let originListItem = this._getListItemFromContainer(container, range.startOffset, 'down') ||
            this.domUtils.getParentElement(container, 'LI');
        if (!originListItem && range.collapsed && document.elementFromPoint) {
            const caretRect = this._getCaretRect(range);
            if (caretRect) {
                const probeX = (caretRect.left || caretRect.x || 0) + 1;
                const probeY = (caretRect.top || caretRect.y || 0) +
                    Math.max(1, Math.min(8, (caretRect.height || 16) * 0.5));
                const visualNode = document.elementFromPoint(probeX, probeY);
                if (visualNode && this.editor.contains(visualNode)) {
                    originListItem = (visualNode.nodeType === Node.ELEMENT_NODE && visualNode.tagName === 'LI')
                        ? visualNode
                        : this.domUtils.getParentElement(visualNode, 'LI');
                }
            }
        }
        let originIsEmptyWithNested = false;
        let originNestedList = null;
        if (originListItem) {
            originNestedList = this._getNestedListContainer(originListItem);
            if (originNestedList) {
                let directText = '';
                for (let child of originListItem.childNodes) {
                    if (child.nodeType === Node.TEXT_NODE) {
                        directText += child.textContent || '';
                    } else if (child.nodeType === Node.ELEMENT_NODE &&
                        child.tagName !== 'UL' && child.tagName !== 'OL') {
                        directText += child.textContent || '';
                    }
                }
                const cleaned = directText.replace(/[\u200B\uFEFF\u00A0]/g, '').trim();
                if (cleaned === '') {
                    originIsEmptyWithNested = true;
                }
            }
        }

        if (!originListItem) {
            let block = container.nodeType === Node.ELEMENT_NODE ? container : container.parentElement;
            while (block && block !== this.editor && !this.domUtils.isBlockElement(block)) {
                block = block.parentElement;
            }
            // editor直下カーソル時に全体先頭のリストへ誤ジャンプしないようにする
            if (block && block !== this.editor) {
                const listInside = block.querySelector('ul, ol');
                if (listInside) {
                    const firstLi = listInside.querySelector('li');
                    if (firstLi) {
                        const textNode = this._getFirstDirectTextNode(firstLi) || this._getLastDirectTextNode(firstLi);
                        if (textNode) {
                            const newRange = document.createRange();
                            newRange.setStart(textNode, 0);
                            newRange.collapse(true);
                            selection.removeAllRanges();
                            selection.addRange(newRange);
                            return;
                        }
                        this._placeCursorInEmptyListItem(firstLi, selection, 'down');
                        return;
                    }
                }
            }
        }

        const currentBlock = (() => {
            let block = container.nodeType === Node.ELEMENT_NODE ? container : container.parentElement;
            while (block && block !== this.editor && !this.domUtils.isBlockElement(block)) {
                block = block.parentElement;
            }
            return block && block !== this.editor ? block : null;
        })();

        if (currentBlock && currentBlock.tagName !== 'LI' && isEffectivelyEmptyBlock(currentBlock)) {
            // LIの場合はリスト固有のナビゲーションに任せる
            if (!this._getNextNavigableElementInDocument(currentBlock)) {
                return;
            }
            let nextElement = this._getNextNavigableElementSibling(currentBlock);
            if (nextElement && nextElement.nodeType === Node.ELEMENT_NODE) {
                if (nextElement.tagName === 'PRE' && this._selectCodeBlockLanguageLabel(nextElement, selection)) {
                    return;
                }
                if (nextElement.tagName === 'HR') {
                    const newRange = document.createRange();
                    newRange.selectNode(nextElement);
                    selection.removeAllRanges();
                    selection.addRange(newRange);
                    return;
                }
                const newRange = document.createRange();
                const firstNode = this._getFirstNavigableTextNode(nextElement);
                if (firstNode) {
                    newRange.setStart(firstNode, 0);
                } else {
                    newRange.setStart(nextElement, 0);
                }
                newRange.collapse(true);
                selection.removeAllRanges();
                selection.addRange(newRange);
                return;
            }
        }

        if (container === this.editor) {
            const children = Array.from(this.editor.childNodes);
            const startIndex = Math.max(0, Math.min(range.startOffset, children.length));
            for (let i = startIndex; i < children.length; i++) {
                const child = children[i];
                if (!child) continue;
                if (child.nodeType === Node.TEXT_NODE) {
                    if (!this._isIgnorableTextNode(child)) {
                        const newRange = document.createRange();
                        newRange.setStart(child, 0);
                        newRange.collapse(true);
                        selection.removeAllRanges();
                        selection.addRange(newRange);
                        return;
                    }
                    continue;
                }
                if (child.nodeType === Node.ELEMENT_NODE) {
                    if (this._isNavigationExcludedElement(child) || child.tagName === 'BR') {
                        continue;
                    }
                    if (child.tagName === 'HR') {
                        const newRange = document.createRange();
                        newRange.selectNode(child);
                        selection.removeAllRanges();
                        selection.addRange(newRange);
                        return;
                    }
                    if (child.tagName === 'PRE' && this._selectCodeBlockLanguageLabel(child, selection)) {
                        return;
                    }
                    const firstNode = this.domUtils.getFirstTextNode(child);
                    const newRange = document.createRange();
                    if (firstNode) {
                        newRange.setStart(firstNode, 0);
                    } else {
                        newRange.setStart(child, 0);
                    }
                    newRange.collapse(true);
                    selection.removeAllRanges();
                    selection.addRange(newRange);
                    return;
                }
            }
        }

        // コードブロック内かチェック
        let codeBlock = this.domUtils.getParentElement(container, 'CODE');
        let preBlock = codeBlock ? this.domUtils.getParentElement(codeBlock, 'PRE') : null;
        if (!preBlock) {
            const preCandidate = this.domUtils.getParentElement(container, 'PRE');
            if (preCandidate) {
                const codeCandidate = preCandidate.querySelector('code');
                if (codeCandidate) {
                    codeBlock = codeCandidate;
                    preBlock = preCandidate;
                }
            }
        }

        const exitCodeBlockDown = () => {
            if (!preBlock) return false;
            const nextElement = this._getNextNavigableElementInDocument(preBlock);

            // 水平線の場合は水平線全体を選択
            if (nextElement && nextElement.nodeType === 1 && nextElement.tagName === 'HR') {
                const newRange = document.createRange();
                newRange.selectNode(nextElement);
                selection.removeAllRanges();
                selection.addRange(newRange);
                return true;
            }

            // 次の要素がある場合、そこにカーソルを移動
            if (nextElement && nextElement.nodeType === 1) {
                if (nextElement.tagName === 'PRE' && this._selectCodeBlockLanguageLabel(nextElement, selection)) {
                    return true;
                }
                const newRange = document.createRange();
                const firstNode = this.domUtils.getFirstTextNode(nextElement);
                if (firstNode) {
                    newRange.setStart(firstNode, 0);
                } else if (nextElement.tagName === 'P') {
                    const hasText = (nextElement.textContent || '').replace(/[\u200B\uFEFF\u00A0]/g, '').trim() !== '';
                    const hasBr = !!nextElement.querySelector('br');
                    if (!hasText && !hasBr) {
                        nextElement.appendChild(document.createElement('br'));
                    }
                    // 既存の空行へ移動するだけのケースでは不要な文字を挿入しない
                    newRange.setStart(nextElement, 0);
                } else {
                    newRange.setStart(nextElement, 0);
                }
                newRange.collapse(true);
                selection.removeAllRanges();
                selection.addRange(newRange);
                return true;
            }

            // 新しい段落を作成（ZWSPでカーソル位置を確保）
            const newP = document.createElement('p');
            const zwsp = document.createTextNode('\u200B');
            newP.appendChild(zwsp);

            if (preBlock.nextSibling) {
                preBlock.parentElement.insertBefore(newP, preBlock.nextSibling);
            } else {
                preBlock.parentElement.appendChild(newP);
            }

            const newRange = document.createRange();
            newRange.setStart(zwsp, zwsp.textContent.length);
            newRange.collapse(true);
            selection.removeAllRanges();
            selection.addRange(newRange);

            if (notifyCallback) notifyCallback();
            return true;
        };

        if (preBlock && codeBlock) {
            const nextElementAfterCode = this._getNextNavigableElementInDocument(preBlock);
            if (!nextElementAfterCode) {
                const caretRect = this._getCaretRect(range);
                const preRect = preBlock.getBoundingClientRect ? preBlock.getBoundingClientRect() : null;
                if (caretRect && preRect) {
                    if (caretRect.bottom + 6 >= preRect.bottom || (preRect.bottom - caretRect.bottom) < 12) {
                        exitCodeBlockDown();
                        return;
                    }
                }
            }

            const isCodeBlockEffectivelyEmpty = () => {
                const text = this.getCodeBlockText(codeBlock);
                return text.replace(/[\u200B\uFEFF\u00A0\s]/g, '') === '';
            };

            // Empty code block: always exit down on ArrowDown
            if (isCodeBlockEffectivelyEmpty()) {
                exitCodeBlockDown();
                return;
            }

            if (isCodeBlockEffectivelyEmpty() &&
                (codeBlock.contains(range.startContainer) || range.startContainer === codeBlock || preBlock.contains(range.startContainer))) {
                exitCodeBlockDown();
                return;
            }

            if (this._isRangeAtCodeBlockEnd(codeBlock, range)) {
                exitCodeBlockDown();
                return;
            }

            const text = this.getCodeBlockText(codeBlock);
            const cursorOffset = this.getCodeBlockCursorOffset(codeBlock, range);
            const normalizedText = text.replace(/[\u200B\uFEFF\u00A0]/g, '').replace(/\n/g, '');
            if (cursorOffset !== null && normalizedText === '') {
                exitCodeBlockDown();
                return;
            }
            if (cursorOffset === null) {
                if (preBlock.contains(range.startContainer) || preBlock === range.startContainer) {
                    exitCodeBlockDown();
                    return;
                }
            }
            if (cursorOffset !== null) {
                const { lines, lineStartOffsets, currentLineIndex, column } =
                    this.getCodeBlockLineInfo(text, cursorOffset);
                const isWhitespaceOnly = (value) => value.replace(/[\u200B\uFEFF\u00A0\s]/g, '') === '';
                let lastNonWhitespaceLineIndex = -1;
                for (let i = lines.length - 1; i >= 0; i--) {
                    if (!isWhitespaceOnly(lines[i])) {
                        lastNonWhitespaceLineIndex = i;
                        break;
                    }
                }
                if (lastNonWhitespaceLineIndex === -1 || currentLineIndex >= lastNonWhitespaceLineIndex) {
                    exitCodeBlockDown();
                    return;
                }

                const trailingNewlines = this._getTrailingNewlineCount(text);
                let lastLineIndex = lines.length - 1;
                if (trailingNewlines >= 2) {
                    lastLineIndex = Math.max(0, lines.length - 2);
                }
                if (currentLineIndex >= lastLineIndex) {
                    exitCodeBlockDown();
                    return;
                }

                const targetLineIndex = currentLineIndex + 1;
                const targetOffset = lineStartOffsets[targetLineIndex] +
                    Math.min(column, lines[targetLineIndex].length);
                if (this.setCodeBlockCursorOffset(codeBlock, selection, targetOffset)) {
                    return;
                }
                exitCodeBlockDown();
                return;
            }
        }

        const moveToBlockStart = (block) => {
            if (!block || block.nodeType !== Node.ELEMENT_NODE) {
                return false;
            }
            if (block.tagName === 'HR') {
                const hrRange = document.createRange();
                hrRange.selectNode(block);
                selection.removeAllRanges();
                selection.addRange(hrRange);
                return true;
            }
            const leadingImage = this._getLeadingImageInBlock(block);
            if (leadingImage) {
                const imageRange = document.createRange();
                if (this._collapseRangeBeforeNode(imageRange, leadingImage)) {
                    selection.removeAllRanges();
                    selection.addRange(imageRange);
                    return true;
                }
            }
            const newRange = document.createRange();
            const firstNode = this._getFirstNavigableTextNode(block);
            if (firstNode) {
                newRange.setStart(firstNode, 0);
            } else {
                if (block.tagName === 'P') {
                    const hasText = (block.textContent || '').replace(/[\u200B\uFEFF\u00A0]/g, '').trim() !== '';
                    const hasBr = !!block.querySelector('br');
                    if (!hasText && !hasBr) {
                        block.appendChild(document.createElement('br'));
                    }
                }
                newRange.setStart(block, 0);
            }
            newRange.collapse(true);
            selection.removeAllRanges();
            selection.addRange(newRange);
            return true;
        };
        const moveToNextLineWithinImageBlock = (imageNode, blockNode) => {
            if (!imageNode || !blockNode || blockNode === this.editor) {
                return false;
            }

            let sibling = imageNode.nextSibling;
            while (sibling) {
                if (sibling.nodeType === Node.TEXT_NODE) {
                    const text = sibling.textContent || '';
                    const cleaned = text.replace(/[\u200B\uFEFF\u00A0]/g, '');
                    if (cleaned.trim() === '') {
                        sibling = sibling.nextSibling;
                        continue;
                    }
                    return false;
                }
                if (sibling.nodeType === Node.ELEMENT_NODE) {
                    if (this._isNavigationExcludedElement(sibling)) {
                        sibling = sibling.nextSibling;
                        continue;
                    }
                    if (sibling.tagName === 'BR') {
                        const lineRange = document.createRange();
                        if (this._collapseRangeAfterNode(lineRange, sibling)) {
                            selection.removeAllRanges();
                            selection.addRange(lineRange);
                            return true;
                        }
                        const fallbackRange = document.createRange();
                        fallbackRange.setStart(blockNode, blockNode.childNodes.length);
                        fallbackRange.collapse(true);
                        selection.removeAllRanges();
                        selection.addRange(fallbackRange);
                        return true;
                    }
                    return false;
                }
                sibling = sibling.nextSibling;
            }
            return false;
        };

        // 画像右エッジ（画像直後）からの↓は、次ブロック先頭へ移動する。
        // 空行が続くケースで視覚プローブが不安定になってもカーソルを見失わないようにする。
        if (range.collapsed) {
            const imageBehind = this._getImageBehindFromCollapsedRange(range);
            if (imageBehind && this._isCollapsedRangeAtNodeBoundary(range, imageBehind, 'after')) {
                const imageBlock = getBlockFromContainer(imageBehind);
                const trailingImage = imageBlock
                    ? this._getTrailingImageInBlock(imageBlock)
                    : (imageBehind.parentElement === this.editor ? imageBehind : null);
                if (trailingImage === imageBehind) {
                    const boundaryNode = imageBlock || imageBehind;
                    const nextAfterImage = this._getNextNavigableElementInDocument(boundaryNode);
                    if (nextAfterImage && moveToBlockStart(nextAfterImage)) {
                        return;
                    }
                    if (!nextAfterImage && boundaryNode && boundaryNode.parentElement) {
                        const newP = document.createElement('p');
                        newP.appendChild(document.createElement('br'));
                        if (boundaryNode.nextSibling) {
                            boundaryNode.parentElement.insertBefore(newP, boundaryNode.nextSibling);
                        } else {
                            boundaryNode.parentElement.appendChild(newP);
                        }
                        const newRange = document.createRange();
                        newRange.setStart(newP, 0);
                        newRange.collapse(true);
                        selection.removeAllRanges();
                        selection.addRange(newRange);
                        if (notifyCallback) notifyCallback();
                        return;
                    }
                }
            }
        }

        // 画像左エッジ（画像直前）からの↓は、画像選択へ入らず次ブロックへ進む。
        // 上行 -> 画像左エッジ -> 下行 の1ステップ移動を保証する。
        if (range.collapsed) {
            const imageAhead = this._getImageAheadFromCollapsedRange(range);
            if (imageAhead) {
                const imageBlock = getBlockFromContainer(imageAhead);
                const imageBoundary = imageBlock || imageAhead;
                const leadingImage = imageBlock
                    ? this._getLeadingImageInBlock(imageBlock)
                    : (imageAhead.parentElement === this.editor ? imageAhead : null);
                const isAtImageLeftEdge =
                    leadingImage === imageAhead &&
                    this._isCollapsedRangeAtNodeBoundary(range, imageAhead, 'before');

                if (isAtImageLeftEdge) {
                    if (imageBlock && moveToNextLineWithinImageBlock(imageAhead, imageBlock)) {
                        return;
                    }
                    const nextAfterImage = this._getNextNavigableElementInDocument(imageBoundary);
                    if (nextAfterImage && moveToBlockStart(nextAfterImage)) {
                        return;
                    }

                    if (imageBoundary && imageBoundary.parentElement) {
                        const newP = document.createElement('p');
                        newP.appendChild(document.createElement('br'));
                        if (imageBoundary.nextSibling) {
                            imageBoundary.parentElement.insertBefore(newP, imageBoundary.nextSibling);
                        } else {
                            imageBoundary.parentElement.appendChild(newP);
                        }
                        const newRange = document.createRange();
                        newRange.setStart(newP, 0);
                        newRange.collapse(true);
                        selection.removeAllRanges();
                        selection.addRange(newRange);
                        if (notifyCallback) notifyCallback();
                        return;
                    }
                }
            }
        }

        const moveDownFromListBoundary = (listItem, currentX) => {
            if (!listItem) {
                return false;
            }

            const nextListItem = this._getAdjacentListItem(listItem, 'next');
            if (nextListItem) {
                if (this._placeCursorInListItemAtX(nextListItem, currentX, 'down', selection)) {
                    return true;
                }
                const fallbackNode = this._getFirstDirectTextNode(nextListItem) || this._getLastDirectTextNode(nextListItem);
                if (fallbackNode) {
                    const fallbackRange = document.createRange();
                    fallbackRange.setStart(fallbackNode, 0);
                    fallbackRange.collapse(true);
                    selection.removeAllRanges();
                    selection.addRange(fallbackRange);
                    return true;
                }
                return false;
            }

            let outerList = listItem.parentElement;
            while (outerList && outerList.parentElement && outerList.parentElement.tagName === 'LI') {
                const parentLi = outerList.parentElement;
                const parentList = parentLi.parentElement;
                if (parentList && (parentList.tagName === 'UL' || parentList.tagName === 'OL')) {
                    outerList = parentList;
                } else {
                    break;
                }
            }

            const listBoundary = outerList || listItem;
            const nextElementAfterList = this._getNextNavigableElementInDocument(listBoundary);
            if (nextElementAfterList) {
                return moveToBlockStart(nextElementAfterList);
            }

            if (listBoundary && listBoundary.parentElement) {
                const newP = document.createElement('p');
                newP.appendChild(document.createElement('br'));
                if (listBoundary.nextSibling) {
                    listBoundary.parentElement.insertBefore(newP, listBoundary.nextSibling);
                } else {
                    listBoundary.parentElement.appendChild(newP);
                }
                const newRange = document.createRange();
                newRange.setStart(newP, 0);
                newRange.collapse(true);
                selection.removeAllRanges();
                selection.addRange(newRange);
                if (notifyCallback) notifyCallback();
                return true;
            }

            return false;
        };

        const isListItemSingleVisualLine = (listItem) => {
            if (!listItem) return false;
            const firstDirectText = this._getFirstDirectTextNode(listItem);
            const lastDirectText = this._getLastDirectTextNode(listItem);
            if (!firstDirectText || !lastDirectText) return true;
            try {
                const probeRange = document.createRange();
                const firstText = firstDirectText.textContent || '';
                const startOffset = this._getFirstNonZwspOffset(firstText);
                probeRange.setStart(firstDirectText, startOffset !== null ? startOffset : 0);
                probeRange.setEnd(lastDirectText, (lastDirectText.textContent || '').length);
                const rects = Array.from(probeRange.getClientRects ? probeRange.getClientRects() : []);
                if (rects.length <= 1) {
                    return true;
                }
                const normalizedTops = [];
                for (const r of rects) {
                    if (!r || !Number.isFinite(r.top)) continue;
                    const isNewLine = normalizedTops.every(t => Math.abs(t - r.top) > 3);
                    if (isNewLine) {
                        normalizedTops.push(r.top);
                        if (normalizedTops.length > 1) {
                            return false;
                        }
                    }
                }
                return true;
            } catch (e) {
                return false;
            }
        };

        // 空のリストアイテムでは視覚ナビゲーションが不安定なため、構造ベースで移動する
        if (originListItem && range.collapsed) {
            const directTextForEmpty = this._getFirstDirectTextNode(originListItem);
            const hasRealText = directTextForEmpty &&
                (directTextForEmpty.textContent || '').replace(/[\u200B\uFEFF\u00A0]/g, '').trim() !== '';
            if (!hasRealText) {
                const emptyRect = this._getCaretRect(range);
                const emptyX = emptyRect ? (emptyRect.left || emptyRect.x || 0) : 0;
                const nextListItem = this._getAdjacentListItem(originListItem, 'next');
                if (nextListItem) {
                    this._placeCursorInListItemAtX(nextListItem, emptyX, 'down', selection);
                    return;
                }
                if (moveDownFromListBoundary(originListItem, emptyX)) {
                    return;
                }
            }
        }

        const getVisualLinesForListItemText = (listItem) => {
            if (!listItem) {
                return [];
            }
            const textNodes = this._getDirectTextNodes(listItem);
            if (textNodes.length === 0) {
                return [];
            }
            const firstNode = textNodes[0];
            const lastNode = textNodes[textNodes.length - 1];
            try {
                const probeRange = document.createRange();
                probeRange.setStart(firstNode, 0);
                probeRange.setEnd(lastNode, (lastNode.textContent || '').length);
                const rawRects = Array.from(probeRange.getClientRects ? probeRange.getClientRects() : []);
                const rects = rawRects
                    .filter(r => r &&
                        Number.isFinite(r.top) &&
                        Number.isFinite(r.bottom) &&
                        Number.isFinite(r.left) &&
                        Number.isFinite(r.right) &&
                        (r.width || r.height))
                    .sort((a, b) => {
                        if (Math.abs(a.top - b.top) <= 1.5) {
                            return a.left - b.left;
                        }
                        return a.top - b.top;
                    });
                if (rects.length === 0) {
                    return [];
                }
                const lines = [];
                for (const rect of rects) {
                    const lastLine = lines.length > 0 ? lines[lines.length - 1] : null;
                    if (!lastLine || Math.abs(lastLine.top - rect.top) > 3) {
                        lines.push({
                            top: rect.top,
                            bottom: rect.bottom,
                            left: rect.left,
                            right: rect.right
                        });
                        continue;
                    }
                    lastLine.top = Math.min(lastLine.top, rect.top);
                    lastLine.bottom = Math.max(lastLine.bottom, rect.bottom);
                    lastLine.left = Math.min(lastLine.left, rect.left);
                    lastLine.right = Math.max(lastLine.right, rect.right);
                }
                return lines;
            } catch (e) {
                return [];
            }
        };
        const isRangeInsideDirectListText = (probeRange, listItem, textNodes) => {
            if (!probeRange || !listItem || !textNodes || textNodes.length === 0) {
                return false;
            }
            const startContainer = probeRange.startContainer;
            if (!startContainer || !listItem.contains(startContainer)) {
                return false;
            }
            if (startContainer.nodeType === Node.TEXT_NODE && textNodes.includes(startContainer)) {
                return true;
            }
            let current = startContainer.nodeType === Node.ELEMENT_NODE
                ? startContainer
                : startContainer.parentElement;
            while (current && current !== listItem) {
                if (current.tagName === 'UL' || current.tagName === 'OL') {
                    return false;
                }
                current = current.parentElement;
            }
            return current === listItem;
        };
        const findLineStartCaretInListItem = (listItem, textNodes, line) => {
            if (!listItem || !textNodes || textNodes.length === 0 || !line) {
                return null;
            }
            const pickCandidate = (skipWhitespace) => {
                let best = null;
                let guard = 0;
                for (const textNode of textNodes) {
                    const text = textNode.textContent || '';
                    if (text.length === 0) continue;
                    for (let i = 0; i < text.length; i++) {
                        guard++;
                        if (guard > 12000) {
                            return best;
                        }
                        const ch = text[i];
                        if (ch === '\n' || ch === '\r' || ch === '\u200B' || ch === '\uFEFF') {
                            continue;
                        }
                        if (skipWhitespace && /\s/.test(ch)) {
                            continue;
                        }
                        let charRect = null;
                        try {
                            const charRange = document.createRange();
                            charRange.setStart(textNode, i);
                            charRange.setEnd(textNode, i + 1);
                            charRect = charRange.getBoundingClientRect();
                        } catch (e) {
                            continue;
                        }
                        if (!charRect || !(charRect.width || charRect.height)) {
                            continue;
                        }
                        const charTop = charRect.top || charRect.y || 0;
                        const charBottom = charRect.bottom || (charRect.y + charRect.height) || charTop;
                        const overlapsTargetLine = charBottom >= line.top - 2 && charTop <= line.bottom + 2;
                        if (!overlapsTargetLine) {
                            continue;
                        }
                        const charLeft = charRect.left || charRect.x || 0;
                        if (!best || charLeft < best.left - 0.5 ||
                            (Math.abs(charLeft - best.left) <= 0.5 && charTop < best.top)) {
                            best = {
                                node: textNode,
                                offset: i,
                                left: charLeft,
                                top: charTop
                            };
                        }
                    }
                }
                return best;
            };
            return pickCandidate(true) || pickCandidate(false);
        };
        const getNearestVisualLineIndex = (lines, caretRect) => {
            if (!lines || lines.length === 0 || !caretRect) {
                return 0;
            }
            const caretTop = caretRect.top || caretRect.y || 0;
            let nearestIndex = 0;
            let minDistance = Infinity;
            for (let i = 0; i < lines.length; i++) {
                const distance = Math.abs(lines[i].top - caretTop);
                if (distance < minDistance) {
                    minDistance = distance;
                    nearestIndex = i;
                }
            }
            return nearestIndex;
        };
        const isCollapsedRangeAtListTextStart = (targetRange, listItem) => {
            if (!targetRange || !targetRange.collapsed || !listItem) {
                return false;
            }
            const startContainer = targetRange.startContainer;
            const startOffset = targetRange.startOffset;
            const firstDirectText = this._getFirstDirectTextNode(listItem);

            let isAtStart = false;
            if (startContainer.nodeType === Node.TEXT_NODE) {
                if (firstDirectText && startContainer === firstDirectText) {
                    const minOffset = this._getFirstNonZwspOffset(firstDirectText.textContent || '');
                    isAtStart = minOffset === null ? startOffset <= 0 : startOffset <= minOffset;
                } else if (!firstDirectText) {
                    isAtStart = startOffset <= 0;
                }
            } else if (startContainer === listItem) {
                isAtStart = startOffset <= 1;
            }

            if (isAtStart) {
                return true;
            }

            try {
                const beforeRange = document.createRange();
                beforeRange.selectNodeContents(listItem);
                beforeRange.setEnd(startContainer, startOffset);
                const beforeText = (beforeRange.toString() || '').replace(/[\u200B\uFEFF\u00A0]/g, '');
                return beforeText.trim() === '';
            } catch (e) {
                return false;
            }
        };
        const tryMoveDownFromListItemTextStartByVisualLine = () => {
            if (!range || !range.collapsed || !document.caretRangeFromPoint) {
                return false;
            }
            const activeListItem = originListItem ||
                this._getListItemFromContainer(range.startContainer, range.startOffset, 'down') ||
                this.domUtils.getParentElement(range.startContainer, 'LI');
            if (!activeListItem) {
                return false;
            }
            if (!isCollapsedRangeAtListTextStart(range, activeListItem)) {
                return false;
            }

            const textNodes = this._getDirectTextNodes(activeListItem);
            if (textNodes.length === 0) {
                return false;
            }
            const lines = getVisualLinesForListItemText(activeListItem);
            if (lines.length < 2) {
                return false;
            }
            const currentRect = getVisualCaretRectForRange(range);
            const currentIndex = currentRect ? getNearestVisualLineIndex(lines, currentRect) : 0;
            if (currentIndex >= lines.length - 1) {
                return false;
            }
            const targetLine = lines[currentIndex + 1];
            if (!targetLine) {
                return false;
            }

            const lineStartCaret = findLineStartCaretInListItem(activeListItem, textNodes, targetLine);
            if (lineStartCaret) {
                const startRange = document.createRange();
                startRange.setStart(lineStartCaret.node, lineStartCaret.offset);
                startRange.collapse(true);
                selection.removeAllRanges();
                selection.addRange(startRange);
                return true;
            }

            const targetHeight = Math.max(1, targetLine.bottom - targetLine.top);
            const targetY = targetLine.top + Math.max(1, Math.min(targetHeight * 0.5, targetHeight - 1));
            let selectedRange = null;
            let selectedLeft = Infinity;
            for (let dx = 0; dx <= 24; dx += 1) {
                const probeRange = document.caretRangeFromPoint(targetLine.left + dx, targetY);
                if (!probeRange || !this.editor.contains(probeRange.startContainer)) {
                    continue;
                }
                if (probeRange.startContainer.nodeType !== Node.TEXT_NODE ||
                    !textNodes.includes(probeRange.startContainer)) {
                    continue;
                }
                if (!isRangeInsideDirectListText(probeRange, activeListItem, textNodes)) {
                    continue;
                }
                const probeRect = getVisualCaretRectForRange(probeRange);
                if (!probeRect) {
                    continue;
                }
                const probeTop = probeRect.top || probeRect.y || 0;
                if (probeTop < targetLine.top - 3 || probeTop > targetLine.bottom + 3) {
                    continue;
                }
                const probeLeft = probeRect.left || probeRect.x || 0;
                if (!selectedRange || probeLeft < selectedLeft) {
                    selectedRange = probeRange;
                    selectedLeft = probeLeft;
                }
            }

            if (selectedRange) {
                selection.removeAllRanges();
                selection.addRange(selectedRange);
                return true;
            }
            return false;
        };
        const tryMoveWithinCurrentListItemByVisualLine = () => {
            if (!range || !range.collapsed || !document.caretRangeFromPoint) {
                return false;
            }
            let activeListItem = originListItem ||
                this._getListItemFromContainer(range.startContainer, range.startOffset, 'down') ||
                this.domUtils.getParentElement(range.startContainer, 'LI');
            if (!activeListItem) {
                const caretRect = getVisualCaretRectForRange(range);
                if (caretRect && document.elementFromPoint) {
                    const visualNode = document.elementFromPoint(
                        (caretRect.left || caretRect.x || 0) + 1,
                        (caretRect.top || caretRect.y || 0) + Math.max(1, Math.min(8, (caretRect.height || 16) * 0.5))
                    );
                    if (visualNode && this.editor.contains(visualNode)) {
                        activeListItem = (visualNode.nodeType === Node.ELEMENT_NODE && visualNode.tagName === 'LI')
                            ? visualNode
                            : this.domUtils.getParentElement(visualNode, 'LI');
                    }
                }
            }
            if (!activeListItem) {
                return false;
            }
            const textNodes = this._getDirectTextNodes(activeListItem);
            if (textNodes.length === 0) {
                return false;
            }
            const lines = getVisualLinesForListItemText(activeListItem);
            if (lines.length < 2) {
                return false;
            }
            const currentRect = getVisualCaretRectForRange(range);
            if (!currentRect) {
                return false;
            }
            const currentIndex = getNearestVisualLineIndex(lines, currentRect);
            if (currentIndex >= lines.length - 1) {
                return false;
            }

            const currentLine = lines[currentIndex];
            const targetLine = lines[currentIndex + 1];
            if (!targetLine) {
                return false;
            }
            const atCurrentLineStart = (currentRect.left || currentRect.x || 0) <= (currentLine.left + 2);
            if (atCurrentLineStart) {
                const lineStartCaret = findLineStartCaretInListItem(activeListItem, textNodes, targetLine);
                if (lineStartCaret) {
                    const startRange = document.createRange();
                    startRange.setStart(lineStartCaret.node, lineStartCaret.offset);
                    startRange.collapse(true);
                    selection.removeAllRanges();
                    selection.addRange(startRange);
                    return true;
                }
            }

            const currentCaretX = currentRect.left || currentRect.x || 0;
            const targetHeight = Math.max(1, targetLine.bottom - targetLine.top);
            const targetY = targetLine.top + Math.max(1, Math.min(targetHeight * 0.5, targetHeight - 1));
            const xCandidates = atCurrentLineStart
                ? [
                    targetLine.left + 0.5,
                    targetLine.left + 1.5,
                    currentCaretX,
                    currentCaretX + 1
                ]
                : [
                    currentCaretX + 1,
                    currentCaretX,
                    targetLine.left + 1,
                    Math.min(targetLine.right - 1, Math.max(targetLine.left + 1, currentCaretX + 8))
                ];
            const tried = new Set();
            let selectedRange = null;
            let selectedScore = Infinity;

            const trySelectRange = (probeRange) => {
                if (!probeRange || !this.editor.contains(probeRange.startContainer)) {
                    return false;
                }
                if (atCurrentLineStart &&
                    (probeRange.startContainer.nodeType !== Node.TEXT_NODE ||
                        !textNodes.includes(probeRange.startContainer))) {
                    return false;
                }
                if (!isRangeInsideDirectListText(probeRange, activeListItem, textNodes)) {
                    return false;
                }
                const probeRect = getVisualCaretRectForRange(probeRange);
                if (!probeRect) {
                    return false;
                }
                const probeTop = probeRect.top || probeRect.y || 0;
                if (probeTop < targetLine.top - 3 || probeTop > targetLine.bottom + 3) {
                    return false;
                }
                const probeLeft = probeRect.left || probeRect.x || 0;
                const score = atCurrentLineStart ? probeLeft : Math.abs(probeLeft - currentCaretX);
                if (!selectedRange || score < selectedScore) {
                    selectedRange = probeRange;
                    selectedScore = score;
                }
                return true;
            };

            for (const x of xCandidates) {
                if (!Number.isFinite(x)) continue;
                const key = Math.round(x * 10) / 10;
                if (tried.has(key)) continue;
                tried.add(key);
                const probeRange = document.caretRangeFromPoint(x, targetY);
                trySelectRange(probeRange);
            }
            if (atCurrentLineStart) {
                for (let dx = 0; dx <= 16; dx += 1) {
                    const probeRange = document.caretRangeFromPoint(targetLine.left + dx, targetY);
                    trySelectRange(probeRange);
                }
            }

            if (selectedRange) {
                selection.removeAllRanges();
                selection.addRange(selectedRange);
                return true;
            }
            return false;
        };
        if (tryMoveDownFromListItemTextStartByVisualLine()) {
            return;
        }
        if (tryMoveWithinCurrentListItemByVisualLine()) {
            return;
        }
        const originListHasVisualLineBelow = (() => {
            if (!originListItem || !range || !range.collapsed) {
                return false;
            }
            const lines = getVisualLinesForListItemText(originListItem);
            if (lines.length < 2) {
                return false;
            }
            const currentRect = getVisualCaretRectForRange(range);
            if (!currentRect) {
                return true;
            }
            const currentIndex = getNearestVisualLineIndex(lines, currentRect);
            return currentIndex < lines.length - 1;
        })();
        const tryNativeMoveDownWithinCurrentListItemByVisualLine = () => {
            if (!originListItem || !originListHasVisualLineBelow || !selection.modify || !range.collapsed) {
                return false;
            }

            const beforeRange = range.cloneRange();
            const beforeContainer = beforeRange.startContainer;
            const beforeOffset = beforeRange.startOffset;
            const beforeRect = getVisualCaretRectForRange(beforeRange);
            const beforeTop = beforeRect ? (beforeRect.top || beforeRect.y || 0) : null;

            try {
                selection.modify('move', 'forward', 'line');
            } catch (e) {
                return false;
            }

            const afterSelection = window.getSelection();
            if (!afterSelection || !afterSelection.rangeCount) {
                restoreOriginalCaret();
                return false;
            }

            const afterRange = afterSelection.getRangeAt(0);
            const movedByNative = afterRange.startContainer !== beforeContainer ||
                afterRange.startOffset !== beforeOffset;
            if (!movedByNative || !this.editor.contains(afterRange.startContainer)) {
                restoreOriginalCaret();
                return false;
            }

            const afterListItem = this._getListItemFromContainer(afterRange.startContainer, afterRange.startOffset, 'down') ||
                this.domUtils.getParentElement(afterRange.startContainer, 'LI');
            if (afterListItem !== originListItem) {
                restoreOriginalCaret();
                return false;
            }

            const afterRect = getVisualCaretRectForRange(afterRange);
            const afterTop = afterRect ? (afterRect.top || afterRect.y || 0) : null;
            const movedDown = Number.isFinite(beforeTop) &&
                Number.isFinite(afterTop) &&
                afterTop > beforeTop + 2;
            if (!movedDown) {
                restoreOriginalCaret();
                return false;
            }

            if (beforeRect && afterRect) {
                const beforeLineHeight = getEstimatedLineHeight(beforeRange.startContainer, beforeRect);
                const deltaY = (afterTop || 0) - (beforeTop || 0);
                if (deltaY > beforeLineHeight * 1.65) {
                    restoreOriginalCaret();
                    return false;
                }
            }

            return true;
        };
        if (tryNativeMoveDownWithinCurrentListItemByVisualLine()) {
            return;
        }

        if (originListItem && range.collapsed) {
            const caretRectInList = this._getCaretRect(range);
            const listRect = originListItem.getBoundingClientRect ? originListItem.getBoundingClientRect() : null;
            // ネストされた子リストがある場合、子リストの上端を実効的な下端として使う
            let effectiveBottom = listRect ? listRect.bottom : null;
            const nestedListForBounds = Array.from(originListItem.children).find(
                child => child.tagName === 'UL' || child.tagName === 'OL'
            );
            if (nestedListForBounds && listRect) {
                const nestedRect = nestedListForBounds.getBoundingClientRect();
                if (nestedRect && nestedRect.top < listRect.bottom) {
                    effectiveBottom = nestedRect.top;
                }
            }
            const isNearListBottom = !!(caretRectInList && effectiveBottom !== null) &&
                (caretRectInList.bottom + 4 >= effectiveBottom ||
                    (effectiveBottom - caretRectInList.bottom) <= Math.max(4, (caretRectInList.height || 16) * 0.6));
            if (isNearListBottom) {
                const xInList = caretRectInList.left || caretRectInList.x || 0;
                if (moveDownFromListBoundary(originListItem, xInList)) {
                    return;
                }
            }
        }

        // 1行の末尾リスト項目では、視覚プローブより先に構造ベースで下要素へ移動する。
        // これにより HR を飛び越えて次段落へ着地するケースを防ぐ。
        const boundaryListItemForDown = originListItem ||
            this._getListItemFromContainer(range.startContainer, range.startOffset, 'down') ||
            this.domUtils.getParentElement(range.startContainer, 'LI');
        if (boundaryListItemForDown && range.collapsed && isListItemSingleVisualLine(boundaryListItemForDown)) {
            const nextListItem = this._getAdjacentListItem(boundaryListItemForDown, 'next');
            if (!nextListItem) {
                const caretRectInList = this._getCaretRect(range);
                const xInList = caretRectInList ? (caretRectInList.left || caretRectInList.x || 0) : 0;
                if (moveDownFromListBoundary(boundaryListItemForDown, xInList)) {
                    return;
                }
            }
        }

        const getVisualLinesForBlock = (block) => {
            if (!block || block === this.editor) {
                return [];
            }
            try {
                const probeRange = document.createRange();
                probeRange.selectNodeContents(block);
                const rawRects = Array.from(probeRange.getClientRects ? probeRange.getClientRects() : []);
                const rects = rawRects
                    .filter(rect => rect &&
                        Number.isFinite(rect.top) &&
                        Number.isFinite(rect.bottom) &&
                        Number.isFinite(rect.left) &&
                        Number.isFinite(rect.right) &&
                        (rect.width || rect.height))
                    .sort((a, b) => {
                        if (Math.abs(a.top - b.top) <= 1.5) {
                            return a.left - b.left;
                        }
                        return a.top - b.top;
                    });
                if (rects.length === 0) {
                    return [];
                }

                const lines = [];
                for (const rect of rects) {
                    const lastLine = lines.length > 0 ? lines[lines.length - 1] : null;
                    if (!lastLine || Math.abs(lastLine.top - rect.top) > 3) {
                        lines.push({
                            top: rect.top,
                            bottom: rect.bottom,
                            left: rect.left,
                            right: rect.right
                        });
                        continue;
                    }
                    lastLine.top = Math.min(lastLine.top, rect.top);
                    lastLine.bottom = Math.max(lastLine.bottom, rect.bottom);
                    lastLine.left = Math.min(lastLine.left, rect.left);
                    lastLine.right = Math.max(lastLine.right, rect.right);
                }
                return lines;
            } catch (e) {
                return [];
            }
        };
        const hasVisualLineBelowInBlock = (block, referenceRange = range) => {
            if (!block || block === this.editor || !referenceRange) {
                return false;
            }
            const currentRect = getVisualCaretRectForRange(referenceRange);
            if (!currentRect) {
                return false;
            }
            const currentTop = currentRect.top || currentRect.y || 0;
            const lines = getVisualLinesForBlock(block);
            if (lines.length === 0) {
                return false;
            }
            let currentIndex = 0;
            let minDistance = Infinity;
            for (let i = 0; i < lines.length; i++) {
                const distance = Math.abs(lines[i].top - currentTop);
                if (distance < minDistance) {
                    minDistance = distance;
                    currentIndex = i;
                }
            }
            return currentIndex < lines.length - 1;
        };
        const tryMoveWithinCurrentBlockByVisualLine = () => {
            if (!range || !range.collapsed || !document.caretRangeFromPoint) {
                return false;
            }
            if (originListItem || originPreBlock) {
                return false;
            }

            const currentBlock = getBlockFromContainer(range.startContainer, range.startOffset);
            if (!currentBlock || currentBlock === this.editor) {
                return false;
            }
            if (currentBlock.tagName === 'LI' ||
                currentBlock.tagName === 'PRE' ||
                currentBlock.tagName === 'TD' ||
                currentBlock.tagName === 'TH') {
                return false;
            }
            const lines = getVisualLinesForBlock(currentBlock);
            if (lines.length < 2) {
                return false;
            }

            const currentRect = getVisualCaretRectForRange(range);
            if (!currentRect) {
                return false;
            }
            const currentTop = currentRect.top || currentRect.y || 0;
            let currentIndex = 0;
            let minDistance = Infinity;
            for (let i = 0; i < lines.length; i++) {
                const distance = Math.abs(lines[i].top - currentTop);
                if (distance < minDistance) {
                    minDistance = distance;
                    currentIndex = i;
                }
            }
            if (currentIndex >= lines.length - 1) {
                return false;
            }
            const currentLine = lines[currentIndex];
            const targetLine = lines[currentIndex + 1];
            if (!targetLine) {
                return false;
            }

            const currentX = currentRect.left || currentRect.x || 0;
            const atCurrentLineStart = !!currentLine && currentX <= (currentLine.left + 2);
            const targetHeight = Math.max(1, targetLine.bottom - targetLine.top);
            const targetY = targetLine.top + Math.max(1, Math.min(targetHeight * 0.5, targetHeight - 1));
            const findLineStartCaretInBlock = (block, line) => {
                if (!block || !line) {
                    return null;
                }

                const pickCandidate = (skipWhitespace) => {
                    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, null, false);
                    let textNode;
                    let best = null;
                    let guard = 0;
                    while (textNode = walker.nextNode()) {
                        const text = textNode.textContent || '';
                        if (text.length === 0) continue;
                        for (let i = 0; i < text.length; i++) {
                            guard++;
                            if (guard > 12000) {
                                return best;
                            }
                            const ch = text[i];
                            if (ch === '\n' || ch === '\r' || ch === '\u200B' || ch === '\uFEFF') {
                                continue;
                            }
                            if (skipWhitespace && /\s/.test(ch)) {
                                continue;
                            }
                            let charRect = null;
                            try {
                                const charRange = document.createRange();
                                charRange.setStart(textNode, i);
                                charRange.setEnd(textNode, i + 1);
                                charRect = charRange.getBoundingClientRect();
                            } catch (e) {
                                continue;
                            }
                            if (!charRect || !(charRect.width || charRect.height)) {
                                continue;
                            }
                            const charTop = charRect.top || charRect.y || 0;
                            const charBottom = charRect.bottom || (charRect.y + charRect.height) || charTop;
                            const overlapsTargetLine = charBottom >= line.top - 2 && charTop <= line.bottom + 2;
                            if (!overlapsTargetLine) {
                                continue;
                            }
                            const charLeft = charRect.left || charRect.x || 0;
                            if (!best || charLeft < best.left - 0.5 ||
                                (Math.abs(charLeft - best.left) <= 0.5 && charTop < best.top)) {
                                best = {
                                    node: textNode,
                                    offset: i,
                                    left: charLeft,
                                    top: charTop
                                };
                            }
                        }
                    }
                    return best;
                };

                return pickCandidate(true) || pickCandidate(false);
            };
            if (atCurrentLineStart) {
                const lineStartCaret = findLineStartCaretInBlock(currentBlock, targetLine);
                if (lineStartCaret) {
                    const startRange = document.createRange();
                    startRange.setStart(lineStartCaret.node, lineStartCaret.offset);
                    startRange.collapse(true);
                    selection.removeAllRanges();
                    selection.addRange(startRange);
                    return true;
                }
            }
            const xCandidates = atCurrentLineStart
                ? [
                    targetLine.left + 0.5,
                    targetLine.left + 1.5,
                    currentX,
                    currentX + 1
                ]
                : [
                    currentX + 1,
                    currentX,
                    targetLine.left + 1,
                    Math.min(targetLine.right - 1, Math.max(targetLine.left + 1, currentX + 8))
                ];
            const tried = new Set();
            let selectedRange = null;
            let selectedScore = Infinity;

            const trySelectRange = (probeRange) => {
                if (!probeRange || !this.editor.contains(probeRange.startContainer)) {
                    return false;
                }
                if (!currentBlock.contains(probeRange.startContainer)) {
                    return false;
                }
                const probeRect = getVisualCaretRectForRange(probeRange);
                if (!probeRect) {
                    return false;
                }
                const probeTop = probeRect.top || probeRect.y || 0;
                if (probeTop < targetLine.top - 3 || probeTop > targetLine.bottom + 3) {
                    return false;
                }
                const probeLeft = probeRect.left || probeRect.x || 0;
                const score = atCurrentLineStart ? probeLeft : Math.abs(probeLeft - currentX);
                if (!selectedRange || score < selectedScore) {
                    selectedRange = probeRange;
                    selectedScore = score;
                }
                return true;
            };

            for (const x of xCandidates) {
                if (!Number.isFinite(x)) continue;
                const key = Math.round(x * 10) / 10;
                if (tried.has(key)) continue;
                tried.add(key);
                const probeRange = document.caretRangeFromPoint(x, targetY);
                trySelectRange(probeRange);
            }

            // 行頭移動時は、ターゲット行の左端に最も近いキャレット位置を探索して採用する。
            if (atCurrentLineStart) {
                for (let dx = 0; dx <= 16; dx += 1) {
                    const probeRange = document.caretRangeFromPoint(targetLine.left + dx, targetY);
                    trySelectRange(probeRange);
                }
            }

            if (selectedRange) {
                selection.removeAllRanges();
                selection.addRange(selectedRange);
                return true;
            }
            return false;
        };
        if (tryMoveWithinCurrentBlockByVisualLine()) {
            return;
        }

        const normalizeTopLevelIgnorableCaretDown = () => {
            const activeSelection = window.getSelection();
            if (!activeSelection || !activeSelection.rangeCount) {
                return false;
            }
            const activeRange = activeSelection.getRangeAt(0);
            if (!activeRange.collapsed) {
                return false;
            }
            const startContainer = activeRange.startContainer;
            if (!startContainer || startContainer.nodeType !== Node.TEXT_NODE) {
                return false;
            }
            if (startContainer.parentElement !== this.editor) {
                return false;
            }
            if (!this._isIgnorableTextNode(startContainer)) {
                return false;
            }

            const findAdjacentNavigableElement = (node, direction) => {
                let sibling = direction === 'next' ? node.nextSibling : node.previousSibling;
                while (sibling) {
                    if (sibling.nodeType === Node.TEXT_NODE) {
                        if (!this._isIgnorableTextNode(sibling)) {
                            return null;
                        }
                        sibling = direction === 'next' ? sibling.nextSibling : sibling.previousSibling;
                        continue;
                    }
                    if (sibling.nodeType !== Node.ELEMENT_NODE) {
                        sibling = direction === 'next' ? sibling.nextSibling : sibling.previousSibling;
                        continue;
                    }
                    if (this._isNavigationExcludedElement(sibling) || sibling.tagName === 'BR') {
                        sibling = direction === 'next' ? sibling.nextSibling : sibling.previousSibling;
                        continue;
                    }
                    return sibling;
                }
                return null;
            };

            const nextElement = findAdjacentNavigableElement(startContainer, 'next');
            if (nextElement && moveToBlockStart(nextElement)) {
                return true;
            }

            const prevElement = findAdjacentNavigableElement(startContainer, 'prev');
            if (prevElement) {
                const fallbackRange = document.createRange();
                const lastTextNode = this._getLastNavigableTextNode(prevElement);
                if (lastTextNode) {
                    fallbackRange.setStart(lastTextNode, (lastTextNode.textContent || '').length);
                } else {
                    fallbackRange.setStart(
                        prevElement,
                        prevElement.childNodes ? prevElement.childNodes.length : 0
                    );
                }
                fallbackRange.collapse(true);
                activeSelection.removeAllRanges();
                activeSelection.addRange(fallbackRange);
                return true;
            }

            return false;
        };

        // 直下が空行ブロックの場合は、次のテキスト行へ飛ばさず空行に入る
        const originBlock = getBlockFromContainer(container, range.startOffset);
        if (originBlock) {
            const nextBlock = this._getNextNavigableElementSibling(originBlock);
            const caretRect = getVisualCaretRectForRange(range);
            const blockRect = originBlock.getBoundingClientRect ? originBlock.getBoundingClientRect() : null;
            const lineHeightForBottom = caretRect ? getEstimatedLineHeight(range.startContainer, caretRect) : 18;
            const effectiveCaretBottom = !caretRect
                ? null
                : (() => {
                    const rectTop = caretRect.top || caretRect.y || 0;
                    const rectBottom = caretRect.bottom || (caretRect.y + caretRect.height) || 0;
                    const rectHeight = caretRect.height || 0;
                    if (rectHeight > lineHeightForBottom * 1.8) {
                        return rectTop + lineHeightForBottom;
                    }
                    return rectBottom;
                })();
            const hasLineBelowInOriginBlock = hasVisualLineBelowInBlock(originBlock, range);
            const nearBottom = !caretRect || !blockRect || !Number.isFinite(effectiveCaretBottom)
                ? true
                : (effectiveCaretBottom + 4 >= blockRect.bottom ||
                    (blockRect.bottom - effectiveCaretBottom) <= Math.max(4, lineHeightForBottom * 0.6));
            const nextLeadingImage = nextBlock ? this._getLeadingImageInBlock(nextBlock) : null;
            if (nextLeadingImage && nearBottom && !hasLineBelowInOriginBlock) {
                const imageRange = document.createRange();
                if (this._collapseRangeBeforeNode(imageRange, nextLeadingImage)) {
                    selection.removeAllRanges();
                    selection.addRange(imageRange);
                    return;
                }
            }
            if (nextBlock && isEffectivelyEmptyBlock(nextBlock)) {
                if (!hasLineBelowInOriginBlock && moveToBlockStart(nextBlock)) {
                    return;
                }
            }
        }

        // リスト項目先頭からの下移動は、次のリスト項目へ確定移動する
        const activeListItemForStartNav = originListItem ||
            this._getListItemFromContainer(range.startContainer, range.startOffset, 'down') ||
            this.domUtils.getParentElement(range.startContainer, 'LI');
        const startNavLines = activeListItemForStartNav
            ? getVisualLinesForListItemText(activeListItemForStartNav)
            : [];
        if (activeListItemForStartNav &&
            range.collapsed &&
            startNavLines.length <= 1 &&
            isCollapsedRangeAtListTextStart(range, activeListItemForStartNav)) {
            const caretRectAtStart = this._getCaretRect(range);
            const xAtStart = caretRectAtStart ? (caretRectAtStart.left || caretRectAtStart.x || 0) : 0;
            const nextListItem = this._getAdjacentListItem(activeListItemForStartNav, 'next');
            if (nextListItem) {
                if (this._placeCursorInListItemAtX(nextListItem, xAtStart, 'down', selection)) {
                    return;
                }
                const fallbackNode = this._getFirstDirectTextNode(nextListItem) || this._getLastDirectTextNode(nextListItem);
                if (fallbackNode) {
                    const fallbackRange = document.createRange();
                    fallbackRange.setStart(fallbackNode, 0);
                    fallbackRange.collapse(true);
                    selection.removeAllRanges();
                    selection.addRange(fallbackRange);
                    return;
                }
            } else if (moveDownFromListBoundary(activeListItemForStartNav, xAtStart)) {
                return;
            }
        }

        const tryNativeMoveDownOneVisualLine = () => {
            if (!selection.modify || !range.collapsed) {
                return false;
            }
            if (originListItem || originPreBlock) {
                return false;
            }

            const beforeRange = range.cloneRange();
            const beforeContainer = beforeRange.startContainer;
            const beforeOffset = beforeRange.startOffset;
            const beforeRect = getVisualCaretRectForRange(beforeRange);
            const beforeTop = beforeRect ? (beforeRect.top || beforeRect.y || 0) : null;

            try {
                selection.modify('move', 'forward', 'line');
            } catch (e) {
                return false;
            }

            const afterSelection = window.getSelection();
            if (!afterSelection || !afterSelection.rangeCount) {
                restoreOriginalCaret();
                return false;
            }

            const afterRange = afterSelection.getRangeAt(0);
            const movedByNative = afterRange.startContainer !== beforeContainer ||
                afterRange.startOffset !== beforeOffset ||
                afterRange.endContainer !== beforeContainer ||
                afterRange.endOffset !== beforeOffset;
            if (!movedByNative || !this.editor.contains(afterRange.startContainer)) {
                restoreOriginalCaret();
                return false;
            }

            const afterRect = getVisualCaretRectForRange(afterRange);
            const afterTop = afterRect ? (afterRect.top || afterRect.y || 0) : null;
            const movedDown = Number.isFinite(beforeTop) &&
                Number.isFinite(afterTop) &&
                afterTop > beforeTop + 2;
            if (!movedDown) {
                restoreOriginalCaret();
                return false;
            }

            // 2行以上飛んだケースは採用せず、既存の詳細ロジックへフォールバックする。
            if (beforeRect && afterRect) {
                const beforeLineHeight = getEstimatedLineHeight(beforeRange.startContainer, beforeRect);
                const deltaY = (afterTop || 0) - (beforeTop || 0);
                if (deltaY > beforeLineHeight * 1.65) {
                    restoreOriginalCaret();
                    return false;
                }
            }

            const landedOnTopLevelIgnorableText =
                afterRange.collapsed &&
                afterRange.startContainer &&
                afterRange.startContainer.nodeType === Node.TEXT_NODE &&
                afterRange.startContainer.parentElement === this.editor &&
                this._isIgnorableTextNode(afterRange.startContainer);
            if (landedOnTopLevelIgnorableText) {
                if (normalizeTopLevelIgnorableCaretDown()) {
                    return true;
                }
                restoreOriginalCaret();
                return false;
            }

            return true;
        };
        if (tryNativeMoveDownOneVisualLine()) {
            return;
        }

        range = selection.getRangeAt(0);
        container = range.startContainer;

        // デフォルトの動作：カーソルを下に移動
        let rect = getVisualCaretRectForRange(range);
        if (!rect) {
            return;
        }

        const estimatedLineHeight = getEstimatedLineHeight(range.startContainer, rect);
        const currentX = rect.left || rect.x || 0;
        const rectTop = rect.top || rect.y || 0;
        const rectBottom = rect.bottom || (rect.y + rect.height) || 0;
        const rangeStartsAtElementBoundary = range.startContainer && range.startContainer.nodeType === Node.ELEMENT_NODE;
        const rectLooksLikeBlockBounds = Number.isFinite(rect.height) && rect.height > estimatedLineHeight * 1.8;
        const currentY = (rangeStartsAtElementBoundary || rectLooksLikeBlockBounds)
            ? (rectTop + estimatedLineHeight)
            : rectBottom;
        const lineStep = estimatedLineHeight;

        let moved = false;

        const tryMoveAt = (targetY) => {
            const elementBelow = document.elementFromPoint(currentX, targetY);
            if (elementBelow && this.editor.contains(elementBelow) && elementBelow.tagName === 'HR') {
                const newRange = document.createRange();
                newRange.selectNode(elementBelow);
                selection.removeAllRanges();
                selection.addRange(newRange);
                return true;
            }
            if (!elementBelow || !this.editor.contains(elementBelow)) {
                return false;
            }

            const caretRange = document.caretRangeFromPoint(currentX, targetY);
            if (!caretRange) {
                return false;
            }
            if (!originPreBlock) {
                const targetCode = this.domUtils.getParentElement(caretRange.startContainer, 'CODE');
                const targetPre = targetCode ? this.domUtils.getParentElement(targetCode, 'PRE') : null;
                if (targetPre && this._selectCodeBlockLanguageLabel(targetPre, selection)) {
                    return true;
                }
            }
            const newRect = caretRange.getBoundingClientRect();
            const newY = newRect.bottom || (newRect.y + newRect.height);
            if (newY <= currentY + 4) {
                return false;
            }

            try {
                const targetContainer = caretRange.startContainer;
                const targetTopLevelBlock = getTopLevelBlockForNavigation(
                    targetContainer,
                    caretRange.startOffset
                );
                if (originTopLevelBlock &&
                    targetTopLevelBlock &&
                    originTopLevelBlock !== targetTopLevelBlock) {
                    let between = this._getNextNavigableElementInDocument(originTopLevelBlock);
                    let guard = 0;
                    while (between && guard < 2000) {
                        guard++;
                        if (between.tagName === 'HR') {
                            const hrRange = document.createRange();
                            hrRange.selectNode(between);
                            selection.removeAllRanges();
                            selection.addRange(hrRange);
                            return true;
                        }
                        const leadingImage = this._getLeadingImageInBlock(between);
                        if (leadingImage) {
                            const imageRange = document.createRange();
                            if (this._collapseRangeBeforeNode(imageRange, leadingImage)) {
                                selection.removeAllRanges();
                                selection.addRange(imageRange);
                                return true;
                            }
                        }
                        if (between === targetTopLevelBlock) {
                            break;
                        }
                        between = this._getNextNavigableElementInDocument(between);
                    }
                }
                let targetListItem = this.domUtils.getParentElement(targetContainer, 'LI');
                if (!targetListItem) {
                    targetListItem = this._getListItemFromContainer(
                        targetContainer,
                        caretRange.startOffset,
                        'down'
                    );
                }
                if (targetListItem) {
                    if (originListHasVisualLineBelow &&
                        originListItem &&
                        targetListItem !== originListItem) {
                        return false;
                    }
                    // リスト内の移動は専用ロジックに委譲し、X位置を維持する
                    // （先頭固定にすると階層跨ぎで見た目位置が崩れる）
                    if (!(originIsEmptyWithNested && originNestedList && originNestedList.contains(targetListItem))) {
                        if (this._placeCursorInListItemAtX(targetListItem, currentX, 'down', selection)) {
                            return true;
                        }
                    }

                    const textNodes = [];
                    const walker = document.createTreeWalker(
                        targetListItem,
                        NodeFilter.SHOW_TEXT,
                        {
                            acceptNode: function (node) {
                                let parent = node.parentElement;
                                while (parent && parent !== targetListItem) {
                                    if (parent.tagName === 'UL' || parent.tagName === 'OL') {
                                        return NodeFilter.FILTER_REJECT;
                                    }
                                    parent = parent.parentElement;
                                }
                                return NodeFilter.FILTER_ACCEPT;
                            }
                        },
                        false
                    );

                    let textNode;
                    while (textNode = walker.nextNode()) {
                        textNodes.push(textNode);
                    }

                    if (textNodes.length > 0) {
                        if (originIsEmptyWithNested && originNestedList && originNestedList.contains(targetListItem)) {
                            caretRange.setStart(textNodes[0], 0);
                            caretRange.collapse(true);
                        } else if (targetContainer.nodeType !== 3) {
                            caretRange.setStart(textNodes[0], 0);
                            caretRange.collapse(true);
                        } else {
                            const isInListItemText = textNodes.some(node => node === targetContainer);
                            if (!isInListItemText) {
                                caretRange.setStart(textNodes[0], 0);
                                caretRange.collapse(true);
                            } else {
                                const textRange = document.createRange();
                                textRange.selectNodeContents(targetContainer);
                                const textRect = textRange.getBoundingClientRect();
                                if (currentX < textRect.left) {
                                    caretRange.setStart(textNodes[0], 0);
                                    caretRange.collapse(true);
                                } else if (currentX > textRect.right) {
                                    const lastTextNode = textNodes[textNodes.length - 1];
                                    caretRange.setStart(lastTextNode, lastTextNode.textContent.length);
                                    caretRange.collapse(true);
                                }
                            }
                        }
                    } else {
                        const newTextNode = document.createTextNode('');
                        this._insertTextNodeIntoListItem(targetListItem, newTextNode);
                        caretRange.setStart(newTextNode, 0);
                        caretRange.collapse(true);
                    }
                } else {
                    // 非リストブロック要素（見出し、段落等）の場合
                    // テキスト行の中心Yで再プローブして正確なX位置を取得する
                    const lineCenterY = newRect.height > 0
                        ? newRect.top + newRect.height / 2
                        : newRect.top;
                    if (lineCenterY > 0 && Math.abs(lineCenterY - targetY) > 2) {
                        const adjustedRange = document.caretRangeFromPoint(currentX, lineCenterY);
                        if (adjustedRange && this.editor.contains(adjustedRange.startContainer)) {
                            caretRange.setStart(adjustedRange.startContainer, adjustedRange.startOffset);
                            caretRange.collapse(true);
                        }
                    }
                }

                selection.removeAllRanges();
                selection.addRange(caretRange);
                return true;
            } catch (e) {
                return false;
            }
        };

        // 視覚的な移動を試みる（近い行から段階的に探索）
        for (let step = 1; step <= 6; step++) {
            const targetY = currentY + lineStep * step;
            if (tryMoveAt(targetY)) {
                moved = true;
                break;
            }
        }

        if (moved) {
            const currentSelection = window.getSelection();
            if (!currentSelection || !currentSelection.rangeCount) {
                moved = false;
            } else {
                const afterRange = currentSelection.getRangeAt(0);
                const afterRect = this._getCaretRect(afterRange);
                const afterBottom = afterRect ? (afterRect.bottom || (afterRect.y + afterRect.height) || 0) : null;
                if (afterBottom === null || afterBottom <= currentY + 2) {
                    moved = false;
                } else {
                    const landedOnTopLevelIgnorableText =
                        afterRange.collapsed &&
                        afterRange.startContainer &&
                        afterRange.startContainer.nodeType === Node.TEXT_NODE &&
                        afterRange.startContainer.parentElement === this.editor &&
                        this._isIgnorableTextNode(afterRange.startContainer);
                    if (landedOnTopLevelIgnorableText && !normalizeTopLevelIgnorableCaretDown()) {
                        moved = false;
                    }
                }
            }
        }

        if (!moved) {
            let listItemForDown = originListItem;
            if (!listItemForDown) {
                const currentSelection = window.getSelection();
                if (currentSelection && currentSelection.rangeCount > 0) {
                    const currentRange = currentSelection.getRangeAt(0);
                    listItemForDown = this._getListItemFromContainer(currentRange.startContainer, currentRange.startOffset, 'down') ||
                        this.domUtils.getParentElement(currentRange.startContainer, 'LI');
                }
            }
            if (!listItemForDown) {
                listItemForDown = this._getListItemFromContainer(container, range.startOffset, 'down') ||
                    this.domUtils.getParentElement(container, 'LI');
            }
            if (originListHasVisualLineBelow) {
                listItemForDown = null;
            }
            const nextListItem = listItemForDown ? this._getAdjacentListItem(listItemForDown, 'next') : null;
            if (nextListItem) {
                if (this._placeCursorInListItemAtX(nextListItem, currentX, 'down', selection)) {
                    return;
                }
            }
        }

        // 視覚的な移動が失敗した場合、構造的な移動を試みる
        if (!moved) {
            // 現在のブロック要素を特定
            let currentBlock = container;
            while (currentBlock && currentBlock !== this.editor && !this.domUtils.isBlockElement(currentBlock)) {
                currentBlock = currentBlock.parentElement;
            }

            // ブロックの下端付近にいるかチェック
            // 視覚移動失敗時は基本的にブロックの端にいるとみなしてよいが、念のためチェック
            // ただし、視覚移動が失敗した時点で「構造的な次の要素に行くしかない」状況であることが多い
            let isAtBottom = false;

            if (currentBlock && currentBlock !== this.editor && currentBlock.tagName !== 'TD' && currentBlock.tagName !== 'TH') {
                // 厳密なBottomチェックは不要かもしれないが、一応行う
                const blockRect = currentBlock.getBoundingClientRect();
                // CaretがBlock Bottom付近にあるか
                if (currentY + 20 >= blockRect.bottom || (blockRect.bottom - currentY) < 40) {
                    isAtBottom = true;
                }
            } else {
                // ブロック特定失敗時等は安全策としてFallback試行
                isAtBottom = true;
            }

            if (isAtBottom && currentBlock) {
                let nextElement = this._getNextNavigableElementSibling(currentBlock);
                // 水平線の場合は水平線全体を選択
                if (nextElement && nextElement.tagName === 'HR') {
                    const newRange = document.createRange();
                    newRange.selectNode(nextElement);
                    selection.removeAllRanges();
                    selection.addRange(newRange);
                    return;
                }
                if (nextElement) {
                    if (nextElement.tagName === 'PRE' && this._selectCodeBlockLanguageLabel(nextElement, selection)) {
                        return;
                    }
                    // X位置を維持してカーソルを配置する
                    let placed = false;
                    const firstNode = this.domUtils.getFirstTextNode(nextElement);
                    if (firstNode) {
                        const text = firstNode.textContent || '';
                        if (text.length > 0) {
                            const firstCharRange = document.createRange();
                            firstCharRange.setStart(firstNode, 0);
                            firstCharRange.setEnd(firstNode, Math.min(1, text.length));
                            const firstCharRect = firstCharRange.getBoundingClientRect();
                            if (firstCharRect && firstCharRect.height > 0) {
                                const lineCenterY = firstCharRect.top + firstCharRect.height / 2;
                                const caretRange = document.caretRangeFromPoint(currentX, lineCenterY);
                                if (caretRange && nextElement.contains(caretRange.startContainer)) {
                                    const newRange = document.createRange();
                                    newRange.setStart(caretRange.startContainer, caretRange.startOffset);
                                    newRange.collapse(true);
                                    selection.removeAllRanges();
                                    selection.addRange(newRange);
                                    placed = true;
                                }
                            }
                        }
                    }
                    if (!placed) {
                        const newRange = document.createRange();
                        if (firstNode) {
                            newRange.setStart(firstNode, 0);
                        } else {
                            newRange.setStart(nextElement, 0);
                        }
                        newRange.collapse(true);
                        selection.removeAllRanges();
                        selection.addRange(newRange);
                    }
                    moved = true;
                }
            }
        }

        if (moved) {
            const currentSelection = window.getSelection();
            if (!currentSelection || !currentSelection.rangeCount) {
                moved = false;
            } else {
                const currentRange = currentSelection.getRangeAt(0);
                if (currentRange.startContainer === originContainer &&
                    currentRange.startOffset === originOffset &&
                    currentRange.endContainer === originContainer &&
                    currentRange.endOffset === originOffset) {
                    moved = false;
                }
            }
        }

        if (!moved) {
            const anchor = getBlockFromContainer(container) ||
                (container.nodeType === Node.ELEMENT_NODE ? container : container.parentElement);
            const nextElement = anchor ? this._getNextNavigableElementInDocument(anchor) : null;
            if (nextElement) {
                if (nextElement.tagName === 'PRE' && this._selectCodeBlockLanguageLabel(nextElement, selection)) {
                    return;
                }
                // X位置を維持してカーソルを配置する
                let placed = false;
                const firstNode = this._getFirstNavigableTextNode(nextElement);
                if (firstNode) {
                    const text = firstNode.textContent || '';
                    if (text.length > 0) {
                        const firstCharRange = document.createRange();
                        firstCharRange.setStart(firstNode, 0);
                        firstCharRange.setEnd(firstNode, Math.min(1, text.length));
                        const firstCharRect = firstCharRange.getBoundingClientRect();
                        if (firstCharRect && firstCharRect.height > 0) {
                            const lineCenterY = firstCharRect.top + firstCharRect.height / 2;
                            const caretRange = document.caretRangeFromPoint(currentX, lineCenterY);
                            if (caretRange && nextElement.contains(caretRange.startContainer)) {
                                const newRange = document.createRange();
                                newRange.setStart(caretRange.startContainer, caretRange.startOffset);
                                newRange.collapse(true);
                                selection.removeAllRanges();
                                selection.addRange(newRange);
                                placed = true;
                            }
                        }
                    }
                }
                if (!placed) {
                    const newRange = document.createRange();
                    if (firstNode) {
                        newRange.setStart(firstNode, 0);
                    } else {
                        newRange.setStart(nextElement, 0);
                    }
                    newRange.collapse(true);
                    selection.removeAllRanges();
                    selection.addRange(newRange);
                }
                return;
            }

            const listContainer = this.domUtils.getParentElement(container, 'UL') ||
                this.domUtils.getParentElement(container, 'OL');
            if (listContainer && listContainer.parentElement) {
                let outerList = listContainer;
                while (outerList.parentElement && outerList.parentElement.tagName === 'LI') {
                    const parentLi = outerList.parentElement;
                    const parentList = parentLi.parentElement;
                    if (parentList && (parentList.tagName === 'UL' || parentList.tagName === 'OL')) {
                        outerList = parentList;
                    } else {
                        break;
                    }
                }

                const newP = document.createElement('p');
                newP.appendChild(document.createElement('br'));
                if (outerList.nextSibling) {
                    outerList.parentElement.insertBefore(newP, outerList.nextSibling);
                } else {
                    outerList.parentElement.appendChild(newP);
                }

                const newRange = document.createRange();
                newRange.setStart(newP, 0);
                newRange.collapse(true);
                selection.removeAllRanges();
                selection.addRange(newRange);
                if (notifyCallback) notifyCallback();
                return;
            }
        }
    }

    /**
     * カーソルを右に1文字移動
     * @param {Function} notifyCallback - 変更を通知するコールバック
     * @returns {boolean} 移動が処理された場合はtrue、それ以外はfalse
     */
    moveCursorForward(notifyCallback) {
        const selection = window.getSelection();
        if (!selection || !selection.rangeCount) return false;
        let range = selection.getRangeAt(0);
        let node = range.startContainer;
        let offset = range.startOffset;
        const applyRange = (targetRange) => {
            this._adjustIntoInlineCodeBoundary(targetRange, 'forward');
            selection.removeAllRanges();
            selection.addRange(targetRange);
        };
        const isEffectivelyEmptyBlock = (block) => {
            if (!block) return false;
            const text = (block.textContent || '').replace(/[\u200B\uFEFF\u00A0]/g, '').trim();
            if (text !== '') return false;
            const meaningfulChild = Array.from(block.childNodes).some(child => {
                if (child.nodeType === Node.ELEMENT_NODE) {
                    if (child.tagName === 'BR') return false;
                    if (this._isNavigationExcludedElement(child)) return false;
                    return true;
                }
                if (child.nodeType === Node.TEXT_NODE) {
                    return !this._isIgnorableTextNode(child);
                }
                return false;
            });
            return !meaningfulChild;
        };
        const getCurrentBlockForNode = (target) => {
            let block = target && target.nodeType === Node.ELEMENT_NODE ? target : target?.parentElement;
            while (block && block !== this.editor && !this.domUtils.isBlockElement(block)) {
                block = block.parentElement;
            }
            return block && block !== this.editor ? block : null;
        };
        const isTrailingEmptyBlock = (target) => {
            const block = getCurrentBlockForNode(target);
            if (!block) return false;
            if (!isEffectivelyEmptyBlock(block)) return false;
            return !this._getNextNavigableElementInDocument(block);
        };
        const moveToCodeBlockLabel = (target) => {
            if (!target || target.nodeType !== Node.ELEMENT_NODE || target.tagName !== 'PRE') {
                return false;
            }
            return this._selectCodeBlockLanguageLabel(target, selection);
        };
        const shouldTreatAsHorizontalEmptyBlock = (block) => {
            if (!block || !isEffectivelyEmptyBlock(block)) return false;
            if (block.tagName === 'LI' || block.tagName === 'TD' || block.tagName === 'TH' || block.tagName === 'PRE') {
                return false;
            }
            return true;
        };
        const moveToBlockStart = (block) => {
            if (!block || block.nodeType !== Node.ELEMENT_NODE) {
                return false;
            }
            if (block.tagName === 'HR') {
                const hrRange = document.createRange();
                hrRange.selectNode(block);
                selection.removeAllRanges();
                selection.addRange(hrRange);
                return true;
            }
            if (this._placeCursorBeforeLeadingInlineCode(block, selection)) {
                return true;
            }
            if (moveToCodeBlockLabel(block)) {
                return true;
            }
            const leadingImage = this._getLeadingImageInBlock(block);
            if (leadingImage) {
                const imageRange = document.createRange();
                if (this._collapseRangeBeforeNode(imageRange, leadingImage)) {
                    applyRange(imageRange);
                    return true;
                }
            }
            const firstNode = this._getFirstNavigableTextNode(block);
            const targetRange = document.createRange();
            if (firstNode) {
                if (moveToInlineCodeOutsideLeftFromTextNode(firstNode)) {
                    return true;
                }
                const text = firstNode.textContent || '';
                const firstOffset = this._getFirstNonZwspOffset(text);
                targetRange.setStart(firstNode, firstOffset !== null ? firstOffset : 0);
            } else {
                if (block.tagName === 'P') {
                    const hasText = (block.textContent || '').replace(/[\u200B\uFEFF\u00A0]/g, '').trim() !== '';
                    const hasBr = !!block.querySelector('br');
                    if (!hasText && !hasBr) {
                        block.appendChild(document.createElement('br'));
                    }
                }
                targetRange.setStart(block, 0);
            }
            targetRange.collapse(true);
            applyRange(targetRange);
            return true;
        };
        const moveToInlineCodeOutsideLeftFromTextNode = (targetTextNode) => {
            if (!targetTextNode || targetTextNode.nodeType !== Node.TEXT_NODE) {
                return false;
            }
            const inlineCode = this.domUtils.getParentElement(targetTextNode, 'CODE');
            if (!inlineCode || this.domUtils.getParentElement(inlineCode, 'PRE')) {
                return false;
            }
            return this._placeCursorBeforeInlineCodeElement(inlineCode, selection);
        };

        if (isTrailingEmptyBlock(node)) {
            return true;
        }

        this._normalizeSelectionForNavigation(selection);
        range = selection.getRangeAt(0);
        node = range.startContainer;
        offset = range.startOffset;
        this._debugInlineNav('forward-start', {
            containerType: node?.nodeType,
            offset
        });
        if (this._consumePendingForwardInlineCodeEntry(selection)) {
            return true;
        }
        // Some WebView engines occasionally normalize a collapsed caret around an image
        // as startContainer=IMG. Treat it as "left edge" so forward keeps:
        // left edge -> image selected -> right edge.
        if (range.collapsed &&
            node &&
            node.nodeType === Node.ELEMENT_NODE &&
            node.tagName === 'IMG') {
            const imageRange = document.createRange();
            imageRange.selectNode(node);
            selection.removeAllRanges();
            selection.addRange(imageRange);
            return true;
        }
        if (this._normalizeCollapsedImageAnchor(selection, 'forward')) {
            return true;
        }
        range = selection.getRangeAt(0);
        node = range.startContainer;
        offset = range.startOffset;

        // 画像右エッジ（画像直後）では、次の行（次ブロック）先頭へ進む。
        if (range.collapsed) {
            const imageBehind = this._getImageBehindFromCollapsedRange(range);
            if (imageBehind && this._isCollapsedRangeAtNodeBoundary(range, imageBehind, 'after')) {
                const imageBlock = getCurrentBlockForNode(imageBehind);
                const trailingImage = imageBlock
                    ? this._getTrailingImageInBlock(imageBlock)
                    : (imageBehind.parentElement === this.editor ? imageBehind : null);
                if (trailingImage === imageBehind) {
                    const boundaryNode = imageBlock || imageBehind;
                    const nextElementAfterImage = this._getNextNavigableElementInDocument(boundaryNode);
                    if (nextElementAfterImage) {
                        if (moveToBlockStart(nextElementAfterImage)) {
                            return true;
                        }
                    } else {
                        return true;
                    }
                }
            }
        }

        // Element-boundary before inline code should land on outside-left first.
        if (node && node.nodeType === Node.ELEMENT_NODE) {
            const candidate = node.childNodes[offset] || null;
            const isInlineCodeCandidate = !!(candidate &&
                candidate.nodeType === Node.ELEMENT_NODE &&
                candidate.tagName === 'CODE' &&
                !this.domUtils.getParentElement(candidate, 'PRE'));
            if (isInlineCodeCandidate) {
                let prevSibling = offset > 0 ? node.childNodes[offset - 1] : null;
                while (prevSibling &&
                    prevSibling.nodeType === Node.TEXT_NODE &&
                    this._isInlineCodeBoundaryPlaceholder(prevSibling)) {
                    prevSibling = prevSibling.previousSibling;
                }
                let hasRealContentBefore = false;
                if (prevSibling && prevSibling.nodeType === Node.TEXT_NODE) {
                    hasRealContentBefore = (prevSibling.textContent || '').replace(/[\u200B\uFEFF]/g, '') !== '';
                } else if (prevSibling &&
                    prevSibling.nodeType === Node.ELEMENT_NODE &&
                    !this._isNavigationExcludedElement(prevSibling) &&
                    prevSibling.tagName !== 'BR') {
                    const lastTextNode = this._getLastNavigableTextNode(prevSibling);
                    hasRealContentBefore = !!(
                        lastTextNode &&
                        (lastTextNode.textContent || '').replace(/[\u200B\uFEFF]/g, '') !== ''
                    );
                }
                if (hasRealContentBefore) {
                    this._debugInlineNav('forward-element-boundary-direct-inside-left', {
                        containerType: node?.nodeType,
                        offset
                    });
                    this._clearPendingForwardInlineCodeEntry();
                    if (this._placeCursorInsideInlineCodeStart(candidate, selection)) {
                        return true;
                    }
                }
                if (this._placeCursorBeforeInlineCodeElement(candidate, selection)) {
                    return true;
                }
            }
        }

        const currentListItem = this._getListItemFromContainer(node, offset, 'down') ||
            this.domUtils.getParentElement(node, 'LI');
        if (currentListItem && range.collapsed) {
            const lastDirectText = this._getLastDirectTextNode(currentListItem);
            let isAtListEnd = false;

            // data-preserve-emptyなリストアイテムは常に末尾として扱い、
            // →キーで即座に次の要素に移動する（&nbsp;等を通過させない）
            if (currentListItem.getAttribute('data-preserve-empty') === 'true') {
                isAtListEnd = true;
            } else if (node.nodeType === Node.TEXT_NODE) {
                if (lastDirectText && node === lastDirectText) {
                    const text = node.textContent || '';
                    const lastNonZwsp = this._getLastNonZwspOffset(text);
                    const logicalEndOffset = lastNonZwsp === null ? 0 : Math.min(text.length, lastNonZwsp + 1);
                    isAtListEnd = offset >= logicalEndOffset;
                }
            } else if (node === currentListItem) {
                isAtListEnd = offset >= currentListItem.childNodes.length;
            }

            if (isAtListEnd) {
                const nextListItem = this._getAdjacentListItem(currentListItem, 'next');
                if (nextListItem) {
                    let targetNode = this._getFirstDirectTextNode(nextListItem) ||
                        this._getLastDirectTextNode(nextListItem);
                    if (!targetNode) {
                        const textNodeFallback = document.createTextNode('\u00A0');
                        this._insertTextNodeIntoListItem(nextListItem, textNodeFallback);
                        targetNode = textNodeFallback;
                    }

                    const text = targetNode.textContent || '';
                    const firstNonZwsp = this._getFirstNonZwspOffset(text);
                    const targetOffset = firstNonZwsp !== null ? firstNonZwsp : 0;
                    const newRange = document.createRange();
                    newRange.setStart(targetNode, targetOffset);
                    newRange.collapse(true);
                    applyRange(newRange);
                    return true;
                }

                // 最後のリスト項目末尾では、リスト外の次ブロック（空行含む）へ移動
                let outerList = currentListItem.parentElement;
                while (outerList && outerList.parentElement && outerList.parentElement.tagName === 'LI') {
                    const parentLi = outerList.parentElement;
                    const parentList = parentLi.parentElement;
                    if (parentList && (parentList.tagName === 'UL' || parentList.tagName === 'OL')) {
                        outerList = parentList;
                    } else {
                        break;
                    }
                }
                const listBoundary = outerList || currentListItem;
                const nextElementAfterList = this._getNextNavigableElementInDocument(listBoundary);
                if (nextElementAfterList && moveToBlockStart(nextElementAfterList)) {
                    return true;
                }
            }
        }

        const currentBlock = getCurrentBlockForNode(node);
        if (shouldTreatAsHorizontalEmptyBlock(currentBlock)) {
            const nextBlock = this._getNextNavigableElementSibling(currentBlock) ||
                this._getNextNavigableElementInDocument(currentBlock);
            if (!nextBlock) {
                return true;
            }
            if (moveToBlockStart(nextBlock)) {
                return true;
            }
        }

        const selectedImage = this._getSelectedImageNode(range);
        if (selectedImage) {
            this._clearForwardImageStep();
            const newRange = document.createRange();
            if (this._collapseRangeAfterNode(newRange, selectedImage)) {
                applyRange(newRange);
                return true;
            }
        }

        // 行内画像（テキスト直後のIMG）では、左エッジを1ステップ挟んでから画像全体選択に進める
        if (range.collapsed && node.nodeType === Node.TEXT_NODE) {
            const text = node.textContent || '';
            if (offset >= text.length) {
                const sibling = this._getNextSiblingForNavigation(node);
                const boundaryImage = this._getImageFromNavigationCandidate(sibling);
                if (boundaryImage) {
                    if (!this._isSameForwardImageStep(boundaryImage, node, offset)) {
                        this._setForwardImageStep(boundaryImage, node, offset);
                        const edgeRange = document.createRange();
                        if (this._collapseRangeBeforeNode(edgeRange, boundaryImage)) {
                            applyRange(edgeRange);
                        }
                        return true;
                    }
                    this._clearForwardImageStep();
                } else {
                    this._clearForwardImageStep();
                }
            } else {
                this._clearForwardImageStep();
            }
        } else {
            this._clearForwardImageStep();
        }

        const imageAhead = this._getImageAheadFromCollapsedRange(range);
        if (imageAhead) {
            this._clearForwardImageStep();
            const newRange = document.createRange();
            newRange.selectNode(imageAhead);
            selection.removeAllRanges();
            selection.addRange(newRange);
            return true;
        }
        this._clearForwardImageStep();

        // インラインコード要素内かチェック
        const codeElement = this.domUtils.getParentElement(node, 'CODE');
        const preBlock = codeElement ? this.domUtils.getParentElement(codeElement, 'PRE') : null;
        if (codeElement && !preBlock) {
            const cursorInfo = this._getInlineCodeCursorInfo(range, codeElement);
            const atInlineCodeStart = (cursorInfo && cursorInfo.offset <= 0) ||
                this._isRangeAtInlineCodeStart(range, codeElement);
            if (atInlineCodeStart) {
                const firstStepPos = this._getInlineCodeAfterFirstCharPosition(codeElement);
                if (firstStepPos) {
                    const startNode = range.startContainer;
                    const startOffset = range.startOffset;
                    if (!(startNode === firstStepPos.node && startOffset >= firstStepPos.offset)) {
                        const advanceRange = document.createRange();
                        advanceRange.setStart(firstStepPos.node, firstStepPos.offset);
                        advanceRange.collapse(true);
                        applyRange(advanceRange);
                        return true;
                    }
                }
            }
            const hasCursorInfo = !!cursorInfo &&
                typeof cursorInfo.offset === 'number' &&
                typeof cursorInfo.total === 'number';
            const atInlineCodeEnd = (hasCursorInfo && cursorInfo.offset >= cursorInfo.total) ||
                this._isRangeAtInlineCodeEnd(range, codeElement) ||
                (!hasCursorInfo && this._isRangeNearInlineCodeEnd(range, codeElement));
            if (atInlineCodeEnd) {
                const parent = codeElement.parentElement;
                if (!parent) return false;
                const immediateNext = codeElement.nextSibling;
                let placeholder = null;
                if (immediateNext && immediateNext.nodeType === Node.TEXT_NODE) {
                    const text = immediateNext.textContent || '';
                    if (text.replace(/[\u200B\uFEFF]/g, '') === '') {
                        placeholder = immediateNext;
                    }
                }
                if (!placeholder) {
                    placeholder = document.createTextNode('\u200B');
                    if (immediateNext) {
                        parent.insertBefore(placeholder, immediateNext);
                    } else {
                        parent.appendChild(placeholder);
                    }
                }
                const fallbackRange = document.createRange();
                fallbackRange.setStart(placeholder, placeholder.textContent.length);
                fallbackRange.collapse(true);
                applyRange(fallbackRange);
                return true;
            }
        }

        if (node.nodeType === 3) { // テキストノード
            let currentNode = node;
            let currentOffset = offset;
            let reachedEditorEnd = false;
            const textLength = currentNode.textContent.length;
            const codeParent = this.domUtils.getParentElement(currentNode, 'CODE');
            const codePre = codeParent ? this.domUtils.getParentElement(codeParent, 'PRE') : null;
            const inInlineCode = !!(codeParent && !codePre);
            const currentText = currentNode.textContent || '';
            const zwspOnly = currentText.replace(/[\u200B\uFEFF]/g, '') === '';

            // Outside-left boundary placeholder -> move inside-left in one step.
            if (!inInlineCode &&
                this._isInlineCodeBoundaryPlaceholder(currentNode)) {
                const immediateNext = currentNode.nextSibling;
                const nextIsInlineCode = !!(immediateNext &&
                    immediateNext.nodeType === Node.ELEMENT_NODE &&
                    immediateNext.tagName === 'CODE' &&
                    !this.domUtils.getParentElement(immediateNext, 'PRE'));
                if (nextIsInlineCode) {
                    // Consume the outside-left placeholder when entering inline code.
                    // Keeping the placeholder can make the first move appear unchanged in WebView.
                    const parent = currentNode.parentNode;
                    if (parent && immediateNext.parentNode === parent) {
                        currentNode.remove();
                    }
                    const firstTextNode = this.domUtils.getFirstTextNode(immediateNext);
                    const directRange = document.createRange();
                    if (firstTextNode) {
                        const firstOffset = this._getFirstNonZwspOffset(firstTextNode.textContent || '');
                        directRange.setStart(firstTextNode, firstOffset !== null ? firstOffset : 0);
                    } else {
                        directRange.setStart(immediateNext, 0);
                    }
                    directRange.collapse(true);
                    applyRange(directRange);
                    return true;
                }
            }

            if (!inInlineCode && zwspOnly) {
                const sibling = this._getNextSiblingForNavigation(currentNode);
                if (sibling) {
                    // 水平線の場合は水平線全体を選択
                    if (sibling.nodeType === Node.ELEMENT_NODE && sibling.tagName === 'HR') {
                        const newRange = document.createRange();
                        newRange.selectNode(sibling);
                        selection.removeAllRanges();
                        selection.addRange(newRange);
                        return true;
                    }
                    if (sibling.nodeType === Node.TEXT_NODE) {
                        const text = sibling.textContent || '';
                        const firstOffset = this._getFirstNonZwspOffset(text);
                        if (firstOffset !== null) {
                            // Consume one visible character when crossing inline-style boundaries.
                            const targetOffset = Math.min(firstOffset + 1, text.length);
                            range.setStart(sibling, targetOffset);
                            range.collapse(true);
                            applyRange(range);
                            return true;
                        }
                    } else if (sibling.nodeType === Node.ELEMENT_NODE) {
                        if (this._placeCursorBeforeLeadingInlineCode(sibling, selection)) {
                            return true;
                        }
                        if (moveToCodeBlockLabel(sibling)) {
                            return true;
                        }
                        const textNode = this._getFirstNavigableTextNode(sibling);
                        if (textNode) {
                            if (moveToInlineCodeOutsideLeftFromTextNode(textNode)) {
                                return true;
                            }
                            const text = textNode.textContent || '';
                            const firstOffset = this._getFirstNonZwspOffset(text);
                            if (firstOffset !== null) {
                                range.setStart(textNode, Math.min(firstOffset + 1, text.length));
                                range.collapse(true);
                                applyRange(range);
                                return true;
                            }
                        }
                        if (this.domUtils.isBlockElement(sibling) && isEffectivelyEmptyBlock(sibling)) {
                            if (moveToBlockStart(sibling)) {
                                return true;
                            }
                        }
                        const fallback = this.domUtils.getNextTextNode(sibling);
                        if (fallback) {
                            if (moveToInlineCodeOutsideLeftFromTextNode(fallback)) {
                                return true;
                            }
                            const text = fallback.textContent || '';
                            const firstOffset = this._getFirstNonZwspOffset(text);
                            if (firstOffset !== null) {
                                range.setStart(fallback, Math.min(firstOffset + 1, text.length));
                                range.collapse(true);
                                applyRange(range);
                                return true;
                            }
                        }
                        try {
                            range.setStartAfter(sibling);
                            range.collapse(true);
                            applyRange(range);
                            return true;
                        } catch (e) {
                            // fall through to default handling
                        }
                    }
                }
            }

            if (currentOffset >= textLength) {
                const sibling = this._getNextSiblingForNavigation(currentNode);
                if (sibling) {
                    // 水平線の場合は水平線全体を選択
                    if (sibling.nodeType === Node.ELEMENT_NODE && sibling.tagName === 'HR') {
                        const newRange = document.createRange();
                        newRange.selectNode(sibling);
                        selection.removeAllRanges();
                        selection.addRange(newRange);
                        return true;
                    }
                    if (sibling.nodeType === Node.TEXT_NODE) {
                        const text = sibling.textContent || '';
                        const firstOffset = this._getFirstNonZwspOffset(text);
                        if (firstOffset !== null) {
                            // Consume one visible character when crossing inline-style boundaries.
                            const targetOffset = Math.min(firstOffset + 1, text.length);
                            range.setStart(sibling, targetOffset);
                            range.collapse(true);
                            applyRange(range);
                            return true;
                        }
                    } else if (sibling.nodeType === Node.ELEMENT_NODE) {
                        const isInlineCodeSibling = sibling.tagName === 'CODE' &&
                            !this.domUtils.getParentElement(sibling, 'PRE');
                        if (isInlineCodeSibling) {
                            const currentText = currentNode.textContent || '';
                            let trailingBoundaryStart = currentText.length;
                            while (trailingBoundaryStart > 0 &&
                                this._isInlineBoundaryChar(currentText[trailingBoundaryStart - 1])) {
                                trailingBoundaryStart--;
                            }
                            const isDirectTextBoundaryBeforeInlineCode =
                                currentNode.nextSibling === sibling &&
                                !this._isInlineCodeBoundaryPlaceholder(currentNode) &&
                                currentOffset >= trailingBoundaryStart;
                            if (isDirectTextBoundaryBeforeInlineCode) {
                                this._debugInlineNav('forward-direct-enter-inside-from-text-end', {
                                    containerType: currentNode?.nodeType,
                                    offset: currentOffset
                                });
                                this._clearPendingForwardInlineCodeEntry();
                                if (this._placeCursorInsideInlineCodeStart(sibling, selection)) {
                                    return true;
                                }
                            }
                            if (this._placeCursorBeforeInlineCodeElement(sibling, selection)) {
                                return true;
                            }
                        }
                        if (moveToCodeBlockLabel(sibling)) {
                            return true;
                        }
                        const textNode = this._getFirstNavigableTextNode(sibling);
                        if (textNode) {
                            if (moveToInlineCodeOutsideLeftFromTextNode(textNode)) {
                                return true;
                            }
                            const text = textNode.textContent || '';
                            const firstOffset = this._getFirstNonZwspOffset(text);
                            if (firstOffset !== null) {
                                range.setStart(textNode, Math.min(firstOffset + 1, text.length));
                                range.collapse(true);
                                applyRange(range);
                                return true;
                            }
                        }
                        if (this.domUtils.isBlockElement(sibling) && isEffectivelyEmptyBlock(sibling)) {
                            if (moveToBlockStart(sibling)) {
                                return true;
                            }
                        }
                        const fallback = this.domUtils.getNextTextNode(sibling);
                        if (fallback) {
                            if (moveToInlineCodeOutsideLeftFromTextNode(fallback)) {
                                return true;
                            }
                            const text = fallback.textContent || '';
                            const firstOffset = this._getFirstNonZwspOffset(text);
                            if (firstOffset !== null) {
                                range.setStart(fallback, Math.min(firstOffset + 1, text.length));
                                range.collapse(true);
                                applyRange(range);
                                return true;
                            }
                        }
                        try {
                            range.setStartAfter(sibling);
                            range.collapse(true);
                            applyRange(range);
                            return true;
                        } catch (e) {
                            // fall through to default handling
                        }
                    }
                } else {
                    // Try to move to the next block
                    let currentBlock = currentNode.parentElement;
                    while (currentBlock && currentBlock !== this.editor && !this.domUtils.isBlockElement(currentBlock) && currentBlock.tagName !== 'TR' && currentBlock.tagName !== 'LI') {
                        currentBlock = currentBlock.parentElement;
                    }

                    if (currentBlock && currentBlock !== this.editor) {
                        let nextBlock = this._getNextNavigableElementSibling(currentBlock);

                        // 水平線の場合は水平線全体を選択
                        if (nextBlock && nextBlock.tagName === 'HR') {
                            const newRange = document.createRange();
                            newRange.selectNode(nextBlock);
                            selection.removeAllRanges();
                            selection.addRange(newRange);
                            return true;
                        }

                        if (nextBlock) {
                            if (moveToBlockStart(nextBlock)) {
                                return true;
                            }
                        }
                    }
                    const anchorElement = currentBlock || currentNode.parentElement;
                    if (!this._getNextNavigableElementInDocument(anchorElement)) {
                        reachedEditorEnd = true;
                    }
                }
            }

            // 現在位置が実際の文字かチェック
            const isAtRealChar = currentOffset < currentNode.textContent.length &&
                !this._isInlineBoundaryChar(currentNode.textContent[currentOffset]);

            if (isAtRealChar) {
                // 実際の文字の位置なので、1つ前に進む
                currentOffset++;
            } else {
                // ゼロ幅スペースまたはノードの終端なので、次の実際の文字までスキップ
                currentOffset++;

                // ノードをまたいでゼロ幅スペースをすべてスキップ
                while (true) {
                    // 現在のノード内のゼロ幅スペースをスキップ
                    while (currentOffset < currentNode.textContent.length &&
                        this._isInlineBoundaryChar(currentNode.textContent[currentOffset])) {
                        currentOffset++;
                    }

                    // 実際の文字が見つかったら停止
                    if (currentOffset < currentNode.textContent.length) {
                        break;
                    }

                    // 次のノードに移動
                    const nextNode = this.domUtils.getNextTextNode(currentNode);
                    if (!nextNode) {
                        // これ以上ノードがない場合、現在のノードの終端に留まる
                        break;
                    }

                    // Moving across nodes should still stop at outside-left before entering inline code.
                    const nextInlineCode = this.domUtils.getParentElement(nextNode, 'CODE');
                    const nextInlinePre = nextInlineCode ? this.domUtils.getParentElement(nextInlineCode, 'PRE') : null;
                    const currentInlineCode = this.domUtils.getParentElement(currentNode, 'CODE');
                    const currentInlinePre = currentInlineCode ? this.domUtils.getParentElement(currentInlineCode, 'PRE') : null;
                    const movingIntoDifferentInlineCode = !!(
                        nextInlineCode &&
                        !nextInlinePre &&
                        (
                            !currentInlineCode ||
                            currentInlineCode !== nextInlineCode ||
                            !!currentInlinePre
                        )
                    );
                    if (movingIntoDifferentInlineCode) {
                        this._debugInlineNav('forward-cross-textnode-to-inline-outside-left', {
                            fromContainerType: currentNode?.nodeType,
                            fromOffset: currentOffset
                        });
                        if (this._placeCursorBeforeInlineCodeElement(nextInlineCode, selection)) {
                            return true;
                        }
                    }

                    currentNode = nextNode;
                    currentOffset = 0;
                }
            }
            const maxOffset = currentNode.textContent.length;
            if (currentOffset > maxOffset) {
                currentOffset = maxOffset;
            }

            // カーソル位置が変わらない場合は何もしない（選択範囲の再設定による副作用を防ぐ）
            if (currentNode === node && currentOffset === offset) {
                if (reachedEditorEnd) {
                    if (isTrailingEmptyBlock(node)) {
                        return true;
                    }
                    const stableTextEnd =
                        node.nodeType === Node.TEXT_NODE &&
                        !this._isIgnorableTextNode(node) &&
                        offset >= (node.textContent || '').length;
                    if (!stableTextEnd) {
                        this._normalizeSelectionAtEditorEnd(range);
                    }
                }
                return reachedEditorEnd;
            }

            range.setStart(currentNode, currentOffset);
            range.collapse(true);
        } else if (node.nodeType === 1) { // 要素ノード
            // 次の要素に移動を試みる
            let moved = false;
            const childNodes = Array.from(node.childNodes || []);
            const nextSibling = childNodes[offset] || null;

            if (nextSibling) {
                if (nextSibling.nodeType === Node.TEXT_NODE) {
                    if (moveToInlineCodeOutsideLeftFromTextNode(nextSibling)) {
                        return true;
                    }
                    const text = nextSibling.textContent || '';
                    const firstOffset = this._getFirstNonZwspOffset(text);
                    if (firstOffset !== null) {
                        range.setStart(nextSibling, Math.min(firstOffset + 1, text.length));
                        range.collapse(true);
                        moved = true;
                    }
                } else if (nextSibling.nodeType === Node.ELEMENT_NODE) {
                    if (moveToCodeBlockLabel(nextSibling)) {
                        moved = true;
                    } else if (this._placeCursorBeforeLeadingInlineCode(nextSibling, selection)) {
                        moved = true;
                    } else {
                        const textNode = this._getFirstNavigableTextNode(nextSibling);
                        if (textNode) {
                            if (moveToInlineCodeOutsideLeftFromTextNode(textNode)) {
                                return true;
                            }
                            const text = textNode.textContent || '';
                            const firstOffset = this._getFirstNonZwspOffset(text);
                            if (firstOffset !== null) {
                                range.setStart(textNode, Math.min(firstOffset + 1, text.length));
                                range.collapse(true);
                                moved = true;
                            }
                        }
                    }
                }
            }

            if (!moved) {
                let nextNode = this._getTextNodeAfterPosition(node, offset);
                while (nextNode) {
                    const preParent = this.domUtils.getParentElement(nextNode, 'PRE');
                    if (preParent && moveToCodeBlockLabel(preParent)) {
                        return true;
                    }
                    const inlineCode = this.domUtils.getParentElement(nextNode, 'CODE');
                    if (inlineCode &&
                        !this.domUtils.getParentElement(inlineCode, 'PRE') &&
                        this._placeCursorBeforeInlineCodeElement(inlineCode, selection)) {
                        return true;
                    }
                    const text = nextNode.textContent || '';
                    const firstOffset = this._getFirstNonZwspOffset(text);
                    if (firstOffset !== null) {
                        const originBlock = getCurrentBlockForNode(node);
                        const targetBlock = getCurrentBlockForNode(nextNode);
                        const consumeInlineBoundaryChar = !!originBlock && originBlock === targetBlock;
                        const targetOffset = consumeInlineBoundaryChar
                            ? Math.min(firstOffset + 1, text.length)
                            : firstOffset;
                        range.setStart(nextNode, targetOffset);
                        range.collapse(true);
                        moved = true;
                        break;
                    }
                    nextNode = this.domUtils.getNextTextNode(nextNode);
                }
            }

            if (!moved) {
                let nextBlock = this._getNextNavigableElementSibling(node);
                if (nextBlock) {
                    if (moveToBlockStart(nextBlock)) {
                        moved = true;
                    }
                }
            }

            if (!moved && isTrailingEmptyBlock(node)) {
                return true;
            }
            if (!moved && !this._getNextNavigableElementInDocument(node)) {
                const atEditorBoundary =
                    node === this.editor &&
                    offset >= (this.editor?.childNodes?.length || 0);
                if (!atEditorBoundary) {
                    this._normalizeSelectionAtEditorEnd(range);
                }
                return true;
            }
        }


        return true;
    }

    /**
     * カーソルを左に1文字移動
     * @param {Function} notifyCallback - 変更を通知するコールバック
     * @returns {boolean} 移動が処理された場合はtrue、それ以外はfalse
     */
    moveCursorBackward(notifyCallback) {
        const selection = window.getSelection();
        if (!selection || !selection.rangeCount) return false;
        this._clearPendingForwardInlineCodeEntry();
        this._clearForwardImageStep();
        this._normalizeSelectionForNavigation(selection);
        let range = selection.getRangeAt(0);
        let node = range.startContainer;
        let offset = range.startOffset;
        if (this._normalizeCollapsedImageAnchor(selection, 'backward')) {
            return true;
        }
        range = selection.getRangeAt(0);
        node = range.startContainer;
        offset = range.startOffset;
        const applyRange = (targetRange) => {
            this._adjustIntoInlineCodeBoundary(targetRange, 'backward');
            selection.removeAllRanges();
            selection.addRange(targetRange);
        };
        const isEffectivelyEmptyBlock = (block) => {
            if (!block) return false;
            const text = (block.textContent || '').replace(/[\u200B\uFEFF\u00A0]/g, '').trim();
            if (text !== '') return false;
            const meaningfulChild = Array.from(block.childNodes).some(child => {
                if (child.nodeType === Node.ELEMENT_NODE) {
                    if (child.tagName === 'BR') return false;
                    if (this._isNavigationExcludedElement(child)) return false;
                    return true;
                }
                if (child.nodeType === Node.TEXT_NODE) {
                    return !this._isIgnorableTextNode(child);
                }
                return false;
            });
            return !meaningfulChild;
        };
        const getCurrentBlockForNode = (target) => {
            let block = target && target.nodeType === Node.ELEMENT_NODE ? target : target?.parentElement;
            while (block && block !== this.editor && !this.domUtils.isBlockElement(block)) {
                block = block.parentElement;
            }
            return block && block !== this.editor ? block : null;
        };
        const shouldTreatAsHorizontalEmptyBlock = (block) => {
            if (!block || !isEffectivelyEmptyBlock(block)) return false;
            if (block.tagName === 'LI' || block.tagName === 'TD' || block.tagName === 'TH' || block.tagName === 'PRE') {
                return false;
            }
            return true;
        };
        const moveToBlockEnd = (block) => {
            if (!block || block.nodeType !== Node.ELEMENT_NODE) {
                return false;
            }
            if (block.tagName === 'HR') {
                const hrRange = document.createRange();
                hrRange.selectNode(block);
                selection.removeAllRanges();
                selection.addRange(hrRange);
                return true;
            }
            if (this._placeCursorAfterTrailingInlineCode(block, selection)) {
                return true;
            }
            const trailingImage = this._getTrailingImageInBlock(block);
            if (trailingImage) {
                const imageRange = document.createRange();
                if (this._collapseRangeAfterNode(imageRange, trailingImage)) {
                    applyRange(imageRange);
                    return true;
                }
            }
            const lastNode = this._getLastNavigableTextNode(block);
            const targetRange = document.createRange();
            if (lastNode) {
                targetRange.setStart(lastNode, lastNode.textContent.length);
            } else {
                if (block.tagName === 'P') {
                    const hasText = (block.textContent || '').replace(/[\u200B\uFEFF\u00A0]/g, '').trim() !== '';
                    const hasBr = !!block.querySelector('br');
                    if (!hasText && !hasBr) {
                        block.appendChild(document.createElement('br'));
                    }
                }
                targetRange.setStart(block, block.childNodes.length);
            }
            targetRange.collapse(true);
            applyRange(targetRange);
            return true;
        };

        const selectedImage = this._getSelectedImageNode(range);
        if (selectedImage) {
            const newRange = document.createRange();
            try {
                newRange.setStart(selectedImage, 0);
                newRange.collapse(true);
                applyRange(newRange);
                return true;
            } catch (e) {
                // Fall back to boundary placement if the engine rejects collapsed ranges in IMG.
            }
            if (this._collapseRangeBeforeNode(newRange, selectedImage)) {
                applyRange(newRange);
                return true;
            }
        }

        const imageBehind = this._getImageBehindFromCollapsedRange(range);
        if (imageBehind) {
            if (!this._isCollapsedRangeAtNodeBoundary(range, imageBehind, 'after')) {
                const edgeRange = document.createRange();
                if (this._collapseRangeAfterNode(edgeRange, imageBehind)) {
                    applyRange(edgeRange);
                    return true;
                }
            }
            const newRange = document.createRange();
            newRange.selectNode(imageBehind);
            selection.removeAllRanges();
            selection.addRange(newRange);
            return true;
        }

        range = selection.getRangeAt(0);
        node = range.startContainer;
        offset = range.startOffset;

        const currentBlock = getCurrentBlockForNode(node);
        if (shouldTreatAsHorizontalEmptyBlock(currentBlock)) {
            const prevBlock = this._getPrevNavigableElementSibling(currentBlock) ||
                this._getPrevNavigableElementInDocument(currentBlock);
            if (!prevBlock) {
                return true;
            }
            // リストの場合は最後のリストアイテムに移動する
            // （moveToBlockEndだとテキストのない空のLIがスキップされてしまうため）
            if (prevBlock.tagName === 'UL' || prevBlock.tagName === 'OL') {
                const listItems = prevBlock.querySelectorAll('li');
                const targetLi = listItems.length > 0 ? listItems[listItems.length - 1] : null;
                if (targetLi) {
                    const targetNode = this._getLastDirectTextNode(targetLi) || this._getFirstDirectTextNode(targetLi);
                    if (targetNode) {
                        const newRange = document.createRange();
                        newRange.setStart(targetNode, targetNode.textContent.length);
                        newRange.collapse(true);
                        applyRange(newRange);
                        return true;
                    }
                    this._placeCursorInEmptyListItem(targetLi, selection, 'up');
                    return true;
                }
            }
            if (moveToBlockEnd(prevBlock)) {
                return true;
            }
        }

        // インラインコード要素内かチェック
        const codeElement = this.domUtils.getParentElement(node, 'CODE');
        const preBlock = codeElement ? this.domUtils.getParentElement(codeElement, 'PRE') : null;
        if (codeElement && !preBlock) {
            const cursorInfo = this._getInlineCodeCursorInfo(range, codeElement);
            const atInlineCodeStart = (cursorInfo && cursorInfo.offset <= 0) ||
                this._isRangeAtInlineCodeStart(range, codeElement);
            if (atInlineCodeStart) {
                this._debugInlineNav('backward-inside-left-to-outside-left', {});
                if (this._placeCursorBeforeInlineCodeElement(codeElement, selection)) {
                    return true;
                }
            }
        }

        const currentListItem = this._getListItemFromContainer(node, offset, 'up') ||
            this.domUtils.getParentElement(node, 'LI');
        let isAtListStart = false;
        if (currentListItem) {
            const firstDirectText = this._getFirstDirectTextNode(currentListItem);
            // data-preserve-emptyなリストアイテムは常に先頭として扱い、
            // ←キーで即座に前の要素に移動する（&nbsp;等を通過させない）
            if (currentListItem.getAttribute('data-preserve-empty') === 'true') {
                isAtListStart = true;
            } else if (node.nodeType === Node.TEXT_NODE) {
                if (firstDirectText && node === firstDirectText) {
                    const minOffset = this._getFirstNonZwspOffset(node.textContent || '');
                    isAtListStart = minOffset === null ? offset <= 0 : offset <= minOffset;
                } else if (!firstDirectText) {
                    isAtListStart = offset <= 0;
                }
            } else {
                if (offset <= 0) {
                    isAtListStart = true;
                } else if (node === currentListItem) {
                    // 空のリストアイテムではoffset 1（<br>の後）もリスト先頭として扱う
                    const liText = (currentListItem.textContent || '').replace(/[\u200B\uFEFF\u00A0]/g, '').trim();
                    if (liText === '') {
                        isAtListStart = true;
                    }
                }
            }

            if (isAtListStart) {
                const prevListItem = this._getAdjacentListItem(currentListItem, 'prev');
                if (prevListItem) {
                    // 空のネストリストアイテムから親LIへ移動する場合、
                    // 親LIのテキスト末尾にカーソルを配置する
                    // （element-level offsetだとブラウザが先頭に描画してしまうため、
                    //  text-level offsetを使って↑キーと同じ位置にする）
                    const parentList = currentListItem.parentElement;
                    if (parentList && (parentList.tagName === 'UL' || parentList.tagName === 'OL')) {
                        const parentLi = this.domUtils.getParentElement(parentList, 'LI');
                        if (parentLi === prevListItem) {
                            const currentText = (currentListItem.textContent || '').replace(/[\u200B\uFEFF\u00A0]/g, '').trim();
                            if (currentText === '') {
                                const lastTextNode = this._getLastDirectTextNode(prevListItem);
                                if (lastTextNode) {
                                    const newRange = document.createRange();
                                    newRange.setStart(lastTextNode, lastTextNode.textContent.length);
                                    newRange.collapse(true);
                                    applyRange(newRange);
                                    return true;
                                }
                                // テキストノードがない場合はelement offsetにフォールバック
                                const parentChildren = Array.from(prevListItem.childNodes);
                                const nestedListIndex = parentChildren.indexOf(parentList);
                                if (nestedListIndex >= 0) {
                                    const newRange = document.createRange();
                                    newRange.setStart(prevListItem, nestedListIndex);
                                    newRange.collapse(true);
                                    applyRange(newRange);
                                    return true;
                                }
                            }
                        }
                    }
                    const textNode = this._getLastDirectTextNode(prevListItem) || this._getFirstDirectTextNode(prevListItem);
                    if (textNode) {
                        const newRange = document.createRange();
                        newRange.setStart(textNode, textNode.textContent.length);
                        newRange.collapse(true);
                        applyRange(newRange);
                        return true;
                    }
                    const textNodeFallback = document.createTextNode('\u00A0');
                    this._insertTextNodeIntoListItem(prevListItem, textNodeFallback);
                    const newRange = document.createRange();
                    newRange.setStart(textNodeFallback, textNodeFallback.textContent.length);
                    newRange.collapse(true);
                    applyRange(newRange);
                    return true;
                }

                const listContainer = currentListItem.parentElement;
                if (listContainer) {
                    let outerList = listContainer;
                    while (outerList.parentElement && outerList.parentElement.tagName === 'LI') {
                        const parentLi = outerList.parentElement;
                        const parentList = parentLi.parentElement;
                        if (parentList && (parentList.tagName === 'UL' || parentList.tagName === 'OL')) {
                            outerList = parentList;
                        } else {
                            break;
                        }
                    }
                    const prevElement = this._getPrevNavigableElementInDocument(outerList);
                    if (prevElement) {
                        if (moveToBlockEnd(prevElement)) {
                            return true;
                        }
                    }
                }
                return true;
            }
        }

        // カーソルが親LI内のネストリスト直前にある場合（例: "aa" と <ul> の間）
        // ネストリストの最初のアイテムが空なら、カーソルを移動しない
        if (currentListItem && !isAtListStart && node === currentListItem && node.nodeType === Node.ELEMENT_NODE) {
            const childAtOffset = node.childNodes[offset];
            if (childAtOffset && (childAtOffset.tagName === 'UL' || childAtOffset.tagName === 'OL')) {
                const firstLi = childAtOffset.querySelector(':scope > li:first-child');
                if (firstLi) {
                    const liText = (firstLi.textContent || '').replace(/[\u200B\uFEFF\u00A0]/g, '').trim();
                    if (liText === '') {
                        return true;
                    }
                }
            }
        }

        if (node.nodeType === 3) { // テキストノード
            let currentNode = node;
            let currentOffset = offset;
            const codeParent = this.domUtils.getParentElement(currentNode, 'CODE');
            const codePre = codeParent ? this.domUtils.getParentElement(codeParent, 'PRE') : null;
            const inInlineCode = !!(codeParent && !codePre);
            const currentText = currentNode.textContent || '';
            const zwspOnly = currentText.replace(/[\u200B\uFEFF]/g, '') === '';
            const nextSibling = currentNode.nextSibling;
            const nextIsInlineCode = !!(nextSibling &&
                nextSibling.nodeType === Node.ELEMENT_NODE &&
                nextSibling.tagName === 'CODE' &&
                !this.domUtils.getParentElement(nextSibling, 'PRE'));

            if (!inInlineCode && zwspOnly) {
                const sibling = this._getPrevSiblingForNavigation(currentNode);
                if (sibling) {
                    // 水平線の場合は水平線全体を選択
                    if (sibling.nodeType === Node.ELEMENT_NODE && sibling.tagName === 'HR') {
                        const newRange = document.createRange();
                        newRange.selectNode(sibling);
                        selection.removeAllRanges();
                        selection.addRange(newRange);
                        return true;
                    }
                    if (sibling.nodeType === Node.TEXT_NODE) {
                        const text = sibling.textContent || '';
                        const lastOffset = this._getLastNonZwspOffset(text);
                        if (lastOffset !== null) {
                            // Consume one visible character when crossing inline-style boundaries.
                            const targetOffset = lastOffset;
                            range.setStart(sibling, targetOffset);
                            range.collapse(true);
                            applyRange(range);
                            return true;
                        }
                    } else if (sibling.nodeType === Node.ELEMENT_NODE) {
                        const textNode = this._getLastNavigableTextNode(sibling);
                        if (textNode) {
                            const text = textNode.textContent || '';
                            const lastOffset = this._getLastNonZwspOffset(text);
                            if (lastOffset !== null) {
                                const targetOffset = lastOffset;
                                range.setStart(textNode, targetOffset);
                                range.collapse(true);
                                applyRange(range);
                                return true;
                            }
                        }
                        const fallback = this.domUtils.getPreviousTextNode(sibling);
                        if (fallback) {
                            const text = fallback.textContent || '';
                            const lastOffset = this._getLastNonZwspOffset(text);
                            if (lastOffset !== null) {
                                const targetOffset = lastOffset;
                                range.setStart(fallback, targetOffset);
                                range.collapse(true);
                                applyRange(range);
                                return true;
                            }
                        }
                        try {
                            range.setStartBefore(sibling);
                            range.collapse(true);
                            applyRange(range);
                            return true;
                        } catch (e) {
                            // fall through to default handling
                        }
                    }
                } else if (nextIsInlineCode) {
                    // outside-left placeholder with no previous sibling:
                    // avoid a no-op step by jumping to previous block end when possible.
                    let currentBlock = currentNode.parentElement;
                    while (currentBlock &&
                        currentBlock !== this.editor &&
                        !this.domUtils.isBlockElement(currentBlock) &&
                        currentBlock.tagName !== 'TR' &&
                        currentBlock.tagName !== 'LI') {
                        currentBlock = currentBlock.parentElement;
                    }
                    if (currentBlock && currentBlock !== this.editor) {
                        const prevBlock = this._getPrevNavigableElementSibling(currentBlock) ||
                            this._getPrevNavigableElementInDocument(currentBlock);
                        if (prevBlock && moveToBlockEnd(prevBlock)) {
                            return true;
                        }
                    }
                }
            }
            if (currentOffset <= 0) {
                const sibling = this._getPrevSiblingForNavigation(currentNode);
                if (sibling) {
                    // 水平線の場合は水平線全体を選択
                    if (sibling.nodeType === Node.ELEMENT_NODE && sibling.tagName === 'HR') {
                        const newRange = document.createRange();
                        newRange.selectNode(sibling);
                        selection.removeAllRanges();
                        selection.addRange(newRange);
                        return true;
                    }
                    if (sibling.nodeType === Node.TEXT_NODE) {
                        const text = sibling.textContent || '';
                        const lastOffset = this._getLastNonZwspOffset(text);
                        if (lastOffset !== null) {
                            range.setStart(sibling, lastOffset);
                            range.collapse(true);
                            applyRange(range);
                            return true;
                        }
                    } else if (sibling.nodeType === Node.ELEMENT_NODE) {
                        const textNode = this._getLastNavigableTextNode(sibling);
                        if (textNode) {
                            const text = textNode.textContent || '';
                            const lastOffset = this._getLastNonZwspOffset(text);
                            if (lastOffset !== null) {
                                range.setStart(textNode, lastOffset);
                                range.collapse(true);
                                applyRange(range);
                                return true;
                            }
                        }
                        const fallback = this.domUtils.getPreviousTextNode(sibling);
                        if (fallback) {
                            const text = fallback.textContent || '';
                            const lastOffset = this._getLastNonZwspOffset(text);
                            if (lastOffset !== null) {
                                range.setStart(fallback, lastOffset);
                                range.collapse(true);
                                applyRange(range);
                                return true;
                            }
                        }
                        try {
                            range.setStartBefore(sibling);
                            range.collapse(true);
                            applyRange(range);
                            return true;
                        } catch (e) {
                            // fall through to default handling
                        }
                    }
                } else {
                    // Try to move to the previous block
                    let currentBlock = currentNode.parentElement;
                    while (currentBlock && currentBlock !== this.editor && !this.domUtils.isBlockElement(currentBlock) && currentBlock.tagName !== 'TR' && currentBlock.tagName !== 'LI') {
                        currentBlock = currentBlock.parentElement;
                    }

                    if (currentBlock && currentBlock !== this.editor) {
                        let prevBlock = this._getPrevNavigableElementSibling(currentBlock);

                        // 水平線の場合は水平線全体を選択
                        if (prevBlock && prevBlock.tagName === 'HR') {
                            const newRange = document.createRange();
                            newRange.selectNode(prevBlock);
                            selection.removeAllRanges();
                            selection.addRange(newRange);
                            return true;
                        }

                        if (prevBlock) {
                            if (moveToBlockEnd(prevBlock)) {
                                return true;
                            }
                        }
                    }
                }
            }

            // Move exactly one visible character backward. Any boundary chars
            // (ZWSP/FEFF) should be consumed in the same keypress.
            let previousVisibleIndex = currentOffset - 1;
            while (previousVisibleIndex >= 0 &&
                this._isInlineBoundaryChar(currentNode.textContent[previousVisibleIndex])) {
                previousVisibleIndex--;
            }

            if (previousVisibleIndex >= 0) {
                currentOffset = previousVisibleIndex;
            } else {
                while (true) {
                    const prevNode = this.domUtils.getPreviousTextNode(currentNode);
                    if (!prevNode) {
                        currentOffset = 0;
                        break;
                    }

                    const prevText = prevNode.textContent || '';
                    let idx = prevText.length - 1;
                    while (idx >= 0 && this._isInlineBoundaryChar(prevText[idx])) {
                        idx--;
                    }
                    if (idx >= 0) {
                        currentNode = prevNode;
                        currentOffset = idx + 1;
                        break;
                    }

                    currentNode = prevNode;
                    currentOffset = 0;
                }
            }
            if (currentOffset < 0) {
                currentOffset = 0;
            }

            // カーソル位置が変わらない場合（行の先頭など）は前のブロックへの移動を試みる
            if (currentNode === node && currentOffset === offset) {
                // 前のブロック要素を探す
                let blockParent = currentNode.parentElement;
                while (blockParent && blockParent !== this.editor &&
                    !['P', 'DIV', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'PRE'].includes(blockParent.tagName)) {
                    blockParent = blockParent.parentElement;
                }

                if (blockParent && blockParent !== this.editor) {
                    let prevBlock = this._getPrevNavigableElementSibling(blockParent);
                    if (prevBlock) {
                        if (moveToBlockEnd(prevBlock)) {
                            return true;
                        }
                    }
                }
                return false;
            }

            range.setStart(currentNode, currentOffset);
            range.collapse(true);
        } else if (node.nodeType === 1) { // 要素ノード
            // 前の要素に移動を試みる
            let moved = false;
            const childNodes = Array.from(node.childNodes || []);
            const prevSibling = offset > 0 ? childNodes[offset - 1] : null;

            if (prevSibling) {
                if (prevSibling.nodeType === Node.TEXT_NODE) {
                    const text = prevSibling.textContent || '';
                    const lastOffset = this._getLastNonZwspOffset(text);
                    if (lastOffset !== null) {
                        const targetOffset = lastOffset;
                        range.setStart(prevSibling, targetOffset);
                        range.collapse(true);
                        moved = true;
                    }
                } else if (prevSibling.nodeType === Node.ELEMENT_NODE) {
                    const textNode = this._getLastNavigableTextNode(prevSibling);
                    if (textNode) {
                        const text = textNode.textContent || '';
                        const lastOffset = this._getLastNonZwspOffset(text);
                        if (lastOffset !== null) {
                            range.setStart(textNode, lastOffset);
                            range.collapse(true);
                            moved = true;
                        }
                    }
                }
            }

            // ブロック先頭（offset 0）で前の兄弟ノードがない場合、前のブロックへ直接移動
            // （空行を飛び越えてテキストノードを探すのを防ぐ）
            if (!moved && offset === 0) {
                let blockParent = node;
                if (!this.domUtils.isBlockElement(blockParent)) {
                    while (blockParent && blockParent !== this.editor && !this.domUtils.isBlockElement(blockParent)) {
                        blockParent = blockParent.parentElement;
                    }
                }
                if (blockParent && blockParent !== this.editor) {
                    const prevBlock = this._getPrevNavigableElementSibling(blockParent);
                    if (prevBlock) {
                        if (moveToBlockEnd(prevBlock)) {
                            return true;
                        }
                    }
                }
            }

            if (!moved) {
                let prevNode = this._getTextNodeBeforePosition(node, offset);
                while (prevNode) {
                    const text = prevNode.textContent || '';
                    const lastOffset = this._getLastNonZwspOffset(text);
                    if (lastOffset !== null) {
                        const originBlock = getCurrentBlockForNode(node);
                        const targetBlock = getCurrentBlockForNode(prevNode);
                        const consumeInlineBoundaryChar = !!originBlock && originBlock === targetBlock;
                        const targetOffset = consumeInlineBoundaryChar
                            ? lastOffset
                            : Math.min(lastOffset + 1, text.length);
                        range.setStart(prevNode, targetOffset);
                        range.collapse(true);
                        moved = true;
                        break;
                    }
                    prevNode = this.domUtils.getPreviousTextNode(prevNode);
                }
            }

            if (!moved) {
                // 前のブロック要素を探す
                let prevBlock = this._getPrevNavigableElementSibling(node);
                if (prevBlock && moveToBlockEnd(prevBlock)) {
                    return true;
                }
            }
        }

        applyRange(range);
        return true;
    }

    /**
     * カーソルを行頭に移動
     */
    moveCursorToLineStart() {
        const selection = window.getSelection();
        if (!selection || !selection.rangeCount) return;

        const range = selection.getRangeAt(0);
        const node = range.startContainer;
        const getCurrentBlockForNode = (targetNode) => {
            let blockElement = targetNode && targetNode.nodeType === Node.ELEMENT_NODE
                ? targetNode
                : targetNode?.parentElement;
            while (blockElement && blockElement !== this.editor && !this.domUtils.isBlockElement(blockElement)) {
                blockElement = blockElement.parentElement;
            }
            return blockElement && blockElement !== this.editor ? blockElement : null;
        };
        const moveBeforeImageIfLeadingInBlock = (imageNode) => {
            if (!imageNode || imageNode.nodeType !== Node.ELEMENT_NODE || imageNode.tagName !== 'IMG') {
                return false;
            }

            const blockElement = getCurrentBlockForNode(imageNode);
            if (blockElement) {
                const leadingImage = this._getLeadingImageInBlock(blockElement);
                if (leadingImage !== imageNode) {
                    return false;
                }
            }

            const imageRange = document.createRange();
            if (!this._collapseRangeBeforeNode(imageRange, imageNode)) {
                return false;
            }
            selection.removeAllRanges();
            selection.addRange(imageRange);
            return true;
        };
        const normalizeInlineCodeLineStartToOutsideLeft = () => {
            if (!selection || !selection.rangeCount || !selection.isCollapsed) {
                return;
            }
            const currentRange = selection.getRangeAt(0);
            const currentContainer = currentRange.startContainer;
            const inlineCode = this.domUtils.getParentElement(currentContainer, 'CODE');
            const preOfInlineCode = inlineCode ? this.domUtils.getParentElement(inlineCode, 'PRE') : null;
            if (!inlineCode || preOfInlineCode) {
                return;
            }

            const cursorInfo = this._getInlineCodeCursorInfo(currentRange, inlineCode);
            const atInlineCodeStart = (cursorInfo && cursorInfo.offset <= 0) ||
                this._isRangeAtInlineCodeStart(currentRange, inlineCode);
            if (!atInlineCodeStart) {
                return;
            }

            this._placeCursorBeforeInlineCodeElement(inlineCode, selection);
        };

        // コードブロック内かチェック
        const codeBlock = this.domUtils.getParentElement(node, 'CODE');
        const preBlock = codeBlock ? this.domUtils.getParentElement(codeBlock, 'PRE') : null;

        if (preBlock && codeBlock) {
            // コードブロック内 - 現在の行の先頭に移動
            let text = '';
            const walker = document.createTreeWalker(
                codeBlock,
                NodeFilter.SHOW_TEXT,
                null
            );
            let textNode;
            while (textNode = walker.nextNode()) {
                text += textNode.textContent;
            }

            // コードブロック全体でのカーソル位置を計算
            let totalOffset = 0;
            const walker2 = document.createTreeWalker(
                codeBlock,
                NodeFilter.SHOW_TEXT,
                null
            );
            let foundCursor = false;
            const cursorContainer = node.nodeType === 3 ? node : null;

            if (cursorContainer) {
                while (textNode = walker2.nextNode()) {
                    if (textNode === cursorContainer) {
                        totalOffset += range.startOffset;
                        foundCursor = true;
                        break;
                    }
                    totalOffset += textNode.textContent.length;
                }
            } else {
                totalOffset = 0;
                foundCursor = true;
            }

            if (foundCursor) {
                // 現在の行の開始位置を見つける
                const lines = text.split('\n');
                let lineStartOffset = 0;
                let charCount = 0;

                for (let i = 0; i < lines.length; i++) {
                    const lineLength = lines[i].length + (i < lines.length - 1 ? 1 : 0);
                    if (totalOffset <= charCount + lineLength) {
                        lineStartOffset = charCount;
                        break;
                    }
                    charCount += lineLength;
                }

                // 行の開始位置のテキストノードとオフセットを見つける
                const walker3 = document.createTreeWalker(
                    codeBlock,
                    NodeFilter.SHOW_TEXT,
                    null
                );
                let currentOffset = 0;
                while (textNode = walker3.nextNode()) {
                    const nodeLength = textNode.textContent.length;
                    if (currentOffset + nodeLength >= lineStartOffset) {
                        const offsetInNode = lineStartOffset - currentOffset;
                        const newRange = document.createRange();
                        newRange.setStart(textNode, offsetInNode);
                        newRange.collapse(true);
                        selection.removeAllRanges();
                        selection.addRange(newRange);
                        return;
                    }
                    currentOffset += nodeLength;
                }
            }
            return;
        }

        // 行頭が画像のとき、画像右エッジからのCtrl+Aで文書先頭へ飛ばないようにする。
        const selectedImage = this._getSelectedImageNode(range);
        if (moveBeforeImageIfLeadingInBlock(selectedImage)) {
            return;
        }
        if (range.collapsed) {
            const imageBehind = this._getImageBehindFromCollapsedRange(range);
            if (moveBeforeImageIfLeadingInBlock(imageBehind)) {
                return;
            }
        }


        // デフォルトの動作：ネイティブのselection.modifyを使用
        // 論理的な行頭移動を行いつつ、インライン要素の整合性を維持する
        if (selection.modify) {
            // Ctrl+A は折り返しの見た目ではなく、論理的な行頭へ移動させる。
            selection.modify('move', 'backward', 'paragraphboundary');
            normalizeInlineCodeLineStartToOutsideLeft();
            return;
        }

        // フォールバック（selection.modifyが使用できない場合）
        // 現在のブロックの開始位置を見つける
        let blockElement = node.nodeType === 3 ? node.parentElement : node;
        while (blockElement && blockElement !== this.editor && !this.domUtils.isBlockElement(blockElement)) {
            blockElement = blockElement.parentElement;
        }

        // テキストがエディタに直接ある場合の処理
        if (blockElement === this.editor) {
            if (node.nodeType === 3 && node.parentElement === this.editor) {
                range.setStart(node, 0);
                range.collapse(true);
                selection.removeAllRanges();
                selection.addRange(range);
                normalizeInlineCodeLineStartToOutsideLeft();
                return;
            }
            const firstTextNode = this.domUtils.getFirstTextNode(this.editor);
            if (firstTextNode) {
                range.setStart(firstTextNode, 0);
                range.collapse(true);
                selection.removeAllRanges();
                selection.addRange(range);
                normalizeInlineCodeLineStartToOutsideLeft();
            }
        } else if (blockElement) {
            const firstTextNode = this.domUtils.getFirstTextNode(blockElement);
            if (firstTextNode) {
                range.setStart(firstTextNode, 0);
                range.collapse(true);
                selection.removeAllRanges();
                selection.addRange(range);
                normalizeInlineCodeLineStartToOutsideLeft();
            }
        }
    }

    /**
     * カーソルを行末に移動
     */
    moveCursorToLineEnd() {
        const selection = window.getSelection();
        if (!selection || !selection.rangeCount) return;

        const range = selection.getRangeAt(0);
        const node = range.startContainer;

        const getCurrentBlockForNode = (targetNode) => {
            let blockElement = targetNode && targetNode.nodeType === Node.ELEMENT_NODE
                ? targetNode
                : targetNode?.parentElement;
            while (blockElement && blockElement !== this.editor && !this.domUtils.isBlockElement(blockElement)) {
                blockElement = blockElement.parentElement;
            }
            return blockElement && blockElement !== this.editor ? blockElement : null;
        };
        const moveAfterImageIfLeadingInBlock = (imageNode) => {
            if (!imageNode || imageNode.nodeType !== Node.ELEMENT_NODE || imageNode.tagName !== 'IMG') {
                return false;
            }

            const blockElement = getCurrentBlockForNode(imageNode);
            if (blockElement) {
                const leadingImage = this._getLeadingImageInBlock(blockElement);
                if (leadingImage !== imageNode) {
                    return false;
                }
            }

            const imageRange = document.createRange();
            if (!this._collapseRangeAfterNode(imageRange, imageNode)) {
                return false;
            }
            selection.removeAllRanges();
            selection.addRange(imageRange);
            return true;
        };

        // コードブロック内かチェック
        const codeBlock = this.domUtils.getParentElement(node, 'CODE');
        const preBlock = codeBlock ? this.domUtils.getParentElement(codeBlock, 'PRE') : null;

        if (preBlock && codeBlock) {
            // コードブロック内 - 現在の行の末尾に移動
            let text = '';
            const walker = document.createTreeWalker(
                codeBlock,
                NodeFilter.SHOW_TEXT,
                null
            );
            let textNode;
            while (textNode = walker.nextNode()) {
                text += textNode.textContent;
            }

            // コードブロック全体でのカーソル位置を計算
            let totalOffset = 0;
            const walker2 = document.createTreeWalker(
                codeBlock,
                NodeFilter.SHOW_TEXT,
                null
            );
            let foundCursor = false;
            const cursorContainer = node.nodeType === 3 ? node : null;

            if (cursorContainer) {
                while (textNode = walker2.nextNode()) {
                    if (textNode === cursorContainer) {
                        totalOffset += range.startOffset;
                        foundCursor = true;
                        break;
                    }
                    totalOffset += textNode.textContent.length;
                }
            } else {
                totalOffset = text.length;
                foundCursor = true;
            }

            if (foundCursor) {
                // 現在の行の終了位置を見つける
                const lines = text.split('\n');
                let lineEndOffset = 0;
                let charCount = 0;

                for (let i = 0; i < lines.length; i++) {
                    const lineLength = lines[i].length;
                    if (totalOffset <= charCount + lineLength) {
                        lineEndOffset = charCount + lineLength;
                        break;
                    }
                    charCount += lineLength + 1; // +1 for \n
                }

                // 行の終了位置のテキストノードとオフセットを見つける
                const walker3 = document.createTreeWalker(
                    codeBlock,
                    NodeFilter.SHOW_TEXT,
                    null
                );
                let currentOffset = 0;
                while (textNode = walker3.nextNode()) {
                    const nodeLength = textNode.textContent.length;
                    if (currentOffset + nodeLength >= lineEndOffset) {
                        const offsetInNode = lineEndOffset - currentOffset;
                        const newRange = document.createRange();
                        newRange.setStart(textNode, offsetInNode);
                        newRange.collapse(true);
                        selection.removeAllRanges();
                        selection.addRange(newRange);
                        return;
                    }
                    currentOffset += nodeLength;
                }
            }
            return;
        }

        // 行頭が画像のとき、画像左エッジでのCtrl+Eは同じ行の画像右エッジへ移動する。
        if (range.collapsed) {
            const imageAhead = this._getImageAheadFromCollapsedRange(range);
            if (imageAhead && this._isCollapsedRangeAtNodeBoundary(range, imageAhead, 'before')) {
                if (moveAfterImageIfLeadingInBlock(imageAhead)) {
                    return;
                }
            }
        }

        // デフォルトの動作：ネイティブのselection.modifyを使用
        if (selection.modify) {
            // Ctrl+E は折り返しの見た目ではなく、論理的な行末へ移動させる。
            selection.modify('move', 'forward', 'paragraphboundary');
            return;
        }

        // フォールバック（selection.modifyが使用できない場合）
        // 現在のブロックの終了位置を見つける
        let blockElement = node.nodeType === 3 ? node.parentElement : node;
        while (blockElement && blockElement !== this.editor && !this.domUtils.isBlockElement(blockElement)) {
            blockElement = blockElement.parentElement;
        }

        // テキストがエディタに直接ある場合の処理
        if (blockElement === this.editor) {
            if (node.nodeType === 3 && node.parentElement === this.editor) {
                range.setStart(node, node.textContent.length);
                range.collapse(true);
                selection.removeAllRanges();
                selection.addRange(range);
                return;
            }
            const lastTextNode = this.domUtils.getLastTextNode(this.editor);
            if (lastTextNode) {
                range.setStart(lastTextNode, lastTextNode.textContent.length);
                range.collapse(true);
                selection.removeAllRanges();
                selection.addRange(range);
            }
        } else if (blockElement) {
            // リストアイテムの場合、ネストされたリストを除外して現在の行の末尾のみを取得
            let lastTextNode;
            if (blockElement.tagName === 'LI') {
                const textNodes = [];
                const walker = document.createTreeWalker(
                    blockElement,
                    NodeFilter.SHOW_TEXT,
                    {
                        acceptNode: function (node) {
                            // このテキストノードがネストされたリスト内にあるかチェック
                            let parent = node.parentElement;
                            while (parent && parent !== blockElement) {
                                if (parent.tagName === 'UL' || parent.tagName === 'OL') {
                                    return NodeFilter.FILTER_REJECT;
                                }
                                parent = parent.parentElement;
                            }
                            // 空のテキストノードも受け入れる（カーソル配置用）
                            return NodeFilter.FILTER_ACCEPT;
                        }
                    },
                    false
                );

                let textNode;
                while (textNode = walker.nextNode()) {
                    textNodes.push(textNode);
                }

                if (textNodes.length > 0) {
                    lastTextNode = textNodes[textNodes.length - 1];
                } else {
                    // テキストノードが見つからない場合、空のテキストノードを作成
                    lastTextNode = document.createTextNode('');
                    const firstChild = blockElement.firstChild;
                    if (firstChild && (firstChild.tagName === 'UL' || firstChild.tagName === 'OL')) {
                        blockElement.insertBefore(lastTextNode, firstChild);
                    } else {
                        blockElement.insertBefore(lastTextNode, firstChild);
                    }
                }
            } else {
                lastTextNode = this.domUtils.getLastTextNode(blockElement);
            }

            if (lastTextNode) {
                range.setStart(lastTextNode, lastTextNode.textContent.length);
                range.collapse(true);
                selection.removeAllRanges();
                selection.addRange(range);
            }
        }
    }
}

// Made with Bob
