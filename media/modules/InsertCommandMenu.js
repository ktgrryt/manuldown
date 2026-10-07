// @ts-nocheck
/** Explicit insertion without adding a slash or a search query to the document. */
export function isInsertMenuShortcut(event, isMac) {
    return !!(!event.metaKey && !event.shiftKey && !event.isComposing && event.keyCode !== 229 &&
        (isMac ? event.ctrlKey && !event.altKey : event.altKey && !event.ctrlKey) &&
        (event.code === 'Slash' || event.key === '/'));
}

export class InsertCommandMenu {
    constructor(editor, { isMac, canOpen, getCommands, position, onExecute }) {
        this.editor = editor;
        this.document = editor.ownerDocument;
        this.isMac = isMac;
        this.canOpen = canOpen;
        this.getCommands = getCommands;
        this.position = position;
        this.onExecute = onExecute;
        this.range = null;
        this.items = [];
        this.activeIndex = 0;
        this.composing = false;
        this.compositionEnded = 0;
    }

    get visible() { return this.range !== null; }

    setup() {
        if (this.menu) return;
        const create = (tag, className) => {
            const element = this.document.createElement(tag);
            element.className = className;
            return element;
        };
        this.menu = create('div', 'slash-command-menu insert-command-menu keyboard-nav-active');
        this.menu.setAttribute('data-exclude-from-markdown', 'true');
        this.search = create('input', 'insert-command-search');
        this.search.type = 'text';
        this.search.placeholder = 'Search commands…';
        this.search.autocomplete = 'off';
        this.search.spellcheck = false;
        this.search.setAttribute('role', 'combobox');
        this.search.setAttribute('aria-label', 'Search insert commands');
        this.search.setAttribute('aria-autocomplete', 'list');
        this.search.setAttribute('aria-controls', 'insert-command-list');
        this.list = create('div', 'insert-command-list');
        this.list.id = 'insert-command-list';
        this.list.setAttribute('role', 'listbox');
        this.list.setAttribute('aria-label', 'Insert commands');
        const hint = create('div', 'insert-command-hint');
        hint.textContent = `${this.isMac ? 'Control+/' : 'Alt+/'} · ↑↓ · Enter · Esc`;
        for (const child of [this.search, this.list, hint]) this.menu.appendChild(child);
        this.document.body.appendChild(this.menu);
        this.search.addEventListener('input', () => { if (!this.composing) this.updateQuery(); });
        this.search.addEventListener('compositionstart', () => { this.composing = true; });
        this.search.addEventListener('compositionend', () => {
            this.composing = false;
            this.compositionEnded = Date.now();
            this.updateQuery();
        });
        this.search.addEventListener('keydown', event => this.handleKeydown(event));
        for (const name of ['mousedown', 'focusin']) {
            this.document.addEventListener(name, event => {
                if (this.visible && !this.menu.contains(event.target)) this.close();
            });
        }
        this.document.defaultView.addEventListener('blur', () => this.close());
        this.document.defaultView.addEventListener('resize', () => this.reposition());
        this.editor.addEventListener('scroll', () => this.reposition());
    }

    open() {
        // A second host delivery must not reset a query or change the insertion point.
        if (this.visible) return true;
        const active = this.document.activeElement;
        if (active !== this.editor && (!this.editor.contains(active) ||
            active?.closest('input, textarea, select, [contenteditable="false"]'))) return false;
        const selection = this.document.defaultView.getSelection();
        if (!selection || selection.rangeCount !== 1) return false;
        const range = selection.getRangeAt(0);
        if (!this.canOpen(range)) return false;
        this.setup();
        this.range = range.cloneRange();
        // A live Range alone can relocate to the root when external HTML replaces
        // its nodes. Keep the original nodes to reject that stale insertion point.
        this.startNode = range.startContainer;
        this.endNode = range.endContainer;
        this.search.value = this.searchValue = this.query = '';
        this.undoQueries = [];
        this.redoQueries = [];
        this.activeIndex = 0;
        this.compositionEnded = 0;
        this.menu.style.display = 'flex';
        this.search.setAttribute('aria-expanded', 'true');
        this.refresh();
        this.search.focus({ preventScroll: true });
        return true;
    }

    valid() {
        return this.visible && this.editor.contains(this.startNode) &&
            this.editor.contains(this.endNode) && this.canOpen(this.range);
    }

    updateQuery() {
        if (this.search.value !== this.searchValue) {
            this.undoQueries.push(this.searchValue);
            this.redoQueries = [];
            this.searchValue = this.search.value;
        }
        this.refresh();
    }

    performHistory(direction) {
        if (!this.visible || this.document.activeElement !== this.search) return false;
        const source = direction === 'undo' ? this.undoQueries : this.redoQueries;
        const target = direction === 'undo' ? this.redoQueries : this.undoQueries;
        if (source.length) {
            target.push(this.searchValue);
            this.search.value = this.searchValue = source.pop();
            this.refresh();
        }
        return true;
    }

    refresh() {
        if (!this.visible || this.composing) return;
        if (!this.valid()) { this.close(); return; }
        const query = this.search.value.trim().replace(/^\//, '');
        if (query !== this.query) this.activeIndex = 0;
        this.query = query;
        this.items = this.getCommands(query, this.range);
        this.activeIndex = Math.min(this.activeIndex, Math.max(0, this.items.length - 1));
        this.list.innerHTML = '';
        this.items.forEach((command, index) => {
            const item = this.document.createElement('div');
            item.className = 'slash-command-item';
            if (command.source === 'custom') item.classList.add('custom-command');
            item.id = `insert-command-${index}`;
            item.setAttribute('role', 'option');
            const name = this.document.createElement('span');
            name.className = 'slash-command-name';
            name.textContent = `/${command.id}`;
            item.appendChild(name);
            item.addEventListener('mousedown', event => {
                event.preventDefault();
                event.stopPropagation();
                this.execute(index);
            });
            item.addEventListener('mousemove', () => {
                this.activeIndex = index;
                this.updateSelection();
            });
            this.list.appendChild(item);
        });
        if (!this.items.length) {
            const empty = this.document.createElement('div');
            empty.className = 'insert-command-empty';
            empty.setAttribute('role', 'status');
            empty.textContent = 'No matching commands';
            this.list.appendChild(empty);
        }
        this.updateSelection();
        this.reposition();
    }

    updateSelection(scroll = false) {
        Array.from(this.list.querySelectorAll('[role="option"]')).forEach((item, index) => {
            const selected = index === this.activeIndex;
            item.classList.toggle('selected', selected);
            item.setAttribute('aria-selected', String(selected));
            if (selected && scroll) item.scrollIntoView({ block: 'nearest' });
        });
        if (this.items.length) this.search.setAttribute('aria-activedescendant', `insert-command-${this.activeIndex}`);
        else this.search.removeAttribute('aria-activedescendant');
    }

    handleCursorMove(direction) {
        if (!this.visible || this.document.activeElement !== this.search) return false;
        if (direction === 'up' || direction === 'down') {
            if (this.items.length) {
                const delta = direction === 'up' ? -1 : 1;
                this.activeIndex = (this.activeIndex + delta + this.items.length) % this.items.length;
                this.updateSelection(true);
            }
        } else if (direction === 'right') {
            const offset = Math.min(this.search.value.length, this.search.selectionEnd + 1);
            this.search.setSelectionRange(offset, offset);
        }
        return true;
    }

    handleKeydown(event) {
        if (this.composing || event.isComposing || event.keyCode === 229 ||
            (event.key === 'Enter' && Date.now() - this.compositionEnded < 80)) return;
        const plain = !event.metaKey && !event.ctrlKey && !event.altKey;
        const ctrlNav = this.isMac && event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey;
        const key = String(event.key || '').toLowerCase();
        if (ctrlNav && (key === 'p' || key === 'f')) {
            // These keys have contributed VS Code cursor commands. Let that
            // single host delivery navigate this field rather than the document.
            event.preventDefault();
            return;
        }
        let delta = 0;
        if ((plain && key === 'arrowdown') || (ctrlNav && key === 'n')) delta = 1;
        else if (plain && key === 'arrowup') delta = -1;
        else if (plain && key === 'tab') delta = event.shiftKey ? -1 : 1;
        if (delta) {
            event.preventDefault();
            event.stopPropagation();
            if (this.items.length) {
                this.activeIndex = (this.activeIndex + delta + this.items.length) % this.items.length;
                this.updateSelection(true);
            }
        } else if (plain && key === 'escape') {
            event.preventDefault();
            event.stopPropagation();
            this.close({ restoreSelection: true });
        } else if (plain && !event.shiftKey && key === 'enter') {
            event.preventDefault();
            event.stopPropagation();
            this.execute(this.activeIndex);
        }
    }

    execute(index) {
        const command = this.items[index];
        if (!command || !this.visible) return;
        if (!this.valid()) { this.close(); return; }
        this.close({ restoreSelection: true });
        this.onExecute(command);
    }

    close({ restoreSelection = false } = {}) {
        if (!this.visible) return;
        const range = this.range;
        const valid = this.editor.contains(this.startNode) && this.editor.contains(this.endNode);
        this.range = null;
        this.startNode = this.endNode = null;
        this.items = [];
        this.composing = false;
        this.menu.style.display = 'none';
        this.search.setAttribute('aria-expanded', 'false');
        this.search.removeAttribute('aria-activedescendant');
        if (restoreSelection && valid) {
            this.editor.focus({ preventScroll: true });
            const selection = this.document.defaultView.getSelection();
            selection.removeAllRanges();
            selection.addRange(range);
        }
    }

    reposition() {
        if (!this.visible) return;
        if (!this.valid()) { this.close(); return; }
        const caret = this.range.cloneRange();
        caret.collapse(false);
        this.position(caret, this.menu);
    }
}
