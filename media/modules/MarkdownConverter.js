// @ts-nocheck
/**
 * Markdown変換モジュール
 * Markdown構文をHTMLに変換する機能を提供
 */

export class MarkdownConverter {
    constructor(editor, domUtils) {
        this.editor = editor;
        this.domUtils = domUtils;
    }

    /**
     * 隣接する同じタイプのリストをマージする
     * @param {HTMLElement} listElement - マージ対象のリスト要素(UL/OL)
     * @returns {HTMLElement} マージ後のリスト要素
     */
    mergeAdjacentLists(listElement) {
        if (!listElement) return listElement;
        const tagName = listElement.tagName;

        // 前の兄弟とマージ
        const prev = listElement.previousElementSibling;
        if (prev && prev.tagName === tagName) {
            while (listElement.firstChild) {
                prev.appendChild(listElement.firstChild);
            }
            listElement.remove();
            listElement = prev;
        }

        // 次の兄弟とマージ
        const next = listElement.nextElementSibling;
        if (next && next.tagName === tagName) {
            while (next.firstChild) {
                listElement.appendChild(next.firstChild);
            }
            next.remove();
        }

        return listElement;
    }

    /**
     * Markdown構文をHTMLに変換
     * @param {Function} notifyCallback - 変更を通知するコールバック
     * @returns {boolean} 変換が実行された場合true、それ以外はfalse
     */
    convertMarkdownSyntax(notifyCallback) {
        const selection = window.getSelection();
        if (!selection || !selection.rangeCount) return false;

        const range = selection.getRangeAt(0);
        const container = range.commonAncestorContainer;
        let textNode = container.nodeType === 3 ? container : null;
        let cursorOffset = null;
        const isMeaningfulTextNode = (node) => {
            if (!node || node.nodeType !== 3) return false;
            const text = (node.textContent || '').replace(/[\u200B\u00A0]/g, '');
            return text.trim() !== '';
        };
        const findDirectTextNode = (element) => {
            if (!element) return null;
            const walker = document.createTreeWalker(
                element,
                NodeFilter.SHOW_TEXT,
                {
                    acceptNode: (node) => {
                        if (!isMeaningfulTextNode(node)) {
                            return NodeFilter.FILTER_SKIP;
                        }
                        let parent = node.parentElement;
                        while (parent && parent !== element) {
                            if (parent.tagName === 'UL' || parent.tagName === 'OL') {
                                return NodeFilter.FILTER_REJECT;
                            }
                            parent = parent.parentElement;
                        }
                        return NodeFilter.FILTER_ACCEPT;
                    }
                }
            );
            return walker.nextNode();
        };

        if (textNode) {
            cursorOffset = range.startOffset;
        } else if (container.nodeType === 1) {
            const childNodes = container.childNodes;
            const before = range.startOffset > 0 ? childNodes[range.startOffset - 1] : null;
            const after = childNodes[range.startOffset] || null;

            if (before && before.nodeType === Node.TEXT_NODE && isMeaningfulTextNode(before)) {
                textNode = before;
                cursorOffset = before.textContent.length;
            } else if (after && after.nodeType === Node.TEXT_NODE && isMeaningfulTextNode(after)) {
                textNode = after;
                cursorOffset = 0;
            } else if (before && before.nodeType === Node.ELEMENT_NODE) {
                textNode = this.domUtils.getLastTextNode(before);
                if (textNode) {
                    cursorOffset = textNode.textContent.length;
                }
            } else if (after && after.nodeType === Node.ELEMENT_NODE) {
                textNode = this.domUtils.getFirstTextNode(after);
                if (textNode) {
                    cursorOffset = 0;
                }
            }
        }

        if ((!textNode || !isMeaningfulTextNode(textNode)) && container.nodeType === 1) {
            const fallbackNode = findDirectTextNode(container);
            if (fallbackNode) {
                textNode = fallbackNode;
                cursorOffset = fallbackNode === range.startContainer ? range.startOffset : fallbackNode.textContent.length;
            }
        }

        if (!textNode || textNode.nodeType !== 3 || cursorOffset === null) return false;

        const rawText = textNode.textContent || '';
        const normalizedText = rawText.replace(/[\u200B\u00A0]/g, '');
        const normalizedCursorOffset = rawText.slice(0, cursorOffset).replace(/[\u200B\u00A0]/g, '').length;

        // 見出し構文をチェック（行頭）
        const headingMatch = normalizedText.match(/^\s*(#{1,6})\s+(.+)$/);
        if (headingMatch) {
            const level = headingMatch[1].length;
            const content = headingMatch[2];
            const headingTag = 'h' + level;

            const heading = document.createElement(headingTag);
            heading.textContent = content;

            const parent = textNode.parentElement;
            if (parent && parent !== this.editor) {
                parent.replaceWith(heading);
            } else {
                textNode.parentNode.replaceChild(heading, textNode);
            }

            // カーソル位置を復元
            const newRange = document.createRange();
            const textContent = heading.firstChild;
            if (textContent) {
                const newOffset = Math.min(content.length, normalizedCursorOffset - headingMatch[1].length - 1);
                newRange.setStart(textContent, Math.max(0, newOffset));
                newRange.collapse(true);
                selection.removeAllRanges();
                selection.addRange(newRange);
            }

            if (notifyCallback) notifyCallback();
            return true;
        }

        // 太字構文をチェック **text**
        const boldMatch = normalizedText.match(/\*\*([^*]+)\*\*$/);
        if (boldMatch && normalizedCursorOffset === normalizedText.length) {
            const beforeText = normalizedText.substring(0, normalizedText.length - boldMatch[0].length);
            const boldText = boldMatch[1];

            const parent = textNode.parentElement;
            const fragment = document.createDocumentFragment();

            if (beforeText) {
                fragment.appendChild(document.createTextNode(beforeText));
            }

            const strong = document.createElement('strong');
            strong.textContent = boldText;
            fragment.appendChild(strong);

            // 後ろにスペースを追加
            fragment.appendChild(document.createTextNode(' '));

            textNode.parentNode.replaceChild(fragment, textNode);

            // 太字テキストの後にカーソルを設定
            const newRange = document.createRange();
            const lastNode = fragment.lastChild;
            newRange.setStart(lastNode, 1);
            newRange.collapse(true);
            selection.removeAllRanges();
            selection.addRange(newRange);

            if (notifyCallback) notifyCallback();
            return true;
        }

        // イタリック構文をチェック *text*
        const italicMatch = normalizedText.match(/(?<!\*)\*([^*]+)\*(?!\*)$/);
        if (italicMatch && normalizedCursorOffset === normalizedText.length) {
            const beforeText = normalizedText.substring(0, normalizedText.length - italicMatch[0].length);
            const italicText = italicMatch[1];

            const parent = textNode.parentElement;
            const fragment = document.createDocumentFragment();

            if (beforeText) {
                fragment.appendChild(document.createTextNode(beforeText));
            }

            const em = document.createElement('em');
            em.textContent = italicText;
            fragment.appendChild(em);

            // 後ろにスペースを追加
            fragment.appendChild(document.createTextNode(' '));

            textNode.parentNode.replaceChild(fragment, textNode);

            // イタリックテキストの後にカーソルを設定
            const newRange = document.createRange();
            const lastNode = fragment.lastChild;
            newRange.setStart(lastNode, 1);
            newRange.collapse(true);
            selection.removeAllRanges();
            selection.addRange(newRange);

            if (notifyCallback) notifyCallback();
            return true;
        }

        // 取り消し線構文をチェック ~~text~~（カーソル直前の範囲で判定）
        const beforeCursorText = normalizedText.slice(0, normalizedCursorOffset);
        const strikeMatch = beforeCursorText.match(/~~([^~]+)~~(\s*)$/);
        if (strikeMatch) {
            const matchedText = strikeMatch[0];
            const strikeText = strikeMatch[1];
            const trailingSpace = strikeMatch[2] || '';
            const beforeText = beforeCursorText.substring(0, beforeCursorText.length - matchedText.length);
            const afterText = normalizedText.slice(normalizedCursorOffset);

            const fragment = document.createDocumentFragment();

            if (beforeText) {
                fragment.appendChild(document.createTextNode(beforeText));
            }

            const del = document.createElement('del');
            del.textContent = strikeText;
            fragment.appendChild(del);

            const spacerText = trailingSpace !== '' ? trailingSpace : ' ';
            const spacerNode = document.createTextNode(spacerText);
            fragment.appendChild(spacerNode);

            if (afterText) {
                fragment.appendChild(document.createTextNode(afterText));
            }

            textNode.parentNode.replaceChild(fragment, textNode);

            // 取り消し線テキストの後にカーソルを設定
            const newRange = document.createRange();
            newRange.setStart(spacerNode, spacerNode.textContent.length);
            newRange.collapse(true);
            selection.removeAllRanges();
            selection.addRange(newRange);

            if (notifyCallback) notifyCallback();
            return true;
        }

        // インラインコード構文をチェック `code`
        // カーソル位置基準で判定し、既存テキストの途中入力（例: aa`bb`cc）も変換対象にする
        const codeMatch = beforeCursorText.match(/`([^`]+)`$/);
        const parentIsCode = textNode.parentNode && textNode.parentNode.tagName === 'CODE';

        if (codeMatch && !parentIsCode) {
            const matchedText = codeMatch[0];
            const beforeText = beforeCursorText.substring(0, beforeCursorText.length - matchedText.length);
            const codeText = codeMatch[1];
            const afterText = normalizedText.slice(normalizedCursorOffset);

            const parent = textNode.parentElement;
            const fragment = document.createDocumentFragment();

            if (beforeText) {
                fragment.appendChild(document.createTextNode(beforeText));
            }

            const code = document.createElement('code');
            code.textContent = codeText;
            fragment.appendChild(code);

            // カーソル移動用の見えないスペースを追加
            const spacer = document.createTextNode('\u200B');
            fragment.appendChild(spacer);

            if (afterText) {
                fragment.appendChild(document.createTextNode(afterText));
            }

            // テキストノードをフラグメントで置き換え
            const parentNode = textNode.parentNode;
            parentNode.replaceChild(fragment, textNode);

            // code要素の直後のスペースにカーソルを設定
            const newRange = document.createRange();
            newRange.setStart(spacer, 1);
            newRange.collapse(true);
            selection.removeAllRanges();
            selection.addRange(newRange);

            if (notifyCallback) notifyCallback();
            return true;
        }

        // 水平線構文をチェック --- (3つ以上のハイフンのみ)
        const hrMatch = normalizedText.match(/^-{3,}$/);
        if (hrMatch) {
            const hr = document.createElement('hr');

            const parent = textNode.parentElement;
            if (parent && parent !== this.editor) {
                parent.replaceWith(hr);
            } else {
                textNode.parentNode.replaceChild(hr, textNode);
            }

            // 水平線の後に新しい段落を作成してカーソルを移動
            const newParagraph = document.createElement('p');
            newParagraph.appendChild(document.createElement('br'));
            if (hr.nextSibling) {
                hr.parentNode.insertBefore(newParagraph, hr.nextSibling);
            } else {
                hr.parentNode.appendChild(newParagraph);
            }

            const newRange = document.createRange();
            newRange.setStart(newParagraph, 0);
            newRange.collapse(true);
            selection.removeAllRanges();
            selection.addRange(newRange);

            if (notifyCallback) notifyCallback();
            return true;
        }

        // 順序なしリスト構文をチェック - item / - [ ] task
        const ulMatch = normalizedText.match(/^\s*[-*]\s+(.*)$/);
        if (ulMatch) {
            const rawContent = ulMatch[1] ?? '';
            const content = rawContent.trim() === '' ? '' : rawContent;
            const taskMatch = rawContent.match(/^\[( |x|X)\](.*)$/);
            const isTaskItem = !!(
                taskMatch &&
                (taskMatch[2] === '' || /^[ \u00A0]/.test(taskMatch[2] || ''))
            );
            const taskChecked = !!(isTaskItem && taskMatch[1].toLowerCase() === 'x');
            const taskText = isTaskItem
                ? (taskMatch[2] || '').replace(/^[ \u00A0]/, '')
                : '';
            const listText = isTaskItem ? taskText : content;

            const li = document.createElement('li');
            let textContentNode = null;
            if (isTaskItem) {
                const checkbox = document.createElement('input');
                checkbox.type = 'checkbox';
                if (taskChecked) {
                    checkbox.checked = true;
                    checkbox.setAttribute('checked', '');
                }
                li.appendChild(checkbox);
                textContentNode = document.createTextNode(listText === '' ? '\u200B' : listText);
                li.appendChild(textContentNode);
            } else if (content) {
                li.textContent = content;
                textContentNode = li.firstChild;
            } else {
                textContentNode = document.createTextNode('');
                li.appendChild(textContentNode);
            }

            const parent = textNode.parentElement;
            let ul = this.domUtils.getParentElement(textNode, 'UL');

            if (!ul) {
                // OLの中にいる場合、リストタイプを変換する（ネストしない）
                const existingOl = this.domUtils.getParentElement(textNode, 'OL');
                if (existingOl && parent && parent.tagName === 'LI') {
                    const currentLi = parent;
                    ul = document.createElement('ul');

                    const siblings = Array.from(existingOl.children);
                    const index = siblings.indexOf(currentLi);

                    existingOl.after(ul);

                    // 現在のLIの後ろにある兄弟要素を新しいOLに移動
                    const siblingsAfter = siblings.slice(index + 1);
                    if (siblingsAfter.length > 0) {
                        const newOl = document.createElement('ol');
                        siblingsAfter.forEach(s => newOl.appendChild(s));
                        ul.after(newOl);
                    }

                    currentLi.remove();
                    ul.appendChild(li);

                    if (existingOl.children.length === 0) {
                        existingOl.remove();
                    }
                } else {
                    ul = document.createElement('ul');
                    if (parent && parent !== this.editor) {
                        parent.replaceWith(ul);
                    } else {
                        textNode.parentNode.replaceChild(ul, textNode);
                    }
                    ul.appendChild(li);
                }
            } else {
                if (parent && parent.tagName === 'LI') {
                    parent.replaceWith(li);
                } else {
                    textNode.parentNode.replaceChild(li, textNode);
                }
            }

            // 隣接する同タイプのリストをマージ
            this.mergeAdjacentLists(ul);

            // カーソル位置を復元
            const newRange = document.createRange();
            if (textContentNode) {
                const markerLength = ulMatch[0].length - listText.length;
                const newOffset = Math.min(listText.length, Math.max(0, normalizedCursorOffset - markerLength));
                newRange.setStart(textContentNode, isTaskItem && listText.length === 0 ? 0 : newOffset);
                newRange.collapse(true);
                selection.removeAllRanges();
                selection.addRange(newRange);
            }

            if (notifyCallback) notifyCallback();
            return true;
        }

        // 順序付きリスト構文をチェック 1. item
        const olMatch = normalizedText.match(/^\s*\d+\.\s+(.*)$/);
        if (olMatch) {
            const rawContent = olMatch[1] ?? '';
            const content = rawContent.trim() === '' ? '' : rawContent;

            const li = document.createElement('li');
            let textContentNode = null;
            if (content) {
                li.textContent = content;
                textContentNode = li.firstChild;
            } else {
                textContentNode = document.createTextNode('');
                li.appendChild(textContentNode);
            }

            const parent = textNode.parentElement;
            let ol = this.domUtils.getParentElement(textNode, 'OL');

            if (!ol) {
                // ULの中にいる場合、リストタイプを変換する（ネストしない）
                const existingUl = this.domUtils.getParentElement(textNode, 'UL');
                if (existingUl && parent && parent.tagName === 'LI') {
                    const currentLi = parent;
                    ol = document.createElement('ol');

                    const siblings = Array.from(existingUl.children);
                    const index = siblings.indexOf(currentLi);

                    existingUl.after(ol);

                    // 現在のLIの後ろにある兄弟要素を新しいULに移動
                    const siblingsAfter = siblings.slice(index + 1);
                    if (siblingsAfter.length > 0) {
                        const newUl = document.createElement('ul');
                        siblingsAfter.forEach(s => newUl.appendChild(s));
                        ol.after(newUl);
                    }

                    currentLi.remove();
                    ol.appendChild(li);

                    if (existingUl.children.length === 0) {
                        existingUl.remove();
                    }
                } else {
                    ol = document.createElement('ol');
                    if (parent && parent !== this.editor) {
                        parent.replaceWith(ol);
                    } else {
                        textNode.parentNode.replaceChild(ol, textNode);
                    }
                    ol.appendChild(li);
                }
            } else {
                if (parent && parent.tagName === 'LI') {
                    parent.replaceWith(li);
                } else {
                    textNode.parentNode.replaceChild(li, textNode);
                }
            }

            // 隣接する同タイプのリストをマージ
            this.mergeAdjacentLists(ol);

            // カーソル位置を復元
            const newRange = document.createRange();
            if (textContentNode) {
                const markerLength = olMatch[0].length - content.length;
                const newOffset = Math.min(content.length, Math.max(0, normalizedCursorOffset - markerLength));
                newRange.setStart(textContentNode, newOffset);
                newRange.collapse(true);
                selection.removeAllRanges();
                selection.addRange(newRange);
            }

            if (notifyCallback) notifyCallback();
            return true;
        }

        // 引用構文をチェック > text（テキストが必要）
        const blockquoteMatch = normalizedText.match(/^\s*>\s+(.+)$/);
        if (blockquoteMatch) {
            const content = blockquoteMatch[1];

            const blockquote = document.createElement('blockquote');
            const p = document.createElement('p');
            p.textContent = content;
            const textContentNode = p.firstChild;
            blockquote.appendChild(p);

            const parent = textNode.parentElement;
            if (parent && parent !== this.editor) {
                parent.replaceWith(blockquote);
            } else {
                textNode.parentNode.replaceChild(blockquote, textNode);
            }

            // カーソル位置を復元
            const newRange = document.createRange();
            if (textContentNode) {
                const markerLength = blockquoteMatch[0].length - content.length;
                const newOffset = Math.min(content.length, Math.max(0, normalizedCursorOffset - markerLength));
                newRange.setStart(textContentNode, newOffset);
                newRange.collapse(true);
                selection.removeAllRanges();
                selection.addRange(newRange);
            }

            if (notifyCallback) notifyCallback();
            return true;
        }

        // URL自動リンク化をチェック（URLの後にスペースで確定）
        const textBeforeCursor = normalizedText.slice(0, normalizedCursorOffset);
        const urlAutoLinkMatch = textBeforeCursor.match(/(https?:\/\/[^\s]+)\s$/);
        if (urlAutoLinkMatch) {
            const url = urlAutoLinkMatch[1];
            const matchIndex = urlAutoLinkMatch.index;
            const beforeUrl = normalizedText.slice(0, matchIndex);
            const afterCursorText = normalizedText.slice(normalizedCursorOffset);

            // 既にリンク内またはコード内にいる場合はスキップ
            const parentLink = textNode.parentElement && textNode.parentElement.closest
                ? textNode.parentElement.closest('a')
                : null;
            const parentIsCode = textNode.parentNode && textNode.parentNode.tagName === 'CODE';
            if (!parentLink && !parentIsCode) {
                const fragment = document.createDocumentFragment();

                if (beforeUrl) {
                    fragment.appendChild(document.createTextNode(beforeUrl));
                }

                const link = document.createElement('a');
                link.href = url;
                link.textContent = url;
                fragment.appendChild(link);

                // スペースを追加
                const spacerNode = document.createTextNode(' ');
                fragment.appendChild(spacerNode);

                if (afterCursorText) {
                    fragment.appendChild(document.createTextNode(afterCursorText));
                }

                textNode.parentNode.replaceChild(fragment, textNode);

                // カーソルをスペースの後に設定
                const newRange = document.createRange();
                newRange.setStart(spacerNode, 1);
                newRange.collapse(true);
                selection.removeAllRanges();
                selection.addRange(newRange);

                if (notifyCallback) notifyCallback();
                return true;
            }
        }

        // 変換が実行されなかった
        return false;
    }
}

// Made with Bob
