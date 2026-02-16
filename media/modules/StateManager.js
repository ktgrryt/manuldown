// @ts-nocheck
/**
 * 状態管理モジュール
 * Undo/Redo履歴の管理と選択範囲の保存/復元を担当
 */

export class StateManager {
    constructor(editor, vscodeApi) {
        this.editor = editor;
        this.vscodeApi = vscodeApi;
        this.undoStack = [];
        this.redoStack = [];
        this.maxHistorySize = 100;
        this.isRestoringState = false;
        this.saveStateTimeout = null;
    }

    /**
     * 現在の選択範囲を保存
     * @returns {Object|null} 選択範囲の情報、または選択がない場合null
     */
    saveSelection() {
        const selection = window.getSelection();
        if (!selection || !selection.rangeCount) return null;

        const range = selection.getRangeAt(0);
        
        /**
         * ノードのパスを取得（エディタからの相対位置）
         */
        const getNodePath = (node) => {
            const path = [];
            let current = node;
            
            while (current && current !== this.editor) {
                const parent = current.parentNode;
                if (!parent) break;
                
                const index = Array.from(parent.childNodes).indexOf(current);
                path.unshift(index);
                current = parent;
            }
            
            return path;
        };

        return {
            startPath: getNodePath(range.startContainer),
            startOffset: range.startOffset,
            endPath: getNodePath(range.endContainer),
            endOffset: range.endOffset,
            collapsed: range.collapsed
        };
    }

    /**
     * 保存された選択範囲を復元
     * @param {Object|null} savedSelection - 保存された選択範囲の情報
     */
    restoreSelection(savedSelection) {
        if (!savedSelection) return;

        const selection = window.getSelection();
        if (!selection) return;

        /**
         * パスからノードを取得
         */
        const getNodeByPath = (path) => {
            let node = this.editor;
            
            for (const index of path) {
                if (!node.childNodes[index]) {
                    return null;
                }
                node = node.childNodes[index];
            }
            
            return node;
        };

        try {
            const startNode = getNodeByPath(savedSelection.startPath);
            const endNode = getNodeByPath(savedSelection.endPath);

            if (!startNode || !endNode) return;

            const range = document.createRange();
            range.setStart(startNode, Math.min(savedSelection.startOffset, startNode.length || startNode.childNodes.length || 0));
            range.setEnd(endNode, Math.min(savedSelection.endOffset, endNode.length || endNode.childNodes.length || 0));

            selection.removeAllRanges();
            selection.addRange(range);
        } catch (error) {
            console.error('Error restoring selection:', error);
        }
    }

    /**
     * デフォルトのカーソル位置を設定（エディタの最初）
     */
    setDefaultCursorPosition() {
        try {
            const selection = window.getSelection();
            if (!selection) return;

            // エディタの最初の要素を探す
            let firstElement = this.editor.firstChild;
            
            // 最初のテキストノードまたは要素を見つける
            while (firstElement && firstElement.nodeType !== 3 && firstElement.nodeType !== 1) {
                firstElement = firstElement.nextSibling;
            }

            if (firstElement) {
                const range = document.createRange();
                
                if (firstElement.nodeType === 3) {
                    // テキストノードの場合
                    range.setStart(firstElement, 0);
                } else {
                    // 要素ノードの場合
                    range.setStart(firstElement, 0);
                }
                
                range.collapse(true);
                selection.removeAllRanges();
                selection.addRange(range);
            }
        } catch (error) {
            console.error('Error setting default cursor position:', error);
        }
    }

    /**
     * 現在のエディタ状態をUndoスタックに保存
     */
    saveState() {
        if (this.isRestoringState) {
            return;
        }
        
        // 保留中の保存タイムアウトをクリア
        if (this.saveStateTimeout) {
            clearTimeout(this.saveStateTimeout);
            this.saveStateTimeout = null;
        }
        
        const state = {
            html: this.editor.innerHTML,
            selection: this.saveSelection()
        };
        
        this.undoStack.push(state);
        
        // スタックサイズを制限
        if (this.undoStack.length > this.maxHistorySize) {
            this.undoStack.shift();
        }
        
        // 新しいアクションが実行されたらRedoスタックをクリア
        this.redoStack = [];
    }

    /**
     * デバウンス付きで状態を保存（テキスト入力用）
     */
    saveStateDebounced() {
        if (this.isRestoringState) return;
        
        if (this.saveStateTimeout) {
            clearTimeout(this.saveStateTimeout);
        }
        
        this.saveStateTimeout = setTimeout(() => {
            this.saveState();
            this.saveStateTimeout = null;
        }, 500); // 最後の入力から0.5秒後に状態を保存
    }

    /**
     * Undo操作を実行
     * @param {Function} notifyCallback - 変更を通知するコールバック
     */
    performUndo(notifyCallback) {
        
        // VSCodeにUndo操作の開始を通知（タイムスタンプ更新のため）
        if (this.vscodeApi) {
            this.vscodeApi.postMessage({ type: 'undoRedo' });
        }
        
        // 保留中の保存があれば即座に実行
        if (this.saveStateTimeout) {
            clearTimeout(this.saveStateTimeout);
            this.saveStateTimeout = null;
            
            // 現在の状態を保存（保留中の保存を実行）
            const pendingState = {
                html: this.editor.innerHTML,
                selection: this.saveSelection()
            };
            this.undoStack.push(pendingState);
            
            // スタックサイズを制限
            if (this.undoStack.length > this.maxHistorySize) {
                this.undoStack.shift();
            }
            
            // Redoスタックをクリア（新しい状態が保存されたため）
            this.redoStack = [];
            
        }
        
        // undoStackが空、または1つしかない場合は何もしない
        if (this.undoStack.length <= 1) {
            return;
        }
        
        this.isRestoringState = true;
        
        // 現在の状態（undoStackの最後）をRedoスタックに移動
        const currentState = this.undoStack.pop();
        this.redoStack.push(currentState);
        
        // Undoスタックから前の状態を復元
        const state = this.undoStack[this.undoStack.length - 1];
        const scrollTop = this.editor.scrollTop;
        this.editor.innerHTML = state.html;
        this.restoreSelection(state.selection);
        this.editor.scrollTop = scrollTop;

        this.isRestoringState = false;

        // エディタにフォーカスを維持（スクロールを防止）
        const scrollTopAfter = this.editor.scrollTop;
        setTimeout(() => {
            try { this.editor.focus({ preventScroll: true }); } catch (e) { this.editor.focus(); }
            this.editor.scrollTop = scrollTopAfter;
        }, 0);
        
        // VSCodeに変更を通知
        if (notifyCallback) {
            notifyCallback();
        }
    }

    /**
     * Redo操作を実行
     * @param {Function} notifyCallback - 変更を通知するコールバック
     */
    performRedo(notifyCallback) {
        // VSCodeにRedo操作の開始を通知（タイムスタンプ更新のため）
        if (this.vscodeApi) {
            this.vscodeApi.postMessage({ type: 'undoRedo' });
        }
        
        // 保留中の保存があればキャンセル（Redoは保存しない）
        if (this.saveStateTimeout) {
            clearTimeout(this.saveStateTimeout);
            this.saveStateTimeout = null;
        }
        
        if (this.redoStack.length === 0) return;
        
        this.isRestoringState = true;
        
        // 現在の状態をUndoスタックに保存
        const currentState = {
            html: this.editor.innerHTML,
            selection: this.saveSelection()
        };
        this.undoStack.push(currentState);
        
        // Redoスタックから状態を復元
        const state = this.redoStack.pop();
        const scrollTop = this.editor.scrollTop;
        this.editor.innerHTML = state.html;
        this.restoreSelection(state.selection);
        this.editor.scrollTop = scrollTop;

        this.isRestoringState = false;

        // エディタにフォーカスを維持（スクロールを防止）
        const scrollTopAfter = this.editor.scrollTop;
        setTimeout(() => {
            try { this.editor.focus({ preventScroll: true }); } catch (e) { this.editor.focus(); }
            this.editor.scrollTop = scrollTopAfter;
        }, 0);
        
        // VSCodeに変更を通知
        if (notifyCallback) {
            notifyCallback();
        }
    }

    /**
     * 状態復元中かどうかを取得
     * @returns {boolean} 状態復元中の場合true
     */
    isRestoring() {
        return this.isRestoringState;
    }

    /**
     * 履歴をクリア
     */
    clearHistory() {
        this.undoStack = [];
        this.redoStack = [];
    }
}

// Made with Bob
