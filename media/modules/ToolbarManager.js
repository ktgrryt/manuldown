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
    }

    /**
     * ツールバーをセットアップ
     */
    setup() {
        const buttons = document.querySelectorAll('.toolbar-btn');
        buttons.forEach(button => {
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
    }

    /**
     * フォーマットコマンドを実行
     * @param {string} command - 実行するコマンド
     */
    executeCommand(command) {
        this.editor.focus();

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
                document.execCommand('insertUnorderedList', false, null);
                break;
            case 'ol':
                document.execCommand('insertOrderedList', false, null);
                break;
            case 'checkbox':
                this.insertCheckboxList();
                break;
            case 'quote':
                this.formatBlock('blockquote');
                break;
        }
    }

    /**
     * チェックボックスリストを挿入
     */
    insertCheckboxList() {
        const selection = window.getSelection();
        if (!selection || !selection.rangeCount) return;

        const range = selection.getRangeAt(0);
        const container = range.commonAncestorContainer;
        const block = container.nodeType === 3 ? container.parentElement : container;

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
            for (const child of li.childNodes) {
                if (child === checkbox) continue;
                if (child.nodeType === Node.ELEMENT_NODE && child.tagName === 'INPUT') continue;
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

            if (!firstContentNode) {
                li.appendChild(document.createTextNode('\u200B'));
            }
        };

        // 現在のブロック要素を取得
        let currentBlock = block;
        while (currentBlock && currentBlock !== this.editor) {
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
        while (currentBlock && currentBlock !== this.editor && currentBlock.parentElement !== this.editor) {
            currentBlock = currentBlock.parentElement;
        }
        if (currentBlock && currentBlock !== this.editor) {
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
