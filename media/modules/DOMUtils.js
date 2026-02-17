// @ts-nocheck
/**
 * DOM操作ユーティリティモジュール
 * DOM要素の検索、操作、テキストノード処理などの共通機能を提供
 */

export class DOMUtils {
    constructor(editor) {
        this.editor = editor;
    }

    /**
     * 指定されたタグ名の親要素を取得
     * @param {Node} node - 開始ノード
     * @param {string} tagName - 検索するタグ名
     * @returns {Element|null} 見つかった親要素、またはnull
     */
    getParentElement(node, tagName) {
        let current = node.nodeType === 3 ? node.parentElement : node;
        while (current && current !== this.editor) {
            if (current.tagName === tagName) {
                return current;
            }
            current = current.parentElement;
        }
        return null;
    }

    /**
     * 要素がブロック要素かどうかを判定
     * @param {Element} element - チェックする要素
     * @returns {boolean} ブロック要素の場合true
     */
    isBlockElement(element) {
        const blockTags = ['P', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'BLOCKQUOTE', 'PRE'];
        return blockTags.includes(element.tagName);
    }

    /**
     * 要素内のすべてのテキストノードを取得
     * @param {Element} element - 検索対象の要素
     * @returns {Text[]} テキストノードの配列
     */
    getTextNodes(element) {
        const textNodes = [];
        const walker = document.createTreeWalker(
            element,
            NodeFilter.SHOW_TEXT,
            null,
            false
        );

        let node;
        while (node = walker.nextNode()) {
            textNodes.push(node);
        }

        return textNodes;
    }

    /**
     * 要素内の最初のテキストノードを取得
     * @param {Element} element - 検索対象の要素
     * @returns {Text|null} 最初のテキストノード、またはnull
     */
    getFirstTextNode(element) {
        const textNodes = this.getTextNodes(element);
        return textNodes.length > 0 ? textNodes[0] : null;
    }

    /**
     * 要素内の最後のテキストノードを取得
     * @param {Element} element - 検索対象の要素
     * @returns {Text|null} 最後のテキストノード、またはnull
     */
    getLastTextNode(element) {
        const textNodes = this.getTextNodes(element);
        return textNodes.length > 0 ? textNodes[textNodes.length - 1] : null;
    }

    /**
     * 次のテキストノードを取得
     * @param {Node} node - 開始ノード
     * @returns {Text|null} 次のテキストノード、またはnull
     */
    getNextTextNode(node) {
        const walker = document.createTreeWalker(
            this.editor,
            NodeFilter.SHOW_TEXT,
            null,
            false
        );

        walker.currentNode = node;
        return walker.nextNode();
    }

    /**
     * 前のテキストノードを取得
     * @param {Node} node - 開始ノード
     * @returns {Text|null} 前のテキストノード、またはnull
     */
    getPreviousTextNode(node) {
        const walker = document.createTreeWalker(
            this.editor,
            NodeFilter.SHOW_TEXT,
            null,
            false
        );

        walker.currentNode = node;
        return walker.previousNode();
    }

    /**
     * HTMLから不要な要素を除去してクリーンアップ
     * @returns {string} クリーンアップされたHTML
     */
    getCleanedHTML() {
        // チェックボックスのcheckedプロパティをHTML属性に同期
        // (プロパティの変更はinnerHTMLに反映されないため)
        const checkboxes = this.editor.querySelectorAll('input[type="checkbox"]');
        checkboxes.forEach(cb => {
            if (cb.checked) {
                cb.setAttribute('checked', '');
            } else {
                cb.removeAttribute('checked');
            }
        });

        // エディタの内容をクローン
        const clone = this.editor.cloneNode(true);

        // コードブロックツールバーを削除
        const toolbars = clone.querySelectorAll('.code-block-toolbar');
        toolbars.forEach(toolbar => {
            toolbar.remove();
        });

        // data-exclude-from-markdown属性を持つ要素を削除
        const excludedElements = clone.querySelectorAll('[data-exclude-from-markdown="true"]');
        excludedElements.forEach(element => {
            element.remove();
        });

        // テーブル選択用のクラスを削除
        const selectedCells = clone.querySelectorAll('.md-table-cell-selected');
        selectedCells.forEach(cell => {
            cell.classList.remove('md-table-cell-selected');
        });
        const selectedStructureCells = clone.querySelectorAll('.md-table-structure-selected-cell');
        selectedStructureCells.forEach(cell => {
            cell.classList.remove('md-table-structure-selected-cell');
        });

        // Normalize table cells so browser-inserted BR/DIV/P don't break Markdown table rows.
        const tableCells = clone.querySelectorAll('td, th');
        tableCells.forEach(cell => {
            const hasText = (cell.textContent || '').replace(/[\u200B\u00A0]/g, '').trim() !== '';
            const hasProblematicStructure =
                !!cell.querySelector('br') || !!cell.querySelector(':scope > div, :scope > p');

            if (!hasText) {
                const emptyArtifacts = cell.querySelectorAll('br, div, p');
                emptyArtifacts.forEach(node => node.remove());
                return;
            }

            if (hasProblematicStructure) {
                const normalized = (cell.textContent || '')
                    .replace(/[\u200B\u00A0]/g, ' ')
                    .replace(/\s+/g, ' ')
                    .trim();
                cell.textContent = normalized;
            }
        });

        // テーブルラッパーを解除
        const tableWrappers = clone.querySelectorAll('.md-table-wrapper');
        tableWrappers.forEach(wrapper => {
            const table = wrapper.querySelector('table');
            if (table) {
                wrapper.replaceWith(table);
            }
        });

        // nested-list-onlyクラスを削除（表示用のクラスなのでMarkdownには含めない）
        const nestedListOnlyItems = clone.querySelectorAll('.nested-list-only');
        nestedListOnlyItems.forEach(item => {
            item.classList.remove('nested-list-only');
        });

        // Remove empty links that have lost their visible text.
        // Keep links that wrap images.
        const anchors = clone.querySelectorAll('a');
        anchors.forEach(anchor => {
            if (anchor.querySelector('img')) {
                return;
            }
            const text = (anchor.textContent || '').replace(/[\u200B\uFEFF\u00A0\s]/g, '');
            if (text !== '') {
                return;
            }
            const hasMeaningfulChild = Array.from(anchor.childNodes || []).some(child => {
                if (!child) return false;
                if (child.nodeType === Node.TEXT_NODE) {
                    return (child.textContent || '').replace(/[\u200B\uFEFF\u00A0\s]/g, '') !== '';
                }
                if (child.nodeType !== Node.ELEMENT_NODE) return false;
                return child.tagName !== 'BR';
            });
            if (!hasMeaningfulChild) {
                anchor.remove();
            }
        });

        // 空のリストアイテムのクリーンアップ
        // 注意：ユーザーが意図的に作成した空のリストアイテム（サブリストを含む）は保持する
        // このクリーンアップは、ブラウザが自動生成した不要な空のリストアイテムのみを対象とする
        const listItems = clone.querySelectorAll('li');
        listItems.forEach(li => {
            // まず、空白のみのテキストノードとBRタグを削除
            const childNodesToRemove = [];
            for (let child of li.childNodes) {
                if (child.nodeType === Node.TEXT_NODE && child.textContent.trim() === '') {
                    childNodesToRemove.push(child);
                } else if (child.nodeType === Node.ELEMENT_NODE && child.tagName === 'BR') {
                    childNodesToRemove.push(child);
                }
            }
            childNodesToRemove.forEach(node => node.remove());

            // 直接の子ノードをチェック（サブリストを除く）
            let hasDirectTextContent = false;
            let hasSublist = false;

            for (let child of li.childNodes) {
                if (child.nodeType === Node.TEXT_NODE) {
                    if (child.textContent.trim() !== '') {
                        hasDirectTextContent = true;
                        break;
                    }
                } else if (child.nodeType === Node.ELEMENT_NODE) {
                    const tagName = child.tagName;
                    if (tagName === 'UL' || tagName === 'OL') {
                        hasSublist = true;
                    } else {
                        hasDirectTextContent = true;
                        break;
                    }
                }
            }

            // 空のリストアイテムにサブリストがある場合は保持する
            // これはユーザーが意図的に作成したものである可能性が高い
            // 例: "- \n  - nested" のような構造
            //
            // クリーンアップは行わない - サブリストのみを含む空のリストアイテムも有効な構造
        });

        // カーソル配置用のゼロ幅スペースを削除
        let html = clone.innerHTML;
        html = html.replace(/[\u200B\uFEFF]/g, '');

        return html;
    }

    /**
     * 空のリストアイテムをクリーンアップ
     */
    cleanupEmptyListItems() {
        const selection = window.getSelection();
        if (!selection || !selection.rangeCount) return;

        const range = selection.getRangeAt(0);
        const currentContainer = range.commonAncestorContainer;
        const currentListItem = this.getParentElement(currentContainer, 'LI');

        const allListItems = this.editor.querySelectorAll('li');
        for (let li of allListItems) {
            // カーソルが現在位置しているリストアイテムはスキップ
            if (li === currentListItem) continue;
            if (li.getAttribute('data-preserve-empty') === 'true') continue;
            if (li.querySelector(':scope > input[type="checkbox"]')) continue;

            // リストアイテムが空かチェック（空白、<br>、または<span><br></span>のみ）
            const textContent = li.textContent.trim();
            if (textContent === '') {
                // 内容のある兄弟要素があるかチェック
                const nextSibling = li.nextElementSibling;
                const prevSibling = li.previousElementSibling;

                const hasContentSibling =
                    (nextSibling && nextSibling.tagName === 'LI' && nextSibling.textContent.trim() !== '') ||
                    (prevSibling && prevSibling.tagName === 'LI' && prevSibling.textContent.trim() !== '');

                if (hasContentSibling) {
                    // 空のリストアイテムを削除（ブラウザが自動生成したもの）
                    li.remove();
                }
            }
        }
    }

    /**
     * インラインコード要素のゼロ幅スペースを整理
     */
    ensureInlineCodeSpaces() {
        const inlineCodes = this.editor.querySelectorAll('code:not(pre code)');
        const selection = window.getSelection();
        let activeCode = null;
        let activeOffset = null;

        if (selection && selection.rangeCount > 0 && selection.isCollapsed) {
            const range = selection.getRangeAt(0);
            const codeElement = this.getParentElement(range.commonAncestorContainer, 'CODE');
            const preBlock = codeElement ? this.getParentElement(codeElement, 'PRE') : null;
            if (codeElement && !preBlock) {
                activeCode = codeElement;
                try {
                    const tempRange = document.createRange();
                    tempRange.selectNodeContents(codeElement);
                    tempRange.setEnd(range.startContainer, range.startOffset);
                    activeOffset = tempRange.toString().replace(/[\u200B\uFEFF]/g, '').length;
                } catch (e) {
                    activeCode = null;
                    activeOffset = null;
                }
            }
        }

        inlineCodes.forEach(code => {
            const parent = code.parentElement;
            if (!parent) return;

            const prevSibling = code.previousSibling;
            if (prevSibling && prevSibling.nodeType === Node.TEXT_NODE &&
                prevSibling.textContent.replace(/[\u200B\uFEFF]/g, '') === '') {
                prevSibling.remove();
            }

            const nextSibling = code.nextSibling;
            if (nextSibling && nextSibling.nodeType === Node.TEXT_NODE &&
                nextSibling.textContent.replace(/[\u200B\uFEFF]/g, '') === '') {
                nextSibling.remove();
            }

            const rawText = code.textContent || '';
            const normalized = rawText.replace(/[\u200B\uFEFF]/g, '');

            if (normalized === '') {
                // 内容が空の場合
                if (code.getAttribute('data-is-new') === 'true') {
                    // 新規作成されたばかりの場合は保持する（カーソル配置用）
                    if (rawText !== '\u200B' || code.childNodes.length !== 1) {
                        code.textContent = '\u200B';
                    }
                } else {
                    // 空で新規作成でない場合は削除
                    // テキストノードとして空文字を挿入してカーソル位置を保持できるようにする
                    const emptyText = document.createTextNode('\u200B');
                    code.replaceWith(emptyText);

                    // 削除されたcodeがあった場所を記録（カーソル復元用）
                    if (selection && selection.rangeCount > 0) {
                        const range = selection.getRangeAt(0);
                        if (code.contains(range.startContainer)) {
                            const newRange = document.createRange();
                            newRange.setStart(emptyText, 1);
                            newRange.collapse(true);
                            selection.removeAllRanges();
                            selection.addRange(newRange);
                        }
                    }
                }
            } else {
                // 内容がある場合、新規フラグを削除
                if (code.hasAttribute('data-is-new')) {
                    code.removeAttribute('data-is-new');
                }

                // 非空のインラインコードは先頭ZWSPを持たせない。
                // 先頭ZWSPがあると折り返し位置になり、1行目が空白になることがある。
                const desired = normalized;
                if (rawText !== desired) {
                    code.textContent = desired;
                }
            }
        });

        if (activeCode && activeOffset !== null && selection) {
            const textNode = activeCode.firstChild;
            if (textNode && textNode.nodeType === Node.TEXT_NODE) {
                const rawText = textNode.textContent || '';
                const normalizedLength = rawText.replace(/[\u200B\uFEFF]/g, '').length;
                let targetOffset = normalizedLength === 0 ? rawText.length : Math.min(activeOffset, normalizedLength);
                const newRange = document.createRange();
                newRange.setStart(textNode, targetOffset);
                newRange.collapse(true);
                selection.removeAllRanges();
                selection.addRange(newRange);
            }
        }
    }

    /**
     * ゴーストスタイル（削除されたインラインコードのスタイルが残ったもの）をクリーンアップ
     */
    cleanupGhostStyles() {
        // fontタグと、スタイルを持つspanタグを検索
        // Markdownエディタとして不要なスタイル属性を持つspanを対象にする
        const ghostElements = this.editor.querySelectorAll('font, span[style*="font-family"], span[style*="background-color"], span[style*="font-size"]');
        let cleaned = false;

        ghostElements.forEach(element => {
            // 要素をアンラップ（子要素を保持したまま親要素のみ削除）
            const parent = element.parentNode;
            if (!parent) return;

            while (element.firstChild) {
                parent.insertBefore(element.firstChild, element);
            }
            element.remove();
            cleaned = true;
        });

        // 連続するテキストノードを結合（正規化）
        if (cleaned) {
            this.editor.normalize();
        }

        return cleaned;
    }
}

// Made with Bob
