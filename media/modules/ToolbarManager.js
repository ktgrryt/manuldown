// @ts-nocheck
/**
 * ツールバー管理モジュール
 * ツールバーボタンのイベント処理とコマンド実行を担当
 */

export class ToolbarManager {
    constructor(editor, stateManager, options = {}) {
        this.editor = editor;
        this.stateManager = stateManager;
        this.onInsertTable = options.onInsertTable || null;
        this.onInsertQuote = options.onInsertQuote || null;
        this.onInsertCodeBlock = options.onInsertCodeBlock || null;
        this.onInsertCheckbox = options.onInsertCheckbox || null;
        this.commandButtons = new Map();
        this.activeStateCommands = new Map([
            ['bold', 'bold'],
            ['italic', 'italic'],
            ['strikethrough', 'strikeThrough'],
        ]);
        this.contextStateCommands = new Set([
            'ul',
            'ol',
            'checkbox',
            'quote',
            'codeblock',
            'table',
        ]);
        this.tableCellRestrictedCommands = new Set([
            'h1',
            'h2',
            'h3',
            'quote',
            'codeblock',
            'table',
        ]);
        this.headingLevelCommands = new Set([
            'h1',
            'h2',
            'h3',
        ]);
    }

    /**
     * ツールバーをセットアップ
     */
    setup() {
        const buttons = document.querySelectorAll('.toolbar-btn');
        buttons.forEach(button => {
            const command = button.getAttribute('data-command');
            if (command) {
                this.commandButtons.set(command, button);
                if (this.activeStateCommands.has(command) || this.contextStateCommands.has(command)) {
                    button.setAttribute('aria-pressed', 'false');
                }
            }
            // Keep caret/selection in the editor when clicking toolbar buttons.
            button.addEventListener('mousedown', (e) => {
                e.preventDefault();
            });
            button.addEventListener('click', (e) => {
                e.preventDefault();
                const command = button.getAttribute('data-command');
                this.executeCommand(command);
                // ダイアログを開くコマンドはダイアログ側でフォーカスを管理するため、ここではスキップ
                if (command !== 'table') {
                    setTimeout(() => this.editor.focus(), 0);
                }
            });
        });

        const updateAvailability = () => {
            this.updateCommandAvailability();
            this.updateCommandContextStates();
        };
        const updateToolbarState = () => this.updateToolbarState();
        document.addEventListener('selectionchange', updateAvailability);
        this.editor.addEventListener('keyup', updateToolbarState);
        this.editor.addEventListener('mouseup', updateToolbarState);
        this.editor.addEventListener('input', updateToolbarState);
        this.editor.addEventListener('focus', updateToolbarState);
        this.editor.addEventListener('blur', updateToolbarState);

        this.updateToolbarState();
    }

    /**
     * フォーマットコマンドを実行
     * @param {string} command - 実行するコマンド
     */
    executeCommand(command) {
        this.editor.focus();

        const isTableCellRestrictedCommand =
            !!command && this.tableCellRestrictedCommands.has(command);
        if (isTableCellRestrictedCommand && this.isSelectionInTableCellContext()) {
            return;
        }

        if (command === 'bold' && this.isSelectionInHeadingContext()) {
            this.updateToolbarState();
            return;
        }

        if (this.headingLevelCommands.has(command) && this.getActiveHeadingCommand() === command) {
            this.updateToolbarState();
            return;
        }

        if (command === 'table' && this.onInsertTable) {
            this.onInsertTable();
            return;
        }

        if (command === 'quote' && this.onInsertQuote) {
            this.onInsertQuote();
            return;
        }

        if (command === 'codeblock' && this.onInsertCodeBlock) {
            this.onInsertCodeBlock();
            return;
        }

        if (command === 'checkbox' && this.onInsertCheckbox) {
            this.onInsertCheckbox();
            return;
        }

        // コマンド実行前に状態を保存
        this.stateManager.saveState();

        switch (command) {
            case 'bold':
                document.execCommand('bold', false, null);
                break;
            case 'italic':
                document.execCommand('italic', false, null);
                break;
            case 'strikethrough':
                document.execCommand('strikeThrough', false, null);
                break;
            case 'h1':
                this.formatBlock('h1');
                break;
            case 'h2':
                this.formatBlock('h2');
                break;
            case 'h3':
                this.formatBlock('h3');
                break;
            case 'ul':
                if (!this.convertCheckboxListItemToListType('ul')) {
                    const marker = this._placeCollapsedCaretMarker();
                    document.execCommand('insertUnorderedList', false, null);
                    this._restoreCollapsedCaretMarker(marker);
                }
                break;
            case 'ol':
                if (!this.convertCheckboxListItemToListType('ol')) {
                    const marker = this._placeCollapsedCaretMarker();
                    document.execCommand('insertOrderedList', false, null);
                    this._restoreCollapsedCaretMarker(marker);
                }
                break;
            case 'checkbox':
                this.insertCheckboxList();
                break;
            case 'quote':
                this.formatBlock('blockquote');
                break;
        }

        this.updateToolbarState();
    }

    updateToolbarState() {
        this.updateCommandAvailability();
        this.updateCommandContextStates();
        this.updateCommandActiveStates();
    }

    updateCommandAvailability() {
        const inTableCellContext = this.isSelectionInTableCellContext();
        const inHeadingContext = this.isSelectionInHeadingContext();
        const activeHeadingCommand = this.getActiveHeadingCommand();

        this.commandButtons.forEach((button, command) => {
            const disabledByTable = this.tableCellRestrictedCommands.has(command) && inTableCellContext;
            const disabledBoldInHeading = command === 'bold' && inHeadingContext;
            const disabledSameHeadingLevel =
                this.headingLevelCommands.has(command) &&
                !!activeHeadingCommand &&
                activeHeadingCommand === command;
            const isCurrentHeadingLevel =
                this.headingLevelCommands.has(command) &&
                !!activeHeadingCommand &&
                activeHeadingCommand === command;
            const isDisabled = disabledByTable || disabledBoldInHeading || disabledSameHeadingLevel;
            button.disabled = isDisabled;
            button.classList.toggle('is-disabled', isDisabled);
            button.classList.toggle('is-current-heading', isCurrentHeadingLevel);
            if (isDisabled) {
                button.setAttribute('aria-disabled', 'true');
            } else {
                button.removeAttribute('aria-disabled');
            }
        });
    }

    updateCommandActiveStates() {
        const shouldReflectActiveState = this.isSelectionInsideEditor();
        this.activeStateCommands.forEach((nativeCommand, command) => {
            const button = this.commandButtons.get(command);
            if (!button) return;

            const isActive =
                !button.disabled &&
                shouldReflectActiveState &&
                this.isNativeCommandActive(nativeCommand);
            button.classList.toggle('is-active', isActive);
            button.setAttribute('aria-pressed', isActive ? 'true' : 'false');
        });
    }

    updateCommandContextStates() {
        const shouldReflectState = this.isSelectionInsideEditor();
        const states = shouldReflectState ? this.getContextCommandStates() : {};

        this.contextStateCommands.forEach((command) => {
            const button = this.commandButtons.get(command);
            if (!button) return;

            const isActive = !!states[command];
            button.classList.toggle('is-active', isActive);
            button.setAttribute('aria-pressed', isActive ? 'true' : 'false');
        });
    }

    getContextCommandStates() {
        const states = {
            ul: false,
            ol: false,
            checkbox: false,
            quote: false,
            codeblock: false,
            table: false,
        };

        const selection = window.getSelection();
        if (!selection || selection.rangeCount === 0) {
            return states;
        }

        if (this.isSelectionInTableCellContext()) {
            states.table = true;
        }

        for (let i = 0; i < selection.rangeCount; i++) {
            const range = selection.getRangeAt(i);
            if (!this.editor.contains(range.startContainer) && !this.editor.contains(range.endContainer)) {
                continue;
            }

            const nodes = [range.startContainer, range.endContainer];
            nodes.forEach((node) => {
                const checkboxListItem = this._getClosestCheckboxListItem(node);
                if (checkboxListItem) {
                    states.checkbox = true;
                } else {
                    const list = this._getClosestListForNode(node);
                    if (list) {
                        if (list.tagName === 'UL') {
                            states.ul = true;
                        } else if (list.tagName === 'OL') {
                            states.ol = true;
                        }
                    }
                }

                if (this._isNodeInBlockquote(node)) {
                    states.quote = true;
                }

                if (this._isNodeInCodeBlock(node)) {
                    states.codeblock = true;
                }

                if (this._isNodeInTable(node)) {
                    states.table = true;
                }
            });
        }

        return states;
    }

    isSelectionInTableCellContext() {
        const selection = window.getSelection();
        if (selection && selection.rangeCount > 0) {
            for (let i = 0; i < selection.rangeCount; i++) {
                const range = selection.getRangeAt(i);
                if (this._isNodeInTableCell(range.startContainer) || this._isNodeInTableCell(range.endContainer)) {
                    return true;
                }
            }
        }

        // TableManager uses these classes for active table selections.
        return !!this.editor.querySelector('.md-table-cell-selected, .md-table-structure-selected-cell');
    }

    _isNodeInTableCell(node) {
        if (!node) return false;
        const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
        if (!element) return false;
        return !!element.closest('td, th');
    }

    _getElementFromNode(node) {
        if (!node) return null;
        return node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    }

    _getClosestListForNode(node) {
        const element = this._getElementFromNode(node);
        if (!element) return null;
        const list = element.closest('ul, ol');
        if (!list || !this.editor.contains(list)) {
            return null;
        }
        const hasDirectListItem = Array.from(list.children || []).some(
            (child) => child && child.tagName === 'LI'
        );
        if (!hasDirectListItem) {
            return null;
        }
        return list;
    }

    _getClosestCheckboxListItem(node) {
        const element = this._getElementFromNode(node);
        if (!element) return null;
        const listItem = element.closest('li');
        if (!listItem || !this.editor.contains(listItem)) {
            return null;
        }
        const checkbox = listItem.querySelector(':scope > input[type="checkbox"]');
        return checkbox ? listItem : null;
    }

    _getFirstDirectTextNode(listItem) {
        if (!listItem) return null;
        const walker = document.createTreeWalker(listItem, NodeFilter.SHOW_TEXT, null);
        let node;
        while ((node = walker.nextNode())) {
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
                return node;
            }
        }
        return null;
    }

    _getDirectTextNodes(listItem) {
        if (!listItem) return [];
        const nodes = [];
        const walker = document.createTreeWalker(listItem, NodeFilter.SHOW_TEXT, null);
        let node;
        while ((node = walker.nextNode())) {
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
                nodes.push(node);
            }
        }
        return nodes;
    }

    _getCollapsedDirectTextOffset(listItem, range) {
        if (!listItem || !range || !range.collapsed) return null;
        if (!listItem.contains(range.startContainer) && range.startContainer !== listItem) return null;

        const directTextNodes = this._getDirectTextNodes(listItem);
        if (directTextNodes.length === 0) {
            return 0;
        }

        let accumulated = 0;
        for (const node of directTextNodes) {
            const length = (node.textContent || '').length;
            if (range.startContainer === node) {
                return accumulated + Math.max(0, Math.min(range.startOffset, length));
            }
            accumulated += length;
        }

        if (range.startContainer === listItem) {
            return range.startOffset <= 1 ? 0 : accumulated;
        }

        try {
            const firstNode = directTextNodes[0];
            const probeRange = document.createRange();
            probeRange.setStart(firstNode, 0);
            probeRange.setEnd(range.startContainer, range.startOffset);
            return Math.max(0, probeRange.toString().length);
        } catch (_error) {
            return null;
        }
    }

    _setCollapsedDirectTextOffset(listItem, absoluteOffset) {
        if (!listItem) return false;
        const selection = window.getSelection();
        if (!selection) return false;

        const safeOffset = Math.max(0, Number.isFinite(absoluteOffset) ? absoluteOffset : 0);
        let directTextNodes = this._getDirectTextNodes(listItem);

        if (directTextNodes.length === 0) {
            const anchor = document.createTextNode('');
            const firstSublist = Array.from(listItem.children || []).find(
                (child) => child.tagName === 'UL' || child.tagName === 'OL'
            );
            if (firstSublist) {
                listItem.insertBefore(anchor, firstSublist);
            } else {
                listItem.appendChild(anchor);
            }
            directTextNodes = [anchor];
        }

        let remaining = safeOffset;
        let targetNode = directTextNodes[directTextNodes.length - 1];
        let targetOffset = (targetNode.textContent || '').length;
        for (const node of directTextNodes) {
            const length = (node.textContent || '').length;
            if (remaining <= length) {
                targetNode = node;
                targetOffset = remaining;
                break;
            }
            remaining -= length;
        }

        const range = document.createRange();
        range.setStart(targetNode, Math.max(0, Math.min(targetOffset, (targetNode.textContent || '').length)));
        range.collapse(true);
        selection.removeAllRanges();
        selection.addRange(range);
        return true;
    }

    _normalizeListItemTextAfterCheckboxRemoval(listItem) {
        const firstDirectTextNode = this._getFirstDirectTextNode(listItem);
        if (!firstDirectTextNode) return 0;
        const text = firstDirectTextNode.textContent || '';
        const normalized = text.replace(/^[ \u00A0\u200B]/, '');
        if (normalized === '') {
            firstDirectTextNode.remove();
            return text.length > 0 ? -1 : 0;
        } else if (normalized !== text) {
            firstDirectTextNode.textContent = normalized;
            return -(text.length - normalized.length);
        }
        return 0;
    }

    _ensureListItemTextAnchor(listItem) {
        if (!listItem) return null;
        let textNode = this._getFirstDirectTextNode(listItem);
        if (textNode) return textNode;

        const anchor = document.createTextNode('');
        const firstSublist = Array.from(listItem.children || []).find(
            (child) => child.tagName === 'UL' || child.tagName === 'OL'
        );
        if (firstSublist) {
            listItem.insertBefore(anchor, firstSublist);
        } else {
            listItem.appendChild(anchor);
        }
        return anchor;
    }

    _convertListItemType(listItem, targetTagName) {
        if (!listItem || !targetTagName) return;
        const parentList = listItem.parentElement;
        if (!parentList || (parentList.tagName !== 'UL' && parentList.tagName !== 'OL')) return;
        if (parentList.tagName === targetTagName) return;
        if (!parentList.parentElement) return;

        const targetList = document.createElement(targetTagName);

        if (!listItem.previousElementSibling && !listItem.nextElementSibling) {
            parentList.replaceWith(targetList);
            targetList.appendChild(listItem);
            return;
        }

        const parent = parentList.parentElement;
        const trailingList = listItem.nextElementSibling
            ? document.createElement(parentList.tagName)
            : null;

        if (trailingList) {
            let nextItem = listItem.nextElementSibling;
            while (nextItem) {
                const itemToMove = nextItem;
                nextItem = nextItem.nextElementSibling;
                trailingList.appendChild(itemToMove);
            }
        }

        parent.insertBefore(targetList, parentList.nextSibling);
        targetList.appendChild(listItem);

        if (trailingList && trailingList.children.length > 0) {
            parent.insertBefore(trailingList, targetList.nextSibling);
        }

        if (parentList.children.length === 0) {
            parentList.remove();
        }
    }

    _dispatchEditorInputEvent() {
        this.editor.dispatchEvent(new Event('input', { bubbles: true }));
    }

    _placeCollapsedCaretMarker() {
        const selection = window.getSelection();
        if (!selection || selection.rangeCount === 0 || !selection.isCollapsed) {
            return null;
        }

        const range = selection.getRangeAt(0);
        if (!this.editor.contains(range.startContainer)) {
            return null;
        }

        const marker = document.createComment('md-caret-marker');
        range.insertNode(marker);

        const afterRange = document.createRange();
        afterRange.setStartAfter(marker);
        afterRange.collapse(true);
        selection.removeAllRanges();
        selection.addRange(afterRange);

        return marker;
    }

    _restoreCollapsedCaretMarker(marker) {
        if (!marker) return false;
        if (!marker.parentNode || !this.editor.contains(marker)) {
            try {
                marker.remove();
            } catch (_error) {
                // noop
            }
            return false;
        }

        const selection = window.getSelection();
        if (!selection) {
            marker.remove();
            return false;
        }

        const range = document.createRange();
        range.setStartBefore(marker);
        range.collapse(true);
        selection.removeAllRanges();
        selection.addRange(range);
        marker.remove();
        return true;
    }

    convertCheckboxListItemToListType(command) {
        if (command !== 'ul' && command !== 'ol') return false;

        const selection = window.getSelection();
        if (!selection || selection.rangeCount === 0) return false;

        const range = selection.getRangeAt(0);
        if (!this.editor.contains(range.startContainer) && !this.editor.contains(range.endContainer)) {
            return false;
        }

        const listItem =
            this._getClosestCheckboxListItem(range.startContainer) ||
            this._getClosestCheckboxListItem(range.endContainer);
        if (!listItem) return false;
        const preservedOffset = this._getCollapsedDirectTextOffset(listItem, range);

        const checkbox = listItem.querySelector(':scope > input[type="checkbox"]');
        if (!checkbox) return false;
        checkbox.remove();
        const normalizationDelta = this._normalizeListItemTextAfterCheckboxRemoval(listItem);
        const restoredOffset = typeof preservedOffset === 'number'
            ? Math.max(0, preservedOffset + normalizationDelta)
            : null;

        const targetTagName = command === 'ol' ? 'OL' : 'UL';
        this._convertListItemType(listItem, targetTagName);

        const activeListItem = listItem.isConnected ? listItem : null;
        if (!activeListItem) {
            this._dispatchEditorInputEvent();
            return true;
        }

        if (typeof restoredOffset === 'number') {
            this._setCollapsedDirectTextOffset(activeListItem, restoredOffset);
        } else {
            const targetNode = this._ensureListItemTextAnchor(activeListItem);
            const newRange = document.createRange();
            newRange.setStart(targetNode, 0);
            newRange.collapse(true);
            selection.removeAllRanges();
            selection.addRange(newRange);
        }

        this._dispatchEditorInputEvent();
        return true;
    }

    _isNodeInBlockquote(node) {
        const element = this._getElementFromNode(node);
        if (!element) return false;
        const blockquote = element.closest('blockquote');
        return !!blockquote && this.editor.contains(blockquote);
    }

    _isNodeInCodeBlock(node) {
        const element = this._getElementFromNode(node);
        if (!element) return false;

        const pre = element.closest('pre');
        if (pre && this.editor.contains(pre)) {
            return true;
        }

        const toolbarElement = element.closest('.code-block-toolbar, .code-block-language');
        if (toolbarElement && this.editor.contains(toolbarElement)) {
            return true;
        }

        return false;
    }

    _isNodeInTable(node) {
        const element = this._getElementFromNode(node);
        if (!element) return false;
        const tableElement = element.closest('table, td, th, .md-table-wrapper');
        return !!tableElement && this.editor.contains(tableElement);
    }

    isSelectionInHeadingContext() {
        const selection = window.getSelection();
        if (!selection || selection.rangeCount === 0) {
            return false;
        }

        const headingSelector = 'h1, h2, h3, h4, h5, h6';

        for (let i = 0; i < selection.rangeCount; i++) {
            const range = selection.getRangeAt(i);
            if (!this.editor.contains(range.startContainer) && !this.editor.contains(range.endContainer)) {
                continue;
            }

            if (this._isNodeInHeading(range.startContainer) || this._isNodeInHeading(range.endContainer)) {
                return true;
            }

            if (range.collapsed) {
                continue;
            }

            const headings = this.editor.querySelectorAll(headingSelector);
            for (const heading of headings) {
                try {
                    if (range.intersectsNode(heading)) {
                        return true;
                    }
                } catch (_error) {
                    // noop
                }
            }
        }

        return false;
    }

    getActiveHeadingCommand() {
        const selection = window.getSelection();
        if (!selection || selection.rangeCount === 0) {
            return null;
        }

        for (let i = 0; i < selection.rangeCount; i++) {
            const range = selection.getRangeAt(i);
            if (!this.editor.contains(range.startContainer) && !this.editor.contains(range.endContainer)) {
                continue;
            }

            const startHeading = this._getHeadingElementFromNode(range.startContainer);
            if (startHeading) {
                const command = startHeading.tagName.toLowerCase();
                return this.headingLevelCommands.has(command) ? command : null;
            }

            const endHeading = this._getHeadingElementFromNode(range.endContainer);
            if (endHeading) {
                const command = endHeading.tagName.toLowerCase();
                return this.headingLevelCommands.has(command) ? command : null;
            }
        }

        return null;
    }

    _isNodeInHeading(node) {
        return !!this._getHeadingElementFromNode(node);
    }

    _getHeadingElementFromNode(node) {
        if (!node) return null;
        const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
        if (!element) return null;
        const heading = element.closest('h1, h2, h3, h4, h5, h6');
        if (!heading || !this.editor.contains(heading)) {
            return null;
        }
        return heading;
    }

    isSelectionInsideEditor() {
        const selection = window.getSelection();
        if (!selection || selection.rangeCount === 0) {
            return false;
        }

        for (let i = 0; i < selection.rangeCount; i++) {
            const range = selection.getRangeAt(i);
            if (this.editor.contains(range.startContainer) || this.editor.contains(range.endContainer)) {
                return true;
            }
        }

        return false;
    }

    isNativeCommandActive(nativeCommand) {
        if (typeof document.queryCommandState !== 'function') {
            return false;
        }

        try {
            return !!document.queryCommandState(nativeCommand);
        } catch (_error) {
            return false;
        }
    }

    /**
     * チェックボックスリストを挿入
     */
    insertCheckboxList() {
        const selection = window.getSelection();
        if (!selection) return;

        const isRangeInsideEditor = (range) => {
            if (!range) return false;
            return this.editor.contains(range.startContainer) && this.editor.contains(range.endContainer);
        };

        const getCellFromNode = (node) => {
            if (!node) return null;
            const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
            if (!element) return null;
            return element.closest('td, th');
        };

        const isStructureHandleNode = (node) =>
            !!(node &&
                node.nodeType === Node.ELEMENT_NODE &&
                node.classList &&
                node.classList.contains('md-table-structure-handle'));

        const isPlaceholderOnlyNode = (node) => {
            if (!node) return true;
            if (node.nodeType === Node.TEXT_NODE) {
                const text = (node.textContent || '').replace(/[\u200B\u00A0]/g, '');
                return text.trim() === '';
            }
            if (node.nodeType !== Node.ELEMENT_NODE) {
                return true;
            }
            if (isStructureHandleNode(node)) {
                return true;
            }
            if (
                node.classList?.contains('md-table-insert-line') ||
                node.getAttribute?.('data-exclude-from-markdown') === 'true'
            ) {
                return true;
            }
            if (node.tagName === 'BR') {
                return true;
            }
            if (node.tagName === 'UL' || node.tagName === 'OL' || node.tagName === 'TABLE') {
                return false;
            }
            const children = Array.from(node.childNodes || []);
            if (!children.length) {
                const text = (node.textContent || '').replace(/[\u200B\u00A0]/g, '');
                return text.trim() === '';
            }
            return children.every((child) => isPlaceholderOnlyNode(child));
        };

        const isPlaceholderOnlyTableCell = (cell) => {
            if (!cell) return false;
            return Array.from(cell.childNodes || []).every((child) => isPlaceholderOnlyNode(child));
        };

        const cleanupPlaceholderArtifactsInCell = (cell) => {
            if (!cell) return;
            Array.from(cell.childNodes || []).forEach((node) => {
                if (isStructureHandleNode(node)) return;
                if (node.nodeType === Node.ELEMENT_NODE &&
                    (node.tagName === 'UL' || node.tagName === 'OL' || node.tagName === 'TABLE')) {
                    return;
                }
                if (isPlaceholderOnlyNode(node)) {
                    node.remove();
                }
            });
        };

        const getActiveSelectedTableCell = () => {
            const cell = this.editor.querySelector('.md-table-cell-selected, .md-table-structure-selected-cell');
            if (!cell) return null;
            return (cell.tagName === 'TD' || cell.tagName === 'TH') ? cell : null;
        };

        const placeCaretAtCellStart = (cell) => {
            if (!cell) return null;
            const range = document.createRange();
            const textWalker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT, null);
            const textNode = textWalker.nextNode();
            if (textNode) {
                range.setStart(textNode, 0);
            } else {
                range.setStart(cell, 0);
            }
            range.collapse(true);
            selection.removeAllRanges();
            selection.addRange(range);
            return range;
        };

        let range = selection.rangeCount ? selection.getRangeAt(0) : null;
        const selectedCell = getActiveSelectedTableCell();
        const rangeCell = range ? getCellFromNode(range.startContainer) : null;
        if (selectedCell && !rangeCell) {
            range = placeCaretAtCellStart(selectedCell);
        } else if (!isRangeInsideEditor(range)) {
            range = selectedCell ? placeCaretAtCellStart(selectedCell) : null;
        }
        if (!isRangeInsideEditor(range)) return;

        const container = range.commonAncestorContainer;
        const block = container.nodeType === 3 ? container.parentElement : container;
        const tableCellBoundary = getCellFromNode(container);
        const traversalBoundary = tableCellBoundary || this.editor;
        const hadOnlyPlaceholderBreaks = isPlaceholderOnlyTableCell(tableCellBoundary);

        const getFirstTextNode = (element) => {
            if (!element) return null;
            const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, null);
            return walker.nextNode();
        };

        const getFirstDirectTextNodeAfterCheckbox = (li) => {
            for (const child of li.childNodes) {
                if (child.nodeType === Node.ELEMENT_NODE && child.tagName === 'INPUT') continue;
                if (child.nodeType === Node.TEXT_NODE) return child;
                if (child.nodeType === Node.ELEMENT_NODE && child.tagName !== 'UL' && child.tagName !== 'OL') {
                    const tn = getFirstTextNode(child);
                    if (tn) return tn;
                }
            }
            return null;
        };

        const getCheckboxTextMinOffset = (li) => {
            const textNode = getFirstDirectTextNodeAfterCheckbox(li);
            if (!textNode) return 0;
            const text = textNode.textContent || '';
            let offset = 0;
            while (offset < text.length && text[offset] === '\u200B') {
                offset++;
            }
            return offset;
        };

        const ensureCheckboxLeadingSpace = (li) => {
            const checkbox = li.querySelector(':scope > input[type="checkbox"]');
            if (!checkbox) return;

            let firstContentNode = null;
            let firstSublist = null;
            for (const child of li.childNodes) {
                if (child === checkbox) continue;
                if (child.nodeType === Node.ELEMENT_NODE && child.tagName === 'INPUT') continue;
                if (child.nodeType === Node.ELEMENT_NODE && (child.tagName === 'UL' || child.tagName === 'OL')) {
                    if (!firstSublist) {
                        firstSublist = child;
                    }
                    continue;
                }
                firstContentNode = child;
                break;
            }

            if (firstContentNode && firstContentNode.nodeType === Node.TEXT_NODE) {
                const text = firstContentNode.textContent || '';
                if (/^[ \u00A0]/.test(text)) {
                    // Remove markdown separator space kept by parser.
                    firstContentNode.textContent = text.slice(1) || '\u200B';
                } else if (text === '') {
                    firstContentNode.textContent = '\u200B';
                }
                return;
            }

            // Replace placeholder BR with a text anchor so no extra blank line appears.
            if (
                firstContentNode &&
                firstContentNode.nodeType === Node.ELEMENT_NODE &&
                firstContentNode.tagName === 'BR'
            ) {
                const anchorNode = document.createTextNode('\u200B');
                firstContentNode.replaceWith(anchorNode);
                return;
            }

            if (!getFirstDirectTextNodeAfterCheckbox(li)) {
                const anchorNode = document.createTextNode('\u200B');
                if (firstContentNode) {
                    li.insertBefore(anchorNode, firstContentNode);
                } else if (firstSublist) {
                    li.insertBefore(anchorNode, firstSublist);
                } else {
                    const nextNode = checkbox.nextSibling;
                    if (nextNode) {
                        li.insertBefore(anchorNode, nextNode);
                    } else {
                        li.appendChild(anchorNode);
                    }
                }
            }
        };

        // 現在のブロック要素を取得
        let currentBlock = block;
        while (currentBlock && currentBlock !== traversalBoundary) {
            if (currentBlock.tagName === 'LI') {
                // 既にリストアイテム内の場合、チェックボックスを追加/削除
                const existingCheckbox = currentBlock.querySelector(':scope > input[type="checkbox"]');
                if (existingCheckbox) {
                    // チェックボックスを削除
                    existingCheckbox.remove();
                } else {
                    // チェックボックスを先頭に追加
                    const checkbox = document.createElement('input');
                    checkbox.type = 'checkbox';
                    currentBlock.insertBefore(checkbox, currentBlock.firstChild);
                    ensureCheckboxLeadingSpace(currentBlock);
                    const targetNode = getFirstDirectTextNodeAfterCheckbox(currentBlock);
                    if (targetNode) {
                        const minOffset = getCheckboxTextMinOffset(currentBlock);
                        const newRange = document.createRange();
                        newRange.setStart(targetNode, minOffset);
                        newRange.collapse(true);
                        selection.removeAllRanges();
                        selection.addRange(newRange);
                    }
                }
                if (hadOnlyPlaceholderBreaks) {
                    cleanupPlaceholderArtifactsInCell(tableCellBoundary);
                }
                return;
            }
            currentBlock = currentBlock.parentElement;
        }

        // リスト外の場合、新しいチェックボックスリストを作成
        const ul = document.createElement('ul');
        const li = document.createElement('li');
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        li.appendChild(checkbox);
        ul.appendChild(li);

        // 現在のブロックを置き換え
        currentBlock = block;
        while (
            currentBlock &&
            currentBlock !== traversalBoundary &&
            currentBlock.parentElement !== traversalBoundary
        ) {
            currentBlock = currentBlock.parentElement;
        }
        if (currentBlock && currentBlock !== traversalBoundary) {
            const nodesToMove = Array.from(currentBlock.childNodes);
            nodesToMove.forEach(node => li.appendChild(node));
            ensureCheckboxLeadingSpace(li);
            currentBlock.replaceWith(ul);
        } else {
            range.deleteContents();
            range.insertNode(ul);
            ensureCheckboxLeadingSpace(li);
        }

        // カーソルをテキストノードの先頭に設定
        const newRange = document.createRange();
        const targetNode = getFirstDirectTextNodeAfterCheckbox(li);
        if (targetNode) {
            const minOffset = getCheckboxTextMinOffset(li);
            newRange.setStart(targetNode, minOffset);
        } else {
            newRange.setStart(li, li.childNodes.length);
        }
        newRange.collapse(true);
        selection.removeAllRanges();
        selection.addRange(newRange);
        if (hadOnlyPlaceholderBreaks) {
            cleanupPlaceholderArtifactsInCell(tableCellBoundary);
        }
    }

    /**
     * ブロック要素をフォーマット（見出し用）
     * @param {string} tag - タグ名（h1, h2, h3など）
     */
    formatBlock(tag) {
        const selection = window.getSelection();
        if (!selection || !selection.rangeCount) return;

        const range = selection.getRangeAt(0);
        const container = range.commonAncestorContainer;
        const block = container.nodeType === 3 ? container.parentElement : container;

        // すでに見出しかチェック
        let currentBlock = block;
        while (currentBlock && currentBlock !== this.editor) {
            if (currentBlock.tagName && /^H[1-6]$/.test(currentBlock.tagName)) {
                // すでに見出しの場合、変更
                const newElement = document.createElement(tag);
                newElement.innerHTML = currentBlock.innerHTML;
                if (currentBlock.parentNode) {
                    currentBlock.parentNode.replaceChild(newElement, currentBlock);
                }

                // 選択範囲を復元
                const newRange = document.createRange();
                newRange.selectNodeContents(newElement);
                selection.removeAllRanges();
                selection.addRange(newRange);
                return;
            }
            currentBlock = currentBlock.parentElement;
        }

        // 見出しでない場合、formatBlockを使用
        document.execCommand('formatBlock', false, tag);
    }
}

// Made with Bob
