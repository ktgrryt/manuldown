// @ts-nocheck
/**
 * ツールバー管理モジュール
 * ツールバーボタンのイベント処理とコマンド実行を担当
 */

export class ToolbarManager {
    constructor(editor, stateManager, options = {}) {
        this.editor = editor;
        this.stateManager = stateManager;
        this.shortcutModifier = options.isMac ? 'Cmd' : 'Ctrl';
        this.onOpenInsertMenu = options.onOpenInsertMenu || null;
        this.canOpenInsertMenu = options.canOpenInsertMenu || (() => true);
        this.onInsertTable = options.onInsertTable || null;
        this.onInsertQuote = options.onInsertQuote || null;
        this.onInsertCodeBlock = options.onInsertCodeBlock || null;
        this.onInsertCheckbox = options.onInsertCheckbox || null;
        this.onInsertLink = options.onInsertLink || null;
        this.onInsertImage = options.onInsertImage || null;
        this.onInsertFootnote = options.onInsertFootnote || null;
        this.canInsertFootnote = options.canInsertFootnote || (() => true);
        this.onInsertMath = options.onInsertMath || null;
        this.canInsertMath = options.canInsertMath || (() => true);
        this.onInsertMathBlock = options.onInsertMathBlock || null;
        this.onOpenSettings = options.onOpenSettings || null;
        this.commandButtons = new Map();
        this.overflowButtons = new Map();
        this.overflowSelection = null;
        this.focusedFootnoteNumber = null;
        this.overflowLayoutFrame = null;
        this.activeStateCommands = new Map([
            ['bold', 'bold'],
            ['italic', 'italic'],
            ['strikethrough', 'strikeThrough'],
        ]);
        this.contextStateCommands = new Set([
            'inlinecode',
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
            'ul',
            'ol',
            'checkbox',
            'quote',
            'codeblock',
            'mathblock',
            'table',
        ]);
        this.headingLevelCommands = new Set([
            'h1',
            'h2',
            'h3',
        ]);
        this.listRestrictedCommands = new Set([
            'h1',
            'h2',
            'h3',
            'quote',
            'codeblock',
            'mathblock',
            'table',
        ]);
    }

    /**
     * ツールバーをセットアップ
     */
    setup() {
        const buttons = document.querySelectorAll('.toolbar > .toolbar-btn');
        Array.from(buttons).forEach(button => {
            const command = button.getAttribute('data-command');
            if (!command) return;
            const shortcutKey = button.getAttribute('data-shortcut-key');
            const fullShortcut = button.getAttribute(this.shortcutModifier === 'Cmd'
                ? 'data-shortcut-mac' : 'data-shortcut-other');
            if (fullShortcut) {
                button.title = `${button.title} (${fullShortcut})`;
            } else if (shortcutKey) {
                button.title = `${button.title} (${this.shortcutModifier}+${shortcutKey})`;
            }
            this.commandButtons.set(command, button);
            if (this.activeStateCommands.has(command) || this.contextStateCommands.has(command)) {
                button.setAttribute('aria-pressed', 'false');
            }
            // Keep caret/selection in the editor when clicking toolbar buttons.
            button.addEventListener('mousedown', (e) => {
                e.preventDefault();
            });
            button.addEventListener('click', (e) => {
                e.preventDefault();
                if (button.disabled) return;
                const command = button.getAttribute('data-command');
                this.executeCommand(command);
                // ダイアログを開くコマンドはダイアログ側でフォーカスを管理するため、ここではスキップ
                if (command !== 'table' && command !== 'link' && command !== 'image' && command !== 'footnote' &&
                    command !== 'math' && command !== 'settings' && command !== 'insert-menu') {
                    setTimeout(() => this.editor.focus(), 0);
                }
            });
        });

        this.setupOverflow();

        const updateAvailability = () => {
            this.updateCommandAvailability();
            this.updateCommandContextStates();
            this.updateOverflowMenuState();
        };
        const updateToolbarState = () => this.updateToolbarState();
        document.addEventListener('selectionchange', updateAvailability);
        this.editor.addEventListener('keyup', updateToolbarState);
        this.editor.addEventListener('mouseup', updateToolbarState);
        this.editor.addEventListener('input', updateToolbarState);
        this.editor.addEventListener('focus', updateToolbarState);
        this.editor.addEventListener('focusin', (event) => {
            this.focusedFootnoteNumber = this.getFootnoteNumber(event.target);
            this.updateToolbarState();
        });
        this.editor.addEventListener('blur', updateToolbarState);

        this.updateToolbarState();
    }

    setupOverflow() {
        this.toolbar = document.querySelector('.toolbar');
        this.overflowToggle = this.toolbar?.querySelector('.toolbar-overflow-toggle');
        this.overflowMenu = this.toolbar?.querySelector('.toolbar-overflow-menu');
        if (!this.overflowToggle || !this.overflowMenu) return;

        this.toolbarItems = Array.from(this.toolbar.children).filter((item) =>
            item.hasAttribute('data-command') || item.classList.contains('toolbar-separator')
        );
        this.toolbarButtons = this.toolbarItems.filter((item) =>
            item.hasAttribute('data-command') && !item.hasAttribute('data-overflow-only')
        );
        this.hasOverflowOnlyCommands = this.toolbarItems.some((item) => item.hasAttribute('data-overflow-only'));
        this.overflowSeparators = new Map();
        this.toolbarItems.forEach((item) => {
            if (item.classList.contains('toolbar-separator')) {
                const separator = document.createElement('div');
                separator.className = 'toolbar-overflow-separator';
                separator.setAttribute('role', 'separator');
                this.overflowMenu.appendChild(separator);
                this.overflowSeparators.set(item, separator);
                return;
            }
            const command = item.getAttribute('data-command');
            const menuItem = document.createElement('button');
            menuItem.type = 'button';
            menuItem.className = 'toolbar-overflow-item';
            menuItem.setAttribute('data-command', command);
            menuItem.tabIndex = -1;
            menuItem.addEventListener('mousedown', (event) => event.preventDefault());
            menuItem.addEventListener('click', (event) => {
                event.preventDefault();
                if (menuItem.disabled) return;
                this.closeOverflowMenu({ restoreSelection: true });
                this.executeCommand(command);
                if (command !== 'table' && command !== 'link' && command !== 'image' && command !== 'footnote' &&
                    command !== 'math' && command !== 'settings' && command !== 'insert-menu') {
                    setTimeout(() => this.editor.focus(), 0);
                }
            });
            this.overflowMenu.appendChild(menuItem);
            this.overflowButtons.set(command, menuItem);
        });

        this.overflowToggle.addEventListener('mousedown', (event) => event.preventDefault());
        this.overflowToggle.addEventListener('click', (event) => {
            event.preventDefault();
            if (this.overflowMenu.hidden) this.openOverflowMenu(event.detail === 0);
            else this.closeOverflowMenu();
        });
        this.overflowToggle.addEventListener('keydown', (event) => {
            if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
            event.preventDefault();
            this.openOverflowMenu(false);
            this.focusOverflowItem(event.key === 'ArrowUp' ? -1 : 0);
        });
        this.overflowMenu.addEventListener('keydown', (event) => {
            if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                this.closeOverflowMenu({ restoreSelection: true, focusToggle: true });
            } else if (event.key === 'Tab') {
                this.closeOverflowMenu({ focusToggle: true });
            } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
                event.preventDefault();
                const items = this.getEnabledOverflowItems();
                const current = items.indexOf(document.activeElement);
                const index = event.key === 'Home' ? 0 : event.key === 'End' ? -1 :
                    (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
                this.focusOverflowItem(index);
            }
        });
        document.addEventListener('mousedown', (event) => {
            if (!this.overflowMenu.hidden && !this.overflowMenu.contains(event.target) &&
                !this.overflowToggle.contains(event.target)) {
                this.closeOverflowMenu();
            }
        });
        document.addEventListener('keydown', (event) => {
            if (event.key === 'Escape' && !this.overflowMenu.hidden) {
                event.preventDefault();
                this.closeOverflowMenu({ restoreSelection: true, focusToggle: true });
            }
        });

        const scheduleLayout = () => {
            if (this.overflowLayoutFrame !== null) return;
            this.overflowLayoutFrame = requestAnimationFrame(() => {
                this.overflowLayoutFrame = null;
                this.updateOverflowLayout();
            });
        };
        if (typeof ResizeObserver === 'function') {
            this.overflowResizeObserver = new ResizeObserver(scheduleLayout);
            this.overflowResizeObserver.observe(this.toolbar);
        }
        window.addEventListener('resize', scheduleLayout);
        this.updateOverflowLayout();
    }

    getVisibleToolbarItems(buttonCount) {
        const visible = new Set(this.toolbarButtons.slice(0, buttonCount));
        return this.toolbarItems.filter((item, index) => {
            if (item.hasAttribute('data-command')) return visible.has(item);
            return this.toolbarItems.slice(0, index).some((before) => visible.has(before)) &&
                this.toolbarItems.slice(index + 1).some((after) => visible.has(after));
        });
    }

    updateOverflowLayout() {
        if (!this.overflowToggle) return;
        if (this.toolbar.clientWidth === 0) {
            this.closeOverflowMenu();
            return;
        }
        const style = window.getComputedStyle(this.toolbar);
        const available = this.toolbar.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
        const gap = parseFloat(style.columnGap) || 0;
        const widths = new Map();
        this.toolbarItems.forEach((item) => {
            item.hidden = item.hasAttribute('data-overflow-only');
            if (item.hidden) return;
            const itemStyle = window.getComputedStyle(item);
            widths.set(item, item.getBoundingClientRect().width +
                (parseFloat(itemStyle.marginLeft) || 0) + (parseFloat(itemStyle.marginRight) || 0));
        });
        const widthOf = (items) => items.reduce((width, item) => width + widths.get(item), 0) +
            Math.max(0, items.length - 1) * gap;
        const needsOverflow = this.hasOverflowOnlyCommands ||
            widthOf(this.getVisibleToolbarItems(this.toolbarButtons.length)) > available;
        this.overflowToggle.hidden = !needsOverflow;
        let count = this.toolbarButtons.length;
        if (needsOverflow) {
            const toggleWidth = this.overflowToggle.getBoundingClientRect().width;
            while (count > 0 && widthOf(this.getVisibleToolbarItems(count)) + gap + toggleWidth > available) {
                count--;
            }
        }
        const visible = new Set(this.getVisibleToolbarItems(count));
        this.toolbarItems.forEach((item) => { item.hidden = !visible.has(item); });
        this.updateOverflowMenuState();
        if (!needsOverflow) this.closeOverflowMenu({ restoreSelection: !this.overflowMenu.hidden });
        else if (!this.overflowMenu.hidden) this.positionOverflowMenu();
    }

    updateOverflowMenuState() {
        this.overflowButtons.forEach((menuItem, command) => {
            const button = this.commandButtons.get(command);
            if (!button) return;
            menuItem.hidden = !button.hidden;
            menuItem.disabled = button.disabled;
            menuItem.title = button.title;
            menuItem.textContent = (button.getAttribute('aria-label') || button.title || button.textContent.trim())
                .replace(/^Insert\s+/, '').replace(/\s+\([^)]*\)$/, '');
            const pressed = button.getAttribute('aria-pressed');
            menuItem.setAttribute('role', pressed === null ? 'menuitem' : 'menuitemcheckbox');
            menuItem.classList.toggle('is-active', pressed === 'true');
            if (pressed === null) menuItem.removeAttribute('aria-checked');
            else menuItem.setAttribute('aria-checked', pressed);
        });
        this.overflowSeparators?.forEach((separator, original) => {
            const index = this.toolbarItems.indexOf(original);
            separator.hidden = !(
                this.toolbarItems.slice(0, index).some((item) => item.hasAttribute('data-command') && item.hidden) &&
                this.toolbarItems.slice(index + 1).some((item) => item.hasAttribute('data-command') && item.hidden)
            );
        });
    }

    openOverflowMenu(focusFirst = false) {
        if (this.overflowToggle.hidden || this.overflowToggle.disabled) return;
        const selection = window.getSelection();
        const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
        this.overflowSelection = range && this.editor.contains(range.startContainer) &&
            this.editor.contains(range.endContainer) ? range.cloneRange() : null;
        this.updateToolbarState();
        this.overflowMenu.hidden = false;
        this.overflowToggle.setAttribute('aria-expanded', 'true');
        this.positionOverflowMenu();
        if (focusFirst) this.focusOverflowItem(0);
    }

    closeOverflowMenu({ restoreSelection = false, focusToggle = false } = {}) {
        if (!this.overflowMenu) return;
        this.overflowMenu.hidden = true;
        this.overflowToggle.setAttribute('aria-expanded', 'false');
        const range = this.overflowSelection;
        this.overflowSelection = null;
        if (restoreSelection && range && this.editor.contains(range.startContainer) && this.editor.contains(range.endContainer)) {
            this.editor.focus({ preventScroll: true });
            const selection = window.getSelection();
            selection.removeAllRanges();
            selection.addRange(range);
        }
        if (focusToggle && !this.overflowToggle.hidden) this.overflowToggle.focus({ preventScroll: true });
    }

    positionOverflowMenu() {
        const anchor = this.overflowToggle.getBoundingClientRect();
        const width = this.overflowMenu.getBoundingClientRect().width;
        const top = Math.min(anchor.bottom + 4, window.innerHeight - 60);
        this.overflowMenu.style.left = `${Math.max(8, Math.min(anchor.right - width, window.innerWidth - width - 8))}px`;
        this.overflowMenu.style.top = `${Math.max(8, top)}px`;
        this.overflowMenu.style.maxHeight = `${Math.max(40, window.innerHeight - Math.max(8, top) - 8)}px`;
    }

    getEnabledOverflowItems() {
        return Array.from(this.overflowButtons.values()).filter((item) => !item.hidden && !item.disabled);
    }

    focusOverflowItem(index) {
        const items = this.getEnabledOverflowItems();
        const item = items[index < 0 ? items.length - 1 : index];
        item?.focus({ preventScroll: true });
        item?.scrollIntoView({ block: 'nearest' });
    }

    /**
     * フォーマットコマンドを実行
     * @param {string} command - 実行するコマンド
     */
    executeCommand(command) {
        if (command === 'settings') {
            if (this.onOpenSettings) this.onOpenSettings();
            return;
        }

        // Check before focusing the editor: a number deliberately has no
        // editable range, and focus could create an unrelated insertion point.
        if (this.isSelectionOnFootnoteNumber()) {
            this.updateToolbarState();
            return;
        }

        this.editor.focus();

        if (command === 'insert-menu') {
            if (this.canOpenInsertMenu() && this.onOpenInsertMenu) this.onOpenInsertMenu();
            this.updateToolbarState();
            return;
        }

        if (command === 'footnote') {
            if (this.canInsertFootnote() && this.onInsertFootnote) this.onInsertFootnote();
            this.updateToolbarState();
            return;
        }

        if (command === 'math') {
            if (this.canInsertMath() && this.onInsertMath) this.onInsertMath();
            this.updateToolbarState();
            return;
        }

        if (command === 'inlinecode') {
            this.toggleInlineCode();
            this.updateToolbarState();
            return;
        }

        const isTableCellRestrictedCommand =
            !!command && this.tableCellRestrictedCommands.has(command);
        if (isTableCellRestrictedCommand && this.isSelectionInTableCellContext()) {
            return;
        }

        if (command === 'bold' && this.isSelectionInHeadingContext()) {
            this.updateToolbarState();
            return;
        }

        if (this.listRestrictedCommands.has(command) && this.isSelectionInListContext()) {
            this.updateToolbarState();
            return;
        }

        if ((command === 'codeblock' || command === 'mathblock') && this.isSelectionInCodeBlockContext()) {
            this.updateToolbarState();
            return;
        }

        if (command === 'image' && (this.isSelectionInCodeBlockContext() || this.isSelectionTouchingInlineCode())) {
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

        if (command === 'mathblock' && this.onInsertMathBlock) {
            this.onInsertMathBlock();
            return;
        }

        if (command === 'checkbox' && this.onInsertCheckbox) {
            this.onInsertCheckbox();
            return;
        }

        if (command === 'link' && this.onInsertLink) {
            this.onInsertLink();
            return;
        }

        if (command === 'image' && this.onInsertImage) {
            this.onInsertImage();
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
                this.formatBlock(this.getActiveHeadingCommand() === command ? 'p' : 'h1');
                break;
            case 'h2':
                this.formatBlock(this.getActiveHeadingCommand() === command ? 'p' : 'h2');
                break;
            case 'h3':
                this.formatBlock(this.getActiveHeadingCommand() === command ? 'p' : 'h3');
                break;
            case 'ul':
                if (this.isSelectionInHeadingContext()) {
                    this.formatBlock('p');
                }
                if (!this.convertCheckboxListItemToListType('ul')) {
                    const marker = this._placeCollapsedCaretMarker();
                    document.execCommand('insertUnorderedList', false, null);
                    this._restoreCollapsedCaretMarker(marker);
                }
                break;
            case 'ol':
                if (this.isSelectionInHeadingContext()) {
                    this.formatBlock('p');
                }
                if (!this.convertCheckboxListItemToListType('ol')) {
                    const marker = this._placeCollapsedCaretMarker();
                    document.execCommand('insertOrderedList', false, null);
                    this._restoreCollapsedCaretMarker(marker);
                }
                break;
        }

        this.updateToolbarState();
    }

    updateToolbarState() {
        this.updateCommandAvailability();
        this.updateCommandContextStates();
        this.updateCommandActiveStates();
        this.updateOverflowMenuState();
    }

    updateCommandAvailability() {
        const onFootnoteNumber = this.isSelectionOnFootnoteNumber();
        const inTableCellContext = this.isSelectionInTableCellContext();
        const inHeadingContext = this.isSelectionInHeadingContext();
        const inListContext = this.isSelectionInListContext();
        const inCodeBlockContext = this.isSelectionInCodeBlockContext();
        const activeHeadingCommand = onFootnoteNumber ? null : this.getActiveHeadingCommand();

        this.commandButtons.forEach((button, command) => {
            const disabledByTable = this.tableCellRestrictedCommands.has(command) && inTableCellContext;
            const disabledBoldInHeading = command === 'bold' && inHeadingContext;
            const isCurrentHeadingLevel =
                this.headingLevelCommands.has(command) &&
                !!activeHeadingCommand &&
                activeHeadingCommand === command;
            const disabledByList = this.listRestrictedCommands.has(command) && inListContext;
            const disabledCodeBlockInCodeBlock = (command === 'codeblock' || command === 'mathblock') && inCodeBlockContext;
            const disabledLinkInCodeBlock = command === 'link' && inCodeBlockContext;
            const disabledInlineCode = command === 'inlinecode' && !this.canToggleInlineCode();
            const disabledImageInCode = command === 'image' &&
                (inCodeBlockContext || this.isSelectionTouchingInlineCode());
            const disabledFootnote = command === 'footnote' && !this.canInsertFootnote();
            const disabledMath = command === 'math' && !this.canInsertMath();
            const disabledInsertMenu = command === 'insert-menu' && !this.canOpenInsertMenu();
            const isDisabled =
                (onFootnoteNumber && command !== 'settings') ||
                disabledByTable ||
                disabledBoldInHeading ||
                disabledByList ||
                disabledCodeBlockInCodeBlock ||
                disabledLinkInCodeBlock ||
                disabledInlineCode ||
                disabledImageInCode ||
                disabledFootnote ||
                disabledMath || disabledInsertMenu;
            button.disabled = isDisabled;
            button.classList.toggle('is-disabled', isDisabled);
            button.classList.toggle('is-current-heading', isCurrentHeadingLevel);
            if (this.headingLevelCommands.has(command)) {
                button.setAttribute('aria-pressed', isCurrentHeadingLevel ? 'true' : 'false');
            }
            if (isDisabled) {
                button.setAttribute('aria-disabled', 'true');
            } else {
                button.removeAttribute('aria-disabled');
            }
        });
    }

    getFootnoteNumber(node) {
        const element = node?.nodeType === 1 ? node : node?.parentElement;
        const number = element?.closest?.('sup[data-mdw-footnote-ref], [data-mdw-footnote-backref]');
        return number && this.editor.contains(number) ? number : null;
    }

    isSelectionOnFootnoteNumber() {
        const document = this.editor.ownerDocument;
        if (!document) return false;
        const number = this.getFootnoteNumber(document.activeElement);
        if (number) {
            this.focusedFootnoteNumber = number;
            return true;
        }
        const selection = document.defaultView?.getSelection?.();
        for (let i = 0; i < (selection?.rangeCount || 0); i++) {
            const range = selection.getRangeAt(i);
            if (this.getFootnoteNumber(range.startContainer) || this.getFootnoteNumber(range.endContainer)) return true;
        }
        // Keyboard focus can move into the toolbar or its overflow menu while
        // the editing target is still the number, with no native selection.
        return !selection?.rangeCount && !!this.focusedFootnoteNumber &&
            this.editor.contains(this.focusedFootnoteNumber) && !!this.toolbar?.contains(document.activeElement);
    }

    updateCommandActiveStates() {
        const shouldReflectActiveState = !this.isSelectionOnFootnoteNumber() && this.isSelectionInsideEditor();
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
        const shouldReflectState = !this.isSelectionOnFootnoteNumber() && this.isSelectionInsideEditor();
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
            inlinecode: this.isInlineCodeActive(),
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

    _getInlineCode(node) {
        const element = this._getElementFromNode(node);
        const code = element?.closest('code');
        return code && !code.closest('pre') && this.editor.contains(code) ? code : null;
    }

    _getSelectedTextNodes(range) {
        const root = range.commonAncestorContainer || this.editor;
        const nodes = [];
        if (root.nodeType === Node.TEXT_NODE) {
            nodes.push(root);
        } else {
            const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
            let node;
            while ((node = walker.nextNode())) nodes.push(node);
        }
        return nodes.filter((node) => {
            if (node.parentElement.closest('[contenteditable="false"], [data-exclude-from-markdown="true"]') ||
                !range.intersectsNode(node)) {
                return false;
            }
            const start = node === range.startContainer ? range.startOffset : 0;
            const end = node === range.endContainer ? range.endOffset : node.length;
            return node.data.slice(start, end).replace(/[\u200B\u2060\uFEFF]/g, '').length > 0;
        });
    }

    canToggleInlineCode() {
        const selection = window.getSelection();
        if (!selection || selection.rangeCount !== 1) return false;
        const range = selection.getRangeAt(0);
        if (!this.editor.contains(range.startContainer) || !this.editor.contains(range.endContainer)) {
            return false;
        }
        if ([range.startContainer, range.endContainer].some((node) =>
            this._getElementFromNode(node)?.closest('pre, [contenteditable="false"], [data-exclude-from-markdown="true"]')
        )) {
            return false;
        }
        if (!range.collapsed) {
            // A selection can cross a code block even when both ends are paragraphs.
            if (Array.from(this.editor.querySelectorAll('pre')).some((pre) => range.intersectsNode(pre))) {
                return false;
            }
            return this._getSelectedTextNodes(range).length > 0;
        }
        return true;
    }

    isInlineCodeActive() {
        const selection = window.getSelection();
        if (!selection || selection.rangeCount !== 1) return false;
        const range = selection.getRangeAt(0);
        if (!this.editor.contains(range.startContainer) || !this.editor.contains(range.endContainer)) {
            return false;
        }
        if (range.collapsed) return !!this._getInlineCode(range.startContainer);
        const nodes = this._getSelectedTextNodes(range);
        return nodes.length > 0 && nodes.every((node) => !!this._getInlineCode(node));
    }

    isSelectionTouchingInlineCode() {
        const selection = window.getSelection();
        if (!selection || selection.rangeCount === 0) return false;
        const range = selection.getRangeAt(0);
        return !!this._getInlineCode(range.startContainer) || !!this._getInlineCode(range.endContainer) ||
            (!range.collapsed && this._getSelectedTextNodes(range).some((node) => !!this._getInlineCode(node)));
    }

    toggleInlineCode() {
        if (!this.canToggleInlineCode()) return false;

        const selection = window.getSelection();
        const range = selection.getRangeAt(0);
        const wasCollapsed = range.collapsed;
        const removeCode = this.isInlineCodeActive();
        this.stateManager.saveState();

        if (wasCollapsed && !removeCode) {
            const code = document.createElement('code');
            code.setAttribute('data-is-new', 'true');
            const text = document.createTextNode('\u200B');
            text.mdwCaretAnchor = { character: '\u200B', text: '\u200B', offset: 0 };
            code.appendChild(text);
            range.insertNode(code);
            range.setStart(text, text.length);
            range.collapse(true);
        } else {
            // Bookmarks survive splitting code elements and formatting across blocks.
            const start = document.createComment('inline-code-start');
            const end = document.createComment('inline-code-end');
            const endRange = range.cloneRange();
            endRange.collapse(false);
            endRange.insertNode(end);
            const startRange = range.cloneRange();
            startRange.collapse(true);
            startRange.insertNode(start);
            const selectedRange = document.createRange();
            selectedRange.setStartAfter(start);
            selectedRange.setEndBefore(end);

            if (removeCode) {
                const codes = wasCollapsed
                    ? [this._getInlineCode(start)]
                    : [...new Set(this._getSelectedTextNodes(selectedRange).map((node) => this._getInlineCode(node)))];
                codes.filter(Boolean).forEach((code) => {
                    const replacement = document.createDocumentFragment();
                    // Keep unselected prefixes and suffixes in their own code spans.
                    if (!wasCollapsed && code.contains(start)) {
                        const before = document.createRange();
                        before.selectNodeContents(code);
                        before.setEndBefore(start);
                        const prefix = code.cloneNode(false);
                        prefix.appendChild(before.extractContents());
                        if (prefix.textContent) replacement.appendChild(prefix);
                    }
                    let suffix = null;
                    if (!wasCollapsed && code.contains(end)) {
                        const after = document.createRange();
                        after.selectNodeContents(code);
                        after.setStartAfter(end);
                        suffix = code.cloneNode(false);
                        suffix.appendChild(after.extractContents());
                    }
                    while (code.firstChild) replacement.appendChild(code.firstChild);
                    if (suffix?.textContent) replacement.appendChild(suffix);
                    code.replaceWith(replacement);
                });
            } else {
                const codes = new Set();
                this._getSelectedTextNodes(selectedRange).forEach((node) => {
                    let code = this._getInlineCode(node);
                    if (!code) {
                        code = document.createElement('code');
                        node.replaceWith(code);
                        code.appendChild(node);
                    }
                    codes.add(code);
                });
                // Adjacent code spans serialize as one Markdown code span. Carry
                // the bookmarks along so the original selection stays intact.
                // Include a neighboring prefix so applying code next to an
                // existing span also merges that pair, without scanning the document.
                Array.from(codes).forEach((code) => {
                    let previous = code.previousSibling;
                    while (previous && (previous === start || previous === end ||
                        (previous.nodeType === Node.TEXT_NODE && previous.length === 0))) {
                        previous = previous.previousSibling;
                    }
                    if (previous?.nodeType === Node.ELEMENT_NODE && previous.tagName === 'CODE') {
                        codes.add(previous);
                    }
                });
                codes.forEach((code) => {
                    let next = code.nextSibling;
                    while (next) {
                        const between = [];
                        let candidate = next;
                        while (candidate && (candidate === start || candidate === end ||
                            (candidate.nodeType === Node.TEXT_NODE && candidate.length === 0))) {
                            between.push(candidate);
                            candidate = candidate.nextSibling;
                        }
                        if (candidate?.nodeType !== Node.ELEMENT_NODE || candidate.tagName !== 'CODE') break;
                        between.forEach((node) => code.appendChild(node));
                        while (candidate.firstChild) code.appendChild(candidate.firstChild);
                        candidate.remove();
                        next = code.nextSibling;
                    }
                });
            }

            range.setStartAfter(start);
            range.setEndBefore(end);
            start.remove();
            end.remove();
            // Bookmark insertion can leave an empty text node between the
            // boundaries. Keep a caret operation collapsed after unwrapping.
            if (wasCollapsed) range.collapse(true);
        }

        selection.removeAllRanges();
        selection.addRange(range);
        this._dispatchEditorInputEvent();
        this.stateManager.commitStateAfterChange?.();
        return true;
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

    isSelectionInListContext() {
        const selection = window.getSelection();
        if (!selection || selection.rangeCount === 0) {
            return false;
        }

        for (let i = 0; i < selection.rangeCount; i++) {
            const range = selection.getRangeAt(i);
            if (!this.editor.contains(range.startContainer) && !this.editor.contains(range.endContainer)) {
                continue;
            }
            if (this._getClosestListForNode(range.startContainer) || this._getClosestListForNode(range.endContainer)) {
                return true;
            }
        }

        return false;
    }

    isSelectionInCodeBlockContext() {
        const selection = window.getSelection();
        if (!selection || selection.rangeCount === 0) {
            return false;
        }

        for (let i = 0; i < selection.rangeCount; i++) {
            const range = selection.getRangeAt(i);
            if (!this.editor.contains(range.startContainer) && !this.editor.contains(range.endContainer)) {
                continue;
            }
            if (this._isNodeInCodeBlock(range.startContainer) ||
                this._isNodeInCodeBlock(range.endContainer) ||
                this._rangeTouchesCodeBlock(range)) {
                return true;
            }
        }

        return false;
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
        const normalized = text.replace(/^[ \u00A0\u200B\u2060]/, '');
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

    _rangeTouchesCodeBlock(range) {
        if (!range) return false;

        const boundaryNodes = [range.commonAncestorContainer];
        const collectBoundaryChild = (container, offset) => {
            if (!container || container.nodeType !== Node.ELEMENT_NODE) return;
            const children = container.childNodes || [];
            const direct = children[offset] || children[offset - 1];
            if (direct) {
                boundaryNodes.push(direct);
            }
        };

        collectBoundaryChild(range.startContainer, range.startOffset);
        collectBoundaryChild(range.endContainer, range.endOffset);

        return boundaryNodes.some((node) => this._isNodeInCodeBlock(node));
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
