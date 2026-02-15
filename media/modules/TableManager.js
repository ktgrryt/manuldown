// @ts-nocheck
/**
 * テーブル管理モジュール
 * テーブル作成/ラップ、セル選択、カーソル移動、行列挿入、削除を担当
 */

export class TableManager {
    constructor(editor, domUtils, stateManager) {
        this.editor = editor;
        this.domUtils = domUtils;
        this.stateManager = stateManager;
        this.notifyChange = null;

        this.selectedCells = [];
        this.selectionRange = null;
        this.structureSelection = null;
        this.structureDrag = null;
        this.hoverHandleContext = null;
        this.selectionHandleContext = null;
        this.isMouseDown = false;
        this.isDragging = false;
        this.anchorCell = null;
        this.focusCell = null;

        this.clipboardMatrix = null;

        this._isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;

        this.hoverInsert = null;
        this.insertLineVertical = null;
        this.insertLineHorizontal = null;

        this.dialog = null;

        this._lastEdgeNavTs = 0;
        this._lastEdgeNavDirection = null;
        this._compositionBlockedEdge = null;
    }

    setup({ notifyChange }) {
        this.notifyChange = notifyChange;
        this._createInsertLines();

        this.editor.addEventListener('mousemove', (e) => this._handleHoverMove(e));
        this.editor.addEventListener('mouseleave', () => {
            this.hoverHandleContext = null;
            this._clearInsertHover();
            this._syncHandleVisibility();
        });
        document.addEventListener('mousemove', (e) => this._handleDragMove(e));
        document.addEventListener('mousemove', (e) => this._handleGlobalHoverCleanup(e));
        document.addEventListener('mouseup', (e) => this._handleMouseUp(e));
        window.addEventListener('resize', () => {
            this._syncStructureSelectionUI();
            this._syncHandleVisibility();
        });
        window.addEventListener('blur', () => {
            this.hoverHandleContext = null;
            this._syncHandleVisibility();
            this._clearInsertHover();
        });
        this.editor.addEventListener('scroll', () => this._clearInsertHover(), { passive: true });
        this.editor.addEventListener('copy', (e) => this._handleCopy(e));
    }

    wrapTables() {
        const tables = Array.from(this.editor.querySelectorAll('table'));
        tables.forEach(table => {
            if (!table.classList.contains('md-table')) {
                table.classList.add('md-table');
            }

            this._ensureTableCells(table);
            this._ensureStructureHandles(table);

            const wrapper = table.closest('.md-table-wrapper');
            if (!wrapper) {
                const newWrapper = this._createWrapper();
                table.parentNode.insertBefore(newWrapper, table);
                newWrapper.appendChild(this._createEdge('left'));
                newWrapper.appendChild(table);
                newWrapper.appendChild(this._createEdge('right'));
            } else {
                // ensure edges exist
                const leftEdge = wrapper.querySelector('.md-table-edge-left');
                const rightEdge = wrapper.querySelector('.md-table-edge-right');
                if (!leftEdge) {
                    wrapper.insertBefore(this._createEdge('left'), wrapper.firstChild);
                }
                if (!rightEdge) {
                    wrapper.appendChild(this._createEdge('right'));
                }
            }

            const activeWrapper = table.closest('.md-table-wrapper');
            if (activeWrapper) {
                this._ensureStructureOutline(activeWrapper);
            }
        });
        this._syncSelectionHandleContextFromSelection();
        this._syncStructureSelectionUI();
    }

    openTableDialog() {
        if (this.dialog) {
            this.dialog.remove();
            this.dialog = null;
        }

        // Save the current selection range before opening dialog
        // (dialog focus may cause selection to be lost)
        const selection = window.getSelection();
        let savedRange = null;
        if (selection && selection.rangeCount) {
            savedRange = selection.getRangeAt(0).cloneRange();
        }

        const overlay = document.createElement('div');
        overlay.className = 'md-table-dialog-overlay';
        overlay.setAttribute('data-exclude-from-markdown', 'true');

        const dialog = document.createElement('div');
        dialog.className = 'md-table-dialog';
        dialog.setAttribute('data-exclude-from-markdown', 'true');

        const title = document.createElement('div');
        title.className = 'md-table-dialog-title';
        title.textContent = 'Insert Table';

        const form = document.createElement('div');
        form.className = 'md-table-dialog-form';

        const sanitizeInput = (input) => {
            input.addEventListener('input', () => {
                input.value = input.value.replace(/[^0-9]/g, '');
                if (input.value !== '' && parseInt(input.value, 10) < 1) {
                    input.value = '1';
                }
            });
            input.addEventListener('keydown', (e) => {
                // Allow: backspace, delete, tab, escape, enter, arrows
                if ([8, 46, 9, 27, 13, 37, 38, 39, 40].includes(e.keyCode)) return;
                // Block non-digit keys (allow numpad 0-9 and main 0-9)
                if ((e.keyCode < 48 || e.keyCode > 57) && (e.keyCode < 96 || e.keyCode > 105)) {
                    e.preventDefault();
                }
            });
            input.addEventListener('blur', () => {
                const val = parseInt(input.value, 10);
                if (!val || val < 1) input.value = '1';
            });
        };

        const rowLabel = document.createElement('label');
        rowLabel.textContent = 'Rows';
        const rowInput = document.createElement('input');
        rowInput.type = 'number';
        rowInput.min = '1';
        rowInput.step = '1';
        rowInput.value = '2';
        sanitizeInput(rowInput);

        const colLabel = document.createElement('label');
        colLabel.textContent = 'Columns';
        const colInput = document.createElement('input');
        colInput.type = 'number';
        colInput.min = '1';
        colInput.step = '1';
        colInput.value = '2';
        sanitizeInput(colInput);

        form.appendChild(rowLabel);
        form.appendChild(rowInput);
        form.appendChild(colLabel);
        form.appendChild(colInput);

        const actions = document.createElement('div');
        actions.className = 'md-table-dialog-actions';

        const cancelBtn = document.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.className = 'md-table-dialog-btn secondary';
        cancelBtn.textContent = 'Cancel';

        const insertBtn = document.createElement('button');
        insertBtn.type = 'button';
        insertBtn.className = 'md-table-dialog-btn primary';
        insertBtn.textContent = 'Insert';

        actions.appendChild(cancelBtn);
        actions.appendChild(insertBtn);

        dialog.appendChild(title);
        dialog.appendChild(form);
        dialog.appendChild(actions);
        overlay.appendChild(dialog);
        document.body.appendChild(overlay);
        this.dialog = overlay;

        const closeDialog = () => {
            if (this.dialog) {
                this.dialog.remove();
                this.dialog = null;
            }
            setTimeout(() => this.editor.focus(), 0);
        };

        cancelBtn.addEventListener('click', closeDialog);
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) {
                closeDialog();
            }
        });

        insertBtn.addEventListener('click', () => {
            const rows = Math.max(1, parseInt(rowInput.value, 10) || 0);
            const cols = Math.max(1, parseInt(colInput.value, 10) || 0);
            closeDialog();
            // Restore the saved selection before inserting
            if (savedRange) {
                this.editor.focus();
                const sel = window.getSelection();
                if (sel) {
                    sel.removeAllRanges();
                    sel.addRange(savedRange);
                }
            }
            this.insertTableAtSelection(rows, cols);
        });

        rowInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                colInput.focus();
            }
        });

        colInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                insertBtn.click();
            }
        });

        // ダイアログ内でTabキーのフォーカスをループさせる
        const focusableElements = [rowInput, colInput, cancelBtn, insertBtn];
        dialog.addEventListener('keydown', (e) => {
            if (e.key === 'Tab') {
                const currentIndex = focusableElements.indexOf(e.target);
                if (currentIndex === -1) return;
                e.preventDefault();
                const nextIndex = e.shiftKey
                    ? (currentIndex - 1 + focusableElements.length) % focusableElements.length
                    : (currentIndex + 1) % focusableElements.length;
                focusableElements[nextIndex].focus();
            }
        });

        setTimeout(() => rowInput.focus(), 0);
    }

    insertTableAtSelection(rows, cols) {
        const selection = window.getSelection();
        if (!selection || !selection.rangeCount) return;

        const range = selection.getRangeAt(0);
        this.stateManager.saveState();

        const wrapper = this._createTableWrapper(rows, cols);
        this._insertNodeAsBlock(range, wrapper);

        this.wrapTables();

        const firstCell = wrapper.querySelector('td, th');
        if (firstCell) {
            this._setCursorToCellStart(firstCell);
        }

        if (this.notifyChange) this.notifyChange();
    }

    handleMouseDown(e) {
        if (e.button !== 0) return false;

        const structureHandleInfo = this._getStructureHandleInfoFromTarget(e.target);
        if (structureHandleInfo) {
            e.preventDefault();
            this._clearInsertHover();
            this.clearCellSelection();
            this._setStructureSelection(structureHandleInfo.type, structureHandleInfo.table, structureHandleInfo.index);
            this._startStructureDrag(structureHandleInfo, e);
            return true;
        }

        if (this.hasStructureSelection()) {
            this.clearStructureSelection();
        }

        if (this.hoverInsert && this.hoverInsert.table) {
            e.preventDefault();
            this.stateManager.saveState();
            if (this.hoverInsert.type === 'col') {
                this._insertColumn(this.hoverInsert.table, this.hoverInsert.index);
            } else if (this.hoverInsert.type === 'row') {
                this._insertRow(this.hoverInsert.table, this.hoverInsert.index);
            }
            this._refreshInsertHoverFromPoint(e.clientX, e.clientY);
            if (this.notifyChange) this.notifyChange();
            return true;
        }

        const cellFromPoint = this._getCellFromPoint(e.clientX, e.clientY);
        const targetEl = e.target && e.target.nodeType === Node.ELEMENT_NODE ? e.target : e.target?.parentElement;
        const isInTableWrapper = !!(targetEl && targetEl.closest && targetEl.closest('.md-table-wrapper'));
        const isEditorBackground = targetEl === this.editor;
        if (!cellFromPoint && (isInTableWrapper || isEditorBackground) &&
            this._handleClickOutsideTable(e.clientX, e.clientY)) {
            e.preventDefault();
            this._clearInsertHover();
            this.clearCellSelection();
            return true;
        }

        const edge = this._getEdgeFromTarget(e.target);
        if (edge) {
            e.preventDefault();
            this._clearInsertHover();
            this.clearCellSelection();
            const wrapper = edge.closest('.md-table-wrapper');
            const table = wrapper ? wrapper.querySelector('table') : null;
            if (table) {
                const rect = table.getBoundingClientRect();
                if (e.clientY > rect.bottom) {
                    this._moveCursorAfterWrapper(wrapper);
                    return true;
                }
                if (e.clientY < rect.top) {
                    this._moveCursorBeforeWrapper(wrapper);
                    return true;
                }
                if (edge.dataset.tableEdge === 'left') {
                    const firstCell = table.querySelector('td, th');
                    if (firstCell) {
                        this._setCursorToCellStart(firstCell);
                    }
                } else if (edge.dataset.tableEdge === 'right') {
                    const lastCell = this._getLastCell(table);
                    if (lastCell) {
                        this._setCursorToCellEnd(lastCell);
                    }
                }
            }
            return true;
        }

        const cell = cellFromPoint || this._getCellFromPoint(e.clientX, e.clientY);
        if (!cell) {
            const wrapper = e.target.closest && e.target.closest('.md-table-wrapper');
            if (wrapper) {
                e.preventDefault();
                this._clearInsertHover();
                this.clearCellSelection();
                const table = wrapper.querySelector('table');
                if (table) {
                    const rect = table.getBoundingClientRect();
                    const isLeftSide = e.clientX < rect.left + rect.width / 2;
                    if (isLeftSide) {
                        const firstCell = table.querySelector('td, th');
                        if (firstCell) this._setCursorToCellStart(firstCell);
                    } else {
                        const lastCell = this._getLastCell(table);
                        if (lastCell) this._setCursorToCellEnd(lastCell);
                    }
                }
                return true;
            }
        }
        if (!cell) {
            const wrappers = Array.from(this.editor.querySelectorAll('.md-table-wrapper'));
            const hitWrapper = wrappers.find(w => {
                const rect = w.getBoundingClientRect();
                return e.clientX >= rect.left && e.clientX <= rect.right &&
                    e.clientY >= rect.top - 6 && e.clientY <= rect.bottom + 6;
            });
            if (hitWrapper) {
                const table = hitWrapper.querySelector('table');
                if (table) {
                    const tableRect = table.getBoundingClientRect();
                    if (e.clientY > tableRect.bottom) {
                        e.preventDefault();
                        this._clearInsertHover();
                        this.clearCellSelection();
                        this._moveCursorAfterWrapper(hitWrapper);
                        return true;
                    }
                    if (e.clientY < tableRect.top) {
                        e.preventDefault();
                        this._clearInsertHover();
                        this.clearCellSelection();
                        this._moveCursorBeforeWrapper(hitWrapper);
                        return true;
                    }
                }
            }
        }
        if (!cell) {
            this.clearCellSelection();
            return false;
        }

        this._clearInsertHover();
        this.isMouseDown = true;
        this.isDragging = false;
        this.anchorCell = cell;
        this.focusCell = cell;
        this.selectCellRange(cell, cell);
        return true;
    }

    _handleClickOutsideTable(x, y) {
        const tables = Array.from(this.editor.querySelectorAll('table.md-table'));
        if (!tables.length) return false;
        const edgeSnapThreshold = 24;

        let belowCandidate = null;
        let belowDistance = Number.POSITIVE_INFINITY;
        let aboveCandidate = null;
        let aboveDistance = Number.POSITIVE_INFINITY;

        for (const table of tables) {
            const rect = table.getBoundingClientRect();
            if (x < rect.left || x > rect.right) continue;

            if (y > rect.bottom) {
                const distance = y - rect.bottom;
                if (distance < belowDistance) {
                    belowDistance = distance;
                    belowCandidate = table;
                }
            } else if (y < rect.top) {
                const distance = rect.top - y;
                if (distance < aboveDistance) {
                    aboveDistance = distance;
                    aboveCandidate = table;
                }
            }
        }

        if (belowCandidate && belowDistance <= edgeSnapThreshold) {
            const wrapper = belowCandidate.closest('.md-table-wrapper');
            if (wrapper) {
                this._moveCursorAfterWrapper(wrapper);
                return true;
            }
        }

        if (aboveCandidate && aboveDistance <= edgeSnapThreshold) {
            const wrapper = aboveCandidate.closest('.md-table-wrapper');
            if (wrapper) {
                this._moveCursorBeforeWrapper(wrapper);
                return true;
            }
        }

        return false;
    }

    handleKeydown(e) {
        const hasCellSelection = this.hasCellSelection();
        const hasStructureSelection = this.hasStructureSelection();
        if (!hasCellSelection && !hasStructureSelection) return false;

        const isModifier = e.metaKey || e.ctrlKey || e.altKey;
        const isNavigation = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key);
        const isTab = e.key === 'Tab';
        const isCopyPaste = (e.metaKey || e.ctrlKey) && ['c', 'v', 'x'].includes(e.key.toLowerCase());
        const key = e.key.toLowerCase();
        const isDeleteKey = e.key === 'Backspace' || e.key === 'Delete' || (this._isMac && e.ctrlKey && key === 'h');
        const isPlainInput = e.key.length === 1 && !isModifier;
        const isEsc = e.key === 'Escape' && !e.metaKey && !e.ctrlKey && !e.altKey;
        const isCtrlNavMove =
            this._isMac && e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey &&
            ['f', 'b', 'n', 'p'].includes(key);

        if (isCopyPaste) {
            return false;
        }

        if (isEsc) {
            e.preventDefault();
            this.clearCellSelection();
            this.clearStructureSelection();
            return true;
        }

        if (hasStructureSelection) {
            const structureSelection = this._normalizeStructureSelection();
            if (structureSelection && this._handleStructureMoveKeydown(e, structureSelection)) {
                return true;
            }
            if (!isDeleteKey && (isNavigation || isTab || e.key === 'Enter' || isPlainInput || isCtrlNavMove)) {
                const anchorCell = this._getStructureAnchorCell(structureSelection);
                this.clearStructureSelection();
                if (anchorCell) {
                    this._setCursorToCellStart(anchorCell);
                }
            }
            return false;
        }

        if (isNavigation || isTab || isCtrlNavMove) {
            const selection = window.getSelection();
            const range = selection && selection.rangeCount ? selection.getRangeAt(0) : null;
            const caretCell = range && selection.isCollapsed
                ? this._getCellFromTarget(range.startContainer)
                : null;

            const anchorCell = this.focusCell || this._getTopLeftSelectedCell();
            this.clearCellSelection();

            // If caret is already placed in a cell (e.g. clicked inside text),
            // keep that exact caret position and let browser/native navigation handle movement.
            if (caretCell) {
                return false;
            }

            if (anchorCell) {
                this._setCursorToCellStart(anchorCell);
            }
            return false;
        }

        if (e.key.length === 1 && !isModifier) {
            this.clearCellSelection();
            return false;
        }

        return false;
    }

    _handleStructureMoveKeydown(e, structureSelection) {
        if (!structureSelection) return false;
        if (!e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return false;

        const isArrow = e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'ArrowUp' || e.key === 'ArrowDown';
        if (!isArrow) return false;

        const { type, table, index } = structureSelection;
        if (!table || !table.isConnected) return false;

        let insertIndex = null;
        let canMove = false;

        if (type === 'row') {
            const rowCount = table.rows.length;
            if (e.key === 'ArrowUp') {
                canMove = index > 0;
                insertIndex = index - 1;
            } else if (e.key === 'ArrowDown') {
                canMove = index < rowCount - 1;
                insertIndex = index + 2;
            }
        } else if (type === 'col') {
            const colCount = this._getColumnCount(table);
            if (e.key === 'ArrowLeft') {
                canMove = index > 0;
                insertIndex = index - 1;
            } else if (e.key === 'ArrowRight') {
                canMove = index < colCount - 1;
                insertIndex = index + 2;
            }
        }

        // During structure selection, consume Shift+Arrow so browser text selection does not start.
        e.preventDefault();
        e.stopPropagation();

        if (!canMove || insertIndex === null) {
            return true;
        }

        this.stateManager.saveState();
        const result = type === 'row'
            ? this._reorderRows(table, index, insertIndex)
            : this._reorderColumns(table, index, insertIndex);

        const moved = result !== null && result !== index;
        if (!moved) {
            return true;
        }

        this._ensureStructureHandles(table);
        this._setStructureSelection(type, table, result);
        if (this.notifyChange) this.notifyChange();
        setTimeout(() => this.editor.focus(), 0);
        return true;
    }

    handleEnterKeydown(e, isComposing = false) {
        if (e.key !== 'Enter' || e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return false;
        if (e.isComposing || isComposing) return false;

        const edge = this._getEdgeFromSelection();
        if (!edge) return false;
        const isLeft = edge.dataset.tableEdge === 'left';
        const isRight = edge.dataset.tableEdge === 'right';
        if (!isLeft && !isRight) return false;

        const wrapper = edge.closest('.md-table-wrapper');
        if (!wrapper || !wrapper.parentElement) return false;

        e.preventDefault();
        this.stateManager.saveState();

        const p = document.createElement('p');
        p.appendChild(document.createElement('br'));
        if (isLeft) {
            wrapper.parentElement.insertBefore(p, wrapper);
            this._setCursorToEdge(edge, false);
        } else {
            if (wrapper.nextSibling) {
                wrapper.parentElement.insertBefore(p, wrapper.nextSibling);
            } else {
                wrapper.parentElement.appendChild(p);
            }
            const selection = window.getSelection();
            if (selection) {
                const range = document.createRange();
                range.setStart(p, 0);
                range.collapse(true);
                selection.removeAllRanges();
                selection.addRange(range);
            }
        }

        if (this.notifyChange) this.notifyChange();
        return true;
    }

    executeTableCommand(command) {
        const info = this._getActiveCellInfo();
        if (!info) return false;

        const { table, rowIndex, colIndex } = info;

        if (command === 'selectColumn' || command === 'selectRow') {
            const type = command === 'selectColumn' ? 'col' : 'row';
            const index = command === 'selectColumn' ? colIndex : rowIndex;
            this.clearCellSelection();
            this.clearStructureSelection();
            this._setStructureSelection(type, table, index);
            setTimeout(() => this.editor.focus(), 0);
            return true;
        }

        this.clearCellSelection();
        this.clearStructureSelection();
        this.stateManager.saveState();

        let handled = false;

        switch (command) {
            case 'insertRowAbove':
                this._insertRow(table, rowIndex, colIndex);
                handled = true;
                break;
            case 'insertRowBelow':
                this._insertRow(table, rowIndex + 1, colIndex);
                handled = true;
                break;
            case 'insertColumnLeft':
                this._insertColumn(table, colIndex, rowIndex);
                handled = true;
                break;
            case 'insertColumnRight':
                this._insertColumn(table, colIndex + 1, rowIndex);
                handled = true;
                break;
            case 'deleteRow':
                handled = this._deleteRowAt(table, rowIndex, colIndex);
                break;
            case 'deleteColumn':
                handled = this._deleteColumnAt(table, colIndex, rowIndex);
                break;
            default:
                handled = false;
        }

        if (handled && this.notifyChange) this.notifyChange();
        return handled;
    }

    handleLineBoundaryKeydown(e) {
        if (!this._isMac) return false;
        if (!e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return false;
        const key = e.key.toLowerCase();
        if (key !== 'e' && key !== 'a') return false;

        const selection = window.getSelection();
        if (selection && selection.rangeCount) {
            const range = selection.getRangeAt(0);
            const cell = this._getCellFromTarget(range.startContainer);
            if (cell) {
                e.preventDefault();
                if (key === 'a') {
                    if (range.collapsed && this._isAtCellStart(cell, range)) {
                        const info = this._getCellInfo(cell);
                        const leftEdge = info ? this._getTableEdge(info.table, 'left') : null;
                        if (leftEdge) {
                            this._setCursorToEdge(leftEdge, false);
                        } else {
                            this._setCursorToCellStart(cell);
                        }
                    } else {
                        this._setCursorToCellStart(cell);
                    }
                } else {
                    if (range.collapsed && this._isAtCellEnd(cell, range)) {
                        const info = this._getCellInfo(cell);
                        const rightEdge = info ? this._getTableEdge(info.table, 'right') : null;
                        if (rightEdge) {
                            this._setCursorToEdge(rightEdge, true);
                        } else {
                            this._setCursorToCellEnd(cell);
                        }
                    } else {
                        this._setCursorToCellEnd(cell);
                    }
                }
                return true;
            }
        }

        const edge = this._getEdgeFromSelection();
        if (!edge) return false;
        const wrapper = edge.closest('.md-table-wrapper');
        if (!wrapper) return false;

        if (key === 'e') {
            if (edge.dataset.tableEdge !== 'left') return false;
            const rightEdge = wrapper.querySelector('.md-table-edge-right');
            if (!rightEdge) return false;
            e.preventDefault();
            this._setCursorToEdge(rightEdge, true);
            return true;
        }

        if (key === 'a') {
            if (edge.dataset.tableEdge !== 'right') return false;
            const leftEdge = wrapper.querySelector('.md-table-edge-left');
            if (!leftEdge) return false;
            e.preventDefault();
            this._setCursorToEdge(leftEdge, false);
            return true;
        }

        return false;
    }

    handleDeleteTableKeydown(e) {
        if (!this._isMac) return false;
        if (!e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return false;
        if (e.key.toLowerCase() !== 'k') return false;

        const edge = this._getEdgeFromSelection();
        if (!edge || edge.dataset.tableEdge !== 'left') return false;

        e.preventDefault();
        this.stateManager.saveState();
        this._deleteTableFromEdge(edge);
        if (this.notifyChange) this.notifyChange();
        return true;
    }

    isSelectionInTableContext() {
        if (this.hasStructureSelection()) return true;
        if (this.hasCellSelection()) return true;
        const selection = window.getSelection();
        if (!selection || !selection.rangeCount) return false;
        const range = selection.getRangeAt(0);
        const cell = this._getCellFromTarget(range.startContainer);
        if (cell) return true;
        const edge = this._getEdgeFromRange(range);
        return !!edge;
    }

    isSelectionOnTableEdge() {
        return !!this._getEdgeFromSelection();
    }

    handleEdgeTextInputKeydown(e) {
        if (!this.isSelectionOnTableEdge()) return false;
        if (e.metaKey || e.ctrlKey || e.altKey) return false;
        const isPrintable = typeof e.key === 'string' && e.key.length === 1;
        if (!isPrintable) return false;
        e.preventDefault();
        return true;
    }

    handleEdgeBeforeInput(e) {
        if (!this.isSelectionOnTableEdge()) return false;
        const inputType = typeof e.inputType === 'string' ? e.inputType : '';
        const blockedTypes = [
            'insertText',
            'insertCompositionText',
            'insertFromPaste',
            'insertFromDrop',
            'insertReplacementText',
            'insertParagraph',
            'insertLineBreak',
        ];
        if (!blockedTypes.includes(inputType)) return false;
        e.preventDefault();
        return true;
    }

    handleEdgePaste(e) {
        if (!this.isSelectionOnTableEdge()) return false;
        e.preventDefault();
        return true;
    }

    handleEdgeCompositionStart() {
        const edge = this._getEdgeFromSelection();
        if (!edge) return false;
        this._compositionBlockedEdge = edge;
        return true;
    }

    handleEdgeCompositionEnd() {
        const edge = this._compositionBlockedEdge;
        if (!edge) return false;
        this._compositionBlockedEdge = null;
        edge.textContent = '\u00A0';
        this._setCursorToEdge(edge, false);
        return true;
    }

    _getActiveCellInfo() {
        const selection = window.getSelection();
        if (selection && selection.rangeCount) {
            const range = selection.getRangeAt(0);
            const cell = this._getCellFromTarget(range.startContainer);
            if (cell) return this._getCellInfo(cell);
        }

        const structureSelection = this._normalizeStructureSelection();
        if (structureSelection) {
            const { table, type, index } = structureSelection;
            if (type === 'row') {
                const row = table.rows[index];
                const cell = row ? (row.cells[0] || row.cells[row.cells.length - 1]) : null;
                return cell ? this._getCellInfo(cell) : null;
            }
            const row = table.rows[0] || table.rows[table.rows.length - 1];
            const cell = row ? (row.cells[index] || row.cells[row.cells.length - 1]) : null;
            return cell ? this._getCellInfo(cell) : null;
        }

        if (this.hasCellSelection()) {
            const cell = this.focusCell || this._getTopLeftSelectedCell();
            return cell ? this._getCellInfo(cell) : null;
        }

        return null;
    }

    handleTabKeydown(e) {
        if (e.key !== 'Tab' || e.isComposing) return false;

        const direction = e.shiftKey ? 'prev' : 'next';
        const handled = this._handleTableNavigation(direction);
        if (handled) {
            e.preventDefault();
            return true;
        }
        return false;
    }

    handleArrowKeydown(e) {
        if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return false;

        let direction = null;
        if (e.key === 'ArrowLeft') direction = 'left';
        if (e.key === 'ArrowRight') direction = 'right';
        if (e.key === 'ArrowUp') direction = 'up';
        if (e.key === 'ArrowDown') direction = 'down';

        if (!direction) return false;

        const handled = this._handleTableNavigation(direction);
        if (handled) {
            e.preventDefault();
            return true;
        }
        return false;
    }

    handleCtrlNavKeydown(e) {
        if (!this._isMac) return false;
        if (!e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return false;

        let direction = null;
        const key = e.key.toLowerCase();
        if (key === 'f') direction = 'right';
        if (key === 'b') direction = 'left';
        if (key === 'n') direction = 'down';
        if (key === 'p') direction = 'up';

        if (!direction) return false;

        if (direction === 'up' && e.repeat) {
            const edge = this._getEdgeFromSelection();
            if (edge && edge.dataset.tableEdge === 'left') {
                const elapsed = Date.now() - (this._lastEdgeNavTs || 0);
                if (elapsed < 300) {
                    e.preventDefault();
                    return true;
                }
            }
        }

        const handled = this._handleTableNavigation(direction);
        if (handled) {
            e.preventDefault();
            return true;
        }
        return false;
    }

    handleBackspaceKeydown(e) {
        if (e.metaKey || e.altKey) return false;
        const key = e.key.toLowerCase();
        const isBackspace = e.key === 'Backspace' || e.key === 'Delete' || (this._isMac && e.ctrlKey && key === 'h');
        if (!isBackspace) return false;

        const structureSelection = this._normalizeStructureSelection();
        if (structureSelection) {
            e.preventDefault();
            this.stateManager.saveState();
            const { table, type, index } = structureSelection;
            let handled = false;
            if (type === 'row') {
                handled = this._deleteRowAt(table, index, 0);
            } else {
                handled = this._deleteColumnAt(table, index, 0);
            }
            if (!handled) return false;

            if (table.isConnected) {
                const nextMaxIndex = type === 'row'
                    ? table.rows.length - 1
                    : this._getColumnCount(table) - 1;
                if (nextMaxIndex >= 0) {
                    this._setStructureSelection(type, table, Math.min(index, nextMaxIndex));
                } else {
                    this.clearStructureSelection();
                }
            } else {
                this.clearStructureSelection();
            }

            if (this.notifyChange) this.notifyChange();
            return true;
        }

        const domSelected = this._getDomSelectedCells();
        const cellsToClear = domSelected.length ? domSelected : this.selectedCells;
        if (domSelected.length) {
            this.selectedCells = domSelected;
            this.selectionRange = null;
        }

        if (cellsToClear && cellsToClear.length) {
            e.preventDefault();
            this.stateManager.saveState();
            cellsToClear.forEach(cell => this._clearCellContent(cell));
            this.clearCellSelection();
            if (this.notifyChange) this.notifyChange();
            return true;
        }

        const selection = window.getSelection();
        if (selection && selection.rangeCount) {
            const range = selection.getRangeAt(0);
            if (!range.collapsed) {
                const startCell = this._getCellFromTarget(range.startContainer);
                const endCell = this._getCellFromTarget(range.endContainer);
                if (startCell && endCell && startCell !== endCell) {
                    const startInfo = this._getCellInfo(startCell);
                    const endInfo = this._getCellInfo(endCell);
                    if (startInfo && endInfo && startInfo.table === endInfo.table) {
                        e.preventDefault();
                        this.stateManager.saveState();
                        this.selectCellRange(startCell, endCell);
                        this.selectedCells.forEach(cell => this._clearCellContent(cell));
                        this.clearCellSelection();
                        if (this.notifyChange) this.notifyChange();
                        return true;
                    }
                }
            }
        }

        const edge = this._getEdgeFromSelection();
        if (edge && edge.dataset.tableEdge === 'right') {
            e.preventDefault();
            this.stateManager.saveState();
            this._deleteTableFromEdge(edge);
            if (this.notifyChange) this.notifyChange();
            return true;
        }

        return false;
    }

    _getDomSelectedCells() {
        return Array.from(this.editor.querySelectorAll('.md-table-cell-selected'));
    }

    handlePaste(e) {
        const selection = window.getSelection();
        if (!selection || !selection.rangeCount) return false;

        const range = selection.getRangeAt(0);
        const cell = this._getCellFromTarget(range.startContainer);
        const hasSelection = this.hasCellSelection();

        if (!cell && !hasSelection) return false;

        const text = e.clipboardData ? e.clipboardData.getData('text/plain') : '';
        let matrix = null;
        if (text) {
            matrix = this._parseClipboard(text);
        } else if (this.clipboardMatrix) {
            matrix = this.clipboardMatrix;
        }

        if (!matrix || matrix.length === 0) return false;

        e.preventDefault();
        this.stateManager.saveState();

        const startCell = hasSelection ? this._getTopLeftSelectedCell() : cell;
        if (!startCell) return false;

        this._applyMatrix(startCell, matrix);
        this.clearCellSelection();

        if (this.notifyChange) this.notifyChange();
        return true;
    }

    hasCellSelection() {
        if (this.selectedCells && this.selectedCells.length > 0) return true;
        const domSelected = this._getDomSelectedCells();
        if (!domSelected.length) return false;
        this.selectedCells = domSelected;
        this.selectionRange = null;
        return true;
    }

    hasStructureSelection() {
        return !!this._normalizeStructureSelection();
    }

    hasActiveTableSelection() {
        return this.hasCellSelection() || this.hasStructureSelection();
    }

    clearCellSelection() {
        const domSelected = this._getDomSelectedCells();
        if (domSelected.length) {
            domSelected.forEach(cell => cell.classList.remove('md-table-cell-selected'));
        }
        if (this.selectedCells && this.selectedCells.length) {
            this.selectedCells.forEach(cell => cell.classList.remove('md-table-cell-selected'));
        }
        this.selectedCells = [];
        this.selectionRange = null;
        this._syncSelectionHandleContextFromSelection();
    }

    clearStructureSelection() {
        this.structureDrag = null;
        document.body.classList.remove('md-table-structure-dragging');
        this.structureSelection = null;
        this._clearStructureSelectionVisuals();
        this._syncHandleVisibility();
    }

    selectCellRange(startCell, endCell) {
        if (!startCell || !endCell) return;

        const startInfo = this._getCellInfo(startCell);
        const endInfo = this._getCellInfo(endCell);
        if (!startInfo || !endInfo || startInfo.table !== endInfo.table) return;

        const table = startInfo.table;
        const minRow = Math.min(startInfo.rowIndex, endInfo.rowIndex);
        const maxRow = Math.max(startInfo.rowIndex, endInfo.rowIndex);
        const minCol = Math.min(startInfo.colIndex, endInfo.colIndex);
        const maxCol = Math.max(startInfo.colIndex, endInfo.colIndex);

        this.clearCellSelection();
        this.clearStructureSelection();

        const cells = [];
        for (let r = minRow; r <= maxRow; r++) {
            const row = table.rows[r];
            if (!row) continue;
            for (let c = minCol; c <= maxCol; c++) {
                const cell = row.cells[c];
                if (cell) {
                    cell.classList.add('md-table-cell-selected');
                    cells.push(cell);
                }
            }
        }

        this.selectedCells = cells;
        this.selectionRange = { table, minRow, maxRow, minCol, maxCol };
    }

    updateEdgeActive() {
        const edges = this.editor.querySelectorAll('.md-table-edge.active');
        edges.forEach(edge => edge.classList.remove('active'));

        const edge = this._getEdgeFromSelection();
        if (edge) {
            edge.classList.add('active');
        }

        this._syncSelectionHandleContextFromSelection();
        this._syncStructureSelectionUI();
    }

    _createInsertLines() {
        const vLine = document.createElement('div');
        vLine.className = 'md-table-insert-line vertical';
        vLine.setAttribute('data-exclude-from-markdown', 'true');
        vLine.setAttribute('contenteditable', 'false');
        vLine.setAttribute('aria-hidden', 'true');
        vLine.style.display = 'none';

        const hLine = document.createElement('div');
        hLine.className = 'md-table-insert-line horizontal';
        hLine.setAttribute('data-exclude-from-markdown', 'true');
        hLine.setAttribute('contenteditable', 'false');
        hLine.setAttribute('aria-hidden', 'true');
        hLine.style.display = 'none';

        this.editor.appendChild(vLine);
        this.editor.appendChild(hLine);
        this.insertLineVertical = vLine;
        this.insertLineHorizontal = hLine;
    }

    ensureInsertLines() {
        const hasVertical = this.insertLineVertical && this.editor.contains(this.insertLineVertical);
        const hasHorizontal = this.insertLineHorizontal && this.editor.contains(this.insertLineHorizontal);
        const allLines = Array.from(this.editor.querySelectorAll('.md-table-insert-line'));
        const hasUnexpectedLine = allLines.some(line =>
            line !== this.insertLineVertical && line !== this.insertLineHorizontal
        );
        if (hasVertical && hasHorizontal && !hasUnexpectedLine) return;

        allLines.forEach(line => line.remove());
        this.insertLineVertical = null;
        this.insertLineHorizontal = null;
        this._createInsertLines();
    }

    _handleDragMove(e) {
        if (this.structureDrag) {
            this._handleStructureDragMove(e);
            return;
        }
        if (!this.isMouseDown) return;
        const cell = this._getCellFromPoint(e.clientX, e.clientY);
        if (!cell) return;

        if (cell !== this.focusCell) {
            this.isDragging = true;
            this.focusCell = cell;
            this.selectCellRange(this.anchorCell, cell);
            const selection = window.getSelection();
            if (selection) selection.removeAllRanges();
        }
    }

    _handleMouseUp() {
        if (this.structureDrag) {
            this._handleStructureDragMouseUp();
            return;
        }

        const wasDragging = this.isDragging;
        if (this.isMouseDown) {
            this.isMouseDown = false;
            this.isDragging = false;
        }
        if (this.hasCellSelection()) {
            const selectedCells = this.selectedCells && this.selectedCells.length
                ? this.selectedCells
                : this._getDomSelectedCells();
            const selectedCount = selectedCells.length;

            if (wasDragging && selectedCount > 1) {
                const focusCell = this.focusCell || this._getTopLeftSelectedCell();
                if (focusCell) {
                    this._setCursorToCellStart(focusCell);
                }
            } else if (selectedCount === 1) {
                const targetCell = selectedCells[0] || this.focusCell || this.anchorCell;
                const selection = window.getSelection();
                const hasRangeSelectionInTargetCell = !!(
                    selection &&
                    selection.rangeCount &&
                    !selection.isCollapsed &&
                    targetCell &&
                    targetCell.contains(selection.getRangeAt(0).startContainer) &&
                    targetCell.contains(selection.getRangeAt(0).endContainer)
                );
                const hasCaretInTargetCell =
                    !!(selection && selection.rangeCount && selection.isCollapsed &&
                        targetCell && targetCell.contains(selection.getRangeAt(0).startContainer));
                if (hasRangeSelectionInTargetCell) {
                    // Prefer native text-range selection inside a cell over table-cell selection mode.
                    this.clearCellSelection();
                } else if (targetCell && !hasCaretInTargetCell) {
                    // Fallback only when browser did not keep the click position.
                    this._setCursorToCellStart(targetCell);
                }
            }
            setTimeout(() => this.editor.focus(), 0);
        }
    }

    _handleGlobalHoverCleanup(e) {
        if (this.structureDrag) return;
        if (!this.hoverInsert && !this._isInsertLineVisible()) return;
        const targetEl = e.target && e.target.nodeType === Node.ELEMENT_NODE ? e.target : e.target?.parentElement;
        if (targetEl && this.editor.contains(targetEl)) return;
        this.hoverHandleContext = null;
        this._syncHandleVisibility();
        this._clearInsertHover();
    }

    _isInsertLineVisible() {
        const verticalVisible = !!(this.insertLineVertical && this.insertLineVertical.style.display !== 'none');
        const horizontalVisible = !!(this.insertLineHorizontal && this.insertLineHorizontal.style.display !== 'none');
        return verticalVisible || horizontalVisible;
    }

    _refreshInsertHoverFromPoint(clientX, clientY) {
        if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) {
            this._clearInsertHover();
            return;
        }

        const target = document.elementFromPoint(clientX, clientY);
        if (!target || !this.editor.contains(target)) {
            this._clearInsertHover();
            return;
        }

        this._handleHoverMove({ clientX, clientY, target });
    }

    _handleHoverMove(e) {
        if (this.isMouseDown || this.structureDrag) return;
        if (!this.insertLineVertical || !this.insertLineHorizontal ||
            !this.editor.contains(this.insertLineVertical) ||
            !this.editor.contains(this.insertLineHorizontal)) {
            this.ensureInsertLines();
        }

        const structureHandleInfo = this._getStructureHandleInfoFromTarget(e.target);
        if (structureHandleInfo) {
            this.hoverHandleContext = {
                table: structureHandleInfo.table,
                rowIndex: structureHandleInfo.type === 'row' ? structureHandleInfo.index : 0,
                colIndex: structureHandleInfo.type === 'col' ? structureHandleInfo.index : 0,
            };
            this._syncHandleVisibility();
            this._clearInsertHover();
            return;
        }

        let cell = this._getCellFromTarget(e.target);
        if (!cell) {
            const targetEl = e.target && e.target.nodeType === Node.ELEMENT_NODE ? e.target : e.target?.parentElement;
            const tableFromTarget = targetEl ? targetEl.closest('table') : null;
            if (tableFromTarget) {
                cell = this._getCellFromTableAtPoint(tableFromTarget, e.clientX, e.clientY);
            }
        }
        if (!cell) {
            this.hoverHandleContext = null;
            this._syncHandleVisibility();
            this._clearInsertHover();
            return;
        }

        const cellInfoForHandle = this._getCellInfo(cell);
        if (cellInfoForHandle) {
            this.hoverHandleContext = {
                table: cellInfoForHandle.table,
                rowIndex: cellInfoForHandle.rowIndex,
                colIndex: cellInfoForHandle.colIndex,
            };
            this._syncHandleVisibility();
        }

        const rect = cell.getBoundingClientRect();
        const table = cell.closest('table');
        if (!table) return;

        const threshold = 6;
        const distLeft = Math.abs(e.clientX - rect.left);
        const distRight = Math.abs(rect.right - e.clientX);
        const distTop = Math.abs(e.clientY - rect.top);
        const distBottom = Math.abs(rect.bottom - e.clientY);

        const minDist = Math.min(distLeft, distRight, distTop, distBottom);
        if (minDist > threshold) {
            this._clearInsertHover();
            return;
        }

        if (minDist === distLeft || minDist === distRight) {
            const insertIndex = cell.cellIndex + (minDist === distRight ? 1 : 0);
            this._showVerticalInsertLine(table, minDist === distRight ? rect.right : rect.left);
            this.hoverInsert = { table, type: 'col', index: insertIndex };
            this.insertLineHorizontal.style.display = 'none';
        } else {
            const rowIndex = cell.parentElement.rowIndex + (minDist === distBottom ? 1 : 0);
            this._showHorizontalInsertLine(table, minDist === distBottom ? rect.bottom : rect.top);
            this.hoverInsert = { table, type: 'row', index: rowIndex };
            this.insertLineVertical.style.display = 'none';
        }
    }

    _getCellFromTableAtPoint(table, x, y) {
        if (!table) return null;
        const rows = Array.from(table.rows);
        for (const row of rows) {
            const cells = Array.from(row.cells);
            for (const cell of cells) {
                const rect = cell.getBoundingClientRect();
                if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
                    return cell;
                }
            }
        }
        return null;
    }

    _showVerticalInsertLine(table, x) {
        const bounds = this._getInsertLineBounds(table);
        const left = x - bounds.editorRect.left + this.editor.scrollLeft;
        this.insertLineVertical.style.display = 'block';
        this.insertLineVertical.style.left = `${left}px`;
        this.insertLineVertical.style.top = `${bounds.top}px`;
        this.insertLineVertical.style.height = `${bounds.height}px`;
    }

    _showHorizontalInsertLine(table, y) {
        const bounds = this._getInsertLineBounds(table);
        const top = y - bounds.editorRect.top + this.editor.scrollTop;
        this.insertLineHorizontal.style.display = 'block';
        this.insertLineHorizontal.style.left = `${bounds.left}px`;
        this.insertLineHorizontal.style.top = `${top}px`;
        this.insertLineHorizontal.style.width = `${bounds.width}px`;
    }

    _clearInsertHover() {
        this.hoverInsert = null;
        if (this.insertLineVertical) this.insertLineVertical.style.display = 'none';
        if (this.insertLineHorizontal) this.insertLineHorizontal.style.display = 'none';
        if (this.insertLineVertical) this.insertLineVertical.classList.remove('reorder');
        if (this.insertLineHorizontal) this.insertLineHorizontal.classList.remove('reorder');
    }

    _getStructureHandleInfoFromTarget(target) {
        if (!target) return null;
        const element = target.nodeType === Node.ELEMENT_NODE ? target : target.parentElement;
        if (!element) return null;

        const rowHandle = element.closest('.md-table-row-handle');
        if (rowHandle) {
            const cell = rowHandle.closest('td, th');
            const table = cell ? cell.closest('table') : null;
            const row = cell ? cell.parentElement : null;
            if (table && row) {
                return { type: 'row', table, index: row.rowIndex, handle: rowHandle };
            }
        }

        const colHandle = element.closest('.md-table-col-handle');
        if (colHandle) {
            const cell = colHandle.closest('td, th');
            const table = cell ? cell.closest('table') : null;
            if (table && cell) {
                return { type: 'col', table, index: cell.cellIndex, handle: colHandle };
            }
        }

        return null;
    }

    _normalizeStructureSelection() {
        if (!this.structureSelection) return null;
        const { type, table } = this.structureSelection;
        const index = Number.isFinite(this.structureSelection.index) ? this.structureSelection.index : 0;
        if (!table || !table.isConnected || (type !== 'row' && type !== 'col')) {
            this.structureSelection = null;
            this._clearStructureSelectionVisuals();
            return null;
        }

        const maxIndex = type === 'row' ? table.rows.length : this._getColumnCount(table);
        if (maxIndex <= 0) {
            this.structureSelection = null;
            this._clearStructureSelectionVisuals();
            return null;
        }

        const normalizedIndex = Math.max(0, Math.min(index, maxIndex - 1));
        if (normalizedIndex !== index) {
            this.structureSelection.index = normalizedIndex;
        }
        return { type, table, index: normalizedIndex };
    }

    _normalizeHandleContext(context) {
        if (!context) return null;
        const table = context.table;
        if (!table || !table.isConnected || !table.rows.length) return null;
        const maxRow = table.rows.length - 1;
        const maxCol = this._getColumnCount(table) - 1;
        if (maxRow < 0 || maxCol < 0) return null;
        const rowIndex = Math.max(0, Math.min(context.rowIndex || 0, maxRow));
        const colIndex = Math.max(0, Math.min(context.colIndex || 0, maxCol));
        return { table, rowIndex, colIndex };
    }

    _syncSelectionHandleContextFromSelection() {
        const selection = window.getSelection();
        let context = null;

        if (selection && selection.rangeCount) {
            const range = selection.getRangeAt(0);
            const cell = this._getCellFromTarget(range.startContainer);
            if (cell) {
                const info = this._getCellInfo(cell);
                if (info) {
                    context = {
                        table: info.table,
                        rowIndex: info.rowIndex,
                        colIndex: info.colIndex,
                    };
                }
            }
        }

        if (!context && this.hasCellSelection()) {
            const fallbackCell = this.focusCell || this._getTopLeftSelectedCell();
            if (fallbackCell) {
                const info = this._getCellInfo(fallbackCell);
                if (info) {
                    context = {
                        table: info.table,
                        rowIndex: info.rowIndex,
                        colIndex: info.colIndex,
                    };
                }
            }
        }

        this.selectionHandleContext = this._normalizeHandleContext(context);
        this._syncHandleVisibility();
    }

    _syncHandleVisibility() {
        const visibleHandles = this.editor.querySelectorAll('.md-table-structure-handle.visible');
        visibleHandles.forEach(handle => handle.classList.remove('visible'));

        if (this.hasStructureSelection()) return;

        // Show handles only while mouse is currently over a table area.
        const context = this._normalizeHandleContext(this.hoverHandleContext);
        if (!context) return;

        const row = context.table.rows[context.rowIndex];
        const rowHandleCell = row ? row.cells[0] : null;
        const rowHandle = rowHandleCell ? rowHandleCell.querySelector(':scope > .md-table-row-handle') : null;
        if (rowHandle) rowHandle.classList.add('visible');

        const topRow = context.table.rows[0];
        const colHandleCell = topRow ? topRow.cells[context.colIndex] : null;
        const colHandle = colHandleCell ? colHandleCell.querySelector(':scope > .md-table-col-handle') : null;
        if (colHandle) colHandle.classList.add('visible');
    }

    _setStructureSelection(type, table, index) {
        if (!table || !table.isConnected || (type !== 'row' && type !== 'col')) return;
        this.clearCellSelection();
        const activeEdges = this.editor.querySelectorAll('.md-table-edge.active');
        activeEdges.forEach(edge => edge.classList.remove('active'));
        this.structureSelection = { type, table, index };
        this._syncStructureSelectionUI();
    }

    _syncStructureSelectionUI() {
        this._clearStructureSelectionVisuals();

        const selection = this._normalizeStructureSelection();
        if (!selection) {
            this._syncHandleVisibility();
            return;
        }

        const cells = this._collectStructureCells(selection.table, selection.type, selection.index);
        if (!cells.length) {
            this.structureSelection = null;
            this._syncHandleVisibility();
            return;
        }

        cells.forEach(cell => cell.classList.add('md-table-structure-selected-cell'));

        if (selection.type === 'row') {
            const row = selection.table.rows[selection.index];
            const handleCell = row ? row.cells[0] : null;
            const handle = handleCell ? handleCell.querySelector(':scope > .md-table-row-handle') : null;
            if (handle) handle.classList.add('active');
        } else {
            const topRow = selection.table.rows[0];
            const handleCell = topRow ? topRow.cells[selection.index] : null;
            const handle = handleCell ? handleCell.querySelector(':scope > .md-table-col-handle') : null;
            if (handle) handle.classList.add('active');
        }

        const wrapper = selection.table.closest('.md-table-wrapper');
        if (!wrapper) {
            this._syncHandleVisibility();
            return;
        }
        const outline = this._ensureStructureOutline(wrapper);
        const bounds = this._getStructureBounds(cells);
        if (!outline || !bounds) {
            this._syncHandleVisibility();
            return;
        }

        const wrapperRect = wrapper.getBoundingClientRect();
        outline.style.left = `${bounds.left - wrapperRect.left}px`;
        outline.style.top = `${bounds.top - wrapperRect.top}px`;
        outline.style.width = `${bounds.width}px`;
        outline.style.height = `${bounds.height}px`;
        outline.classList.add('active');
        this._syncHandleVisibility();
    }

    _clearStructureSelectionVisuals() {
        const selectedCells = this.editor.querySelectorAll('.md-table-structure-selected-cell');
        selectedCells.forEach(cell => cell.classList.remove('md-table-structure-selected-cell'));

        const activeHandles = this.editor.querySelectorAll('.md-table-structure-handle.active');
        activeHandles.forEach(handle => handle.classList.remove('active'));

        const activeOutlines = this.editor.querySelectorAll('.md-table-structure-outline.active');
        activeOutlines.forEach(outline => {
            outline.classList.remove('active');
            outline.style.left = '';
            outline.style.top = '';
            outline.style.width = '';
            outline.style.height = '';
        });
    }

    _collectStructureCells(table, type, index) {
        if (!table) return [];
        if (type === 'row') {
            const row = table.rows[index];
            return row ? Array.from(row.cells) : [];
        }

        const cells = [];
        const rows = Array.from(table.rows);
        rows.forEach(row => {
            const cell = row.cells[index];
            if (cell) cells.push(cell);
        });
        return cells;
    }

    _getStructureAnchorCell(selection) {
        if (!selection) return null;
        const { table, type, index } = selection;
        if (!table) return null;
        if (type === 'row') {
            const row = table.rows[index];
            return row ? (row.cells[0] || row.cells[row.cells.length - 1] || null) : null;
        }
        const topRow = table.rows[0];
        if (!topRow) return null;
        return topRow.cells[index] || topRow.cells[topRow.cells.length - 1] || null;
    }

    _getStructureBounds(cells) {
        if (!cells || !cells.length) return null;
        let left = Number.POSITIVE_INFINITY;
        let top = Number.POSITIVE_INFINITY;
        let right = Number.NEGATIVE_INFINITY;
        let bottom = Number.NEGATIVE_INFINITY;

        cells.forEach(cell => {
            const rect = cell.getBoundingClientRect();
            left = Math.min(left, rect.left);
            top = Math.min(top, rect.top);
            right = Math.max(right, rect.right);
            bottom = Math.max(bottom, rect.bottom);
        });

        if (!Number.isFinite(left) || !Number.isFinite(top) || !Number.isFinite(right) || !Number.isFinite(bottom)) {
            return null;
        }

        return {
            left,
            top,
            width: Math.max(0, right - left),
            height: Math.max(0, bottom - top),
        };
    }

    _ensureStructureOutline(wrapper) {
        if (!wrapper) return null;
        let outline = wrapper.querySelector(':scope > .md-table-structure-outline');
        if (outline) return outline;

        outline = document.createElement('div');
        outline.className = 'md-table-structure-outline';
        outline.setAttribute('data-exclude-from-markdown', 'true');
        outline.setAttribute('contenteditable', 'false');
        outline.setAttribute('aria-hidden', 'true');
        wrapper.appendChild(outline);
        return outline;
    }

    _startStructureDrag(structureHandleInfo, e) {
        const { type, table, index } = structureHandleInfo;
        this.isMouseDown = false;
        this.isDragging = false;
        this.anchorCell = null;
        this.focusCell = null;
        this.structureDrag = {
            type,
            table,
            sourceIndex: index,
            insertIndex: type === 'row' ? index + 1 : index + 1,
            startX: e.clientX,
            startY: e.clientY,
            isDragging: false,
        };
    }

    _handleStructureDragMove(e) {
        const drag = this.structureDrag;
        if (!drag) return;
        if (!drag.table || !drag.table.isConnected) {
            this._handleStructureDragMouseUp();
            return;
        }

        const dx = e.clientX - drag.startX;
        const dy = e.clientY - drag.startY;
        const distance = Math.hypot(dx, dy);
        if (!drag.isDragging && distance < 4) return;

        if (!drag.isDragging) {
            drag.isDragging = true;
            const selection = window.getSelection();
            if (selection) selection.removeAllRanges();
            document.body.classList.add('md-table-structure-dragging');
        }

        e.preventDefault();
        this.ensureInsertLines();
        this._clearInsertHover();

        if (drag.type === 'row') {
            const insertIndex = this._getRowDropInsertIndex(drag.table, e.clientY);
            drag.insertIndex = insertIndex;
            const y = this._getRowBoundaryY(drag.table, insertIndex);
            if (y !== null) {
                this._showHorizontalInsertLine(drag.table, y);
                if (this.insertLineHorizontal) this.insertLineHorizontal.classList.add('reorder');
            }
            if (this.insertLineVertical) this.insertLineVertical.style.display = 'none';
        } else {
            const insertIndex = this._getColumnDropInsertIndex(drag.table, e.clientX);
            drag.insertIndex = insertIndex;
            const x = this._getColumnBoundaryX(drag.table, insertIndex);
            if (x !== null) {
                this._showVerticalInsertLine(drag.table, x);
                if (this.insertLineVertical) this.insertLineVertical.classList.add('reorder');
            }
            if (this.insertLineHorizontal) this.insertLineHorizontal.style.display = 'none';
        }
    }

    _handleStructureDragMouseUp() {
        const drag = this.structureDrag;
        this.structureDrag = null;
        if (!drag) return;

        document.body.classList.remove('md-table-structure-dragging');
        this._clearInsertHover();

        if (!drag.table || !drag.table.isConnected) {
            this.clearStructureSelection();
            return;
        }

        if (!drag.isDragging) {
            this._setStructureSelection(drag.type, drag.table, drag.sourceIndex);
            setTimeout(() => this.editor.focus(), 0);
            return;
        }

        let moved = false;

        if (drag.type === 'row') {
            const rowCount = drag.table.rows.length;
            const insertIndex = Math.max(0, Math.min(drag.insertIndex, rowCount));
            const targetIndex = insertIndex > drag.sourceIndex ? insertIndex - 1 : insertIndex;
            if (targetIndex !== drag.sourceIndex) {
                this.stateManager.saveState();
                const result = this._reorderRows(drag.table, drag.sourceIndex, insertIndex);
                moved = result !== null && result !== drag.sourceIndex;
            }
        } else {
            const colCount = this._getColumnCount(drag.table);
            const insertIndex = Math.max(0, Math.min(drag.insertIndex, colCount));
            const targetIndex = insertIndex > drag.sourceIndex ? insertIndex - 1 : insertIndex;
            if (targetIndex !== drag.sourceIndex) {
                this.stateManager.saveState();
                const result = this._reorderColumns(drag.table, drag.sourceIndex, insertIndex);
                moved = result !== null && result !== drag.sourceIndex;
            }
        }

        this._ensureStructureHandles(drag.table);
        // Keep click-to-select behavior, but clear highlight after any drag-drop interaction.
        this.clearStructureSelection();
        if (moved && this.notifyChange) this.notifyChange();
        setTimeout(() => this.editor.focus(), 0);
    }

    _getRowDropInsertIndex(table, y) {
        if (!table || !table.rows.length) return 0;
        let insertIndex = 0;
        const rows = Array.from(table.rows);
        for (let i = 0; i < rows.length; i++) {
            const rect = rows[i].getBoundingClientRect();
            const center = rect.top + rect.height / 2;
            if (y >= center) {
                insertIndex = i + 1;
            }
        }
        return Math.max(0, Math.min(insertIndex, rows.length));
    }

    _getColumnDropInsertIndex(table, x) {
        const topRow = table && table.rows.length ? table.rows[0] : null;
        if (!topRow || !topRow.cells.length) return 0;
        let insertIndex = 0;
        const cells = Array.from(topRow.cells);
        for (let i = 0; i < cells.length; i++) {
            const rect = cells[i].getBoundingClientRect();
            const center = rect.left + rect.width / 2;
            if (x >= center) {
                insertIndex = i + 1;
            }
        }
        return Math.max(0, Math.min(insertIndex, cells.length));
    }

    _getRowBoundaryY(table, insertIndex) {
        const rows = table ? Array.from(table.rows) : [];
        if (!rows.length) return null;
        if (insertIndex <= 0) return rows[0].getBoundingClientRect().top;
        if (insertIndex >= rows.length) return rows[rows.length - 1].getBoundingClientRect().bottom;
        return rows[insertIndex].getBoundingClientRect().top;
    }

    _getColumnBoundaryX(table, insertIndex) {
        const topRow = table && table.rows.length ? table.rows[0] : null;
        const cells = topRow ? Array.from(topRow.cells) : [];
        if (!cells.length) return null;
        if (insertIndex <= 0) return cells[0].getBoundingClientRect().left;
        if (insertIndex >= cells.length) return cells[cells.length - 1].getBoundingClientRect().right;
        return cells[insertIndex].getBoundingClientRect().left;
    }

    _reorderRows(table, sourceIndex, insertIndex) {
        if (!table || !table.rows.length) return null;
        const totalRows = table.rows.length;
        if (sourceIndex < 0 || sourceIndex >= totalRows) return null;

        const normalizedInsert = Math.max(0, Math.min(insertIndex, totalRows));
        let targetIndex = normalizedInsert > sourceIndex ? normalizedInsert - 1 : normalizedInsert;
        targetIndex = Math.max(0, Math.min(targetIndex, totalRows - 1));
        if (targetIndex === sourceIndex) return sourceIndex;

        const movingRow = table.rows[sourceIndex];
        if (!movingRow) return null;
        const sourceSection = movingRow.parentElement;
        movingRow.remove();
        if (sourceSection && (sourceSection.tagName === 'THEAD' || sourceSection.tagName === 'TBODY') && sourceSection.rows.length === 0) {
            sourceSection.remove();
        }

        const rowsAfterRemoval = Array.from(table.rows);
        if (targetIndex >= rowsAfterRemoval.length) {
            const tailRow = rowsAfterRemoval[rowsAfterRemoval.length - 1];
            const section = tailRow ? tailRow.parentElement : (table.tBodies[table.tBodies.length - 1] || table.tHead || table);
            section.appendChild(movingRow);
            this._normalizeTableSections(table);
            return rowsAfterRemoval.length;
        }

        const referenceRow = rowsAfterRemoval[targetIndex];
        if (!referenceRow || !referenceRow.parentElement) return null;
        referenceRow.parentElement.insertBefore(movingRow, referenceRow);
        this._normalizeTableSections(table);
        return targetIndex;
    }

    _reorderColumns(table, sourceIndex, insertIndex) {
        const totalCols = this._getColumnCount(table);
        if (!table || !table.rows.length || totalCols <= 0) return null;
        if (sourceIndex < 0 || sourceIndex >= totalCols) return null;

        const normalizedInsert = Math.max(0, Math.min(insertIndex, totalCols));
        let targetIndex = normalizedInsert > sourceIndex ? normalizedInsert - 1 : normalizedInsert;
        targetIndex = Math.max(0, Math.min(targetIndex, totalCols - 1));
        if (targetIndex === sourceIndex) return sourceIndex;

        const rows = Array.from(table.rows);
        rows.forEach(row => {
            const movingCell = row.cells[sourceIndex];
            if (!movingCell) return;
            movingCell.remove();
            if (targetIndex >= row.cells.length) {
                row.appendChild(movingCell);
                return;
            }
            row.insertBefore(movingCell, row.cells[targetIndex]);
        });

        return targetIndex;
    }

    _getColumnCount(table) {
        if (!table || !table.rows.length) return 0;
        let max = 0;
        const rows = Array.from(table.rows);
        rows.forEach(row => {
            max = Math.max(max, row.cells.length);
        });
        return max;
    }

    _normalizeTableSections(table) {
        if (!table || !table.rows.length) return;

        const rows = Array.from(table.rows);
        if (!rows.length) return;

        const thead = table.tHead || document.createElement('thead');
        const tbody = table.tBodies[0] || document.createElement('tbody');

        if (!table.tHead) {
            table.insertBefore(thead, table.firstChild);
        }
        if (!table.contains(tbody)) {
            table.appendChild(tbody);
        }

        Array.from(table.tBodies).forEach(section => {
            if (section !== tbody) section.remove();
        });

        while (thead.firstChild) {
            thead.removeChild(thead.firstChild);
        }
        while (tbody.firstChild) {
            tbody.removeChild(tbody.firstChild);
        }

        rows.forEach((row, rowIndex) => {
            const targetTag = rowIndex === 0 ? 'TH' : 'TD';
            this._normalizeRowCellTag(row, targetTag);
            if (rowIndex === 0) {
                thead.appendChild(row);
            } else {
                tbody.appendChild(row);
            }
        });
    }

    _normalizeRowCellTag(row, tagName) {
        const cells = Array.from(row.cells);
        cells.forEach(cell => {
            let targetCell = cell;
            if (cell.tagName !== tagName) {
                const replacement = document.createElement(tagName);
                replacement.contentEditable = 'true';
                while (cell.firstChild) {
                    replacement.appendChild(cell.firstChild);
                }
                cell.replaceWith(replacement);
                targetCell = replacement;
            }
            targetCell.contentEditable = 'true';
            this._ensureCellNotEmpty(targetCell);
        });
    }

    _handleCopy(e) {
        if (!this.hasCellSelection()) return;

        const matrix = this._getSelectedMatrix();
        if (!matrix) return;

        const text = matrix.map(row => row.join('\t')).join('\n');
        if (e.clipboardData) {
            e.clipboardData.setData('text/plain', text);
            e.preventDefault();
        }
        this.clipboardMatrix = matrix;
    }

    _getSelectedMatrix() {
        if (!this.selectionRange) return null;
        const { table, minRow, maxRow, minCol, maxCol } = this.selectionRange;
        const rows = [];
        for (let r = minRow; r <= maxRow; r++) {
            const row = table.rows[r];
            if (!row) continue;
            const cols = [];
            for (let c = minCol; c <= maxCol; c++) {
                const cell = row.cells[c];
                cols.push(cell ? (cell.textContent || '') : '');
            }
            rows.push(cols);
        }
        return rows;
    }

    _getTopLeftSelectedCell() {
        if (!this.selectionRange) return null;
        const { table, minRow, minCol } = this.selectionRange;
        const row = table.rows[minRow];
        return row ? row.cells[minCol] : null;
    }

    _parseClipboard(text) {
        const lines = text.replace(/\r\n/g, '\n').split('\n');
        if (lines.length && lines[lines.length - 1] === '') {
            lines.pop();
        }
        return lines.map(line => line.split('\t'));
    }

    _applyMatrix(startCell, matrix) {
        const info = this._getCellInfo(startCell);
        if (!info) return;
        const { table, rowIndex: startRow, colIndex: startCol } = info;

        for (let r = 0; r < matrix.length; r++) {
            const row = table.rows[startRow + r];
            if (!row) continue;
            for (let c = 0; c < matrix[r].length; c++) {
                const cell = row.cells[startCol + c];
                if (!cell) continue;
                this._setCellPlainText(cell, matrix[r][c]);
            }
        }

        const lastRowIndex = Math.min(startRow + matrix.length - 1, table.rows.length - 1);
        const lastRow = table.rows[lastRowIndex];
        if (lastRow) {
            const lastColIndex = Math.min(startCol + (matrix[0]?.length || 1) - 1, lastRow.cells.length - 1);
            const lastCell = lastRow.cells[lastColIndex];
            if (lastCell) {
                this._setCursorToCellEnd(lastCell);
            }
        }
    }

    _handleTableNavigation(direction) {
        const selection = window.getSelection();
        if (!selection || !selection.rangeCount || !selection.isCollapsed) return false;

        const range = selection.getRangeAt(0);
        const edge = this._getEdgeFromRange(range);
        if (edge) {
            return this._handleEdgeNavigation(edge, direction);
        }

        const cell = this._getCellFromTarget(range.startContainer);
        if (cell) {
            return this._handleCellNavigation(cell, range, direction);
        }

        return this._handleOutsideNavigation(range, direction);
    }

    _handleEdgeNavigation(edge, direction) {
        const wrapper = edge.closest('.md-table-wrapper');
        if (!wrapper) return false;
        const table = wrapper.querySelector('table');
        if (!table) return false;

        const isLeft = edge.dataset.tableEdge === 'left';
        const isRight = edge.dataset.tableEdge === 'right';

        if (isLeft) {
            if (direction === 'right' || direction === 'next') {
                const firstCell = table.querySelector('td, th');
                if (firstCell) {
                    this._setCursorToCellStart(firstCell);
                    return true;
                }
            }
            if (direction === 'left' || direction === 'prev') {
                this._moveCursorBeforeWrapper(wrapper);
                return true;
            }
            if (direction === 'up') {
                this._moveCursorBeforeWrapper(wrapper, true);
                return true;
            }
            if (direction === 'down') {
                this._moveCursorAfterWrapper(wrapper);
                return true;
            }
        }

        if (isRight) {
            if (direction === 'left' || direction === 'prev') {
                const lastCell = this._getLastCell(table);
                if (lastCell) {
                    this._setCursorToCellEnd(lastCell);
                    return true;
                }
            }
            if (direction === 'right' || direction === 'next') {
                this._moveCursorAfterWrapper(wrapper);
                return true;
            }
            if (direction === 'down') {
                this._moveCursorAfterWrapper(wrapper);
                return true;
            }
        }

        return false;
    }

    _handleCellNavigation(cell, range, direction) {
        const info = this._getCellInfo(cell);
        if (!info) return false;
        const { table, rowIndex, colIndex } = info;
        const sourceRange = range && range.cloneRange ? range.cloneRange() : range;

        const totalRows = table.rows.length;
        const totalCols = table.rows[0] ? table.rows[0].cells.length : 0;

        if (direction === 'left') {
            if (!this._isAtCellStart(cell, range)) return false;
            if (colIndex > 0) {
                const target = table.rows[rowIndex].cells[colIndex - 1];
                if (target) {
                    this._setCursorToCellEnd(target);
                    return true;
                }
            }
            if (rowIndex > 0) {
                const prevRow = table.rows[rowIndex - 1];
                if (prevRow && prevRow.cells.length) {
                    const target = prevRow.cells[prevRow.cells.length - 1];
                    if (target) {
                        this._setCursorToCellEnd(target);
                        return true;
                    }
                }
            }
            const leftEdge = this._getTableEdge(table, 'left');
            if (leftEdge) {
                this._setCursorToEdge(leftEdge, false);
                return true;
            }
        }

        if (direction === 'right') {
            if (!this._isAtCellEnd(cell, range)) return false;
            if (colIndex < totalCols - 1) {
                const target = table.rows[rowIndex].cells[colIndex + 1];
                if (target) {
                    this._setCursorToCellStart(target);
                    return true;
                }
            }
            if (rowIndex < totalRows - 1) {
                const nextRow = table.rows[rowIndex + 1];
                if (nextRow && nextRow.cells.length) {
                    const target = nextRow.cells[0];
                    if (target) {
                        this._setCursorToCellStart(target);
                        return true;
                    }
                }
            }
            const rightEdge = this._getTableEdge(table, 'right');
            if (rightEdge) {
                this._setCursorToEdge(rightEdge, true);
                return true;
            }
        }

        if (direction === 'up') {
            if (this._hasVisualLineInCell(cell, range, 'up')) {
                if (this._moveWithinCellByVisualLine(cell, range, 'up')) {
                    return true;
                }
            }
            if (rowIndex > 0) {
                const target = table.rows[rowIndex - 1].cells[colIndex];
                if (target) {
                    if (this._setCursorToCellByVisualX(sourceRange, target, 'up')) {
                        return true;
                    }
                    const offset = this._getCursorOffsetInCell(cell, range);
                    this._setCursorToCellOffset(target, offset);
                    return true;
                }
            }
            const leftEdge = this._getTableEdge(table, 'left');
            if (leftEdge) {
                this._setCursorToEdge(leftEdge, false);
                this._lastEdgeNavTs = Date.now();
                this._lastEdgeNavDirection = 'up';
                return true;
            }
            return false;
        }

        if (direction === 'down') {
            if (this._hasVisualLineInCell(cell, range, 'down')) {
                if (this._moveWithinCellByVisualLine(cell, range, 'down')) {
                    return true;
                }
            }
            if (rowIndex < totalRows - 1) {
                const target = table.rows[rowIndex + 1].cells[colIndex];
                if (target) {
                    if (this._setCursorToCellByVisualX(sourceRange, target, 'down')) {
                        return true;
                    }
                    const offset = this._getCursorOffsetInCell(cell, range);
                    this._setCursorToCellOffset(target, offset);
                    return true;
                }
            }
            const wrapper = table.closest('.md-table-wrapper');
            if (wrapper) {
                this._moveCursorAfterWrapper(wrapper);
                return true;
            }
            return false;
        }

        if (direction === 'next') {
            const nextCol = colIndex + 1;
            const nextRow = rowIndex + (nextCol >= totalCols ? 1 : 0);
            const targetCol = nextCol >= totalCols ? 0 : nextCol;
            if (nextRow < totalRows) {
                const target = table.rows[nextRow].cells[targetCol];
                if (target) {
                    this._setCursorToCellStart(target);
                    return true;
                }
            }
            const rightEdge = this._getTableEdge(table, 'right');
            if (rightEdge) {
                this._setCursorToEdge(rightEdge, true);
                return true;
            }
        }

        if (direction === 'prev') {
            const prevCol = colIndex - 1;
            const prevRow = prevCol < 0 ? rowIndex - 1 : rowIndex;
            const targetCol = prevCol < 0 ? totalCols - 1 : prevCol;
            if (prevRow >= 0) {
                const target = table.rows[prevRow].cells[targetCol];
                if (target) {
                    this._setCursorToCellEnd(target);
                    return true;
                }
            }
            const leftEdge = this._getTableEdge(table, 'left');
            if (leftEdge) {
                this._setCursorToEdge(leftEdge, false);
                return true;
            }
        }

        return false;
    }

    _handleOutsideNavigation(range, direction) {
        if (direction !== 'left' && direction !== 'right' && direction !== 'up') return false;

        const block = this._getClosestBlock(range.startContainer);
        if (!block || block === this.editor) return false;

        if (direction === 'up') {
            const tableWrapper = this._getPrevTableWrapper(block);
            if (!tableWrapper) return false;
            if (!this._isAtBlockStart(range, block)) return false;
            const edge = tableWrapper.querySelector('.md-table-edge-left');
            if (edge) {
                this._setCursorToEdge(edge, false);
                this._lastEdgeNavTs = Date.now();
                this._lastEdgeNavDirection = 'up';
                return true;
            }
            return false;
        }

        const tableWrapper = direction === 'right'
            ? this._getNextTableWrapper(block)
            : this._getPrevTableWrapper(block);

        if (!tableWrapper) return false;

        if (direction === 'right' && this._isAtBlockEnd(range, block)) {
            const edge = tableWrapper.querySelector('.md-table-edge-left');
            if (edge) {
                this._setCursorToEdge(edge, false);
                return true;
            }
        }

        if (direction === 'left' && this._isAtBlockStart(range, block)) {
            const edge = tableWrapper.querySelector('.md-table-edge-right');
            if (edge) {
                this._setCursorToEdge(edge, true);
                return true;
            }
        }

        return false;
    }

    _getNextTableWrapper(block) {
        let next = block ? block.nextElementSibling : null;
        while (next &&
            (next.classList?.contains('md-table-insert-line') ||
                next.getAttribute?.('data-exclude-from-markdown') === 'true')) {
            next = next.nextElementSibling;
        }
        if (!next) return null;
        if (next.classList && next.classList.contains('md-table-wrapper')) return next;
        if (next.tagName === 'TABLE') return next.closest('.md-table-wrapper');
        return null;
    }

    _getPrevTableWrapper(block) {
        let prev = block ? block.previousElementSibling : null;
        while (prev &&
            (prev.classList?.contains('md-table-insert-line') ||
                prev.getAttribute?.('data-exclude-from-markdown') === 'true')) {
            prev = prev.previousElementSibling;
        }
        if (!prev) return null;
        if (prev.classList && prev.classList.contains('md-table-wrapper')) return prev;
        if (prev.tagName === 'TABLE') return prev.closest('.md-table-wrapper');
        return null;
    }

    _isAtBlockStart(range, block) {
        const tempRange = document.createRange();
        tempRange.selectNodeContents(block);
        tempRange.setEnd(range.startContainer, range.startOffset);
        const beforeText = tempRange.toString().replace(/\u200B/g, '');
        return beforeText.length === 0;
    }

    _isAtBlockEnd(range, block) {
        const tempRange = document.createRange();
        tempRange.selectNodeContents(block);
        tempRange.setStart(range.endContainer, range.endOffset);
        const afterText = tempRange.toString().replace(/\u200B/g, '');
        return afterText.length === 0;
    }

    _moveCursorBeforeWrapper(wrapper, placeAtStart = false) {
        const prev = this._getPrevNavigableSiblingNode(wrapper);
        const selection = window.getSelection();
        if (!selection) return;
        const range = document.createRange();

        if (prev) {
            if (prev.nodeType === Node.TEXT_NODE) {
                range.setStart(prev, placeAtStart ? 0 : prev.textContent.length);
            } else if (prev.tagName === 'HR') {
                range.selectNode(prev);
            } else if (placeAtStart) {
                const firstNode = this.domUtils.getFirstTextNode(prev);
                if (firstNode) {
                    range.setStart(firstNode, 0);
                } else {
                    range.setStart(prev, 0);
                }
            } else {
                const lastNode = this.domUtils.getLastTextNode(prev);
                if (lastNode) {
                    range.setStart(lastNode, lastNode.textContent.length);
                } else {
                    range.setStart(prev, prev.childNodes.length);
                }
            }
        } else {
            const p = document.createElement('p');
            p.appendChild(document.createElement('br'));
            wrapper.parentElement.insertBefore(p, wrapper);
            range.setStart(p, 0);
        }

        range.collapse(true);
        selection.removeAllRanges();
        selection.addRange(range);
    }

    _moveCursorAfterWrapper(wrapper) {
        const next = this._getNextNavigableSiblingNode(wrapper);
        const selection = window.getSelection();
        if (!selection) return;
        const range = document.createRange();

        if (next && next.nodeType === Node.ELEMENT_NODE && next.classList?.contains('md-table-wrapper')) {
            const leftEdge = next.querySelector('.md-table-edge-left');
            if (leftEdge) {
                this._setCursorToEdge(leftEdge, false);
                return;
            }
        }

        if (next && next.nodeType === Node.ELEMENT_NODE && next.tagName === 'TABLE') {
            const leftEdge = next.closest('.md-table-wrapper')?.querySelector('.md-table-edge-left');
            if (leftEdge) {
                this._setCursorToEdge(leftEdge, false);
                return;
            }
        }

        if (next) {
            if (next.nodeType === Node.TEXT_NODE) {
                range.setStart(next, 0);
            } else {
                const firstNode = this.domUtils.getFirstTextNode(next);
                if (firstNode) {
                    range.setStart(firstNode, 0);
                } else {
                    range.setStart(next, 0);
                }
            }
        } else {
            const p = document.createElement('p');
            p.appendChild(document.createElement('br'));
            if (wrapper.nextSibling) {
                wrapper.parentElement.insertBefore(p, wrapper.nextSibling);
            } else {
                wrapper.parentElement.appendChild(p);
            }
            range.setStart(p, 0);
        }

        range.collapse(true);
        selection.removeAllRanges();
        selection.addRange(range);
    }

    _getNextNavigableSiblingNode(node) {
        let next = node ? node.nextSibling : null;
        while (next) {
            if (next.nodeType === Node.TEXT_NODE) {
                const text = (next.textContent || '').replace(/[\u200B\u00A0]/g, '');
                if (text.trim() !== '') {
                    return next;
                }
                next = next.nextSibling;
                continue;
            }
            if (next.nodeType !== Node.ELEMENT_NODE) {
                next = next.nextSibling;
                continue;
            }
            if (next.classList?.contains('md-table-insert-line') ||
                next.getAttribute?.('data-exclude-from-markdown') === 'true') {
                next = next.nextSibling;
                continue;
            }
            return next;
        }
        return null;
    }

    _getPrevNavigableSiblingNode(node) {
        let prev = node ? node.previousSibling : null;
        while (prev) {
            if (prev.nodeType === Node.TEXT_NODE) {
                const text = (prev.textContent || '').replace(/[\u200B\u00A0]/g, '');
                if (text.trim() !== '') {
                    return prev;
                }
                prev = prev.previousSibling;
                continue;
            }
            if (prev.nodeType !== Node.ELEMENT_NODE) {
                prev = prev.previousSibling;
                continue;
            }
            if (prev.classList?.contains('md-table-insert-line') ||
                prev.getAttribute?.('data-exclude-from-markdown') === 'true') {
                prev = prev.previousSibling;
                continue;
            }
            return prev;
        }
        return null;
    }

    _getCellInfo(cell) {
        const table = cell.closest('table');
        if (!table) return null;
        const rowIndex = cell.parentElement.rowIndex;
        const colIndex = cell.cellIndex;
        return { table, rowIndex, colIndex };
    }

    _getLastCell(table) {
        if (!table || !table.rows.length) return null;
        const lastRow = table.rows[table.rows.length - 1];
        return lastRow.cells[lastRow.cells.length - 1] || null;
    }

    _getTableEdge(table, side) {
        const wrapper = table.closest('.md-table-wrapper');
        if (!wrapper) return null;
        return wrapper.querySelector(side === 'left' ? '.md-table-edge-left' : '.md-table-edge-right');
    }

    _setCursorToCellStart(cell) {
        this._ensureCellNotEmpty(cell);
        const selection = window.getSelection();
        if (!selection) return;
        const range = document.createRange();
        const textNode = this.domUtils.getFirstTextNode(cell);
        if (textNode) {
            range.setStart(textNode, 0);
        } else {
            range.setStart(cell, 0);
        }
        range.collapse(true);
        selection.removeAllRanges();
        selection.addRange(range);
    }

    _setCursorToCellEnd(cell) {
        this._ensureCellNotEmpty(cell);
        const selection = window.getSelection();
        if (!selection) return;
        const range = document.createRange();
        const textNode = this.domUtils.getLastTextNode(cell);
        if (textNode) {
            range.setStart(textNode, textNode.textContent.length);
        } else if (this._isCellEmpty(cell)) {
            // For empty cells, placing caret after placeholder <br> makes typing start on the next visual line.
            range.setStart(cell, 0);
        } else {
            range.setStart(cell, cell.childNodes.length);
        }
        range.collapse(true);
        selection.removeAllRanges();
        selection.addRange(range);
    }

    _setCursorToCellOffset(cell, offset) {
        this._ensureCellNotEmpty(cell);
        const selection = window.getSelection();
        if (!selection) return;
        const range = document.createRange();
        const textNodes = this.domUtils.getTextNodes(cell);

        if (!textNodes.length) {
            range.setStart(cell, 0);
        } else {
            let remaining = offset;
            let placed = false;
            for (let i = 0; i < textNodes.length; i++) {
                const node = textNodes[i];
                const len = node.textContent.length;
                if (remaining <= len) {
                    range.setStart(node, remaining);
                    placed = true;
                    break;
                }
                remaining -= len;
            }
            if (!placed) {
                const last = textNodes[textNodes.length - 1];
                range.setStart(last, last.textContent.length);
            }
        }

        range.collapse(true);
        selection.removeAllRanges();
        selection.addRange(range);
    }

    _setCursorToCellByVisualX(sourceRange, targetCell, direction) {
        if (!sourceRange || !targetCell || !sourceRange.collapsed) return false;
        if (direction !== 'up' && direction !== 'down') return false;
        if (typeof document.caretRangeFromPoint !== 'function') return false;

        this._ensureCellNotEmpty(targetCell);

        const sourceRect = this._getVisualCaretRectForRange(sourceRange);
        if (!sourceRect) return false;
        const sourceX = (sourceRect.left || sourceRect.x || 0) + 1;
        if (!Number.isFinite(sourceX)) return false;

        const lines = this._getVisualLinesForCell(targetCell);
        if (!lines.length) return false;

        const targetLine = direction === 'up'
            ? lines[lines.length - 1]
            : lines[0];
        if (!targetLine) return false;

        const targetHeight = Math.max(1, targetLine.bottom - targetLine.top);
        const targetY = targetLine.top + Math.max(1, Math.min(targetHeight * 0.5, targetHeight - 1));

        const minX = targetLine.left + 1;
        const maxX = Math.max(minX, targetLine.right - 1);
        const clampedX = Math.min(maxX, Math.max(minX, sourceX));
        const xCandidates = [
            clampedX,
            sourceX,
            minX,
            maxX,
            minX + 1,
            maxX - 1
        ];

        let bestRange = null;
        let bestScore = Infinity;

        for (const candidateX of xCandidates) {
            if (!Number.isFinite(candidateX)) continue;

            let probeRange = null;
            try {
                probeRange = document.caretRangeFromPoint(candidateX, targetY);
            } catch (_e) {
                probeRange = null;
            }
            if (!probeRange || !targetCell.contains(probeRange.startContainer)) {
                continue;
            }

            const probeRect = this._getVisualCaretRectForRange(probeRange);
            if (!probeRect) {
                continue;
            }
            const probeTop = probeRect.top || probeRect.y || 0;
            if (probeTop < targetLine.top - 3 || probeTop > targetLine.bottom + 3) {
                continue;
            }

            const probeX = probeRect.left || probeRect.x || 0;
            const score = Math.abs(probeX - sourceX);
            if (!bestRange || score < bestScore) {
                bestRange = probeRange;
                bestScore = score;
            }
        }

        if (!bestRange) {
            return false;
        }

        const selection = window.getSelection();
        if (!selection) return false;

        const range = document.createRange();
        range.setStart(bestRange.startContainer, bestRange.startOffset);
        range.collapse(true);
        selection.removeAllRanges();
        selection.addRange(range);
        return true;
    }

    _moveWithinCellByVisualLine(cell, range, direction) {
        if (!cell || !range || !range.collapsed) return false;
        if (!cell.contains(range.startContainer)) return false;
        if (direction !== 'up' && direction !== 'down') return false;
        if (typeof document.caretRangeFromPoint !== 'function') return false;
        const originContainer = range.startContainer;
        const originOffset = range.startOffset;

        const lines = this._getVisualLinesForCell(cell);
        if (lines.length < 2) return false;

        const currentRect = this._getVisualCaretRectForRange(range);
        if (!currentRect) return false;

        const currentIndex = this._getNearestVisualLineIndex(lines, currentRect);
        if (currentIndex < 0) return false;

        const targetIndex = direction === 'up' ? currentIndex - 1 : currentIndex + 1;
        if (targetIndex < 0 || targetIndex >= lines.length) return false;

        const currentLine = lines[currentIndex];
        const targetLine = lines[targetIndex];
        if (!targetLine) return false;

        const currentX = currentRect.left || currentRect.x || 0;
        const atCurrentLineStart = !!currentLine && currentX <= (currentLine.left + 2);
        const targetHeight = Math.max(1, targetLine.bottom - targetLine.top);
        const targetY = targetLine.top + Math.max(1, Math.min(targetHeight * 0.5, targetHeight - 1));

        const trySetRange = (targetRange) => {
            if (!targetRange || !cell.contains(targetRange.startContainer)) return false;
            const isSamePosition =
                targetRange.startContainer === originContainer &&
                targetRange.startOffset === originOffset;
            if (isSamePosition) return false;
            const sel = window.getSelection();
            if (!sel) return false;
            const collapsed = document.createRange();
            collapsed.setStart(targetRange.startContainer, targetRange.startOffset);
            collapsed.collapse(true);
            sel.removeAllRanges();
            sel.addRange(collapsed);
            return true;
        };

        const findLineStartCaretInCell = (skipWhitespace) => {
            const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT, null, false);
            let textNode;
            let best = null;
            let guard = 0;

            while (textNode = walker.nextNode()) {
                const text = textNode.textContent || '';
                if (!text.length) continue;
                for (let i = 0; i < text.length; i++) {
                    guard++;
                    if (guard > 12000) return best;
                    const ch = text[i];
                    if (ch === '\n' || ch === '\r' || ch === '\u200B' || ch === '\uFEFF') {
                        continue;
                    }
                    if (skipWhitespace && /\s/.test(ch)) {
                        continue;
                    }
                    let rect = null;
                    try {
                        const charRange = document.createRange();
                        charRange.setStart(textNode, i);
                        charRange.setEnd(textNode, i + 1);
                        rect = charRange.getBoundingClientRect();
                    } catch (_e) {
                        continue;
                    }
                    if (!rect || !(rect.width || rect.height)) {
                        continue;
                    }
                    const top = rect.top || rect.y || 0;
                    const bottom = rect.bottom || (rect.y + rect.height) || top;
                    if (bottom < targetLine.top - 2 || top > targetLine.bottom + 2) {
                        continue;
                    }
                    const left = rect.left || rect.x || 0;
                    if (!best || left < best.left - 0.5 ||
                        (Math.abs(left - best.left) <= 0.5 && top < best.top)) {
                        best = { node: textNode, offset: i, left, top };
                    }
                }
            }
            return best;
        };

        if (atCurrentLineStart) {
            const lineStartCaret = findLineStartCaretInCell(true) || findLineStartCaretInCell(false);
            if (lineStartCaret) {
                const startRange = document.createRange();
                startRange.setStart(lineStartCaret.node, lineStartCaret.offset);
                startRange.collapse(true);
                if (trySetRange(startRange)) {
                    return true;
                }
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
        let bestRange = null;
        let bestScore = Infinity;

        const trySelectRange = (probeRange) => {
            if (!probeRange || !cell.contains(probeRange.startContainer)) {
                return;
            }
            const probeRect = this._getVisualCaretRectForRange(probeRange);
            if (!probeRect) {
                return;
            }
            const probeTop = probeRect.top || probeRect.y || 0;
            if (probeTop < targetLine.top - 3 || probeTop > targetLine.bottom + 3) {
                return;
            }
            const probeLeft = probeRect.left || probeRect.x || 0;
            const score = atCurrentLineStart ? probeLeft : Math.abs(probeLeft - currentX);
            if (!bestRange || score < bestScore) {
                bestRange = probeRange;
                bestScore = score;
            }
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

        if (bestRange && trySetRange(bestRange)) {
            return true;
        }

        // Safety fallback: keep movement inside current cell.
        const selection = window.getSelection();
        if (!selection || !selection.rangeCount) return false;
        const restore = range.cloneRange();
        if (typeof selection.modify !== 'function') {
            return false;
        }
        try {
            selection.modify('move', direction === 'up' ? 'backward' : 'forward', 'line');
            if (selection.rangeCount) {
                const movedRange = selection.getRangeAt(0);
                if (cell.contains(movedRange.startContainer)) {
                    return true;
                }
            }
        } catch (_e) {
            // restore below
        }
        selection.removeAllRanges();
        selection.addRange(restore);
        return false;
    }

    _setCursorToEdge(edge, atEnd) {
        const selection = window.getSelection();
        if (!selection) return;
        const range = document.createRange();
        const textNode = edge.firstChild && edge.firstChild.nodeType === Node.TEXT_NODE
            ? edge.firstChild
            : null;

        if (textNode) {
            range.setStart(textNode, atEnd ? textNode.textContent.length : 0);
        } else {
            range.setStart(edge, 0);
        }
        range.collapse(true);
        selection.removeAllRanges();
        selection.addRange(range);
    }

    _getCursorOffsetInCell(cell, range) {
        const tempRange = document.createRange();
        tempRange.selectNodeContents(cell);
        tempRange.setEnd(range.startContainer, range.startOffset);
        return tempRange.toString().length;
    }

    _getVisualCaretRectForRange(range) {
        if (!range) return null;

        const baseRect = (() => {
            const rects = Array.from(range.getClientRects ? range.getClientRects() : []);
            const firstRect = rects.find(rect =>
                rect &&
                Number.isFinite(rect.top) &&
                Number.isFinite(rect.left) &&
                (rect.width || rect.height)
            );
            if (firstRect) return firstRect;
            const fallback = range.getBoundingClientRect ? range.getBoundingClientRect() : null;
            if (fallback &&
                Number.isFinite(fallback.top) &&
                Number.isFinite(fallback.left) &&
                (fallback.width || fallback.height)) {
                return fallback;
            }
            return null;
        })();
        if (!baseRect || !range.collapsed) {
            return baseRect;
        }

        const containerNode = range.startContainer;
        if (!containerNode || containerNode.nodeType !== Node.TEXT_NODE) {
            return baseRect;
        }
        const text = containerNode.textContent || '';
        const offset = Math.max(0, Math.min(range.startOffset, text.length));
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
                // At wrapped-line head, prefer the next character's line.
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
        } catch (_e) {
            // fall back to baseRect
        }
        return baseRect;
    }

    _getVisualLinesForCell(cell) {
        if (!cell) return [];
        try {
            const cellRect = cell.getBoundingClientRect ? cell.getBoundingClientRect() : null;
            const rawRects = [];
            const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT, null, false);
            let textNode;
            let guard = 0;
            while (textNode = walker.nextNode()) {
                const text = textNode.textContent || '';
                if (!text.length) continue;
                for (let i = 0; i < text.length; i++) {
                    guard++;
                    if (guard > 20000) break;
                    const ch = text[i];
                    if (ch === '\n' || ch === '\r' || ch === '\u200B' || ch === '\uFEFF') {
                        continue;
                    }
                    try {
                        const charRange = document.createRange();
                        charRange.setStart(textNode, i);
                        charRange.setEnd(textNode, i + 1);
                        const rect = charRange.getBoundingClientRect();
                        if (rect) rawRects.push(rect);
                    } catch (_e) {
                        // ignore broken ranges and continue
                    }
                }
                if (guard > 20000) break;
            }
            const rects = rawRects
                .filter(rect =>
                    rect &&
                    Number.isFinite(rect.top) &&
                    Number.isFinite(rect.bottom) &&
                    Number.isFinite(rect.left) &&
                    Number.isFinite(rect.right) &&
                    (!cellRect ||
                        (rect.bottom >= cellRect.top + 1 &&
                            rect.top <= cellRect.bottom - 1 &&
                            rect.right >= cellRect.left + 1 &&
                            rect.left <= cellRect.right - 1)) &&
                    (rect.width || rect.height)
                )
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
        } catch (_e) {
            return [];
        }
    }

    _getNearestVisualLineIndex(lines, caretRect) {
        if (!lines || !lines.length || !caretRect) {
            return -1;
        }
        const caretTop = caretRect.top || caretRect.y || 0;
        let index = 0;
        let minDistance = Infinity;
        for (let i = 0; i < lines.length; i++) {
            const distance = Math.abs(lines[i].top - caretTop);
            if (distance < minDistance) {
                minDistance = distance;
                index = i;
            }
        }
        return index;
    }

    _hasVisualLineInCell(cell, range, direction) {
        if (!cell || !range || !range.collapsed) return false;
        if (!cell.contains(range.startContainer)) return false;
        if (direction !== 'up' && direction !== 'down') return false;

        const lines = this._getVisualLinesForCell(cell);
        if (lines.length < 2) return false;

        const caretRect = this._getVisualCaretRectForRange(range);
        if (!caretRect) return false;

        const currentIndex = this._getNearestVisualLineIndex(lines, caretRect);
        if (currentIndex < 0) return false;

        return direction === 'up'
            ? currentIndex > 0
            : currentIndex < lines.length - 1;
    }

    _isAtCellStart(cell, range) {
        if (this._isCellEmpty(cell)) return true;
        const offset = this._getCursorOffsetInCell(cell, range);
        return offset <= 0;
    }

    _isAtCellEnd(cell, range) {
        if (this._isCellEmpty(cell)) return true;
        const total = (cell.textContent || '').length;
        const offset = this._getCursorOffsetInCell(cell, range);
        return offset >= total;
    }

    _isCellEmpty(cell) {
        const text = (cell.textContent || '').replace(/\u200B/g, '');
        return text.trim() === '';
    }

    _getCellFromTarget(target) {
        if (!target) return null;
        const element = target.nodeType === Node.ELEMENT_NODE ? target : target.parentElement;
        if (!element) return null;
        return element.closest('td, th');
    }

    _getEdgeFromTarget(target) {
        if (!target) return null;
        const element = target.nodeType === Node.ELEMENT_NODE ? target : target.parentElement;
        if (!element) return null;
        return element.closest('.md-table-edge');
    }

    _getCellFromPoint(x, y) {
        const el = document.elementFromPoint(x, y);
        return this._getCellFromTarget(el);
    }

    _getInsertLineBounds(table) {
        const tableRect = table.getBoundingClientRect();
        const editorRect = this.editor.getBoundingClientRect();
        const pad = 1;
        return {
            left: tableRect.left - editorRect.left + this.editor.scrollLeft - pad,
            top: tableRect.top - editorRect.top + this.editor.scrollTop - pad,
            width: tableRect.width + pad * 2,
            height: tableRect.height + pad * 2,
            editorRect
        };
    }

    _getEdgeFromSelection() {
        const selection = window.getSelection();
        if (!selection || !selection.rangeCount) return null;
        const range = selection.getRangeAt(0);
        return this._getEdgeFromRange(range);
    }

    _getEdgeFromRange(range) {
        const node = range.startContainer;
        const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
        if (!element) return null;
        return element.closest('.md-table-edge');
    }

    _insertColumn(table, index, preferredRowIndex = 0) {
        const rows = Array.from(table.rows);
        rows.forEach(row => {
            const isHeader = row.parentElement && row.parentElement.tagName === 'THEAD';
            const cellTag = isHeader ? 'TH' : 'TD';
            const newCell = document.createElement(cellTag);
            newCell.contentEditable = 'true';
            newCell.appendChild(document.createElement('br'));
            if (index >= row.cells.length) {
                row.appendChild(newCell);
            } else {
                row.insertBefore(newCell, row.cells[index]);
            }
        });

        this._ensureStructureHandles(table);
        this._syncStructureSelectionUI();

        const rowIndex = Math.max(0, Math.min(preferredRowIndex, table.rows.length - 1));
        const targetRow = table.rows[rowIndex];
        if (targetRow && targetRow.cells.length) {
            const targetIndex = Math.max(0, Math.min(index, targetRow.cells.length - 1));
            const targetCell = targetRow.cells[targetIndex];
            if (targetCell) this._setCursorToCellStart(targetCell);
        }
    }

    _insertRow(table, index, preferredColIndex = 0) {
        const colCount = table.rows[0] ? table.rows[0].cells.length : 0;
        const referenceRow = table.rows[index] || null;
        const isHeader = referenceRow && referenceRow.parentElement.tagName === 'THEAD';

        // If inserting above a THEAD row, redirect to the beginning of TBODY
        // (markdown tables always have exactly one header row)
        if (isHeader) {
            const tbody = table.tBodies[0] || (() => {
                const tb = document.createElement('tbody');
                table.appendChild(tb);
                return tb;
            })();
            const newRow = document.createElement('tr');
            for (let i = 0; i < colCount; i++) {
                const cell = document.createElement('td');
                cell.contentEditable = 'true';
                cell.appendChild(document.createElement('br'));
                newRow.appendChild(cell);
            }
            tbody.insertBefore(newRow, tbody.firstChild);

            this._ensureStructureHandles(table);
            this._syncStructureSelectionUI();

            if (newRow.cells.length) {
                const targetIndex = Math.max(0, Math.min(preferredColIndex, newRow.cells.length - 1));
                const targetCell = newRow.cells[targetIndex];
                if (targetCell) this._setCursorToCellStart(targetCell);
            }
            return;
        }

        const section = referenceRow ? referenceRow.parentElement : (table.tBodies[0] || table);
        const newRow = document.createElement('tr');
        for (let i = 0; i < colCount; i++) {
            const cell = document.createElement('td');
            cell.contentEditable = 'true';
            cell.appendChild(document.createElement('br'));
            newRow.appendChild(cell);
        }
        if (referenceRow) {
            section.insertBefore(newRow, referenceRow);
        } else {
            section.appendChild(newRow);
        }

        this._ensureStructureHandles(table);
        this._syncStructureSelectionUI();

        if (newRow.cells.length) {
            const targetIndex = Math.max(0, Math.min(preferredColIndex, newRow.cells.length - 1));
            const targetCell = newRow.cells[targetIndex];
            if (targetCell) this._setCursorToCellStart(targetCell);
        }
    }

    _deleteTableFromEdge(edge) {
        const wrapper = edge.closest('.md-table-wrapper');
        if (!wrapper) return;
        const table = wrapper.querySelector('table');
        if (table && this.structureDrag && this.structureDrag.table === table) {
            this.structureDrag = null;
            document.body.classList.remove('md-table-structure-dragging');
        }
        if (table && this.selectionRange && this.selectionRange.table === table) {
            this.clearCellSelection();
        }
        if (table && this.structureSelection && this.structureSelection.table === table) {
            this.structureSelection = null;
            this._clearStructureSelectionVisuals();
        }
        const next = wrapper.nextElementSibling;
        const prev = wrapper.previousElementSibling;
        wrapper.remove();

        const selection = window.getSelection();
        if (!selection) return;
        const range = document.createRange();

        if (next) {
            const firstNode = this.domUtils.getFirstTextNode(next);
            if (firstNode) {
                range.setStart(firstNode, 0);
            } else {
                range.setStart(next, 0);
            }
        } else if (prev) {
            const lastNode = this.domUtils.getLastTextNode(prev);
            if (lastNode) {
                range.setStart(lastNode, lastNode.textContent.length);
            } else {
                range.setStart(prev, prev.childNodes.length);
            }
        } else {
            const p = document.createElement('p');
            p.appendChild(document.createElement('br'));
            this.editor.appendChild(p);
            range.setStart(p, 0);
        }

        range.collapse(true);
        selection.removeAllRanges();
        selection.addRange(range);
    }

    _deleteRowAt(table, rowIndex, colIndex) {
        if (!table || !table.rows.length) return false;
        const row = table.rows[rowIndex];
        if (!row) return false;

        const section = row.parentElement;
        row.remove();

        if (section && section.tagName === 'THEAD' && section.rows.length === 0) {
            section.remove();
        }
        if (section && section.tagName === 'TBODY' && section.rows.length === 0) {
            section.remove();
        }

        if (!table.rows.length) {
            const edge = this._getTableEdge(table, 'right') || this._getTableEdge(table, 'left');
            if (edge) {
                this._deleteTableFromEdge(edge);
            }
            return true;
        }

        this._normalizeTableSections(table);
        this._ensureStructureHandles(table);
        this._syncStructureSelectionUI();

        const nextRowIndex = Math.min(rowIndex, table.rows.length - 1);
        const nextRow = table.rows[nextRowIndex];
        if (nextRow) {
            const nextColIndex = Math.min(colIndex, nextRow.cells.length - 1);
            const target = nextRow.cells[nextColIndex] || nextRow.cells[0];
            if (target) {
                this._setCursorToCellStart(target);
            }
        }
        return true;
    }

    _deleteColumnAt(table, colIndex, rowIndex) {
        if (!table || !table.rows.length) return false;
        const totalCols = table.rows[0] ? table.rows[0].cells.length : 0;
        if (totalCols <= 1) {
            const edge = this._getTableEdge(table, 'right') || this._getTableEdge(table, 'left');
            if (edge) {
                this._deleteTableFromEdge(edge);
            }
            return true;
        }

        const rows = Array.from(table.rows);
        rows.forEach(row => {
            const cell = row.cells[colIndex];
            if (cell) {
                row.removeChild(cell);
            }
        });

        this._ensureStructureHandles(table);
        this._syncStructureSelectionUI();

        const targetRow = table.rows[Math.min(rowIndex, table.rows.length - 1)];
        if (targetRow && targetRow.cells.length) {
            const targetColIndex = Math.min(colIndex, targetRow.cells.length - 1);
            const target = targetRow.cells[targetColIndex] || targetRow.cells[targetRow.cells.length - 1];
            if (target) {
                this._setCursorToCellStart(target);
            }
        }

        return true;
    }

    _createTableWrapper(rows, cols) {
        const wrapper = this._createWrapper();
        const leftEdge = this._createEdge('left');
        const rightEdge = this._createEdge('right');
        const table = document.createElement('table');
        table.className = 'md-table';
        const thead = document.createElement('thead');
        const headRow = document.createElement('tr');
        for (let c = 0; c < cols; c++) {
            const th = document.createElement('th');
            th.contentEditable = 'true';
            th.appendChild(document.createElement('br'));
            headRow.appendChild(th);
        }
        thead.appendChild(headRow);
        table.appendChild(thead);

        const tbody = document.createElement('tbody');
        for (let r = 1; r < rows; r++) {
            const tr = document.createElement('tr');
            for (let c = 0; c < cols; c++) {
                const td = document.createElement('td');
                td.contentEditable = 'true';
                td.appendChild(document.createElement('br'));
                tr.appendChild(td);
            }
            tbody.appendChild(tr);
        }
        table.appendChild(tbody);

        wrapper.appendChild(leftEdge);
        wrapper.appendChild(table);
        wrapper.appendChild(rightEdge);
        return wrapper;
    }

    _createWrapper() {
        const wrapper = document.createElement('div');
        wrapper.className = 'md-table-wrapper';
        return wrapper;
    }

    _createEdge(side) {
        const edge = document.createElement('div');
        edge.className = `md-table-edge md-table-edge-${side}`;
        edge.dataset.tableEdge = side;
        edge.setAttribute('data-exclude-from-markdown', 'true');
        edge.contentEditable = 'true';
        edge.spellcheck = false;
        edge.textContent = '\u00A0';
        return edge;
    }

    _ensureTableCells(table) {
        const cells = table.querySelectorAll('td, th');
        cells.forEach(cell => {
            cell.contentEditable = 'true';
            this._ensureCellNotEmpty(cell);
        });
    }

    _ensureStructureHandles(table) {
        if (!table) return;

        const existingHandles = table.querySelectorAll('.md-table-structure-handle');
        existingHandles.forEach(handle => handle.remove());

        const rows = Array.from(table.rows);
        if (!rows.length) return;

        rows.forEach((row, rowIndex) => {
            const firstCell = row.cells[0];
            if (!firstCell) return;
            firstCell.appendChild(this._createStructureHandle('row', rowIndex));
        });

        const topRow = rows[0];
        const topCells = Array.from(topRow.cells);
        topCells.forEach((cell, colIndex) => {
            cell.appendChild(this._createStructureHandle('col', colIndex));
        });

        const wrapper = table.closest('.md-table-wrapper');
        if (wrapper) {
            this._ensureStructureOutline(wrapper);
        }
        this._syncHandleVisibility();
    }

    _createStructureHandle(type, index) {
        const handle = document.createElement('span');
        handle.className = `md-table-structure-handle md-table-${type}-handle`;
        handle.dataset.tableStructureHandle = type;
        handle.dataset.tableStructureIndex = String(index);
        handle.setAttribute('data-exclude-from-markdown', 'true');
        handle.setAttribute('contenteditable', 'false');
        handle.setAttribute('aria-hidden', 'true');
        handle.tabIndex = -1;
        return handle;
    }

    _ensureCellNotEmpty(cell) {
        if (!cell) return;
        const hasText = (cell.textContent || '').replace(/\u200B/g, '').trim() !== '';
        const hasBr = !!cell.querySelector('br');
        if (hasText) {
            this._cleanupHandleCellPlaceholderBreaks(cell);
            return;
        }
        if (!hasBr) {
            cell.appendChild(document.createElement('br'));
        }
    }

    _cleanupHandleCellPlaceholderBreaks(cell) {
        if (!cell) return;
        const hasHandle = !!cell.querySelector(':scope > .md-table-structure-handle');
        if (!hasHandle) return;

        let first = cell.firstChild;
        while (first && first.nodeType === Node.ELEMENT_NODE && first.tagName === 'BR') {
            const next = first.nextSibling;
            first.remove();
            first = next;
        }

        let last = cell.lastChild;
        while (last && last.nodeType === Node.ELEMENT_NODE && last.tagName === 'BR') {
            const prev = last.previousSibling;
            last.remove();
            last = prev;
        }
    }

    _clearCellContent(cell) {
        if (!cell) return;
        this._setCellPlainText(cell, '');
    }

    _setCellPlainText(cell, text) {
        if (!cell) return;
        const directHandles = Array.from(cell.querySelectorAll(':scope > .md-table-structure-handle'));
        directHandles.forEach(handle => handle.remove());

        cell.textContent = text || '';
        this._ensureCellNotEmpty(cell);

        directHandles.forEach(handle => {
            cell.appendChild(handle);
        });
    }

    _insertNodeAsBlock(range, node) {
        const block = this._getClosestBlock(range.startContainer);
        if (!block || block === this.editor || block.tagName === 'LI' || block.tagName === 'TD' || block.tagName === 'TH') {
            range.deleteContents();
            range.insertNode(node);
            return;
        }

        const beforeRange = range.cloneRange();
        beforeRange.selectNodeContents(block);
        beforeRange.setEnd(range.startContainer, range.startOffset);
        const afterRange = range.cloneRange();
        afterRange.selectNodeContents(block);
        afterRange.setStart(range.startContainer, range.startOffset);

        const beforeFrag = beforeRange.extractContents();
        const afterFrag = afterRange.extractContents();

        const beforeBlock = block.cloneNode(false);
        beforeBlock.appendChild(beforeFrag);
        if ((beforeBlock.textContent || '').trim() === '') {
            beforeBlock.appendChild(document.createElement('br'));
        }

        const afterBlock = block.cloneNode(false);
        afterBlock.appendChild(afterFrag);
        if ((afterBlock.textContent || '').trim() === '') {
            afterBlock.appendChild(document.createElement('br'));
        }

        block.parentNode.insertBefore(beforeBlock, block);
        block.parentNode.insertBefore(node, block);
        block.parentNode.insertBefore(afterBlock, block);
        block.remove();
    }

    _getClosestBlock(node) {
        let current = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
        while (current && current !== this.editor) {
            if (this.domUtils.isBlockElement(current)) return current;
            current = current.parentElement;
        }
        return current;
    }
}

// Made with Bob
