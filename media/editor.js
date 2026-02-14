// @ts-nocheck
import { DOMUtils } from './modules/DOMUtils.js';
import { StateManager } from './modules/StateManager.js';
import { CursorManager } from './modules/CursorManager.js';
import { ListManager } from './modules/ListManager.js';
import { MarkdownConverter } from './modules/MarkdownConverter.js';
import { CodeBlockManager } from './modules/CodeBlockManager.js';
import { TableOfContentsManager } from './modules/TableOfContentsManager.js';
import { ToolbarManager } from './modules/ToolbarManager.js';
import { TableManager } from './modules/TableManager.js';
import { SearchManager } from './modules/SearchManager.js';

(function () {
    // @ts-ignore
    const vscode = acquireVsCodeApi();
    const editor = document.getElementById('editor');
    let isUpdating = false;
    let isComposing = false;
    let notifyTimeout = null;
    let pendingDeleteListItem = null;
    let pendingStrikeCleanup = false;
    let pendingEmptyListItemInsert = null;
    let pendingListMouseAdjustment = null;
    let pendingMouseDriftCorrection = null;
    let lastPointerCaretIntentTs = 0;
    let lastPointerCheckboxClickTs = 0;
    let lastCtrlNavKeydownTs = 0;
    let lastCtrlNavCommandTs = 0;
    let lastCtrlNavDirection = null;
    let scrollbarDragState = null;

    const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;

    const initialSettings = window.__manulDownSettings || {};
    const settingsState = {
        toolbarVisible: initialSettings.toolbarVisible !== false,
        tocEnabled: initialSettings.tocEnabled !== false,
        useVsCodeCtrlP: initialSettings.useVsCodeCtrlP !== false,
        listDashStyle: initialSettings.listDashStyle === true
    };
    const imageRenderMaxWidthPx = 820;
    let overflowStateRaf = null;

    function getEditorScrollbarMetrics() {
        if (!editor) return null;
        const clientHeight = editor.clientHeight;
        const scrollHeight = editor.scrollHeight;
        if (clientHeight <= 0 || scrollHeight <= clientHeight + 1) {
            return null;
        }
        const thumbHeight = Math.max(24, Math.round((clientHeight / scrollHeight) * clientHeight));
        const maxThumbTop = Math.max(0, clientHeight - thumbHeight);
        const maxScrollTop = Math.max(1, scrollHeight - clientHeight);
        return { thumbHeight, maxThumbTop, maxScrollTop };
    }

    function applyScrollFromThumbPosition(rawThumbTop, metrics) {
        if (!editor || !metrics) return;
        const thumbTop = Math.max(0, Math.min(metrics.maxThumbTop, rawThumbTop));
        const scrollRatio = metrics.maxThumbTop > 0 ? thumbTop / metrics.maxThumbTop : 0;
        editor.scrollTop = Math.round(scrollRatio * metrics.maxScrollTop);
        scheduleEditorOverflowStateUpdate();
    }

    function updateEditorOverflowState() {
        if (!editor) return;
        const hasRenderableContent = Array.from(editor.childNodes || []).some((node) => {
            if (!node) return false;
            if (node.nodeType === Node.TEXT_NODE) {
                const text = (node.textContent || '').replace(/[\u200B\uFEFF\u00A0]/g, '').trim();
                return text !== '';
            }
            if (node.nodeType !== Node.ELEMENT_NODE) {
                return false;
            }
            const element = node;
            if (element.getAttribute('data-exclude-from-markdown') === 'true') {
                return false;
            }
            if (element.classList && element.classList.contains('md-table-insert-line')) {
                return false;
            }
            return true;
        });
        editor.classList.toggle('is-empty', !hasRenderableContent);

        const metrics = getEditorScrollbarMetrics();
        const hasOverflow = !!metrics;
        editor.classList.toggle('has-overflow', hasOverflow);

        if (!editorScrollbarIndicator || !editorScrollbarThumb) return;

        const needsIndicator = hasOverflow;
        editorScrollbarIndicator.classList.toggle('visible', needsIndicator);
        if (!needsIndicator || !metrics) return;

        const scrollRatio = Math.max(0, Math.min(1, editor.scrollTop / metrics.maxScrollTop));
        const thumbTop = Math.round(scrollRatio * metrics.maxThumbTop);
        editorScrollbarThumb.style.height = `${metrics.thumbHeight}px`;
        editorScrollbarThumb.style.transform = `translateY(${thumbTop}px)`;
    }

    function scheduleEditorOverflowStateUpdate() {
        if (overflowStateRaf !== null) return;
        overflowStateRaf = requestAnimationFrame(() => {
            overflowStateRaf = null;
            updateEditorOverflowState();
        });
    }


    const syncBodySettings = () => {
        document.body.dataset.toolbarVisible = settingsState.toolbarVisible ? 'true' : 'false';
        document.body.dataset.tocEnabled = settingsState.tocEnabled ? 'true' : 'false';
        document.body.dataset.listDashStyle = settingsState.listDashStyle ? 'true' : 'false';
        document.body.dataset.platform = isMac ? 'mac' : 'other';
    };
    syncBodySettings();

    const syncToolbarBulletLabel = () => {
        const ulBtn = document.querySelector('.toolbar-btn[data-command="ul"]');
        if (ulBtn) {
            ulBtn.textContent = settingsState.listDashStyle ? '– List' : '• List';
        }
    };

    // 目次要素
    const tocContainer = document.getElementById('toc-container');
    const tocContent = document.getElementById('toc-content');
    const tocEmpty = document.getElementById('toc-empty');
    const editorScrollbarIndicator = document.getElementById('editor-scrollbar-indicator');
    const editorScrollbarThumb = document.getElementById('editor-scrollbar-thumb');

    // モジュールのインスタンスを作成
    const domUtils = new DOMUtils(editor);
    const stateManager = new StateManager(editor, vscode);
    const cursorManager = new CursorManager(editor, domUtils);
    const listManager = new ListManager(editor, domUtils);
    const markdownConverter = new MarkdownConverter(editor, domUtils);
    const codeBlockManager = new CodeBlockManager(editor, cursorManager, vscode);
    const tocManager = new TableOfContentsManager(editor, tocContainer, tocContent, tocEmpty, {
        enabled: settingsState.tocEnabled
    });
    const tableManager = new TableManager(editor, domUtils, stateManager);
    const searchManager = new SearchManager(editor);
    const toolbarManager = new ToolbarManager(editor, stateManager, {
        onInsertTable: () => tableManager.openTableDialog(),
        onInsertQuote: () => insertToolbarQuote(),
        onInsertCodeBlock: () => insertToolbarCodeBlock()
    });

    function applySettings(nextSettings) {
        if (!nextSettings) return;
        if (typeof nextSettings.toolbarVisible === 'boolean') {
            settingsState.toolbarVisible = nextSettings.toolbarVisible;
        }
        if (typeof nextSettings.tocEnabled === 'boolean') {
            settingsState.tocEnabled = nextSettings.tocEnabled;
        }
        if (typeof nextSettings.useVsCodeCtrlP === 'boolean') {
            settingsState.useVsCodeCtrlP = nextSettings.useVsCodeCtrlP;
        }
        if (typeof nextSettings.listDashStyle === 'boolean') {
            settingsState.listDashStyle = nextSettings.listDashStyle;
        }
        syncBodySettings();
        syncToolbarBulletLabel();
        tocManager.setEnabled(settingsState.tocEnabled);
        scheduleEditorOverflowStateUpdate();
    }

    function getDirectTextContent(listItem) {
        let directTextContent = '';
        for (let child of listItem.childNodes) {
            if (child.nodeType === Node.TEXT_NODE) {
                directTextContent += child.textContent;
            } else if (child.nodeType === Node.ELEMENT_NODE &&
                child.tagName !== 'UL' && child.tagName !== 'OL') {
                directTextContent += child.textContent;
            }
        }
        return directTextContent;
    }

    function hasDirectTextContent(listItem) {
        return getDirectTextContent(listItem).replace(/[\u00A0\u200B]/g, '').trim() !== '';
    }

    function hasNestedListChild(listItem) {
        return Array.from(listItem.children).some(
            child => child.tagName === 'UL' || child.tagName === 'OL'
        );
    }

    function isRangeInListItemDirectContent(range, listItem) {
        if (!range || !listItem) return false;
        let current = range.startContainer.nodeType === Node.TEXT_NODE
            ? range.startContainer.parentElement
            : range.startContainer;
        while (current && current !== listItem) {
            if (current.tagName === 'UL' || current.tagName === 'OL') {
                if (current.parentElement === listItem && range.startContainer === current) {
                    const offset = range.startOffset;
                    const maxOffset = current.childNodes ? current.childNodes.length : 0;
                    if (offset <= 0 || offset >= maxOffset) {
                        return true;
                    }
                }
                return false;
            }
            current = current.parentElement;
        }
        return current === listItem;
    }

    function getEmptyListItemAtRange(range) {
        if (!range || !range.collapsed) return null;
        const startListItem = domUtils.getParentElement(range.startContainer, 'LI');
        const endListItem = domUtils.getParentElement(range.endContainer, 'LI');
        let listItem = startListItem || endListItem;
        if (listItem && !isRangeInListItemDirectContent(range, listItem)) {
            listItem = null;
        }
        if (!listItem) {
            listItem = getListItemFromRange(range, 'down');
        }
        if (!listItem) return null;
        if (hasCheckboxAtStart(listItem)) return null;
        if (!isRangeInListItemDirectContent(range, listItem)) return null;
        const directText = getDirectTextContent(listItem).replace(/[\u00A0\u200B]/g, '').trim();
        if (directText !== '') return null;
        return listItem;
    }

    function normalizeCaretIfStuckAtListItemStart(listItem) {
        if (!listItem || !listItem.isConnected) return false;
        const selection = window.getSelection();
        if (!selection || !selection.rangeCount || !selection.isCollapsed) return false;
        const range = selection.getRangeAt(0);
        if (!isRangeInListItemDirectContent(range, listItem)) return false;

        const firstTextNode = getFirstDirectTextNode(listItem);
        if (!firstTextNode) return false;
        const text = firstTextNode.textContent || '';
        let firstNonPlaceholder = null;
        for (let i = 0; i < text.length; i++) {
            if (!/[\u00A0\u200B]/.test(text[i])) {
                firstNonPlaceholder = i;
                break;
            }
        }
        if (firstNonPlaceholder === null) return false;

        const targetOffset = Math.min(text.length, firstNonPlaceholder + 1);
        let shouldFix = false;
        if (range.startContainer === firstTextNode && range.startOffset <= firstNonPlaceholder) {
            shouldFix = true;
        } else if (range.startContainer === listItem) {
            shouldFix = true;
        }
        if (!shouldFix) return false;

        const newRange = document.createRange();
        newRange.setStart(firstTextNode, targetOffset);
        newRange.collapse(true);
        selection.removeAllRanges();
        selection.addRange(newRange);
        return true;
    }

    function getCheckboxInListItemDirectContent(listItem) {
        if (!listItem) return null;

        const isWhitespaceText = (node) =>
            node && node.nodeType === Node.TEXT_NODE &&
            (node.textContent || '').replace(/[\u00A0\u200B]/g, '').trim() === '';

        const findFirstMeaningfulDescendant = (element) => {
            if (!element || element.nodeType !== Node.ELEMENT_NODE) return null;
            const walker = document.createTreeWalker(element, NodeFilter.SHOW_ALL, null);
            let node = walker.currentNode;
            while (node) {
                if (node !== element) {
                    if (node.nodeType === Node.TEXT_NODE) {
                        const cleaned = (node.textContent || '').replace(/[\u00A0\u200B]/g, '');
                        if (cleaned.trim() !== '') return node;
                    } else if (node.nodeType === Node.ELEMENT_NODE) {
                        if (node.tagName === 'BR') {
                            // skip
                        } else {
                            return node;
                        }
                    }
                }
                node = walker.nextNode();
            }
            return null;
        };

        for (const child of Array.from(listItem.childNodes || [])) {
            if (isWhitespaceText(child)) {
                continue;
            }
            if (child.nodeType !== Node.ELEMENT_NODE) {
                return null;
            }
            if (child.tagName === 'UL' || child.tagName === 'OL') {
                return null;
            }
            if (child.tagName === 'INPUT' && child.type === 'checkbox') {
                return child;
            }
            const firstMeaningful = findFirstMeaningfulDescendant(child);
            if (firstMeaningful &&
                firstMeaningful.nodeType === Node.ELEMENT_NODE &&
                firstMeaningful.tagName === 'INPUT' &&
                firstMeaningful.type === 'checkbox') {
                return firstMeaningful;
            }
            return null;
        }
        return null;
    }

    function hasCheckbox(listItem) {
        return getCheckboxInListItemDirectContent(listItem) !== null;
    }

    // チェックボックスがリストアイテムの先頭にあるかどうかをチェック
    function hasCheckboxAtStart(listItem) {
        return hasCheckbox(listItem);
    }

    function parseImageAltSizeSpec(rawAlt) {
        const altText = typeof rawAlt === 'string' ? rawAlt : '';
        const pipeIndex = altText.lastIndexOf('|');
        if (pipeIndex === -1) {
            return { hasSize: false, altText };
        }

        const baseAlt = altText.slice(0, pipeIndex);
        const sizeToken = altText.slice(pipeIndex + 1).trim();
        if (!sizeToken) {
            return { hasSize: false, altText };
        }

        const toPositiveInt = (value) => {
            const num = Number.parseInt(value, 10);
            if (!Number.isFinite(num) || num <= 0) {
                return null;
            }
            return num;
        };

        if (/^\d+$/.test(sizeToken)) {
            const width = toPositiveInt(sizeToken);
            if (width) {
                return {
                    hasSize: true,
                    altText: baseAlt,
                    width,
                    height: null
                };
            }
            return { hasSize: false, altText };
        }

        const match = sizeToken.match(/^(\d*)x(\d*)$/i);
        if (!match || (!match[1] && !match[2])) {
            return { hasSize: false, altText };
        }

        const width = match[1] ? toPositiveInt(match[1]) : null;
        const height = match[2] ? toPositiveInt(match[2]) : null;
        if (!width && !height) {
            return { hasSize: false, altText };
        }

        return {
            hasSize: true,
            altText: baseAlt,
            width,
            height
        };
    }

    function getImageRenderMaxWidth() {
        if (!editor) {
            return imageRenderMaxWidthPx;
        }
        const cs = window.getComputedStyle(editor);
        const paddingLeft = parseFloat(cs.paddingLeft) || 0;
        const paddingRight = parseFloat(cs.paddingRight) || 0;
        const contentWidth = editor.clientWidth - paddingLeft - paddingRight;
        return Math.max(40, Math.min(imageRenderMaxWidthPx, contentWidth));
    }

    function applyImageRenderSizeFromAlt(image) {
        if (!image || image.tagName !== 'IMG') return false;

        const beforeWidthStyle = image.style.width;
        const beforeHeightStyle = image.style.height;
        const beforeWidthAttr = image.getAttribute('width');
        const beforeHeightAttr = image.getAttribute('height');

        const parsed = parseImageAltSizeSpec(image.getAttribute('alt') || '');
        if (parsed.hasSize) {
            let targetWidth = parsed.width;
            let targetHeight = parsed.height;
            const maxWidth = getImageRenderMaxWidth();
            if (targetWidth && targetWidth > maxWidth) {
                const scale = maxWidth / targetWidth;
                targetWidth = maxWidth;
                if (targetHeight) {
                    targetHeight = Math.max(1, Math.round(targetHeight * scale));
                }
            }

            if (targetWidth) {
                image.style.width = `${targetWidth}px`;
                image.setAttribute('width', String(targetWidth));
            } else {
                image.style.removeProperty('width');
                image.removeAttribute('width');
            }

            if (targetWidth) {
                // 幅指定時は高さをautoにしてレスポンシブ縮小時の縦横比崩れを防ぐ
                image.style.removeProperty('height');
                image.removeAttribute('height');
            } else if (targetHeight) {
                image.style.height = `${targetHeight}px`;
                image.setAttribute('height', String(targetHeight));
            } else {
                image.style.removeProperty('height');
                image.removeAttribute('height');
            }
            // 明示的にaspect-ratioを設定し、max-width制約時も縦横比を維持する
            const nw = image.naturalWidth;
            const nh = image.naturalHeight;
            if (nw > 0 && nh > 0) {
                image.style.aspectRatio = `${nw} / ${nh}`;
            }
        } else {
            image.style.removeProperty('width');
            image.style.removeProperty('height');
            image.style.removeProperty('aspect-ratio');
            image.removeAttribute('width');
            image.removeAttribute('height');
        }

        const afterWidthStyle = image.style.width;
        const afterHeightStyle = image.style.height;
        const afterWidthAttr = image.getAttribute('width');
        const afterHeightAttr = image.getAttribute('height');

        return beforeWidthStyle !== afterWidthStyle ||
            beforeHeightStyle !== afterHeightStyle ||
            beforeWidthAttr !== afterWidthAttr ||
            beforeHeightAttr !== afterHeightAttr;
    }

    function applyImageRenderSizes(root = editor) {
        if (!root) return;
        if (root.nodeType === Node.ELEMENT_NODE && root.tagName === 'IMG') {
            applyImageRenderSizeFromAlt(root);
            return;
        }
        if (!root.querySelectorAll) return;
        root.querySelectorAll('img').forEach((img) => applyImageRenderSizeFromAlt(img));
    }

    function buildImageAltWithSizeSpec(rawAlt, width, height) {
        const parsed = parseImageAltSizeSpec(rawAlt || '');
        const baseAlt = parsed.hasSize ? parsed.altText : (rawAlt || '');
        const safeWidth = Math.max(1, Math.round(width || 1));
        const safeHeight = Math.max(1, Math.round(height || 1));
        return `${baseAlt}|${safeWidth}x${safeHeight}`;
    }

    function setImageRenderSize(image, width, height) {
        if (!image || image.tagName !== 'IMG') return;
        const maxWidth = getImageRenderMaxWidth();
        const safeWidth = Math.max(1, Math.min(Math.round(width || 1), maxWidth));
        image.style.width = `${safeWidth}px`;
        image.setAttribute('width', String(safeWidth));
        image.style.removeProperty('height');
        image.removeAttribute('height');
        // 明示的にaspect-ratioを設定し、max-width制約時も縦横比を維持する
        const nw = image.naturalWidth;
        const nh = image.naturalHeight;
        if (nw > 0 && nh > 0) {
            image.style.aspectRatio = `${nw} / ${nh}`;
        }
    }

    function syncImageAltSizeFromRenderedSize(image) {
        if (!image || image.tagName !== 'IMG') return false;
        const rect = image.getBoundingClientRect();
        if (!rect || rect.width <= 0 || rect.height <= 0) return false;
        const previousAlt = image.getAttribute('alt') || '';
        const nextAlt = buildImageAltWithSizeSpec(previousAlt, rect.width, rect.height);
        if (nextAlt === previousAlt) return false;
        image.setAttribute('alt', nextAlt);
        return true;
    }

    function createMarkdownImageSyntaxFromElement(image) {
        if (!image || image.tagName !== 'IMG') return '';
        const alt = (image.getAttribute('alt') || '').replace(/]/g, '\\]');
        const src = image.getAttribute('src') || image.currentSrc || '';
        return `![${alt}](${src})`;
    }

    function selectionContainsImage(selection) {
        if (!selection || !selection.rangeCount) return false;
        for (let i = 0; i < selection.rangeCount; i++) {
            const range = selection.getRangeAt(i);
            const fragment = range.cloneContents();
            if (fragment.querySelector && fragment.querySelector('img')) {
                return true;
            }
            const container = range.startContainer;
            if (container && container.nodeType === Node.ELEMENT_NODE) {
                const nodeAtOffset = container.childNodes[range.startOffset];
                if (nodeAtOffset && nodeAtOffset.nodeType === Node.ELEMENT_NODE && nodeAtOffset.tagName === 'IMG') {
                    return true;
                }
            }
        }
        return false;
    }

    function fragmentToClipboardPlainText(fragment) {
        if (!fragment) return '';
        const blockTags = new Set([
            'P', 'DIV', 'LI', 'UL', 'OL', 'BLOCKQUOTE',
            'PRE', 'TABLE', 'TR', 'TD', 'TH',
            'H1', 'H2', 'H3', 'H4', 'H5', 'H6'
        ]);
        let output = '';

        const walk = (node) => {
            if (!node) return;
            if (node.nodeType === Node.TEXT_NODE) {
                output += node.textContent || '';
                return;
            }
            if (node.nodeType !== Node.ELEMENT_NODE) return;

            const el = node;
            if (el.getAttribute && el.getAttribute('data-exclude-from-markdown') === 'true') {
                return;
            }
            if (el.tagName === 'IMG') {
                output += createMarkdownImageSyntaxFromElement(el);
                return;
            }
            if (el.tagName === 'BR') {
                output += '\n';
                return;
            }

            const isBlock = blockTags.has(el.tagName);
            if (isBlock && output !== '' && !output.endsWith('\n')) {
                output += '\n';
            }
            for (const child of Array.from(el.childNodes || [])) {
                walk(child);
            }
            if (isBlock && !output.endsWith('\n')) {
                output += '\n';
            }
        };

        for (const child of Array.from(fragment.childNodes || [])) {
            walk(child);
        }

        return output.replace(/\n{3,}/g, '\n\n').trimEnd();
    }

    function createClipboardPayloadFromSelection(selection) {
        if (!selection || !selection.rangeCount) return null;
        const range = selection.getRangeAt(0);
        const fragment = range.cloneContents();
        const wrapper = document.createElement('div');
        wrapper.appendChild(fragment);
        wrapper.querySelectorAll('[data-exclude-from-markdown="true"]').forEach((node) => node.remove());
        return {
            html: wrapper.innerHTML,
            text: fragmentToClipboardPlainText(wrapper)
        };
    }

    let caretScrollRaf = null;
    const caretScrollMargin = 8;

    function ensureCaretVisible() {
        if (isUpdating) return;
        // Mouse click placement should not trigger additional auto-scroll corrections.
        // Browsers already scroll naturally for pointer caret placement.
        if (Date.now() - lastPointerCaretIntentTs < 250) return;
        const selection = window.getSelection();
        if (!selection || !selection.rangeCount || !selection.isCollapsed) return;
        const range = selection.getRangeAt(0);
        if (!editor.contains(range.startContainer)) return;

        const isEditorBoundary = range.startContainer === editor;
        const rectFromManager = cursorManager && cursorManager._getCaretRect
            ? cursorManager._getCaretRect(range)
            : null;
        const rects = !isEditorBoundary && range.getClientRects ? range.getClientRects() : null;
        const caretRect = rectFromManager || (rects && rects.length ? rects[0] : null);
        if (!caretRect) return;

        const isEditorEndBoundary = range.startContainer === editor &&
            range.startOffset >= (editor.childNodes ? editor.childNodes.length : 0);
        const editorViewportRect = editor.getBoundingClientRect();
        if (isEditorEndBoundary && caretRect.bottom < editorViewportRect.top) {
            return;
        }

        const editorRect = editor.getBoundingClientRect();
        const caretTop = caretRect.top - editorRect.top + editor.scrollTop;
        const caretBottom = caretRect.bottom - editorRect.top + editor.scrollTop;
        const visibleTop = editor.scrollTop;
        const visibleBottom = editor.scrollTop + editor.clientHeight;

        if (caretTop < visibleTop + caretScrollMargin) {
            editor.scrollTop = Math.max(0, caretTop - caretScrollMargin);
        } else if (caretBottom > visibleBottom - caretScrollMargin) {
            editor.scrollTop = Math.max(0, caretBottom - editor.clientHeight + caretScrollMargin);
        }
    }

    function scheduleEnsureCaretVisible() {
        if (caretScrollRaf) return;
        caretScrollRaf = requestAnimationFrame(() => {
            caretScrollRaf = null;
            ensureCaretVisible();
        });
    }

    function createCheckboxElement() {
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        return checkbox;
    }

    // チェックボックスli内の最初のテキストノードを取得（チェックボックスとサブリストを除く）
    function getFirstDirectTextNodeAfterCheckbox(li) {
        if (!li) return null;
        const checkbox = li.querySelector(':scope > input[type="checkbox"]');
        let passedCheckbox = !checkbox;
        for (let child of li.childNodes) {
            if (child === checkbox) {
                passedCheckbox = true;
                continue;
            }
            if (!passedCheckbox) {
                continue;
            }
            if (child.nodeType === Node.ELEMENT_NODE && child.tagName === 'INPUT') continue;
            if (child.nodeType === Node.TEXT_NODE) return child;
            if (child.nodeType === Node.ELEMENT_NODE &&
                child.tagName !== 'UL' && child.tagName !== 'OL') {
                const tn = domUtils.getFirstTextNode(child);
                if (tn) return tn;
            }
        }
        return null;
    }

    // チェックボックスli内テキストの最小カーソル位置を取得
    function getCheckboxTextMinOffset(li) {
        const textNode = getFirstDirectTextNodeAfterCheckbox(li);
        if (!textNode) return 0;
        const text = textNode.textContent || '';
        let offset = 0;
        while (offset < text.length && text[offset] === '\u200B') {
            offset++;
        }
        return offset;
    }

    function ensureCheckboxLeadingSpace(li) {
        if (!li) return;
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
                // Markdown parser keeps a separator space after checkbox marker.
                // Keep DOM text clean so caret-at-start behaves like plain text.
                firstContentNode.textContent = text.slice(1) || '\u200B';
            } else if (text === '') {
                // Keep an invisible anchor so caret starts on the text side of checkbox.
                firstContentNode.textContent = '\u200B';
            }
            return;
        }

        if (!firstContentNode) {
            li.appendChild(document.createTextNode('\u200B'));
        }
    }

    function normalizeCheckboxListItems(root = editor) {
        if (!root || !root.querySelectorAll) return;
        root.querySelectorAll('li').forEach(li => {
            if (hasCheckboxAtStart(li)) {
                ensureCheckboxLeadingSpace(li);
                return;
            }

            const parseTaskMarker = (text) => {
                if (typeof text !== 'string') return null;
                const match = text.match(/^(\s*)\[( |x|X)\](.*)$/);
                if (!match) return null;
                const trailing = match[3] || '';
                if (trailing !== '' && !/^[ \u00A0]/.test(trailing)) {
                    return null;
                }
                return {
                    checked: match[2].toLowerCase() === 'x',
                    restText: trailing.replace(/^[ \u00A0]/, '')
                };
            };

            let converted = false;
            for (const child of Array.from(li.childNodes || [])) {
                if (child.nodeType === Node.ELEMENT_NODE &&
                    (child.tagName === 'UL' || child.tagName === 'OL')) {
                    continue;
                }

                if (child.nodeType === Node.TEXT_NODE) {
                    const cleaned = (child.textContent || '').replace(/[\u00A0\u200B]/g, '').trim();
                    if (cleaned === '') {
                        continue;
                    }
                    const marker = parseTaskMarker(child.textContent || '');
                    if (!marker) break;
                    const checkbox = createCheckboxElement();
                    if (marker.checked) {
                        checkbox.checked = true;
                        checkbox.setAttribute('checked', '');
                    }
                    li.insertBefore(checkbox, li.firstChild);
                    child.textContent = marker.restText;
                    converted = true;
                    break;
                }

                if (child.nodeType === Node.ELEMENT_NODE && child.tagName !== 'INPUT') {
                    const firstTextNode = domUtils.getFirstTextNode(child);
                    const marker = firstTextNode ? parseTaskMarker(firstTextNode.textContent || '') : null;
                    if (!marker) break;
                    const checkbox = createCheckboxElement();
                    if (marker.checked) {
                        checkbox.checked = true;
                        checkbox.setAttribute('checked', '');
                    }
                    li.insertBefore(checkbox, li.firstChild);
                    firstTextNode.textContent = marker.restText;
                    converted = true;
                    break;
                }

                break;
            }

            if (converted || hasCheckboxAtStart(li)) {
                ensureCheckboxLeadingSpace(li);
            }
        });
    }

    function isBlockElement(node) {
        if (!node || node.nodeType !== Node.ELEMENT_NODE) return false;
        const tag = node.tagName;
        if (tag === 'P' || tag === 'DIV' || tag === 'UL' || tag === 'OL' || tag === 'PRE' || tag === 'TABLE' ||
            tag === 'BLOCKQUOTE' || tag === 'HR') {
            return true;
        }
        return /^H[1-6]$/.test(tag);
    }

    function getDirectNodesFromEditor(range) {
        if (!range) return [];
        let startNode = null;

        if (range.startContainer === editor) {
            startNode = editor.childNodes[range.startOffset] || null;
        } else if (range.startContainer.nodeType === Node.TEXT_NODE &&
            range.startContainer.parentElement === editor) {
            startNode = range.startContainer;
        } else if (range.startContainer.nodeType === Node.ELEMENT_NODE &&
            range.startContainer.parentElement === editor) {
            startNode = range.startContainer;
        } else {
            let current = range.startContainer.nodeType === Node.ELEMENT_NODE
                ? range.startContainer
                : range.startContainer.parentElement;
            while (current && current !== editor) {
                if (current.parentElement === editor) {
                    startNode = current;
                    break;
                }
                if (domUtils.isBlockElement(current)) return [];
                current = current.parentElement;
            }
        }

        if (!startNode) return [];
        if (startNode.nodeType === Node.ELEMENT_NODE && domUtils.isBlockElement(startNode)) return [];

        let startIndex = Array.prototype.indexOf.call(editor.childNodes, startNode);
        if (startIndex < 0) return [];
        while (startIndex > 0) {
            const prev = editor.childNodes[startIndex - 1];
            if (prev.nodeType === Node.ELEMENT_NODE && domUtils.isBlockElement(prev)) break;
            startIndex -= 1;
        }

        const nodes = [];
        for (let i = startIndex; i < editor.childNodes.length; i++) {
            const node = editor.childNodes[i];
            if (node.nodeType === Node.ELEMENT_NODE && domUtils.isBlockElement(node)) break;
            nodes.push(node);
        }
        return nodes;
    }

    function getLastDirectTextNode(listItem) {
        const walker = document.createTreeWalker(listItem, NodeFilter.SHOW_TEXT, null);
        let lastDirectTextNode = null;
        let node;
        while (node = walker.nextNode()) {
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
                lastDirectTextNode = node;
            }
        }
        return lastDirectTextNode;
    }

    function getLastMeaningfulDirectTextNode(listItem) {
        const walker = document.createTreeWalker(listItem, NodeFilter.SHOW_TEXT, null);
        let lastMeaningfulTextNode = null;
        let node;
        while (node = walker.nextNode()) {
            let current = node.parentElement;
            let inSublist = false;
            while (current && current !== listItem) {
                if (current.tagName === 'UL' || current.tagName === 'OL') {
                    inSublist = true;
                    break;
                }
                current = current.parentElement;
            }
            if (inSublist) continue;

            const cleaned = (node.textContent || '').replace(/[\u200B\u00A0]/g, '');
            if (cleaned.trim() === '') continue;
            lastMeaningfulTextNode = node;
        }
        return lastMeaningfulTextNode;
    }

    function getFirstDirectTextNode(listItem) {
        const walker = document.createTreeWalker(listItem, NodeFilter.SHOW_TEXT, null);
        let node;
        while (node = walker.nextNode()) {
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

    function getPreferredFirstTextNodeForElement(element) {
        if (!element || element.nodeType !== Node.ELEMENT_NODE) return null;
        if (element.tagName === 'UL' || element.tagName === 'OL') {
            const firstLi = element.querySelector('li');
            if (!firstLi) return null;
            if (hasCheckboxAtStart(firstLi)) {
                return getFirstDirectTextNodeAfterCheckbox(firstLi) ||
                    getFirstDirectTextNode(firstLi) ||
                    getLastDirectTextNode(firstLi);
            }
            return getFirstDirectTextNode(firstLi) || getLastDirectTextNode(firstLi);
        }
        return domUtils.getFirstTextNode(element);
    }

    function getListItemFromRange(range, direction = 'down') {
        if (!range) return null;

        const resolveFromListContainerBoundary = (container, offset) => {
            if (!container) return null;
            let listContainer = null;
            if (container.nodeType === Node.ELEMENT_NODE &&
                (container.tagName === 'UL' || container.tagName === 'OL')) {
                listContainer = container;
            } else if (container.parentElement &&
                (container.parentElement.tagName === 'UL' || container.parentElement.tagName === 'OL')) {
                listContainer = container.parentElement;
            }
            if (!listContainer) return null;

            const nodes = Array.from(listContainer.childNodes || []);
            const pickFromIndex = (startIndex) => {
                if (nodes.length === 0) return null;
                const clamped = Math.max(0, Math.min(startIndex, nodes.length - 1));
                if (direction === 'up') {
                    for (let i = clamped; i >= 0; i--) {
                        const node = nodes[i];
                        if (node && node.nodeType === Node.ELEMENT_NODE && node.tagName === 'LI') {
                            return node;
                        }
                    }
                    for (let i = clamped + 1; i < nodes.length; i++) {
                        const node = nodes[i];
                        if (node && node.nodeType === Node.ELEMENT_NODE && node.tagName === 'LI') {
                            return node;
                        }
                    }
                    return null;
                }
                for (let i = clamped; i < nodes.length; i++) {
                    const node = nodes[i];
                    if (node && node.nodeType === Node.ELEMENT_NODE && node.tagName === 'LI') {
                        return node;
                    }
                }
                for (let i = clamped - 1; i >= 0; i--) {
                    const node = nodes[i];
                    if (node && node.nodeType === Node.ELEMENT_NODE && node.tagName === 'LI') {
                        return node;
                    }
                }
                return null;
            };

            if (container === listContainer) {
                const parentListItem = domUtils.getParentElement(listContainer, 'LI');
                if (direction === 'up' && parentListItem && offset <= 0) {
                    const firstChildListItem = nodes.find(
                        node => node && node.nodeType === Node.ELEMENT_NODE && node.tagName === 'LI'
                    ) || null;
                    if (firstChildListItem && cursorManager && typeof cursorManager._getCaretRect === 'function') {
                        const caretRect = cursorManager._getCaretRect(range);
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
                    return parentListItem;
                }
                if (direction === 'down' && parentListItem && offset >= nodes.length) {
                    return parentListItem;
                }
                const baseIndex = direction === 'up' ? offset - 1 : offset;
                return pickFromIndex(baseIndex);
            }

            const boundaryIndex = nodes.indexOf(container);
            if (boundaryIndex === -1) {
                return null;
            }
            const baseIndex = direction === 'up' ? boundaryIndex - 1 : boundaryIndex + 1;
            return pickFromIndex(baseIndex);
        };

        const resolveFromContainer = (container, offset) => {
            const fromBoundary = resolveFromListContainerBoundary(container, offset);
            if (fromBoundary) return fromBoundary;
            return domUtils.getParentElement(container, 'LI');
        };

        let listItem = resolveFromContainer(range.startContainer, range.startOffset);
        if (listItem) return listItem;
        listItem = resolveFromContainer(range.endContainer, range.endOffset);
        if (listItem) return listItem;
        if (cursorManager && typeof cursorManager._getListItemFromContainer === 'function') {
            listItem = cursorManager._getListItemFromContainer(range.startContainer, range.startOffset, direction);
            if (listItem) return listItem;
            listItem = cursorManager._getListItemFromContainer(range.endContainer, range.endOffset, direction);
        }
        if (listItem) return listItem;

        const resolveFromEditorBoundary = (container, offset) => {
            if (container !== editor || !editor.childNodes || editor.childNodes.length === 0) return null;
            const children = Array.from(editor.childNodes);
            const primaryIndex = direction === 'up'
                ? Math.max(0, Math.min(offset - 1, children.length - 1))
                : Math.max(0, Math.min(offset, children.length - 1));
            const fallbackIndex = direction === 'up'
                ? Math.max(0, Math.min(offset, children.length - 1))
                : Math.max(0, Math.min(offset - 1, children.length - 1));
            const indices = direction === 'up'
                ? [primaryIndex, fallbackIndex]
                : [primaryIndex, fallbackIndex];

            for (const idx of indices) {
                const node = children[idx];
                if (!node || node.nodeType !== Node.ELEMENT_NODE) continue;
                if (node.tagName === 'LI') return node;
                if (node.tagName === 'UL' || node.tagName === 'OL') {
                    const items = node.querySelectorAll('li');
                    if (items.length > 0) {
                        return direction === 'up' ? items[items.length - 1] : items[0];
                    }
                }
                const items = node.querySelectorAll ? node.querySelectorAll('li') : [];
                if (items.length > 0) {
                    return direction === 'up' ? items[items.length - 1] : items[0];
                }
            }
            return null;
        };

        listItem = resolveFromEditorBoundary(range.startContainer, range.startOffset);
        if (listItem) return listItem;
        listItem = resolveFromEditorBoundary(range.endContainer, range.endOffset);
        return listItem || null;
    }

    function isRangeAtListItemStart(range, listItem) {
        if (!range || !listItem || !range.collapsed) return false;

        if (hasCheckboxAtStart(listItem)) {
            const firstText = getFirstDirectTextNodeAfterCheckbox(listItem);
            const minOffset = getCheckboxTextMinOffset(listItem);
            if (firstText && range.startContainer === firstText && range.startOffset <= minOffset) {
                return true;
            }
        } else {
            const firstText = getFirstDirectTextNode(listItem);
            if (firstText && range.startContainer === firstText) {
                const match = (firstText.textContent || '').match(/^(\s*)/);
                const minOffset = match ? match[1].length : 0;
                if (range.startOffset <= minOffset) {
                    return true;
                }
            }
        }

        if (range.startContainer === listItem && range.startOffset <= 1) {
            return true;
        }

        const listContainer = listItem.parentElement;
        if (listContainer && (listContainer.tagName === 'UL' || listContainer.tagName === 'OL')) {
            if (range.startContainer === listContainer) {
                const nodes = Array.from(listContainer.childNodes || []);
                let index = Math.max(0, Math.min(range.startOffset, nodes.length));
                while (index < nodes.length) {
                    const node = nodes[index];
                    if (!node) break;
                    if (node.nodeType === Node.TEXT_NODE) {
                        const cleaned = (node.textContent || '').replace(/[\u200B\u00A0]/g, '').trim();
                        if (cleaned === '') {
                            index++;
                            continue;
                        }
                        break;
                    }
                    if (node.nodeType === Node.ELEMENT_NODE && node.tagName === 'LI') {
                        return node === listItem;
                    }
                    break;
                }
            }

            if (range.startContainer.nodeType === Node.TEXT_NODE &&
                range.startContainer.parentElement === listContainer &&
                !listItem.contains(range.startContainer)) {
                const beforeText = (range.startContainer.textContent || '').slice(0, range.startOffset)
                    .replace(/[\u200B\u00A0]/g, '').trim();
                if (beforeText === '') {
                    let next = range.startContainer;
                    while (next) {
                        next = next.nextSibling;
                        if (!next) break;
                        if (next.nodeType === Node.TEXT_NODE) {
                            const cleaned = (next.textContent || '').replace(/[\u200B\u00A0]/g, '').trim();
                            if (cleaned === '') continue;
                            break;
                        }
                        if (next.nodeType === Node.ELEMENT_NODE && next.tagName === 'LI') {
                            return next === listItem;
                        }
                        break;
                    }
                }
            }
        }

        try {
            const beforeRange = document.createRange();
            beforeRange.selectNodeContents(listItem);
            beforeRange.setEnd(range.startContainer, range.startOffset);
            const beforeText = (beforeRange.toString() || '').replace(/[\u200B\u00A0]/g, '');
            return beforeText.trim() === '';
        } catch (e) {
            return false;
        }
    }

    function placeCursorAtListItemStart(listItem) {
        if (!listItem) return false;
        const selection = window.getSelection();
        if (!selection) return false;

        let targetNode = null;
        let targetOffset = 0;

        if (hasCheckboxAtStart(listItem)) {
            targetNode = getFirstDirectTextNodeAfterCheckbox(listItem);
            targetOffset = getCheckboxTextMinOffset(listItem);
        } else {
            targetNode = getFirstDirectTextNode(listItem) || getLastDirectTextNode(listItem);
            targetOffset = 0;
        }

        if (!targetNode) return false;

        const newRange = document.createRange();
        newRange.setStart(targetNode, Math.max(0, targetOffset));
        newRange.collapse(true);
        selection.removeAllRanges();
        selection.addRange(newRange);
        return true;
    }

    // 空のチェックボックス行から下移動する際は、必ず隣接する1行だけへ移動する
    function moveDownFromEmptyCheckboxListItemOneStep(range, selection) {
        if (!range || !selection || !range.collapsed) return false;

        const currentListItem = getListItemFromRange(range, 'down') ||
            domUtils.getParentElement(range.startContainer, 'LI');
        if (!currentListItem || !hasCheckboxAtStart(currentListItem)) {
            return false;
        }

        const directText = getDirectTextContent(currentListItem)
            .replace(/[\u00A0\u200B\uFEFF]/g, '')
            .trim();
        if (directText !== '') {
            return false;
        }

        const nextListItem = cursorManager && typeof cursorManager._getAdjacentListItem === 'function'
            ? cursorManager._getAdjacentListItem(currentListItem, 'next')
            : currentListItem.nextElementSibling;
        if (!nextListItem) {
            return false;
        }

        const newRange = document.createRange();
        if (hasCheckboxAtStart(nextListItem)) {
            const targetTextNode = getFirstDirectTextNodeAfterCheckbox(nextListItem);
            if (targetTextNode) {
                newRange.setStart(targetTextNode, getCheckboxTextMinOffset(nextListItem));
            } else {
                newRange.setStart(nextListItem, 0);
            }
        } else {
            const targetTextNode = getFirstDirectTextNode(nextListItem) || getLastDirectTextNode(nextListItem);
            if (targetTextNode) {
                newRange.setStart(targetTextNode, 0);
            } else {
                newRange.setStart(nextListItem, 0);
            }
        }

        newRange.collapse(true);
        selection.removeAllRanges();
        selection.addRange(newRange);
        return true;
    }

    // Slash command
    let slashMenu = null;
    const slashMenuState = {
        visible: false,
        items: [],
        activeIndex: 0,
        query: '',
        match: null
    };

    function insertSlashTable() {
        const selection = window.getSelection();
        if (!selection || !selection.rangeCount) return;

        const range = selection.getRangeAt(0);
        stateManager.saveState();

        const wrapper = tableManager._createTableWrapper(2, 2);
        tableManager._insertNodeAsBlock(range, wrapper);
        tableManager.wrapTables();

        requestAnimationFrame(() => {
            const firstCell = wrapper.querySelector('td, th');
            if (firstCell) {
                tableManager._setCursorToCellStart(firstCell);
            }
            editor.focus();
            notifyChange();
        });
    }

    function insertEmptyQuote() {
        const selection = window.getSelection();
        if (!selection || !selection.rangeCount) return;

        const range = selection.getRangeAt(0);
        stateManager.saveState();

        const blockquote = document.createElement('blockquote');
        const p = document.createElement('p');
        p.appendChild(document.createElement('br'));
        blockquote.appendChild(p);

        tableManager._insertNodeAsBlock(range, blockquote);

        requestAnimationFrame(() => {
            const sel = window.getSelection();
            if (!sel) return;
            const newRange = document.createRange();
            newRange.setStart(p, 0);
            newRange.collapse(true);
            sel.removeAllRanges();
            sel.addRange(newRange);
            editor.focus();
            notifyChange();
        });
    }

    function tryWrapQuoteAtCaret() {
        const selection = window.getSelection();
        if (!selection || !selection.rangeCount || !selection.isCollapsed) return false;

        const range = selection.getRangeAt(0);
        if (!editor.contains(range.startContainer)) return false;
        const cursorInfo = getActiveTextNodeAtCursor(range);
        let block = range.startContainer.nodeType === Node.ELEMENT_NODE
            ? range.startContainer
            : range.startContainer.parentElement;
        while (block && block !== editor && !domUtils.isBlockElement(block)) {
            block = block.parentElement;
        }

        if (block && block !== editor && block.tagName !== 'BLOCKQUOTE' && block.tagName !== 'LI') {
            stateManager.saveState();
            // スラッシュコマンドテキスト削除後にブロックが空の場合、<br>で高さを確保
            if ((block.textContent || '').trim() === '' && !block.querySelector('br')) {
                block.innerHTML = '';
                block.appendChild(document.createElement('br'));
            }
            const blockquote = document.createElement('blockquote');
            block.parentNode.insertBefore(blockquote, block);
            blockquote.appendChild(block);

            requestAnimationFrame(() => {
                const sel = window.getSelection();
                if (!sel) return;
                const newRange = document.createRange();
                if (cursorInfo && cursorInfo.textNode && blockquote.contains(cursorInfo.textNode)) {
                    const offset = Math.min(cursorInfo.offset, cursorInfo.textNode.textContent.length);
                    newRange.setStart(cursorInfo.textNode, offset);
                } else {
                    const target = domUtils.getFirstTextNode(blockquote);
                    if (target) {
                        newRange.setStart(target, 0);
                    } else {
                        newRange.setStart(blockquote, 0);
                    }
                }
                newRange.collapse(true);
                sel.removeAllRanges();
                sel.addRange(newRange);
                editor.focus();
                notifyChange();
            });
            return true;
        }

        if (!block || block === editor) {
            const nodesToMove = getDirectNodesFromEditor(range);
            if (nodesToMove.length > 0) {
                stateManager.saveState();
                const blockquote = document.createElement('blockquote');
                const paragraph = document.createElement('p');
                const insertBeforeNode = nodesToMove[0];
                editor.insertBefore(blockquote, insertBeforeNode);
                nodesToMove.forEach(node => paragraph.appendChild(node));
                if ((paragraph.textContent || '').trim() === '') {
                    paragraph.appendChild(document.createElement('br'));
                }
                blockquote.appendChild(paragraph);

                requestAnimationFrame(() => {
                    const sel = window.getSelection();
                    if (!sel) return;
                    const newRange = document.createRange();
                    if (cursorInfo && cursorInfo.textNode && blockquote.contains(cursorInfo.textNode)) {
                        const offset = Math.min(cursorInfo.offset, cursorInfo.textNode.textContent.length);
                        newRange.setStart(cursorInfo.textNode, offset);
                    } else {
                        newRange.setStart(paragraph, 0);
                    }
                    newRange.collapse(true);
                    sel.removeAllRanges();
                    sel.addRange(newRange);
                    editor.focus();
                    notifyChange();
                });
                return true;
            }
        }

        return false;
    }

    function insertSlashQuote() {
        if (tryWrapQuoteAtCaret()) return;
        insertEmptyQuote();
    }

    function insertToolbarQuote() {
        if (tryWrapQuoteAtCaret()) return;
        insertEmptyQuote();
    }

    function insertToolbarCodeBlock() {
        insertSlashCodeBlock();
    }

    function insertSlashCodeBlock() {
        const selection = window.getSelection();
        if (!selection || !selection.rangeCount) return;

        const range = selection.getRangeAt(0);
        stateManager.saveState();

        const pre = document.createElement('pre');
        const code = document.createElement('code');
        code.textContent = '\n';
        pre.appendChild(code);
        codeBlockManager.addCodeBlockControls(pre, '');

        tableManager._insertNodeAsBlock(range, pre);

        requestAnimationFrame(() => {
            const label = pre.querySelector('.code-block-language');
            if (label && startEditingCodeBlockLanguageLabel(label)) {
                notifyChange();
                return;
            }
            if (label && selectCodeBlockLanguageLabel(pre)) {
                editor.focus();
                notifyChange();
                return;
            }

            const sel = window.getSelection();
            if (!sel) return;
            const newRange = document.createRange();
            const textNode = code.firstChild;
            if (textNode && textNode.nodeType === Node.TEXT_NODE) {
                newRange.setStart(textNode, 0);
            } else {
                newRange.setStart(code, 0);
            }
            newRange.collapse(true);
            sel.removeAllRanges();
            sel.addRange(newRange);
            editor.focus();
            notifyChange();
        });
    }

    function insertSlashCheckbox() {
        const selection = window.getSelection();
        if (!selection || !selection.rangeCount) return;

        const range = selection.getRangeAt(0);
        const container = range.commonAncestorContainer;
        let currentBlock = container.nodeType === 3 ? container.parentElement : container;

        while (currentBlock && currentBlock !== editor) {
            if (currentBlock.tagName === 'LI') {
                stateManager.saveState();

                let checkbox = currentBlock.querySelector(':scope > input[type="checkbox"]');
                if (!checkbox) {
                    checkbox = createCheckboxElement();
                    currentBlock.insertBefore(checkbox, currentBlock.firstChild);
                }

                ensureCheckboxLeadingSpace(currentBlock);

                requestAnimationFrame(() => {
                    const sel = window.getSelection();
                    if (!sel) return;
                    const newRange = document.createRange();
                    const targetNode = getFirstDirectTextNodeAfterCheckbox(currentBlock);
                    if (targetNode) {
                        const minOffset = getCheckboxTextMinOffset(currentBlock);
                        newRange.setStart(targetNode, minOffset);
                    } else {
                        newRange.setStart(currentBlock, currentBlock.childNodes.length);
                    }
                    newRange.collapse(true);
                    sel.removeAllRanges();
                    sel.addRange(newRange);
                    editor.focus();
                    updateListItemClasses();
                    notifyChange();
                });
                return;
            }
            currentBlock = currentBlock.parentElement;
        }

        stateManager.saveState();

        const ul = document.createElement('ul');
        const li = document.createElement('li');
        const checkbox = createCheckboxElement();
        li.appendChild(checkbox);
        ul.appendChild(li);

        let topBlock = container.nodeType === 3 ? container.parentElement : container;
        while (topBlock && topBlock !== editor && topBlock.parentElement !== editor) {
            topBlock = topBlock.parentElement;
        }

        if (topBlock && topBlock !== editor && isBlockElement(topBlock)) {
            const nodesToMove = Array.from(topBlock.childNodes);
            nodesToMove.forEach(node => li.appendChild(node));
            ensureCheckboxLeadingSpace(li);
            topBlock.replaceWith(ul);
        } else {
            const nodesToMove = getDirectNodesFromEditor(range);
            if (nodesToMove.length > 0) {
                editor.insertBefore(ul, nodesToMove[0]);
                nodesToMove.forEach(node => li.appendChild(node));
                ensureCheckboxLeadingSpace(li);
            } else {
                range.deleteContents();
                range.insertNode(ul);
                ensureCheckboxLeadingSpace(li);
            }
        }

        requestAnimationFrame(() => {
            const sel = window.getSelection();
            if (!sel) return;
            const newRange = document.createRange();
            const targetNode = getFirstDirectTextNodeAfterCheckbox(li);
            if (targetNode) {
                const minOffset = getCheckboxTextMinOffset(li);
                newRange.setStart(targetNode, minOffset);
            } else {
                newRange.setStart(li, li.childNodes.length);
            }
            newRange.collapse(true);
            sel.removeAllRanges();
            sel.addRange(newRange);
            editor.focus();
            updateListItemClasses();
            notifyChange();
        });
    }

    const slashCommands = [
        { id: 'table', action: insertSlashTable },
        { id: 'quote', action: insertSlashQuote },
        { id: 'code', action: insertSlashCodeBlock },
        { id: 'checkbox', action: insertSlashCheckbox }
    ];

    function createSlashMenu() {
        const menu = document.createElement('div');
        menu.className = 'slash-command-menu';
        menu.setAttribute('data-exclude-from-markdown', 'true');
        document.body.appendChild(menu);
        return menu;
    }

    function getActiveTextNodeAtCursor(range) {
        if (!range) return null;
        const container = range.startContainer;
        if (container.nodeType === Node.TEXT_NODE) {
            return { textNode: container, offset: range.startOffset };
        }

        if (container.nodeType !== Node.ELEMENT_NODE) return null;

        const childNodes = container.childNodes;
        const before = range.startOffset > 0 ? childNodes[range.startOffset - 1] : null;
        const after = childNodes[range.startOffset] || null;

        if (before && before.nodeType === Node.TEXT_NODE) {
            return { textNode: before, offset: before.textContent.length };
        }

        if (after && after.nodeType === Node.TEXT_NODE) {
            return { textNode: after, offset: 0 };
        }

        if (before && before.nodeType === Node.ELEMENT_NODE) {
            const textNode = domUtils.getLastTextNode(before);
            if (textNode) {
                return { textNode, offset: textNode.textContent.length };
            }
        }

        if (after && after.nodeType === Node.ELEMENT_NODE) {
            const textNode = domUtils.getFirstTextNode(after);
            if (textNode) {
                return { textNode, offset: 0 };
            }
        }

        return null;
    }

    function getSlashCommandMatch() {
        const selection = window.getSelection();
        if (!selection || !selection.rangeCount || !selection.isCollapsed) return null;

        const range = selection.getRangeAt(0);
        if (!editor.contains(range.startContainer)) return null;

        const inCode = domUtils.getParentElement(range.startContainer, 'CODE');
        if (inCode) return null;

        const inTableCell = domUtils.getParentElement(range.startContainer, 'TD') || domUtils.getParentElement(range.startContainer, 'TH');
        if (inTableCell) return null;

        const info = getActiveTextNodeAtCursor(range);
        if (!info) return null;

        const { textNode, offset } = info;
        const textBefore = (textNode.textContent || '').slice(0, offset);
        const match = textBefore.match(/(?:^|[\s\u00A0])\/([^\s]*)$/);
        if (!match) return null;

        const slashOffset = match[0].lastIndexOf('/');
        const slashIndex = (match.index || 0) + slashOffset;
        const query = match[1] || '';
        return { textNode, offset, slashIndex, query, range };
    }

    function getFilteredSlashCommands(query) {
        const q = (query || '').toLowerCase();
        if (!q) return slashCommands;
        return slashCommands.filter(cmd => cmd.id.toLowerCase().startsWith(q));
    }

    function updateSlashMenuSelection() {
        if (!slashMenu) return;
        const items = slashMenu.querySelectorAll('.slash-command-item');
        items.forEach((item, index) => {
            item.classList.toggle('selected', index === slashMenuState.activeIndex);
        });
    }

    function moveSlashCommandSelection(delta) {
        if (!slashMenuState.visible || slashMenuState.items.length === 0) {
            return false;
        }

        const total = slashMenuState.items.length;
        slashMenuState.activeIndex = (slashMenuState.activeIndex + delta + total) % total;
        updateSlashMenuSelection();
        return true;
    }

    function positionSlashMenu(range) {
        if (!slashMenu || !range) return;

        const rects = range.getClientRects();
        const caretRect = rects.length > 0 ? rects[0] : range.getBoundingClientRect();
        if (!caretRect) return;

        let top = caretRect.bottom + window.scrollY + 4;
        let left = caretRect.left + window.scrollX;

        slashMenu.style.top = `${top}px`;
        slashMenu.style.left = `${left}px`;

        const menuRect = slashMenu.getBoundingClientRect();
        if (menuRect.right > window.innerWidth - 8) {
            left = Math.max(8, window.innerWidth - menuRect.width - 8);
        }
        if (menuRect.bottom > window.innerHeight - 8) {
            top = Math.max(8, caretRect.top + window.scrollY - menuRect.height - 4);
        }

        slashMenu.style.top = `${top}px`;
        slashMenu.style.left = `${left}px`;
    }

    function renderSlashMenu(items) {
        if (!slashMenu) {
            slashMenu = createSlashMenu();
        }

        slashMenu.innerHTML = '';
        items.forEach((cmd, index) => {
            const item = document.createElement('div');
            item.className = 'slash-command-item';
            if (index === slashMenuState.activeIndex) {
                item.classList.add('selected');
            }

            const name = document.createElement('span');
            name.className = 'slash-command-name';
            name.textContent = `/${cmd.id}`;

            item.appendChild(name);
            if (cmd.description && cmd.description.trim() !== '') {
                const desc = document.createElement('span');
                desc.className = 'slash-command-desc';
                desc.textContent = cmd.description;
                item.appendChild(desc);
            }

            item.addEventListener('mousedown', (e) => {
                e.preventDefault();
                e.stopPropagation();
                executeSlashCommand(cmd);
            });

            item.addEventListener('mouseenter', () => {
                slashMenuState.activeIndex = index;
                updateSlashMenuSelection();
            });

            slashMenu.appendChild(item);
        });
    }

    function showSlashCommandMenu(match, items) {
        if (match.query !== slashMenuState.query) {
            slashMenuState.activeIndex = 0;
        }

        slashMenuState.query = match.query;
        slashMenuState.items = items;
        slashMenuState.match = match;
        slashMenuState.visible = true;

        renderSlashMenu(items);
        slashMenu.style.display = 'block';
        positionSlashMenu(match.range);
    }

    function hideSlashCommandMenu() {
        if (slashMenu) {
            slashMenu.style.display = 'none';
        }
        slashMenuState.visible = false;
        slashMenuState.items = [];
        slashMenuState.query = '';
        slashMenuState.match = null;
    }

    function updateSlashCommandMenu() {
        if (isUpdating || isComposing) {
            hideSlashCommandMenu();
            return;
        }

        const match = getSlashCommandMatch();
        if (!match) {
            hideSlashCommandMenu();
            return;
        }

        const items = getFilteredSlashCommands(match.query);
        if (items.length === 0) {
            hideSlashCommandMenu();
            return;
        }

        showSlashCommandMenu(match, items);
    }

    function removeSlashCommandText(match) {
        if (!match || !match.textNode) return;

        const range = document.createRange();
        range.setStart(match.textNode, match.slashIndex);
        range.setEnd(match.textNode, match.offset);
        range.deleteContents();

        const selection = window.getSelection();
        if (selection) {
            const newRange = document.createRange();
            newRange.setStart(match.textNode, match.slashIndex);
            newRange.collapse(true);
            selection.removeAllRanges();
            selection.addRange(newRange);
        }
    }

    function ensureSlashCommandSelectionInEditor(preferredNode, preferredOffset) {
        const selection = window.getSelection();
        if (!selection) return false;

        if (selection.rangeCount > 0) {
            const currentRange = selection.getRangeAt(0);
            if (editor.contains(currentRange.startContainer)) {
                return true;
            }
        }

        const range = document.createRange();
        if (preferredNode && editor.contains(preferredNode)) {
            if (preferredNode.nodeType === Node.TEXT_NODE) {
                const maxOffset = (preferredNode.textContent || '').length;
                const safeOffset = Math.max(0, Math.min(preferredOffset || 0, maxOffset));
                range.setStart(preferredNode, safeOffset);
            } else if (preferredNode.nodeType === Node.ELEMENT_NODE) {
                const childCount = preferredNode.childNodes.length;
                const safeOffset = Math.max(0, Math.min(preferredOffset || 0, childCount));
                range.setStart(preferredNode, safeOffset);
            } else {
                range.selectNodeContents(editor);
                range.collapse(false);
                selection.removeAllRanges();
                selection.addRange(range);
                return true;
            }
            range.collapse(true);
            selection.removeAllRanges();
            selection.addRange(range);
            return true;
        }

        const lastTextNode = domUtils.getLastTextNode(editor);
        if (lastTextNode) {
            range.setStart(lastTextNode, lastTextNode.textContent.length);
        } else {
            range.selectNodeContents(editor);
            range.collapse(false);
            selection.removeAllRanges();
            selection.addRange(range);
            return true;
        }
        range.collapse(true);
        selection.removeAllRanges();
        selection.addRange(range);
        return true;
    }

    function executeSlashCommand(cmd) {
        const match = slashMenuState.match || getSlashCommandMatch();
        if (!match) return;

        hideSlashCommandMenu();
        removeSlashCommandText(match);
        ensureSlashCommandSelectionInEditor(match.textNode, match.slashIndex);
        cmd.action();
    }

    function handleSlashCommandKeydown(e) {
        if (!slashMenuState.visible || slashMenuState.items.length === 0) {
            return false;
        }

        if (e.key === 'Escape') {
            e.preventDefault();
            hideSlashCommandMenu();
            return true;
        }

        if (e.key === 'Tab') {
            e.preventDefault();
            const delta = e.shiftKey ? -1 : 1;
            moveSlashCommandSelection(delta);
            return true;
        }

        if (e.key === 'Enter') {
            e.preventDefault();
            const cmd = slashMenuState.items[slashMenuState.activeIndex];
            if (cmd) {
                executeSlashCommand(cmd);
            }
            return true;
        }

        const key = e.key.toLowerCase();
        const isCtrlN = isMac && e.ctrlKey && !e.metaKey && !e.altKey && key === 'n';
        const isCtrlP = isMac && e.ctrlKey && !e.metaKey && !e.altKey && key === 'p';
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || isCtrlN || isCtrlP) {
            const syncDirection = isCtrlN ? 'down' : (isCtrlP ? 'up' : null);
            if (syncDirection && shouldSuppressKeydownNav(syncDirection)) {
                e.preventDefault();
                e.stopPropagation();
                return true;
            }
            e.preventDefault();
            const delta = (e.key === 'ArrowDown' || isCtrlN) ? 1 : -1;
            moveSlashCommandSelection(delta);
            if (syncDirection) {
                recordCtrlNavHandled(syncDirection, false);
            }
            return true;
        }

        return false;
    }

    // チェックボックス行に入った場合のカーソル位置補正
    // チェックボックスが先頭にある場合のみ適用
    function correctCheckboxCursorPosition() {
        const sel = window.getSelection();
        if (!sel || !sel.rangeCount || !sel.isCollapsed) return;
        const range = sel.getRangeAt(0);
        const container = range.startContainer;
        const offset = range.startOffset;

        // カーソルがINPUT要素（チェックボックス）自体にある場合
        // → li, offset=0（チェックボックス位置）に移動
        if (container.nodeType === Node.ELEMENT_NODE && container.tagName === 'INPUT') {
            const li = container.parentElement;
            if (li && li.tagName === 'LI' && hasCheckboxAtStart(li)) {
                const newRange = document.createRange();
                newRange.setStart(li, 0);
                newRange.collapse(true);
                sel.removeAllRanges();
                sel.addRange(newRange);
                return;
            }
        }

        // カーソルが要素レベル（テキストノード以外）でli内にある場合
        if (container.nodeType === Node.ELEMENT_NODE && container.tagName === 'LI' && hasCheckboxAtStart(container)) {
            // offset === 0 はチェックボックス位置 → 補正しない
            if (offset === 0) return;
            // offset === 1 はチェックボックス直後 → テキスト先頭へ補正
            if (offset === 1) {
                const textNode = getFirstDirectTextNodeAfterCheckbox(container);
                if (textNode) {
                    const minOffset = getCheckboxTextMinOffset(container);
                    const newRange = document.createRange();
                    newRange.setStart(textNode, minOffset);
                    newRange.collapse(true);
                    sel.removeAllRanges();
                    sel.addRange(newRange);
                    return;
                }
            }
        }

        // カーソルがテキストノード内でもチェックボックスli内の先頭空白位置にある場合
        if (container.nodeType === Node.TEXT_NODE) {
            const li = domUtils.getParentElement(container, 'LI');
            if (li && hasCheckboxAtStart(li)) {
                const firstTN = getFirstDirectTextNodeAfterCheckbox(li);
                if (container === firstTN) {
                    const minOffset = getCheckboxTextMinOffset(li);
                    if (offset < minOffset) {
                        const newRange = document.createRange();
                        newRange.setStart(firstTN, minOffset);
                        newRange.collapse(true);
                        sel.removeAllRanges();
                        sel.addRange(newRange);
                        return;
                    }
                }
            }
        }
    }

    // Update list item classes based on content
    function updateListItemClasses() {
        const listItems = editor.querySelectorAll('li');
        const selection = window.getSelection();
        let activeListItem = null;
        if (selection && selection.rangeCount > 0) {
            const range = selection.getRangeAt(0);
            activeListItem = domUtils.getParentElement(range.commonAncestorContainer, 'LI');
        }

        listItems.forEach(li => {
            // Check if list item only contains nested lists (no text content)
            const directText = getDirectTextContent(li);
            const directTextWithoutPlaceholders = directText.replace(/[\u00A0\u200B]/g, '');
            const hasTextContent = directTextWithoutPlaceholders.trim() !== '';
            const hasNestedList = hasNestedListChild(li);
            let isPreservedEmpty = li.getAttribute('data-preserve-empty') === 'true';
            const isActiveItem = activeListItem && li === activeListItem;

            if (!isPreservedEmpty && !hasNestedList && !hasTextContent) {
                li.setAttribute('data-preserve-empty', 'true');
                isPreservedEmpty = true;
            }

            if (!isPreservedEmpty && isActiveItem && hasNestedList && !hasTextContent) {
                li.setAttribute('data-preserve-empty', 'true');
                isPreservedEmpty = true;
            }

            if (!isPreservedEmpty && hasNestedList && !hasTextContent && directText.includes('\u00A0')) {
                li.setAttribute('data-preserve-empty', 'true');
                isPreservedEmpty = true;
            }

            if (isPreservedEmpty && hasTextContent) {
                li.removeAttribute('data-preserve-empty');
                const textNodes = domUtils.getTextNodes(li);
                textNodes.forEach(textNode => {
                    let current = textNode.parentElement;
                    let inSublist = false;
                    while (current && current !== li) {
                        if (current.tagName === 'UL' || current.tagName === 'OL') {
                            inSublist = true;
                            break;
                        }
                        current = current.parentElement;
                    }
                    if (inSublist) return;

                    if (textNode.textContent.includes('\u00A0')) {
                        const cleaned = textNode.textContent.replace(/[\u00A0\u200B]/g, '');
                        if (cleaned === '') {
                            textNode.remove();
                        } else {
                            textNode.textContent = cleaned;
                        }
                    }
                });
            }

            if (isPreservedEmpty && !hasTextContent && hasNestedList) {
                const hasNbspNode = Array.from(li.childNodes).some(
                    child => child.nodeType === Node.TEXT_NODE && child.textContent.includes('\u00A0')
                );
                if (!hasNbspNode) {
                    const nbspNode = document.createTextNode('\u00A0');
                    const firstSublist = Array.from(li.children).find(
                        child => child.tagName === 'UL' || child.tagName === 'OL'
                    );
                    li.insertBefore(nbspNode, firstSublist || li.firstChild);
                }
            }

            // Add or remove class based on content
            // Always hide marker if there's a nested list and no text content
            // Even if the cursor is in this list item
            if (hasNestedList && !hasTextContent && !isPreservedEmpty) {
                li.classList.add('nested-list-only');
            } else {
                li.classList.remove('nested-list-only');
            }
        });
    }

    function preserveEmptyListItemAfterDelete(listItem) {
        if (!listItem || !listItem.isConnected) return false;

        const directText = getDirectTextContent(listItem);
        const directTextWithoutPlaceholders = directText.replace(/[\u00A0\u200B]/g, '');
        const hasTextContent = directTextWithoutPlaceholders.trim() !== '';
        const hasNestedList = hasNestedListChild(listItem);

        if (hasTextContent || !hasNestedList) return false;

        listItem.setAttribute('data-preserve-empty', 'true');

        const childNodes = Array.from(listItem.childNodes);
        childNodes.forEach(child => {
            if (child.nodeType === Node.ELEMENT_NODE && child.tagName === 'BR') {
                child.remove();
                return;
            }
            if (child.nodeType === Node.TEXT_NODE) {
                const text = child.textContent || '';
                const withoutPlaceholders = text.replace(/[\u00A0\u200B]/g, '');
                if (withoutPlaceholders.trim() === '' && !text.includes('\u00A0')) {
                    child.remove();
                }
            }
        });

        let nbspNode = null;
        for (let child of listItem.childNodes) {
            if (child.nodeType === Node.TEXT_NODE && (child.textContent || '').includes('\u00A0')) {
                nbspNode = child;
                break;
            }
        }

        if (!nbspNode) {
            const textNode = document.createTextNode('\u00A0');
            const firstSublist = Array.from(listItem.children).find(
                child => child.tagName === 'UL' || child.tagName === 'OL'
            );
            listItem.insertBefore(textNode, firstSublist || listItem.firstChild);
            nbspNode = textNode;
        }

        const selection = window.getSelection();
        if (selection && selection.rangeCount > 0 && nbspNode) {
            const range = selection.getRangeAt(0);
            const cursorContainer = range.startContainer;
            let shouldMoveCursor = true;

            if (cursorContainer && listItem.contains(cursorContainer)) {
                let current = cursorContainer.nodeType === 3 ? cursorContainer.parentElement : cursorContainer;
                let inSublist = false;
                while (current && current !== listItem) {
                    if (current.tagName === 'UL' || current.tagName === 'OL') {
                        inSublist = true;
                        break;
                    }
                    current = current.parentElement;
                }
                if (!inSublist) {
                    shouldMoveCursor = false;
                }
            }

            if (shouldMoveCursor) {
                try {
                    const newRange = document.createRange();
                    newRange.setStart(nbspNode, 0);
                    newRange.collapse(true);
                    selection.removeAllRanges();
                    selection.addRange(newRange);
                } catch (e) {
                    console.error('Failed to restore cursor after delete:', e);
                }
            }
        }

        return true;
    }

    function clearNotifyTimeout() {
        if (notifyTimeout) {
            clearTimeout(notifyTimeout);
            notifyTimeout = null;
        }
    }

    function postUpdate() {
        const content = domUtils.getCleanedHTML();
        vscode.postMessage({
            type: 'update',
            content: content
        });
    }

    function scheduleUpdate(delayMs) {
        clearNotifyTimeout();
        if (delayMs <= 0) {
            postUpdate();
            return;
        }
        notifyTimeout = setTimeout(() => {
            postUpdate();
            notifyTimeout = null;
        }, delayMs);
    }

    // 隣接する同タイプのリストをマージ
    function mergeAdjacentLists() {
        const lists = editor.querySelectorAll('ol, ul');
        for (const list of lists) {
            const next = list.nextElementSibling;
            if (next && next.tagName === list.tagName) {
                while (next.firstChild) {
                    list.appendChild(next.firstChild);
                }
                next.remove();
            }
        }
    }

    // 変更を通知
    function notifyChange() {
        // ゴーストスタイル（削除されたインラインコードのスタイルが残ったもの）をクリーンアップ
        domUtils.cleanupGhostStyles();

        // Update list item classes before notifying
        updateListItemClasses();

        // 隣接する同タイプのリスト(ol+ol, ul+ul)を自動マージ
        mergeAdjacentLists();

        scheduleEditorOverflowStateUpdate();

        scheduleUpdate(500);
    }

    function notifyChangeImmediate() {
        scheduleEditorOverflowStateUpdate();
        scheduleUpdate(0);
    }

    // Undo/Redo用の遅延通知（VSCodeの更新処理が完了するまで待つ）
    function notifyChangeDelayed() {
        scheduleEditorOverflowStateUpdate();
        // VSCodeの更新処理が完了するまで待つ（100ms - 短縮）
        scheduleUpdate(100);
    }

    function scheduleMarkdownConversion(convertFn) {
        if (typeof queueMicrotask === 'function') {
            queueMicrotask(convertFn);
        } else {
            setTimeout(convertFn, 0);
        }
    }

    function selectionCoversRange(outerRange, innerRange) {
        return outerRange.compareBoundaryPoints(Range.START_TO_START, innerRange) <= 0 &&
            outerRange.compareBoundaryPoints(Range.END_TO_END, innerRange) >= 0;
    }

    function getCodeBlockCursorOffset(codeBlock, range) {
        const offset = cursorManager.getCodeBlockCursorOffset(codeBlock, range);
        if (offset !== null) {
            return offset;
        }

        try {
            const startContainer = range.startContainer;
            if (!codeBlock.contains(startContainer) && startContainer !== codeBlock) {
                // The browser can place a collapsed caret on PRE boundaries (e.g. before/after
                // the CODE node in empty blocks). Map that caret to the nearest CODE edge so
                // backspace never deletes toolbar DOM nodes.
                if (range.collapsed) {
                    const parentPre = domUtils.getParentElement(startContainer, 'PRE');
                    const codePre = domUtils.getParentElement(codeBlock, 'PRE');
                    if (parentPre && codePre && parentPre === codePre) {
                        const codeRange = document.createRange();
                        codeRange.selectNodeContents(codeBlock);
                        const relativePos = codeRange.comparePoint(startContainer, range.startOffset);
                        if (relativePos < 0) {
                            return 0;
                        }
                        if (relativePos > 0) {
                            return cursorManager.getCodeBlockText(codeBlock).length;
                        }
                    }
                }
                return null;
            }
            const tempRange = document.createRange();
            tempRange.selectNodeContents(codeBlock);
            tempRange.setEnd(startContainer, range.startOffset);
            return tempRange.toString().length;
        } catch (e) {
            return null;
        }
    }

    function getLineInfoAtOffset(text, cursorOffset) {
        const safeOffset = Math.max(0, Math.min(cursorOffset, text.length));
        const lineStart = text.lastIndexOf('\n', Math.max(0, safeOffset - 1)) + 1;
        let lineEnd = text.indexOf('\n', safeOffset);
        if (lineEnd === -1) {
            lineEnd = text.length;
        }
        const lineLength = lineEnd - lineStart;
        const remainder = text.slice(lineEnd);
        return { safeOffset, lineStart, lineEnd, lineLength, remainder };
    }

    function isRangeAtCodeBlockEnd(codeBlock, range) {
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

    function findSelectedCodeBlock(range) {
        const startCode = domUtils.getParentElement(range.startContainer, 'CODE');
        const endCode = domUtils.getParentElement(range.endContainer, 'CODE');
        if (startCode && startCode === endCode) {
            const pre = domUtils.getParentElement(startCode, 'PRE');
            if (pre) {
                const codeRange = document.createRange();
                codeRange.selectNodeContents(startCode);
                if (selectionCoversRange(range, codeRange)) {
                    return pre;
                }
            }
        }

        const preBlocks = editor.querySelectorAll('pre');
        for (const pre of preBlocks) {
            const preRange = document.createRange();
            preRange.selectNode(pre);
            if (selectionCoversRange(range, preRange)) {
                return pre;
            }
        }

        return null;
    }

    function getNextElementSibling(node) {
        let next = node.nextSibling;
        while (next && next.nodeType === 3 && next.textContent.trim() === '') {
            next = next.nextSibling;
        }
        while (next && next.nodeType === 1 && isNavigationExcludedElement(next)) {
            next = next.nextSibling;
            while (next && next.nodeType === 3 && next.textContent.trim() === '') {
                next = next.nextSibling;
            }
        }
        return next && next.nodeType === 1 ? next : null;
    }

    function getNextNavigableSibling(node) {
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
            if (isNavigationExcludedElement(next)) {
                next = next.nextSibling;
                continue;
            }
            return next;
        }
        return null;
    }

    function getNextNavigableNodeAfter(node) {
        let current = node;
        while (current && current !== editor) {
            const next = getNextNavigableSibling(current);
            if (next) {
                return next;
            }
            current = current.parentNode;
        }
        return null;
    }

    function getPreviousElementSibling(node) {
        let prev = node.previousSibling;
        while (prev && prev.nodeType === 3 && prev.textContent.trim() === '') {
            prev = prev.previousSibling;
        }
        while (prev && prev.nodeType === 1 && isNavigationExcludedElement(prev)) {
            prev = prev.previousSibling;
            while (prev && prev.nodeType === 3 && prev.textContent.trim() === '') {
                prev = prev.previousSibling;
            }
        }
        return prev && prev.nodeType === 1 ? prev : null;
    }

    function isNavigationExcludedElement(element) {
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

    function getOutermostStrikeElement(node) {
        let current = node && node.nodeType === 3 ? node.parentElement : node;
        let found = null;
        while (current && current !== editor) {
            if (current.tagName === 'DEL' || current.tagName === 'S' || current.tagName === 'STRIKE') {
                found = current;
            }
            current = current.parentElement;
        }
        return found;
    }

    function isAtStrikeEnd(range, strikeElement) {
        if (!strikeElement || !range.collapsed) return false;
        if (!strikeElement.contains(range.startContainer)) return false;
        try {
            const tailRange = document.createRange();
            tailRange.setStart(range.startContainer, range.startOffset);
            tailRange.setEnd(strikeElement, strikeElement.childNodes.length);
            const remaining = tailRange.toString().replace(/[\u200B\s]/g, '');
            return remaining === '';
        } catch (e) {
            return false;
        }
    }

    function isEmptyInlineStrike(strikeElement) {
        if (!strikeElement) return false;
        const text = (strikeElement.textContent || '').replace(/[\u200B\s\u00A0]/g, '');
        if (text !== '') return false;
        // Allow <br> only; any other element means it's not empty
        for (const child of strikeElement.childNodes) {
            if (child.nodeType === Node.ELEMENT_NODE && child.tagName !== 'BR') {
                return false;
            }
        }
        return true;
    }

    function cleanupEmptyStrikeAtSelection() {
        const selection = window.getSelection();
        if (!selection || !selection.rangeCount || !selection.isCollapsed) return false;
        const range = selection.getRangeAt(0);
        const container = range.commonAncestorContainer;
        const strikeElement = getOutermostStrikeElement(container);
        if (!strikeElement || !isEmptyInlineStrike(strikeElement)) return false;

        const parent = strikeElement.parentNode;
        if (!parent) return false;
        const hasBr = !!strikeElement.querySelector('br');
        const replacement = hasBr ? document.createElement('br') : document.createTextNode('\u200B');
        parent.replaceChild(replacement, strikeElement);

        const newRange = document.createRange();
        if (replacement.nodeType === Node.TEXT_NODE) {
            newRange.setStart(replacement, Math.min(1, replacement.textContent.length));
        } else {
            newRange.setStartAfter(replacement);
        }
        newRange.collapse(true);
        selection.removeAllRanges();
        selection.addRange(newRange);
        return true;
    }

    function cleanupEmptyStrikes() {
        const selection = window.getSelection();
        let activeRange = selection && selection.rangeCount ? selection.getRangeAt(0) : null;
        let removed = false;

        const strikes = Array.from(editor.querySelectorAll('del, s, strike'));
        strikes.forEach(strikeElement => {
            if (!isEmptyInlineStrike(strikeElement)) return;
            const parent = strikeElement.parentNode;
            if (!parent) return;

            const hasBr = !!strikeElement.querySelector('br');
            const replacement = hasBr ? document.createElement('br') : document.createTextNode('\u200B');
            const shouldRestore = activeRange && strikeElement.contains(activeRange.startContainer);

            parent.replaceChild(replacement, strikeElement);
            removed = true;

            if (shouldRestore && selection) {
                const newRange = document.createRange();
                if (replacement.nodeType === Node.TEXT_NODE) {
                    newRange.setStart(replacement, Math.min(1, replacement.textContent.length));
                } else {
                    newRange.setStartAfter(replacement);
                }
                newRange.collapse(true);
                selection.removeAllRanges();
                selection.addRange(newRange);
                activeRange = newRange;
            }
        });

        return removed;
    }

    function getStrikeSiblingAtCaret(range) {
        if (!range) return null;
        const container = range.commonAncestorContainer;
        if (container && container.nodeType === Node.ELEMENT_NODE) {
            const offset = range.startOffset;
            if (offset > 0 && offset <= container.childNodes.length) {
                const prevNode = container.childNodes[offset - 1];
                if (prevNode && prevNode.tagName && ['DEL', 'S', 'STRIKE'].includes(prevNode.tagName)) {
                    return prevNode;
                }
            }
        }
        return null;
    }

    function unwrapStrikeAtSelection() {
        const selection = window.getSelection();
        if (!selection || !selection.rangeCount) return false;
        const range = selection.getRangeAt(0);
        const container = range.commonAncestorContainer;
        let strikeElement = getOutermostStrikeElement(container);
        if (!strikeElement) {
            strikeElement = getStrikeSiblingAtCaret(range);
        }
        if (!strikeElement) return false;

        const parent = strikeElement.parentNode;
        if (!parent) return false;

        const fragment = document.createDocumentFragment();
        while (strikeElement.firstChild) {
            fragment.appendChild(strikeElement.firstChild);
        }
        parent.replaceChild(fragment, strikeElement);

        // Move caret to the end of the unwrapped content
        const newRange = document.createRange();
        const lastNode = parent.childNodes[parent.childNodes.length - 1];
        if (lastNode && lastNode.nodeType === Node.TEXT_NODE) {
            newRange.setStart(lastNode, lastNode.textContent.length);
        } else if (lastNode) {
            newRange.setStartAfter(lastNode);
        } else {
            newRange.setStart(parent, parent.childNodes.length);
        }
        newRange.collapse(true);
        selection.removeAllRanges();
        selection.addRange(newRange);
        return true;
    }

    function insertPlainTextAtSelection(text) {
        const selection = window.getSelection();
        if (!selection || !selection.rangeCount) return false;
        const range = selection.getRangeAt(0);

        cleanupEmptyStrikeAtSelection();
        cleanupEmptyStrikes();
        unwrapStrikeAtSelection();

        // Remove a <br> at caret position if present
        if (range.startContainer && range.startContainer.nodeType === Node.ELEMENT_NODE) {
            const container = range.startContainer;
            const offset = range.startOffset;
            const child = container.childNodes[offset];
            if (child && child.nodeType === Node.ELEMENT_NODE && child.tagName === 'BR') {
                child.remove();
            }
        }

        if (!range.collapsed) {
            range.deleteContents();
        }

        const textNode = document.createTextNode(text);
        range.insertNode(textNode);

        const newRange = document.createRange();
        newRange.setStart(textNode, textNode.textContent.length);
        newRange.collapse(true);
        selection.removeAllRanges();
        selection.addRange(newRange);
        return true;
    }

    function isSelectionInStrike() {
        const selection = window.getSelection();
        if (!selection || !selection.rangeCount) return false;
        const range = selection.getRangeAt(0);
        const container = range.commonAncestorContainer;
        return !!getOutermostStrikeElement(container) || !!getStrikeSiblingAtCaret(range);
    }

    function shouldFlagStrikeCleanupForDelete(range) {
        if (!range) return false;
        const container = range.commonAncestorContainer;
        if (getOutermostStrikeElement(container)) return true;
        if (getStrikeSiblingAtCaret(range)) return true;
        if (range.intersectsNode) {
            const strikes = editor.querySelectorAll('del, s, strike');
            for (const strike of strikes) {
                try {
                    if (range.intersectsNode(strike)) {
                        return true;
                    }
                } catch (e) {
                    // ignore
                }
            }
        }
        return false;
    }

    function clearStrikeThroughState() {
        try {
            if (document.queryCommandState && document.queryCommandState('strikeThrough')) {
                document.execCommand('strikeThrough', false, null);
            }
        } catch (e) {
            // ignore
        }
    }

    // 引用ブロックの末尾にカーソルがあるかチェック
    function isAtBlockquoteEnd() {
        const selection = window.getSelection();
        if (!selection || !selection.rangeCount) return false;

        const range = selection.getRangeAt(0);
        if (!range.collapsed) return false;

        const container = range.commonAncestorContainer;
        const blockquote = domUtils.getParentElement(container, 'BLOCKQUOTE');
        if (!blockquote) return false;

        // 引用ブロック内のテキストノードを取得
        const allTextNodes = domUtils.getTextNodes(blockquote);

        // 空白のみではない「意味のある」テキストノードを取得
        const meaningfulTextNodes = allTextNodes.filter(tn => tn.textContent.trim() !== '');

        // 意味のあるテキストノードがない場合は末尾とみなす
        if (meaningfulTextNodes.length === 0) return true;

        const lastMeaningfulTextNode = meaningfulTextNodes[meaningfulTextNodes.length - 1];
        const offset = range.startOffset;

        // 現在のカーソル位置が意味のある最後のテキストノード内にある場合
        if (container === lastMeaningfulTextNode) {
            // 末尾または末尾付近（残りがZWSPや空白のみ）にいるかチェック
            const remainingText = lastMeaningfulTextNode.textContent.slice(offset);
            const cleanRemaining = remainingText.replace(/[\u200B\s]/g, '');
            if (cleanRemaining === '') {
                return true;
            }
        }

        // コンテナが要素の場合（例：<p>内にカーソルがある場合）
        if (container.nodeType === Node.ELEMENT_NODE) {
            // カーソルが要素の最後にある場合
            if (offset === container.childNodes.length || offset > 0) {
                // その要素がblockquote内の最後の意味のあるテキストを含むかチェック
                if (container.contains(lastMeaningfulTextNode)) {
                    // 最後の意味のあるテキストノードの後にカーソルがあるか確認
                    const containerTextNodes = domUtils.getTextNodes(container);
                    const lastContainerTextNode = containerTextNodes.filter(tn => tn.textContent.trim() !== '').pop();
                    if (lastContainerTextNode === lastMeaningfulTextNode) {
                        return true;
                    }
                }
            }
        }

        return false;
    }

    function shouldExitBlockquoteDownByVisualPosition() {
        const selection = window.getSelection();
        if (!selection || !selection.rangeCount) return false;

        const range = selection.getRangeAt(0);
        if (!range.collapsed) return false;

        const container = range.commonAncestorContainer;
        const blockquote = domUtils.getParentElement(container, 'BLOCKQUOTE');
        if (!blockquote) return false;

        if (!isCaretOnLastVisualLine(range, blockquote) && !isCaretNearBlockBottom(range, blockquote)) {
            return false;
        }

        const rects = range.getClientRects ? range.getClientRects() : null;
        const rect = rects && rects.length > 0 ? rects[0] : range.getBoundingClientRect();
        if (!rect) return true;

        const probeX = rect.left + Math.min(10, Math.max(2, rect.width * 0.1));
        const probeY = rect.bottom + Math.max(4, Math.min(20, rect.height || 16));
        const nextRange = getCaretRangeFromPoint(probeX, probeY);
        if (nextRange) {
            const node = nextRange.startContainer;
            if (node && (node === blockquote || blockquote.contains(node))) {
                return false;
            }
        }

        return true;
    }

    // 引用ブロックから抜ける（下に移動）
    function exitBlockquoteAfter(options = {}) {
        const selection = window.getSelection();
        if (!selection || !selection.rangeCount) return false;

        const range = selection.getRangeAt(0);
        const container = range.commonAncestorContainer;
        const blockquote = domUtils.getParentElement(container, 'BLOCKQUOTE');
        if (!blockquote) return false;

        const preferTopLevelGap = options && options.preferTopLevelGap === true;
        if (preferTopLevelGap) {
            let sibling = blockquote.nextSibling;
            let firstGapTextNode = null;
            let firstNavigableElement = null;
            while (sibling) {
                if (sibling.nodeType === Node.TEXT_NODE) {
                    const raw = sibling.textContent || '';
                    const cleaned = raw.replace(/[\u200B\uFEFF\u00A0]/g, '');
                    if (cleaned.trim() === '') {
                        if (!firstGapTextNode && /[\r\n]/.test(raw)) {
                            firstGapTextNode = sibling;
                        }
                        sibling = sibling.nextSibling;
                        continue;
                    }
                    break;
                }
                if (sibling.nodeType === Node.ELEMENT_NODE && isNavigationExcludedElement(sibling)) {
                    sibling = sibling.nextSibling;
                    continue;
                }
                if (sibling.nodeType === Node.ELEMENT_NODE) {
                    firstNavigableElement = sibling;
                }
                break;
            }

            if (firstGapTextNode && !(firstNavigableElement && isEffectivelyEmptyBlock(firstNavigableElement))) {
                const parent = blockquote.parentElement;
                if (parent) {
                    const gapParagraph = document.createElement('p');
                    gapParagraph.appendChild(document.createElement('br'));

                    if (firstNavigableElement && firstNavigableElement.parentElement === parent) {
                        parent.insertBefore(gapParagraph, firstNavigableElement);
                    } else if (blockquote.nextSibling) {
                        parent.insertBefore(gapParagraph, blockquote.nextSibling);
                    } else {
                        parent.appendChild(gapParagraph);
                    }

                    if (firstGapTextNode.parentNode === parent) {
                        firstGapTextNode.remove();
                    }

                    const gapRange = document.createRange();
                    gapRange.setStart(gapParagraph, 0);
                    gapRange.collapse(true);
                    selection.removeAllRanges();
                    selection.addRange(gapRange);
                    return true;
                }
            }
        }

        // 引用ブロックの次の要素を確認
        let nextElement = getNextElementSibling(blockquote);

        // 次の要素がない場合は新しい段落を作成
        if (!nextElement) {
            const p = document.createElement('p');
            const br = document.createElement('br');
            p.appendChild(br);
            blockquote.parentElement.insertBefore(p, blockquote.nextSibling);
            nextElement = p;
        }

        // カーソルを次の要素の先頭に移動
        const newRange = document.createRange();
        const firstNode = getPreferredFirstTextNodeForElement(nextElement);
        if (firstNode) {
            newRange.setStart(firstNode, 0);
        } else {
            newRange.setStart(nextElement, 0);
        }
        newRange.collapse(true);
        selection.removeAllRanges();
        selection.addRange(newRange);

        return true;
    }

    function deleteCodeBlock(pre, selection) {
        const parent = pre.parentElement;
        if (!parent) return;

        const nextElement = getNextElementSibling(pre);
        const prevElement = getPreviousElementSibling(pre);
        const targetElement = nextElement || prevElement;
        const useNext = !!nextElement;

        pre.remove();

        let focusTarget = targetElement;
        if (!focusTarget) {
            const newP = document.createElement('p');
            newP.appendChild(document.createElement('br'));
            parent.appendChild(newP);
            focusTarget = newP;
        }

        const newRange = document.createRange();
        if (useNext) {
            const firstNode = domUtils.getFirstTextNode(focusTarget);
            if (firstNode) {
                newRange.setStart(firstNode, 0);
            } else {
                newRange.setStart(focusTarget, 0);
            }
        } else {
            const lastNode = domUtils.getLastTextNode(focusTarget);
            if (lastNode) {
                newRange.setStart(lastNode, lastNode.textContent.length);
            } else {
                newRange.setStart(focusTarget, focusTarget.childNodes.length);
            }
        }
        newRange.collapse(true);
        selection.removeAllRanges();
        selection.addRange(newRange);
    }

    // Backspace処理
    function handleBackspace() {
        const selection = window.getSelection();
        if (!selection || !selection.rangeCount) return false;

        const range = selection.getRangeAt(0);
        let container = range.commonAncestorContainer;
        let offset = range.startOffset;

        const isInlineCodeElement = (node) => {
            if (!node || node.nodeType !== Node.ELEMENT_NODE || node.tagName !== 'CODE') {
                return false;
            }
            return !domUtils.getParentElement(node, 'PRE');
        };
        const isInlineBoundaryOnlyTextNode = (node) => {
            if (!node || node.nodeType !== Node.TEXT_NODE) {
                return false;
            }
            return (node.textContent || '').replace(/[\u200B\uFEFF]/g, '') === '';
        };
        const getOutsideLeftInlineCode = (targetRange) => {
            if (!targetRange || !targetRange.collapsed) {
                return null;
            }
            const targetContainer = targetRange.startContainer;
            const targetOffset = targetRange.startOffset;
            if (!targetContainer) {
                return null;
            }
            if (targetContainer.nodeType === Node.TEXT_NODE) {
                const nextSibling = targetContainer.nextSibling;
                if (!isInlineCodeElement(nextSibling)) {
                    return null;
                }
                const text = targetContainer.textContent || '';
                let trailingBoundaryStart = text.length;
                while (trailingBoundaryStart > 0 &&
                    (text[trailingBoundaryStart - 1] === '\u200B' || text[trailingBoundaryStart - 1] === '\uFEFF')) {
                    trailingBoundaryStart--;
                }
                return targetOffset >= trailingBoundaryStart ? nextSibling : null;
            }
            if (targetContainer.nodeType !== Node.ELEMENT_NODE) {
                return null;
            }
            const candidate = targetContainer.childNodes[targetOffset] || null;
            if (isInlineCodeElement(candidate)) {
                return candidate;
            }
            if (isInlineBoundaryOnlyTextNode(candidate) && isInlineCodeElement(candidate.nextSibling)) {
                return candidate.nextSibling;
            }
            return null;
        };
        const getCurrentBlock = (node) => {
            let block = node && node.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
            while (block && block !== editor && !domUtils.isBlockElement(block)) {
                block = block.parentElement;
            }
            return block && block !== editor ? block : null;
        };
        const isRangeAtBlockStart = (targetRange, block) => {
            if (!targetRange || !block) return false;
            try {
                const tempRange = document.createRange();
                tempRange.selectNodeContents(block);
                tempRange.setEnd(targetRange.startContainer, targetRange.startOffset);
                const beforeText = (tempRange.toString() || '').replace(/[\u200B\uFEFF\u00A0]/g, '').trim();
                return beforeText === '';
            } catch (e) {
                return false;
            }
        };

        // Backspace at outside-left of a leading inline code should delete line break first,
        // not consume inline-code boundary and jump inside-left.
        if (range.collapsed) {
            const outsideLeftInlineCode = getOutsideLeftInlineCode(range);
            const currentBlock = getCurrentBlock(range.startContainer);
            const isSupportedBlock = !!(currentBlock &&
                currentBlock.tagName !== 'LI' &&
                currentBlock.tagName !== 'PRE' &&
                currentBlock.tagName !== 'BLOCKQUOTE');
            if (outsideLeftInlineCode && isSupportedBlock && isRangeAtBlockStart(range, currentBlock)) {
                const prevBlock = getPreviousElementSibling(currentBlock);
                if (!prevBlock) {
                    return true;
                }
                const blockStartRange = document.createRange();
                blockStartRange.setStart(currentBlock, 0);
                blockStartRange.collapse(true);
                selection.removeAllRanges();
                selection.addRange(blockStartRange);
                document.execCommand('delete', false, null);
                notifyChange();
                return true;
            }
        }

        // ゼロ幅スペースをスキップして実際の文字を削除
        if (container.nodeType === 3 && offset > 0) {
            let currentNode = container;
            let currentOffset = offset;
            let deletedZWSP = false;

            while (currentOffset > 0 && currentNode.textContent[currentOffset - 1] === '\u200B') {
                currentOffset--;
                deletedZWSP = true;
            }

            if (deletedZWSP && currentOffset > 0) {
                const newRange = document.createRange();
                newRange.setStart(currentNode, currentOffset);
                newRange.collapse(true);
                selection.removeAllRanges();
                selection.addRange(newRange);

                document.execCommand('delete', false, null);
                notifyChange();
                return true;
            }
        }

        // 空の見出しの行頭でBackspaceされた場合、通常段落に戻す
        let heading = container.nodeType === Node.ELEMENT_NODE
            ? container
            : container.parentElement;
        while (heading && heading !== editor && !/^H[1-6]$/.test(heading.tagName)) {
            heading = heading.parentElement;
        }
        if (heading && heading !== editor && /^H[1-6]$/.test(heading.tagName) && range.collapsed) {
            const headingTextNodes = domUtils.getTextNodes(heading);
            let isAtHeadingStart = false;
            if (headingTextNodes.length > 0) {
                const firstTextNode = headingTextNodes[0];
                if (container === firstTextNode && offset === 0) {
                    isAtHeadingStart = true;
                }
            } else if (container === heading && offset <= 1) {
                // <h1><br></h1> のような空見出しでカーソルが先頭のケース
                isAtHeadingStart = true;
            }

            if (isAtHeadingStart && isEffectivelyEmptyBlock(heading)) {
                const p = document.createElement('p');
                p.innerHTML = '<br>';
                heading.replaceWith(p);

                const newRange = document.createRange();
                newRange.setStart(p, 0);
                newRange.collapse(true);
                selection.removeAllRanges();
                selection.addRange(newRange);

                notifyChange();
                return true;
            }
        }

        // リストアイテムの先頭かチェック
        const listItem = domUtils.getParentElement(container, 'LI');

        if (listItem && range.collapsed) {
            const textNodes = domUtils.getTextNodes(listItem);

            // カーソルがリストアイテムの先頭にあるかチェック
            let isAtStart = false;

            if (textNodes.length > 0) {
                const firstTextNode = textNodes[0];

                // テキストノードの先頭にカーソルがある場合
                if (container === firstTextNode && offset === 0) {
                    isAtStart = true;
                }

                // チェックボックスが先頭にある場合、minOffset以下も先頭として扱う
                if (!isAtStart && hasCheckboxAtStart(listItem)) {
                    const firstTN = getFirstDirectTextNodeAfterCheckbox(listItem);
                    const minOffset = getCheckboxTextMinOffset(listItem);
                    if (container === firstTN && offset <= minOffset) {
                        isAtStart = true;
                    }
                }
            } else if (container.nodeType === Node.ELEMENT_NODE && offset === 0) {
                // テキストノードがなく、要素の先頭にカーソルがある場合
                isAtStart = true;
            }

            // チェックボックスが先頭にあり、テキストがなく、カーソルがチェックボックス直後にある場合
            if (!isAtStart && hasCheckboxAtStart(listItem) && container === listItem) {
                // offset 1 = チェックボックス(input要素)の直後
                if (offset === 1 || (offset === 0 && listItem.firstChild?.nodeName === 'INPUT')) {
                    isAtStart = true;
                }
            }

            if (isAtStart) {
                const firstTextNode = textNodes.length > 0 ? textNodes[0] : null;

                // リストアイテムの先頭
                const parentList = listItem.parentElement;
                const grandParentItem = parentList ? parentList.parentElement : null;

                // リストアイテムのテキストコンテンツを取得（サブリストを除く）
                const directTextContent = getDirectTextContent(listItem);
                const isEmpty = directTextContent.trim() === '';

                if (grandParentItem && grandParentItem.tagName === 'LI') {
                    // ネストされたリスト
                    listManager.outdentListItem(listItem, firstTextNode, offset);
                    notifyChange();
                    return true;
                } else {
                    // トップレベルでのみチェックボックスを解除
                    if (hasCheckbox(listItem)) {
                        const checkbox = getCheckboxInListItemDirectContent(listItem);
                        if (checkbox) {
                            checkbox.remove();
                        }

                        // チェックボックス専用の先頭プレースホルダーを除去
                        const firstDirectTextNode = getFirstDirectTextNode(listItem) || domUtils.getFirstTextNode(listItem);
                        if (firstDirectTextNode && firstDirectTextNode.nodeType === Node.TEXT_NODE) {
                            const text = firstDirectTextNode.textContent || '';
                            const normalized = text.replace(/^[ \u00A0\u200B]/, '');
                            if (normalized === '') {
                                firstDirectTextNode.remove();
                            } else if (normalized !== text) {
                                firstDirectTextNode.textContent = normalized;
                            }
                        }
                    }

                    // トップレベルのリスト - 段落に変換
                    const p = document.createElement('p');
                    p.innerHTML = listItem.innerHTML;

                    // 空の段落の場合、<br>を追加して表示・編集可能にする
                    if (p.innerHTML.trim() === '' || p.textContent.trim() === '') {
                        p.innerHTML = '<br>';
                    }

                    if (listItem.previousElementSibling || listItem.nextElementSibling) {
                        // リストに他のアイテムがある場合、リストを分割して段落を挿入
                        // 後続のアイテムがある場合、新しいリストを作成
                        if (listItem.nextElementSibling) {
                            const newList = document.createElement(parentList.tagName);
                            let nextItem = listItem.nextElementSibling;
                            while (nextItem) {
                                const itemToMove = nextItem;
                                nextItem = nextItem.nextElementSibling;
                                newList.appendChild(itemToMove);
                            }
                            // 段落を現在のリストの直後に挿入
                            parentList.parentElement.insertBefore(p, parentList.nextSibling);
                            // 新しいリストを段落の直後に挿入
                            parentList.parentElement.insertBefore(newList, p.nextSibling);
                        } else {
                            // 後続のアイテムがない場合、段落をリストの直後に挿入
                            parentList.parentElement.insertBefore(p, parentList.nextSibling);
                        }

                        // 現在のアイテムを削除
                        listItem.remove();

                        // リストが空になった場合は削除
                        if (parentList.children.length === 0) {
                            parentList.remove();
                        }
                    } else {
                        // リストに1つしかアイテムがない場合、リスト全体を段落に置き換え
                        parentList.replaceWith(p);
                    }

                    // カーソル位置とフォーカスを復元
                    // DOMが更新されるまで待つためにrequestAnimationFrameを使用
                    requestAnimationFrame(() => {
                        // エディタにフォーカスを確保
                        editor.focus();

                        const newRange = document.createRange();
                        const firstNode = domUtils.getFirstTextNode(p);
                        if (firstNode) {
                            newRange.setStart(firstNode, 0);
                        } else {
                            newRange.setStart(p, 0);
                        }
                        newRange.collapse(true);
                        selection.removeAllRanges();
                        selection.addRange(newRange);
                    });
                }

                notifyChange();
                return true;
            }
        }

        // 引用ブロックの先頭かチェック
        const blockquote = domUtils.getParentElement(container, 'BLOCKQUOTE');
        if (blockquote && range.collapsed) {
            // カーソルが現在いる<p>要素を取得
            const currentP = domUtils.getParentElement(container, 'P');

            // <p>要素の先頭にカーソルがあるかチェック
            let isAtParagraphStart = false;
            if (currentP && blockquote.contains(currentP)) {
                const pTextNodes = domUtils.getTextNodes(currentP);
                if (pTextNodes.length > 0) {
                    const firstTextNode = pTextNodes[0];
                    if (container === firstTextNode && offset === 0) {
                        isAtParagraphStart = true;
                    }
                } else if (container === currentP && offset === 0) {
                    isAtParagraphStart = true;
                }
            }

            // blockquote内のすべての<p>要素を取得
            const paragraphs = Array.from(blockquote.querySelectorAll('p'));
            const currentPIndex = paragraphs.indexOf(currentP);

            if (isAtParagraphStart && currentP) {
                // 現在の段落を引用から抜け出す
                const newP = document.createElement('p');
                newP.innerHTML = currentP.innerHTML;

                if (currentPIndex === 0) {
                    // 最初の段落の場合
                    if (paragraphs.length === 1) {
                        // 唯一の段落 - blockquote全体を段落に置き換え
                        blockquote.replaceWith(newP);
                    } else {
                        // 他に段落がある - blockquoteの前に段落を挿入
                        blockquote.parentElement.insertBefore(newP, blockquote);
                        currentP.remove();
                    }
                } else {
                    // 最初の段落ではない場合 - blockquoteを分割
                    // 現在の段落より前の段落は元のblockquoteに残す
                    // 現在の段落は通常の段落として抽出
                    // 現在の段落より後の段落は新しいblockquoteに移動

                    // 現在の段落より後の段落を収集
                    const afterParagraphs = paragraphs.slice(currentPIndex + 1);

                    // 現在の段落を削除
                    currentP.remove();

                    // 新しい段落をblockquoteの後に挿入
                    blockquote.parentElement.insertBefore(newP, blockquote.nextSibling);

                    // 後続の段落がある場合、新しいblockquoteを作成
                    if (afterParagraphs.length > 0) {
                        const newBlockquote = document.createElement('blockquote');
                        afterParagraphs.forEach(p => {
                            newBlockquote.appendChild(p);
                        });
                        newP.parentElement.insertBefore(newBlockquote, newP.nextSibling);
                    }
                }

                // カーソル位置を復元
                requestAnimationFrame(() => {
                    editor.focus();
                    const newRange = document.createRange();
                    const firstNode = domUtils.getFirstTextNode(newP);
                    if (firstNode) {
                        newRange.setStart(firstNode, 0);
                    } else {
                        newRange.setStart(newP, 0);
                    }
                    newRange.collapse(true);
                    selection.removeAllRanges();
                    selection.addRange(newRange);
                });

                notifyChange();
                return true;
            }
        }

        // 空の段落の直後でBackspaceされた場合、空段落を削除してカーソル位置を行頭に保つ
        const currentP = domUtils.getParentElement(container, 'P');
        if (currentP && range.collapsed) {
            let isAtParagraphStart = false;
            const pTextNodes = domUtils.getTextNodes(currentP);
            if (pTextNodes.length > 0) {
                const firstTextNode = pTextNodes[0];
                if (container === firstTextNode && offset === 0) {
                    isAtParagraphStart = true;
                }
            } else if (container === currentP && offset === 0) {
                isAtParagraphStart = true;
            }

            if (isAtParagraphStart) {
                const prev = currentP.previousElementSibling;
                if (prev && prev.tagName === 'P' && isEffectivelyEmptyBlock(prev)) {
                    prev.remove();

                    const newRange = document.createRange();
                    const firstNode = domUtils.getFirstTextNode(currentP);
                    if (firstNode) {
                        newRange.setStart(firstNode, 0);
                    } else {
                        newRange.setStart(currentP, 0);
                    }
                    newRange.collapse(true);
                    selection.removeAllRanges();
                    selection.addRange(newRange);

                    notifyChange();
                    return true;
                }
            }
        }

        // コードブロック内かチェック（PRE境界にカーソルがあるケースも含む）
        let startCodeBlock = domUtils.getParentElement(range.startContainer, 'CODE');
        let endCodeBlock = domUtils.getParentElement(range.endContainer, 'CODE');
        let codeBlock = null;
        let preBlock = null;
        if (startCodeBlock && startCodeBlock === endCodeBlock) {
            codeBlock = startCodeBlock;
            preBlock = domUtils.getParentElement(codeBlock, 'PRE');
        } else {
            const startPre = domUtils.getParentElement(range.startContainer, 'PRE');
            const endPre = domUtils.getParentElement(range.endContainer, 'PRE');
            const resolvedPre = startPre && (!endPre || startPre === endPre) ? startPre : endPre;
            if (resolvedPre) {
                const codeCandidate = resolvedPre.querySelector('code');
                if (codeCandidate) {
                    codeBlock = codeCandidate;
                    preBlock = resolvedPre;
                }
            }
        }

        if (preBlock && codeBlock && range.collapsed) {
            const codeText = cursorManager.getCodeBlockText(codeBlock);
            const normalizedCodeText = codeText.replace(/[\u200B\uFEFF]/g, '');
            const isEmptyCodeBlock = normalizedCodeText.trim() === '';

            // 空のコードブロックはBackspace/Ctrl+Hでブロックごと削除
            if (isEmptyCodeBlock) {
                deleteCodeBlock(preBlock, selection);
                notifyChange();
                return true;
            }

            const cursorOffset = getCodeBlockCursorOffset(codeBlock, range);

            if (cursorOffset !== null) {
                const { safeOffset, lineStart, lineEnd } =
                    getLineInfoAtOffset(codeText, cursorOffset);
                const lineText = codeText.slice(lineStart, lineEnd);
                const deleteIndex = safeOffset - lineStart - 1;
                const canDeleteChar =
                    safeOffset === lineEnd &&
                    deleteIndex >= 0 &&
                    deleteIndex < lineText.length;

                if (canDeleteChar) {
                    const nextLineText = lineText.slice(0, deleteIndex) + lineText.slice(deleteIndex + 1);
                    const lineBecomesWhitespaceOnly =
                        nextLineText.replace(/\u200B/g, '').trim() === '';
                    if (lineBecomesWhitespaceOnly) {
                        let newText = codeText.slice(0, safeOffset - 1) + codeText.slice(safeOffset);
                        if (!newText.endsWith('\n')) {
                            newText += '\n';
                        }
                        newText = newText === '' ? '\n' : newText;
                        codeBlock.textContent = newText;

                        const targetOffset = Math.min(Math.max(safeOffset - 1, 0), newText.length);
                        cursorManager.setCodeBlockCursorOffset(codeBlock, selection, targetOffset);

                        if (codeBlock.className.match(/language-\w+/)) {
                            setTimeout(() => {
                                codeBlockManager.highlightSingleCodeBlock(codeBlock);
                            }, 0);
                        }

                        notifyChange();
                        return true;
                    }
                }
            }

            if (cursorOffset !== null && cursorOffset === 0) {
                // コードブロックの先頭 - 段落に変換
                const p = document.createElement('p');
                p.textContent = codeText;
                preBlock.replaceWith(p);

                const newRange = document.createRange();
                const firstNode = domUtils.getFirstTextNode(p);
                if (firstNode) {
                    newRange.setStart(firstNode, 0);
                } else {
                    newRange.setStart(p, 0);
                }
                newRange.collapse(true);
                selection.removeAllRanges();
                selection.addRange(newRange);

                notifyChange();
                return true;
            }
        }

        // Backspace実行前にカーソルがあるリストアイテムを記録
        let listItemBeforeDelete = listItem;

        // サブリスト付きのリストアイテムで、最後の1文字を削除するケースを記録
        // ブラウザが空のリストアイテムを消してしまう場合に備える
        let restoreInfo = null;
        if (listItem && range.collapsed) {
            const sublists = Array.from(listItem.children).filter(
                child => child.tagName === 'UL' || child.tagName === 'OL'
            );

            if (sublists.length > 0) {
                const directTextNodes = [];
                const walker = document.createTreeWalker(listItem, NodeFilter.SHOW_TEXT, null);
                let node;
                while (node = walker.nextNode()) {
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
                        directTextNodes.push(node);
                    }
                }

                if (directTextNodes.length > 0 && directTextNodes.includes(container)) {
                    let totalDirectLength = 0;
                    let cursorOffsetInDirect = null;

                    directTextNodes.forEach(textNode => {
                        if (cursorOffsetInDirect === null && textNode === container) {
                            cursorOffsetInDirect = totalDirectLength + offset;
                        }
                        totalDirectLength += textNode.textContent.length;
                    });

                    if (cursorOffsetInDirect !== null && cursorOffsetInDirect > 0) {
                        const directText = directTextNodes.map(node => node.textContent || '').join('');
                        const remainingText =
                            directText.slice(0, cursorOffsetInDirect - 1) + directText.slice(cursorOffsetInDirect);
                        const isLastVisibleCharDeleted =
                            remainingText.replace(/\u200B/g, '').trim() === '';

                        if (isLastVisibleCharDeleted) {
                            restoreInfo = {
                                parentList: listItem.parentElement,
                                nextSibling: listItem.nextElementSibling,
                                sublists: sublists.map(sublist => ({
                                    element: sublist,
                                    tagName: sublist.tagName,
                                    items: Array.from(sublist.children).filter(child => child.tagName === 'LI')
                                }))
                            };
                        }
                    }
                }
            }
        }

        // 通常のBackspace
        document.execCommand('delete', false, null);

        // Backspace後に空のリストアイテムをクリーンアップ
        requestAnimationFrame(() => {
            const selection = window.getSelection();
            const currentRange = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
            let cursorContainer = currentRange ? currentRange.startContainer : null;

            let shouldRestoreCursorToEmptyItem = false;
            let emptyListItemForCursor = null;
            let cursorTextNode = null;

            if (restoreInfo && listItemBeforeDelete && !listItemBeforeDelete.isConnected) {
                const parentList = restoreInfo.parentList;
                if (parentList && parentList.isConnected) {
                    const restoredListItem = document.createElement('li');

                    restoreInfo.sublists.forEach(info => {
                        let sublistElement = info.element;
                        if (!sublistElement || sublistElement.tagName !== info.tagName) {
                            sublistElement = document.createElement(info.tagName);
                        }

                        info.items.forEach(item => {
                            if (item && item.tagName === 'LI') {
                                if (item.parentElement !== sublistElement) {
                                    sublistElement.appendChild(item);
                                }
                            }
                        });

                        restoredListItem.appendChild(sublistElement);
                    });

                    if (restoreInfo.nextSibling && restoreInfo.nextSibling.parentElement === parentList) {
                        parentList.insertBefore(restoredListItem, restoreInfo.nextSibling);
                    } else {
                        parentList.appendChild(restoredListItem);
                    }

                    listItemBeforeDelete = restoredListItem;
                    cursorContainer = restoredListItem;
                }
            }

            const allListItems = editor.querySelectorAll('li');

            allListItems.forEach(li => {
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

                // 直接のテキストコンテンツがあるかチェック（サブリストを除く）
                const hasDirectTextContentValue = hasDirectTextContent(li);

                // 直接のテキストコンテンツがなく、サブリストのみの場合
                if (!hasDirectTextContentValue) {
                    const sublists = Array.from(li.children).filter(
                        child => child.tagName === 'UL' || child.tagName === 'OL'
                    );

                    if (sublists.length > 0) {
                        const parentList = li.parentElement;
                        if (parentList && (parentList.tagName === 'UL' || parentList.tagName === 'OL')) {
                            // このリストアイテムがBackspace実行前のリストアイテムと同じ場合、
                            // またはカーソルがこのリストアイテム内にある場合
                            // カーソルをこの空のリストアイテムに保持する必要がある
                            const cursorInThisItem = cursorContainer && li.contains(cursorContainer);
                            let cursorInDirectContent = false;
                            if (cursorInThisItem) {
                                let current = cursorContainer.nodeType === 3 ? cursorContainer.parentElement : cursorContainer;
                                let inSublist = false;
                                while (current && current !== li) {
                                    if (current.tagName === 'UL' || current.tagName === 'OL') {
                                        inSublist = true;
                                        break;
                                    }
                                    current = current.parentElement;
                                }
                                cursorInDirectContent = !inSublist;
                            }
                            const isPreservedEmpty = li.getAttribute('data-preserve-empty') === 'true';
                            const shouldPreserveEmptyItem =
                                li === listItemBeforeDelete || cursorInThisItem || isPreservedEmpty;

                            if (shouldPreserveEmptyItem) {
                                if (!shouldRestoreCursorToEmptyItem && (cursorInDirectContent || li === listItemBeforeDelete)) {
                                    shouldRestoreCursorToEmptyItem = true;
                                    emptyListItemForCursor = li;
                                }

                                let emptyTextNode = null;
                                const existingNbspNode = Array.from(li.childNodes).find(
                                    child => child.nodeType === Node.TEXT_NODE &&
                                        (child.textContent || '').includes('\u00A0')
                                );
                                if (existingNbspNode) {
                                    emptyTextNode = existingNbspNode;
                                } else {
                                    emptyTextNode = document.createTextNode('\u00A0');
                                    li.insertBefore(emptyTextNode, sublists[0]);
                                }

                                if (emptyListItemForCursor === li) {
                                    cursorTextNode = emptyTextNode;
                                }

                                // VSCode側でこの空のリストアイテムを保持するためのマーカーを追加
                                li.setAttribute('data-preserve-empty', 'true');
                            } else {
                                // 他の空のリストアイテムは従来通りの処理
                                // サブリストの子要素を親リストに移動
                                sublists.forEach(sublist => {
                                    const items = Array.from(sublist.children);
                                    items.forEach(item => {
                                        parentList.insertBefore(item, li.nextSibling);
                                    });
                                    sublist.remove();
                                });
                                // 空になったリストアイテムを削除
                                li.remove();
                            }
                        }
                    }
                }
            });

            // カーソルを空のリストアイテムに戻す
            if (shouldRestoreCursorToEmptyItem && emptyListItemForCursor && cursorTextNode && selection) {
                try {
                    const range = document.createRange();
                    range.setStart(cursorTextNode, 0);
                    range.collapse(true);
                    selection.removeAllRanges();
                    selection.addRange(range);
                } catch (e) {
                    console.error('Failed to restore cursor:', e);
                }
            }

            // Re-evaluate list markers after DOM adjustments for preserved empty items.
            updateListItemClasses();
        });

        notifyChange();
        return true;
    }

    function handleUndoRedoKeydown(e) {
        const syncTableUIAfterHistoryRestore = () => {
            tableManager.ensureInsertLines();
            tableManager.wrapTables();
            notifyChangeDelayed();
        };

        if ((e.metaKey || e.ctrlKey) && e.key === 'z' && !e.shiftKey) {
            e.preventDefault();
            stateManager.performUndo(syncTableUIAfterHistoryRestore);
            return true;
        }

        if ((e.metaKey || e.ctrlKey) && (e.key === 'Z' || (e.key === 'z' && e.shiftKey))) {
            e.preventDefault();
            stateManager.performRedo(syncTableUIAfterHistoryRestore);
            return true;
        }

        return false;
    }

    function handleFormatShortcutKeydown(e) {
        if (e.isComposing || isComposing) {
            return false;
        }

        if (e.metaKey && !e.ctrlKey && !e.altKey && e.shiftKey && e.key.toLowerCase() === 'x') {
            e.preventDefault();
            e.stopPropagation();
            toolbarManager.executeCommand('strikethrough');
            return true;
        }

        if (!isMac && e.altKey && e.shiftKey && !e.ctrlKey && !e.metaKey && e.key === '5') {
            e.preventDefault();
            e.stopPropagation();
            toolbarManager.executeCommand('strikethrough');
            return true;
        }

        if ((isMac ? e.metaKey && !e.ctrlKey : (e.metaKey || e.ctrlKey)) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'b') {
            e.preventDefault();
            e.stopPropagation();
            toolbarManager.executeCommand('bold');
            return true;
        }

        if ((isMac ? e.metaKey && !e.ctrlKey : (e.metaKey || e.ctrlKey)) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'i') {
            e.preventDefault();
            e.stopPropagation();
            toolbarManager.executeCommand('italic');
            return true;
        }

        return false;
    }

    function handleCodeBlockFenceEnterKeydown(e, context) {
        const { selection, range, container } = context;
        if (e.key !== 'Enter' || e.shiftKey || e.metaKey || e.ctrlKey || e.altKey || e.isComposing || isComposing) {
            return false;
        }

        if (!range.collapsed) {
            return false;
        }

        const inCodeBlock = domUtils.getParentElement(container, 'CODE');
        if (inCodeBlock) {
            return false;
        }

        const textNode = container.nodeType === 3 ? container : container.firstChild;
        if (!textNode || textNode.nodeType !== 3) {
            return false;
        }

        const textParent = textNode.parentElement;
        if (textParent && !textParent.contains(range.startContainer)) {
            return false;
        }

        const rawText = textNode.textContent || '';
        const normalizedText = rawText.replace(/\u200B/g, '');
        const fenceMatch = normalizedText.match(/^\s*```\s*([A-Za-z0-9_-]+)?\s*$/);
        if (!fenceMatch) {
            return false;
        }

        let cursorOffset = null;
        if (range.startContainer === textNode) {
            cursorOffset = range.startOffset;
        } else {
            const tempRange = document.createRange();
            tempRange.setStart(textNode, 0);
            try {
                tempRange.setEnd(range.startContainer, range.startOffset);
                cursorOffset = tempRange.toString().length;
            } catch (e) {
                return false;
            }
        }

        if (cursorOffset === null) {
            return false;
        }

        const normalizedOffset = rawText.slice(0, cursorOffset).replace(/\u200B/g, '').length;
        if (normalizedOffset !== normalizedText.length) {
            return false;
        }

        e.preventDefault();

        stateManager.saveState();

        const language = (fenceMatch[1] || '').toLowerCase();
        const pre = document.createElement('pre');
        const code = document.createElement('code');
        if (language) {
            code.className = `language-${language}`;
        }
        code.textContent = '\n';
        pre.appendChild(code);
        codeBlockManager.addCodeBlockControls(pre, language);

        const parent = textNode.parentElement;
        if (parent && parent !== editor) {
            parent.replaceWith(pre);
        } else {
            textNode.parentNode.replaceChild(pre, textNode);
        }

        requestAnimationFrame(() => {
            editor.focus();
            const newRange = document.createRange();
            const codeTextNode = code.firstChild;
            if (codeTextNode && codeTextNode.nodeType === 3) {
                newRange.setStart(codeTextNode, 0);
            } else {
                newRange.setStart(code, 0);
            }
            newRange.collapse(true);
            selection.removeAllRanges();
            selection.addRange(newRange);
            notifyChange();
        });

        return true;
    }

    function handleCodeBlockEnterKeydown(e, context) {
        const { selection, range } = context;
        if (e.key !== 'Enter' || e.shiftKey || e.metaKey || e.ctrlKey || e.altKey || e.isComposing || isComposing) {
            return false;
        }

        let startCodeBlock = domUtils.getParentElement(range.startContainer, 'CODE');
        let endCodeBlock = domUtils.getParentElement(range.endContainer, 'CODE');
        let codeBlock = null;
        let preBlock = null;
        if (startCodeBlock && startCodeBlock === endCodeBlock) {
            codeBlock = startCodeBlock;
            preBlock = domUtils.getParentElement(codeBlock, 'PRE');
        } else {
            const startPre = domUtils.getParentElement(range.startContainer, 'PRE');
            const endPre = domUtils.getParentElement(range.endContainer, 'PRE');
            const resolvedPre = startPre && (!endPre || startPre === endPre) ? startPre : endPre;
            if (resolvedPre) {
                const codeCandidate = resolvedPre.querySelector('code');
                if (codeCandidate) {
                    codeBlock = codeCandidate;
                    preBlock = resolvedPre;
                }
            }
        }
        if (!codeBlock || !preBlock) {
            return false;
        }

        const codeText = cursorManager.getCodeBlockText(codeBlock);
        const endRange = range.cloneRange();
        endRange.setStart(range.endContainer, range.endOffset);
        endRange.collapse(true);
        let startOffset = getCodeBlockCursorOffset(codeBlock, range);
        let endOffset = getCodeBlockCursorOffset(codeBlock, endRange);
        if (range.collapsed && isRangeAtCodeBlockEnd(codeBlock, range)) {
            startOffset = codeText.length;
            endOffset = codeText.length;
        } else if (startOffset === null || endOffset === null) {
            if (preBlock && (preBlock.contains(range.startContainer) || preBlock.contains(range.endContainer))) {
                startOffset = codeText.length;
                endOffset = codeText.length;
            } else {
                return false;
            }
        }

        e.preventDefault();
        stateManager.saveState();

        const insertOffset = Math.min(startOffset, endOffset);
        const deleteEndOffset = Math.max(startOffset, endOffset);
        const insertText = deleteEndOffset === codeText.length ? '\n\n' : '\n';
        let newText = codeText.slice(0, insertOffset) + insertText + codeText.slice(deleteEndOffset);
        if (newText === '') {
            newText = '\n';
        }
        codeBlock.textContent = newText;

        const targetOffset = Math.min(insertOffset + 1, newText.length);
        cursorManager.setCodeBlockCursorOffset(codeBlock, selection, targetOffset);

        if (codeBlock.className.match(/language-\w+/)) {
            setTimeout(() => {
                codeBlockManager.highlightSingleCodeBlock(codeBlock);
                cursorManager.setCodeBlockCursorOffset(codeBlock, selection, targetOffset);
            }, 0);
        }

        notifyChange();
        return true;
    }

    function handleListItemEnterKeydown(e, context) {
        const { selection, range, container, listItem } = context;
        const getListDepth = (node) => {
            let depth = 0;
            let current = node;
            while (current && current !== editor) {
                depth++;
                current = current.parentElement;
            }
            return depth;
        };
        const pickDeepestListItem = (items) => {
            const filtered = items.filter(item => !!item);
            if (filtered.length === 0) return null;
            let best = filtered[0];
            for (const candidate of filtered.slice(1)) {
                if (!candidate || candidate === best) continue;
                if (best.contains(candidate)) {
                    best = candidate;
                    continue;
                }
                if (candidate.contains(best)) {
                    continue;
                }
                if (getListDepth(candidate) > getListDepth(best)) {
                    best = candidate;
                }
            }
            return best;
        };
        const startContainerListItem = domUtils.getParentElement(range.startContainer, 'LI');
        const endContainerListItem = domUtils.getParentElement(range.endContainer, 'LI');
        const rangeListItemUp = getListItemFromRange(range, 'up');
        const rangeListItemDown = getListItemFromRange(range, 'down');
        const activeListItem = pickDeepestListItem([
            startContainerListItem,
            endContainerListItem,
            rangeListItemDown,
            rangeListItemUp,
            listItem
        ]);
        if (e.key !== 'Enter' || e.shiftKey || e.metaKey || e.ctrlKey || e.altKey || e.isComposing || isComposing || !activeListItem) {
            return false;
        }

        e.preventDefault();

        // Save state before any Enter operation
        stateManager.saveState();

        // Check if the list item is empty (ignore caret placeholders)
        const directTextForEnter = getDirectTextContent(activeListItem).replace(/[\u00A0\u200B]/g, '').trim();
        const isEmpty = directTextForEnter === '';
        const isCheckboxItem = hasCheckbox(activeListItem);

        if (isEmpty && !isCheckboxItem) {
            // Check if this is a nested list
            const parentList = activeListItem.parentElement;
            const grandParentItem = parentList ? parentList.parentElement : null;

            if (grandParentItem && grandParentItem.tagName === 'LI') {
                // Nested list - outdent
                const textNode = container.nodeType === 3 ? container : container.firstChild;
                const offset = range.startOffset;
                listManager.outdentListItem(activeListItem, textNode, offset);
            } else {
                // Top-level list - convert to paragraph
                const p = document.createElement('p');
                const br = document.createElement('br');
                p.appendChild(br);

                if (activeListItem.previousElementSibling || activeListItem.nextElementSibling) {
                    parentList.parentElement.insertBefore(p, parentList.nextSibling);
                    activeListItem.remove();

                    if (parentList.children.length === 0) {
                        parentList.remove();
                    }
                } else {
                    parentList.replaceWith(p);
                }

                // Set cursor in the new paragraph
                const newRange = document.createRange();
                newRange.setStart(p, 0);
                newRange.collapse(true);
                selection.removeAllRanges();
                selection.addRange(newRange);
            }
        } else if (isEmpty && isCheckboxItem) {
            // 空のチェックボックスアイテムでEnter → アウトデントまたはパラグラフに変換
            const parentList = activeListItem.parentElement;
            const grandParentItem = parentList ? parentList.parentElement : null;
            const convertToParagraphFromTopLevelEmptyCheckbox = () => {
                const p = document.createElement('p');
                const br = document.createElement('br');
                p.appendChild(br);

                if (activeListItem.previousElementSibling || activeListItem.nextElementSibling) {
                    if (activeListItem.nextElementSibling) {
                        const newList = document.createElement(parentList.tagName);
                        let nextItem = activeListItem.nextElementSibling;
                        while (nextItem) {
                            const itemToMove = nextItem;
                            nextItem = nextItem.nextElementSibling;
                            newList.appendChild(itemToMove);
                        }
                        parentList.parentElement.insertBefore(p, parentList.nextSibling);
                        parentList.parentElement.insertBefore(newList, p.nextSibling);
                    } else {
                        parentList.parentElement.insertBefore(p, parentList.nextSibling);
                    }
                    activeListItem.remove();

                    if (parentList.children.length === 0) {
                        parentList.remove();
                    }
                } else {
                    parentList.replaceWith(p);
                }

                // カーソルを新しいパラグラフに設定
                const newRange = document.createRange();
                newRange.setStart(p, 0);
                newRange.collapse(true);
                selection.removeAllRanges();
                selection.addRange(newRange);
                editor.focus();
                updateListItemClasses();
            };

            if (grandParentItem && grandParentItem.tagName === 'LI') {
                // ネストされたリスト → アウトデント
                const textNode = container.nodeType === 3 ? container : container.firstChild;
                const offset = range.startOffset;
                listManager.outdentListItem(activeListItem, textNode, offset);
            } else {
                // トップレベルの空チェックボックスで子リストがある場合は、
                // 空の親項目のみ削除して子項目を1段持ち上げる
                const nestedSublist = Array.from(activeListItem.children).find(
                    child => child.tagName === 'UL' || child.tagName === 'OL'
                );
                const liftedItems = nestedSublist
                    ? Array.from(nestedSublist.children).filter(child => child.tagName === 'LI')
                    : [];

                if (liftedItems.length > 0) {
                    const insertBeforeNode = activeListItem.nextSibling;
                    liftedItems.forEach(item => {
                        parentList.insertBefore(item, insertBeforeNode);
                    });
                    activeListItem.remove();

                    requestAnimationFrame(() => {
                        editor.focus();
                        const targetItem = liftedItems[0];
                        const targetIsCheckbox = hasCheckbox(targetItem);
                        let targetTextNode = targetIsCheckbox
                            ? getFirstDirectTextNodeAfterCheckbox(targetItem)
                            : domUtils.getFirstTextNode(targetItem);

                        if (!targetTextNode) {
                            const anchorNode = document.createTextNode(targetIsCheckbox ? '\u200B' : '');
                            const firstSublist = Array.from(targetItem.children).find(
                                child => child.tagName === 'UL' || child.tagName === 'OL'
                            );
                            if (firstSublist) {
                                targetItem.insertBefore(anchorNode, firstSublist);
                            } else {
                                targetItem.appendChild(anchorNode);
                            }
                            targetTextNode = anchorNode;
                        }

                        const newRange = document.createRange();
                        const startOffset = targetIsCheckbox ? getCheckboxTextMinOffset(targetItem) : 0;
                        newRange.setStart(targetTextNode, startOffset);
                        newRange.collapse(true);
                        selection.removeAllRanges();
                        selection.addRange(newRange);
                        updateListItemClasses();
                    });
                } else {
                    // 子リストがない場合は従来どおり段落化
                    convertToParagraphFromTopLevelEmptyCheckbox();
                }
            }
        } else {
            // Non-empty list item - create a new list item
            const parentList = activeListItem.parentElement;
            const newListItem = document.createElement('li');

            // Check if cursor is at the end of the list item's direct text content
            // (excluding any nested sublists)
            let isAtEndOfDirectText = false;
            let lastDirectTextNode = null;

            // Find the last text node that is not inside a sublist
            for (let child of activeListItem.childNodes) {
                if (child.nodeType === Node.TEXT_NODE) {
                    lastDirectTextNode = child;
                } else if (child.nodeType === Node.ELEMENT_NODE &&
                    child.tagName !== 'UL' && child.tagName !== 'OL' &&
                    child.tagName !== 'INPUT') {
                    // Check for text nodes inside non-list/non-input elements
                    const textNodes = domUtils.getTextNodes(child);
                    if (textNodes.length > 0) {
                        lastDirectTextNode = textNodes[textNodes.length - 1];
                    }
                }
            }

            if (lastDirectTextNode) {
                if (container === lastDirectTextNode && range.startOffset === lastDirectTextNode.textContent.length) {
                    isAtEndOfDirectText = true;
                }

                if (!isAtEndOfDirectText && range.collapsed) {
                    if (container === activeListItem && range.startOffset >= activeListItem.childNodes.length) {
                        isAtEndOfDirectText = true;
                    } else if (parentList && container === parentList) {
                        const siblings = Array.from(parentList.childNodes || []);
                        const activeIndex = siblings.indexOf(activeListItem);
                        if (activeIndex !== -1 && range.startOffset >= activeIndex + 1) {
                            isAtEndOfDirectText = true;
                        }
                    }
                }
            } else {
                // No direct text content, treat as at end
                isAtEndOfDirectText = true;
            }

            if (isAtEndOfDirectText) {
                // Check if there's a sublist in the current list item
                const sublist = Array.from(activeListItem.children).find(
                    child => child.tagName === 'UL' || child.tagName === 'OL'
                );

                if (sublist) {
                    // If there's a sublist, create TWO new list items:
                    // 1. First empty item (where cursor will be)
                    // 2. Second item with the sublist

                    const firstNewItem = document.createElement('li');
                    if (isCheckboxItem) {
                        firstNewItem.appendChild(createCheckboxElement());
                        firstNewItem.setAttribute('data-preserve-empty', 'true');
                    }
                    const firstTextNode = document.createTextNode(isCheckboxItem ? '\u200B' : '');
                    firstNewItem.appendChild(firstTextNode);

                    const secondNewItem = document.createElement('li');
                    const secondTextNode = document.createTextNode('');
                    secondNewItem.appendChild(secondTextNode);

                    // Move the sublist to the second item
                    sublist.remove();
                    secondNewItem.appendChild(sublist);

                    // Insert both items after the current item
                    if (activeListItem.nextSibling) {
                        parentList.insertBefore(firstNewItem, activeListItem.nextSibling);
                        parentList.insertBefore(secondNewItem, firstNewItem.nextSibling);
                    } else {
                        parentList.appendChild(firstNewItem);
                        parentList.appendChild(secondNewItem);
                    }

                    // Set cursor in the first new item
                    requestAnimationFrame(() => {
                        const newRange = document.createRange();
                        const startOffset = isCheckboxItem ? getCheckboxTextMinOffset(firstNewItem) : 0;
                        newRange.setStart(firstTextNode, startOffset);
                        newRange.collapse(true);
                        selection.removeAllRanges();
                        selection.addRange(newRange);
                        editor.focus();

                        // Update list item classes after cursor is set
                        updateListItemClasses();
                    });
                } else {
                    // No sublist - create a single new list item
                    if (isCheckboxItem) {
                        newListItem.appendChild(createCheckboxElement());
                        newListItem.setAttribute('data-preserve-empty', 'true');
                    }
                    const textNode = document.createTextNode(isCheckboxItem ? '\u200B' : '');
                    newListItem.appendChild(textNode);

                    // Insert the new list item after the current item in the parent list
                    if (activeListItem.nextSibling) {
                        parentList.insertBefore(newListItem, activeListItem.nextSibling);
                    } else {
                        parentList.appendChild(newListItem);
                    }

                    // Set cursor in new list item
                    requestAnimationFrame(() => {
                        const newRange = document.createRange();
                        const startOffset = isCheckboxItem ? getCheckboxTextMinOffset(newListItem) : 0;
                        newRange.setStart(textNode, startOffset);
                        newRange.collapse(true);
                        selection.removeAllRanges();
                        selection.addRange(newRange);
                        editor.focus();

                        // Update list item classes after cursor is set
                        updateListItemClasses();
                    });
                }
            } else if (isCheckboxItem && isRangeAtListItemStart(range, activeListItem)) {
                const grandParentItem = parentList ? parentList.parentElement : null;
                if (grandParentItem && grandParentItem.tagName === 'LI') {
                    // ネストされたチェックボックス行の先頭でEnter → アウトデント
                    const textNode = container.nodeType === Node.TEXT_NODE
                        ? container
                        : getFirstDirectTextNodeAfterCheckbox(activeListItem);
                    const offset = range.startOffset;
                    listManager.outdentListItem(activeListItem, textNode, offset);
                } else {
                    // トップレベルのチェックボックス行の先頭でEnter →
                    // チェックボックスを解除して通常の段落に変換
                    const checkbox = getCheckboxInListItemDirectContent(activeListItem);
                    if (checkbox) {
                        checkbox.remove();
                    }

                    // チェックボックス専用の先頭プレースホルダーを除去
                    const firstDirectTextNode = getFirstDirectTextNode(activeListItem) || domUtils.getFirstTextNode(activeListItem);
                    if (firstDirectTextNode && firstDirectTextNode.nodeType === Node.TEXT_NODE) {
                        const text = firstDirectTextNode.textContent || '';
                        const normalized = text.replace(/^[ \u00A0\u200B]/, '');
                        if (normalized === '') {
                            firstDirectTextNode.remove();
                        } else if (normalized !== text) {
                            firstDirectTextNode.textContent = normalized;
                        }
                    }

                    const p = document.createElement('p');
                    p.innerHTML = activeListItem.innerHTML;
                    if (p.innerHTML.trim() === '' || p.textContent.trim() === '') {
                        p.innerHTML = '<br>';
                    }

                    if (activeListItem.previousElementSibling || activeListItem.nextElementSibling) {
                        if (activeListItem.nextElementSibling) {
                            const newList = document.createElement(parentList.tagName);
                            let nextItem = activeListItem.nextElementSibling;
                            while (nextItem) {
                                const itemToMove = nextItem;
                                nextItem = nextItem.nextElementSibling;
                                newList.appendChild(itemToMove);
                            }
                            parentList.parentElement.insertBefore(p, parentList.nextSibling);
                            parentList.parentElement.insertBefore(newList, p.nextSibling);
                        } else {
                            parentList.parentElement.insertBefore(p, parentList.nextSibling);
                        }
                        activeListItem.remove();
                        if (parentList.children.length === 0) {
                            parentList.remove();
                        }
                    } else {
                        parentList.replaceWith(p);
                    }

                    // カーソルは変換後の段落の先頭に配置
                    requestAnimationFrame(() => {
                        const newRange = document.createRange();
                        const firstNode = domUtils.getFirstTextNode(p);
                        if (firstNode) {
                            newRange.setStart(firstNode, 0);
                        } else {
                            newRange.setStart(p, 0);
                        }
                        newRange.collapse(true);
                        selection.removeAllRanges();
                        selection.addRange(newRange);
                        editor.focus();
                        updateListItemClasses();
                    });
                }
            } else {
                // Cursor in middle - split the list item
                // Move content after cursor to new list item
                const splitRange = document.createRange();
                splitRange.setStart(range.startContainer, range.startOffset);
                splitRange.setEnd(activeListItem, activeListItem.childNodes.length);
                const afterContent = splitRange.extractContents();

                // For checkbox items, add a checkbox to the new item
                // and remove the checkbox from the extracted content (if it was somehow included)
                if (isCheckboxItem) {
                    newListItem.appendChild(createCheckboxElement());
                    // Remove only a top-level extracted checkbox.
                    // Deep descendants belong to nested checkbox list items and must be preserved.
                    const extractedTopLevelCheckbox = Array.from(afterContent.childNodes || []).find(node =>
                        node &&
                        node.nodeType === Node.ELEMENT_NODE &&
                        node.tagName === 'INPUT' &&
                        node.type === 'checkbox'
                    );
                    if (extractedTopLevelCheckbox) {
                        extractedTopLevelCheckbox.remove();
                    }
                }
                newListItem.appendChild(afterContent);

                // If new list item is empty (besides checkbox), add a text node
                const newItemTextContent = Array.from(newListItem.childNodes)
                    .filter(n => n.nodeType === Node.TEXT_NODE || (n.nodeType === Node.ELEMENT_NODE && n.tagName !== 'INPUT'))
                    .map(n => n.textContent)
                    .join('');
                if (newItemTextContent.trim() === '') {
                    // Remove any non-checkbox, non-text elements
                    Array.from(newListItem.childNodes).forEach(n => {
                        if (n.nodeType === Node.TEXT_NODE || (n.nodeType === Node.ELEMENT_NODE && n.tagName !== 'INPUT')) {
                            n.remove();
                        }
                    });
                    const textNode = document.createTextNode(isCheckboxItem ? '\u200B' : '');
                    newListItem.appendChild(textNode);
                    if (isCheckboxItem) {
                        newListItem.setAttribute('data-preserve-empty', 'true');
                    }
                }

                // Insert after current list item
                if (activeListItem.nextSibling) {
                    parentList.insertBefore(newListItem, activeListItem.nextSibling);
                } else {
                    parentList.appendChild(newListItem);
                }

                // Set cursor at start of new list item (after checkbox if present)
                const newFirstTextNode = isCheckboxItem
                    ? getFirstDirectTextNodeAfterCheckbox(newListItem)
                    : domUtils.getFirstTextNode(newListItem);
                if (newFirstTextNode) {
                    const newRange = document.createRange();
                    const cursorOffset = isCheckboxItem ? getCheckboxTextMinOffset(newListItem) : 0;
                    newRange.setStart(newFirstTextNode, cursorOffset);
                    newRange.collapse(true);
                    selection.removeAllRanges();
                    selection.addRange(newRange);
                }
            }
        }

        notifyChange();
        return true;
    }

    function handlePlainEnterKeydown(e, context) {
        const { selection, range, container, listItem } = context;
        if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey && !listItem) {
            const isInlineCodeElement = (node) => {
                if (!node || node.nodeType !== Node.ELEMENT_NODE || node.tagName !== 'CODE') {
                    return false;
                }
                return !domUtils.getParentElement(node, 'PRE');
            };
            const isBoundaryOnlyTextNode = (node) => {
                if (!node || node.nodeType !== Node.TEXT_NODE) {
                    return false;
                }
                return (node.textContent || '').replace(/[\u200B\uFEFF]/g, '') === '';
            };
            const getInlineCodeAtOutsideLeftBoundary = (targetRange) => {
                if (!targetRange || !targetRange.collapsed) {
                    return null;
                }
                const targetContainer = targetRange.startContainer;
                const targetOffset = targetRange.startOffset;
                if (!targetContainer) {
                    return null;
                }
                if (targetContainer.nodeType === Node.TEXT_NODE) {
                    const nextSibling = targetContainer.nextSibling;
                    if (!isInlineCodeElement(nextSibling)) {
                        return null;
                    }
                    const text = targetContainer.textContent || '';
                    let trailingBoundaryStart = text.length;
                    while (trailingBoundaryStart > 0 &&
                        (text[trailingBoundaryStart - 1] === '\u200B' || text[trailingBoundaryStart - 1] === '\uFEFF')) {
                        trailingBoundaryStart--;
                    }
                    return targetOffset >= trailingBoundaryStart ? nextSibling : null;
                }
                if (targetContainer.nodeType !== Node.ELEMENT_NODE) {
                    return null;
                }
                const candidate = targetContainer.childNodes[targetOffset] || null;
                if (isInlineCodeElement(candidate)) {
                    return candidate;
                }
                if (isBoundaryOnlyTextNode(candidate) && isInlineCodeElement(candidate.nextSibling)) {
                    return candidate.nextSibling;
                }
                return null;
            };
            const inlineCodeAtOutsideLeft = getInlineCodeAtOutsideLeftBoundary(range);
            if (inlineCodeAtOutsideLeft) {
                e.preventDefault();
                stateManager.saveState();
                document.execCommand('insertParagraph', false, null);

                const afterSelection = window.getSelection();
                if (afterSelection && afterSelection.rangeCount > 0) {
                    const afterRange = afterSelection.getRangeAt(0);
                    const insideCode = domUtils.getParentElement(afterRange.startContainer, 'CODE');
                    const insidePre = insideCode ? domUtils.getParentElement(insideCode, 'PRE') : null;
                    if (insideCode && !insidePre) {
                        cursorManager._placeCursorBeforeInlineCodeElement(insideCode, afterSelection);
                    } else {
                        const outsideLeftCode = getInlineCodeAtOutsideLeftBoundary(afterRange);
                        if (outsideLeftCode) {
                            cursorManager._placeCursorBeforeInlineCodeElement(outsideLeftCode, afterSelection);
                        }
                    }
                }
                notifyChange();
                return true;
            }

            const strikeElement = getOutermostStrikeElement(container);
            if (strikeElement && isAtStrikeEnd(range, strikeElement)) {
                e.preventDefault();
                stateManager.saveState();

                const newRange = document.createRange();
                newRange.setStartAfter(strikeElement);
                newRange.collapse(true);
                selection.removeAllRanges();
                selection.addRange(newRange);

                document.execCommand('insertParagraph', false, null);
                clearStrikeThroughState();
                notifyChange();
                return true;
            }

            // Save state before Enter operation
            stateManager.saveState();
        }
        return false;
    }

    function handleTabKeydown(e, context) {
        const { listItem, container, range } = context;
        // Tab/Shift+Tab でリストのインデント/アウトデント
        // Ignore Tab key during IME composition (e.g., Japanese input conversion)
        if (e.key !== 'Tab' || e.isComposing) {
            return false;
        }

        if (tableManager.handleTabKeydown(e)) {
            return true;
        }

        if (listItem) {
            e.preventDefault();
            e.stopPropagation();

            // Save state before indent/outdent operation
            stateManager.saveState();

            const textNode = container.nodeType === 3 ? container : container.firstChild;
            const offset = range.startOffset;

            if (e.shiftKey) {
                listManager.outdentListItem(listItem, textNode, offset);
            } else {
                listManager.indentListItem(listItem, textNode, offset);
            }

            // Ensure editor maintains focus after Tab operation
            setTimeout(() => {
                editor.focus();
            }, 0);

            notifyChange();
            return true;
        }

        // Not in a list, but still prevent default Tab behavior
        // and ensure editor keeps focus
        e.preventDefault();
        editor.focus();
        return false;
    }

    // 水平線を削除して前後の要素にカーソルを移動
    function deleteSelectedHR(hr, direction) {
        const selection = window.getSelection();
        const newRange = document.createRange();
        let targetElement = direction === 'backward' ? hr.previousElementSibling : hr.nextElementSibling;
        let rangePlaced = false;

        const placeCaretInElement = (element, atEnd) => {
            if (!element) return false;
            const textNode = atEnd ? domUtils.getLastTextNode(element) : domUtils.getFirstTextNode(element);
            if (textNode) {
                const offset = atEnd ? textNode.textContent.length : 0;
                newRange.setStart(textNode, offset);
                newRange.collapse(true);
                return true;
            }
            const offset = atEnd ? element.childNodes.length : 0;
            newRange.setStart(element, offset);
            newRange.collapse(true);
            return true;
        };

        // 連続するHRはスキップして、実際にカーソルを置ける要素を探す
        while (targetElement && targetElement.tagName === 'HR') {
            targetElement = direction === 'backward' ? targetElement.previousElementSibling : targetElement.nextElementSibling;
        }

        // 削除する前に移動先を確保
        if (targetElement) {
            rangePlaced = placeCaretInElement(targetElement, direction === 'backward');
        }

        if (!rangePlaced) {
            // 前後に要素がない場合、新しい段落を作成
            const newParagraph = document.createElement('p');
            const br = document.createElement('br');
            newParagraph.appendChild(br);
            if (direction === 'backward') {
                hr.before(newParagraph);
            } else {
                hr.after(newParagraph);
            }
            newRange.setStart(newParagraph, 0);
            newRange.collapse(true);
        }

        // HRを削除
        hr.remove();

        // カーソルを設定
        selection.removeAllRanges();
        selection.addRange(newRange);
    }

    function handleBackspaceKeydown(e, context) {
        const { range } = context;
        // Backspace (Ctrl+H) または Delete
        const key = e.key.toLowerCase();
        const labelTarget = range && range.startContainer
            ? (range.startContainer.nodeType === Node.ELEMENT_NODE
                ? range.startContainer
                : range.startContainer.parentElement)
            : null;
        const editingLabel = labelTarget && labelTarget.closest
            ? labelTarget.closest('.code-block-language.editing')
            : null;
        if (editingLabel) {
            const isCtrlH = isMac && e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && key === 'h';
            if (isCtrlH) {
                e.preventDefault();
                e.stopPropagation();
                const selection = window.getSelection();
                if (selection && selection.rangeCount > 0) {
                    const selRange = selection.getRangeAt(0);
                    if (selRange.collapsed && selRange.startContainer.nodeType === Node.TEXT_NODE) {
                        const offset = selRange.startOffset;
                        if (offset > 0) {
                            selRange.setStart(selRange.startContainer, offset - 1);
                            selRange.setEnd(selRange.startContainer, offset);
                            selection.removeAllRanges();
                            selection.addRange(selRange);
                        }
                    }
                }
                document.execCommand('delete', false, null);
                return true;
            }
            return false;
        }
        if ((e.key === 'Backspace' || e.key === 'Delete' || (isMac && e.ctrlKey && key === 'h')) && !e.metaKey && !e.altKey) {
            if (tableManager.handleBackspaceKeydown(e)) {
                return true;
            }
            // 水平線が選択されている場合は削除
            const selectedHR = isHRSelected();
            if (selectedHR) {
                e.preventDefault();
                stateManager.saveState();
                deleteSelectedHR(selectedHR, e.key === 'Backspace' ? 'backward' : 'forward');
                notifyChange();
                return true;
            }

            // チェックボックス位置でのBackspace/Ctrl+H/Delete → リストアイテム全体を削除
            const checkboxForBS = isCursorOnCheckbox();
            if (checkboxForBS) {
                e.preventDefault();
                stateManager.saveState();
                deleteCheckboxListItem(checkboxForBS.parentElement);
                return true;
            }

            if (isMac && e.ctrlKey && e.key === 'h') {
                e.preventDefault();
            }

            if (!range.collapsed) {
                if (shouldFlagStrikeCleanupForDelete(range)) {
                    pendingStrikeCleanup = true;
                }
                // 選択範囲がある場合は状態を保存
                stateManager.saveState();
                if (isMac && e.ctrlKey && key === 'h') {
                    document.execCommand('delete', false, null);
                }
                return true;
            }

            // Deleteキーの場合はデフォルト動作を許可
            if (e.key === 'Delete') {
                return false;
            }

            e.preventDefault();
            // Backspace操作の前に状態を保存
            stateManager.saveState();
            if (shouldFlagStrikeCleanupForDelete(range)) {
                pendingStrikeCleanup = true;
            }
            handleBackspace();
            const removedStrike = cleanupEmptyStrikeAtSelection() || cleanupEmptyStrikes();
            if (removedStrike) {
                if (!isSelectionInStrike()) {
                    clearStrikeThroughState();
                }
                notifyChange();
            }
            return true;
        }

        return false;
    }

    function isEffectivelyEmptyBlock(block) {
        if (!block) return false;
        const text = (block.textContent || '').replace(/[\u200B\u00A0]/g, '').trim();
        if (text !== '') return false;
        const hasNonBrElement = Array.from(block.childNodes).some(node => {
            if (node.nodeType !== Node.ELEMENT_NODE) return false;
            const el = node;
            if (el.tagName === 'BR') return false;
            if (el.getAttribute && el.getAttribute('data-exclude-from-markdown') === 'true') return false;
            return true;
        });
        return !hasNonBrElement;
    }

    function handleEmptyLineAboveCodeBlockNav(range, selection, direction) {
        if (!range || !selection || !range.collapsed) return false;
        if (domUtils.getParentElement(range.startContainer, 'PRE')) return false;
        let block = range.startContainer.nodeType === Node.ELEMENT_NODE
            ? range.startContainer
            : range.startContainer.parentElement;
        while (block && block !== editor && !domUtils.isBlockElement(block)) {
            block = block.parentElement;
        }
        if (block === editor) {
            const children = Array.from(editor.childNodes || []);
            const direct = children[range.startOffset] || null;
            if (direct && direct.nodeType === Node.ELEMENT_NODE && domUtils.isBlockElement(direct)) {
                block = direct;
            } else if (range.startOffset > 0) {
                const prev = children[range.startOffset - 1];
                if (prev && prev.nodeType === Node.ELEMENT_NODE && domUtils.isBlockElement(prev)) {
                    block = prev;
                }
            }
        }
        if (!block || block === editor) return false;
        if (!isEffectivelyEmptyBlock(block)) return false;
        const nextElement = getNextElementSibling(block);
        if (!nextElement || nextElement.tagName !== 'PRE' || !nextElement.querySelector('code')) {
            return false;
        }
        if (direction === 'down') {
            return selectCodeBlockLanguageLabel(nextElement);
        }
        const prevElement = getPreviousElementSibling(block);
        if (!prevElement) return false;
        const newRange = document.createRange();
        const lastNode = domUtils.getLastTextNode(prevElement);
        if (lastNode) {
            newRange.setStart(lastNode, lastNode.textContent.length);
        } else {
            newRange.setStart(prevElement, prevElement.childNodes.length);
        }
        newRange.collapse(true);
        selection.removeAllRanges();
        selection.addRange(newRange);
        return true;
    }

    function isAtBlockStartForRange(range, block) {
        if (!range || !block) return false;
        try {
            const tempRange = document.createRange();
            tempRange.selectNodeContents(block);
            tempRange.setEnd(range.startContainer, range.startOffset);
            const beforeText = tempRange.toString().replace(/\u200B/g, '');
            return beforeText.length === 0;
        } catch (e) {
            return false;
        }
    }

    function handleTableEdgeUpFromBelow(range, selection) {
        if (!range || !selection || !range.collapsed) return false;
        if (tableManager.isSelectionInTableContext()) return false;
        let block = range.startContainer.nodeType === Node.ELEMENT_NODE
            ? range.startContainer
            : range.startContainer.parentElement;
        while (block && block !== editor && !domUtils.isBlockElement(block)) {
            block = block.parentElement;
        }
        if (block === editor) {
            const children = Array.from(editor.childNodes || []);
            let index = Math.max(0, Math.min(range.startOffset, children.length)) - 1;
            for (let i = index; i >= 0; i--) {
                const node = children[i];
                if (!node) continue;
                if (node.nodeType === Node.TEXT_NODE) {
                    if (node.textContent.trim() === '') {
                        continue;
                    }
                    break;
                }
                if (node.nodeType === Node.ELEMENT_NODE) {
                    if (node.classList?.contains('md-table-insert-line') ||
                        node.getAttribute?.('data-exclude-from-markdown') === 'true') {
                        continue;
                    }
                    let wrapper = null;
                    if (node.classList?.contains('md-table-wrapper')) {
                        wrapper = node;
                    } else if (node.tagName === 'TABLE') {
                        wrapper = node.closest('.md-table-wrapper');
                    }
                    if (wrapper) {
                        const leftEdge = wrapper.querySelector('.md-table-edge-left');
                        if (!leftEdge) return false;
                        tableManager._setCursorToEdge(leftEdge, false);
                        if (typeof tableManager._lastEdgeNavTs === 'number') {
                            tableManager._lastEdgeNavTs = Date.now();
                            tableManager._lastEdgeNavDirection = 'up';
                        }
                        return true;
                    }
                    break;
                }
            }
            return false;
        }
        if (!block) return false;
        const prevWrapper = tableManager._getPrevTableWrapper
            ? tableManager._getPrevTableWrapper(block)
            : null;
        if (!prevWrapper) return false;
        const leftEdge = prevWrapper.querySelector('.md-table-edge-left');
        if (!leftEdge) return false;
        tableManager._setCursorToEdge(leftEdge, false);
        if (typeof tableManager._lastEdgeNavTs === 'number') {
            tableManager._lastEdgeNavTs = Date.now();
            tableManager._lastEdgeNavDirection = 'up';
        }
        return true;
    }

    function handleCtrlKEmptyLineBeforeTableKeydown(e, context) {
        if (!isMac) return false;
        if (!e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return false;
        if (e.key.toLowerCase() !== 'k') return false;
        if (tableManager.isSelectionInTableContext()) return false;

        const { range, container } = context;
        if (!range || !range.collapsed) return false;

        let block = container.nodeType === 3 ? container.parentElement : container;
        while (block && block !== editor && !domUtils.isBlockElement(block)) {
            block = block.parentElement;
        }
        if (!block) return false;
        if (block === editor) {
            const children = Array.from(editor.childNodes || []);
            const direct = children[range.startOffset] || null;
            if (direct && direct.nodeType === Node.ELEMENT_NODE && domUtils.isBlockElement(direct)) {
                block = direct;
            } else if (range.startOffset > 0) {
                const prev = children[range.startOffset - 1];
                if (prev && prev.nodeType === Node.ELEMENT_NODE && domUtils.isBlockElement(prev)) {
                    block = prev;
                }
            }
            if (block === editor) return false;
        }
        // 空の引用ブロック → 空のパラグラフに変換
        let blockquote = null;
        if (block.tagName === 'BLOCKQUOTE') {
            blockquote = block;
        } else if (block.parentElement && block.parentElement.tagName === 'BLOCKQUOTE' && block.parentElement.parentElement === editor) {
            blockquote = block.parentElement;
        }
        const isBlockquoteEmpty = blockquote && (blockquote.textContent || '').replace(/[\u200B\u00A0]/g, '').trim() === '';
        if (isBlockquoteEmpty) {
            e.preventDefault();
            stateManager.saveState();
            const p = document.createElement('p');
            p.appendChild(document.createElement('br'));
            blockquote.replaceWith(p);
            const sel = window.getSelection();
            if (sel) {
                const newRange = document.createRange();
                newRange.setStart(p, 0);
                newRange.collapse(true);
                sel.removeAllRanges();
                sel.addRange(newRange);
            }
            notifyChange();
            return true;
        }

        const isEmptyBlock = /^(P|DIV|H[1-6])$/.test(block.tagName);
        if (!isEmptyBlock) return false;
        if (!isEffectivelyEmptyBlock(block)) return false;

        const isHeading = /^H[1-6]$/.test(block.tagName);
        const nextElement = getNextElementSibling(block);
        if (!nextElement && !isHeading) return false;

        let wrapper = null;
        const nextIsRawTable = !!(nextElement && nextElement.tagName === 'TABLE');
        if (nextElement) {
            if (nextElement.classList?.contains('md-table-wrapper')) {
                wrapper = nextElement;
            } else if (nextElement.tagName === 'TABLE') {
                wrapper = nextElement.closest('.md-table-wrapper');
            }
        }

        e.preventDefault();
        stateManager.saveState();

        const prevElement = getPreviousElementSibling(block);
        block.remove();

        // If the next block is a raw table, ensure wrapper/edges exist so caret can stay visible.
        if (!wrapper && nextIsRawTable) {
            tableManager.wrapTables();
            wrapper = nextElement.closest('.md-table-wrapper');
        }

        if (nextElement) {
            if (wrapper) {
                const leftEdge = wrapper.querySelector('.md-table-edge-left');
                if (leftEdge) {
                    tableManager._setCursorToEdge(leftEdge, false);
                } else {
                    const selection = window.getSelection();
                    if (selection) {
                        const newRange = document.createRange();
                        newRange.setStart(wrapper, 0);
                        newRange.collapse(true);
                        selection.removeAllRanges();
                        selection.addRange(newRange);
                    }
                }
            } else {
                const selection = window.getSelection();
                if (selection) {
                    const newRange = document.createRange();
                    const firstNode = getPreferredFirstTextNodeForElement(nextElement);
                    if (firstNode) {
                        newRange.setStart(firstNode, 0);
                    } else {
                        newRange.setStart(nextElement, 0);
                    }
                    newRange.collapse(true);
                    selection.removeAllRanges();
                    selection.addRange(newRange);
                }
            }
        } else if (prevElement) {
            const selection = window.getSelection();
            if (selection) {
                const newRange = document.createRange();
                const lastNode = domUtils.getLastTextNode(prevElement);
                if (lastNode) {
                    newRange.setStart(lastNode, lastNode.textContent.length);
                } else {
                    newRange.setStart(prevElement, prevElement.childNodes.length);
                }
                newRange.collapse(true);
                selection.removeAllRanges();
                selection.addRange(newRange);
            }
        } else {
            // Keep a visible caret when the removed block was the only block in the editor.
            const selection = window.getSelection();
            const p = document.createElement('p');
            p.appendChild(document.createElement('br'));
            editor.appendChild(p);
            if (selection) {
                const newRange = document.createRange();
                newRange.setStart(p, 0);
                newRange.collapse(true);
                selection.removeAllRanges();
                selection.addRange(newRange);
            }
        }

        notifyChange();
        return true;
    }

    // 水平線が選択されているかチェック
    function isHRSelected() {
        const selection = window.getSelection();
        if (!selection || selection.rangeCount === 0) return null;
        const range = selection.getRangeAt(0);
        // rangeが水平線ノードを選択しているか確認
        if (range.startContainer === range.endContainer &&
            range.startContainer.nodeType === Node.ELEMENT_NODE) {
            const container = range.startContainer;
            const startNode = container.childNodes[range.startOffset];
            if (startNode && startNode.tagName === 'HR') {
                return startNode;
            }
        }
        // 折りたたみ選択でHR直後にキャレットがある場合もHR扱いにする
        if (range.collapsed && range.startContainer.nodeType === Node.ELEMENT_NODE) {
            const container = range.startContainer;
            const prevNode = range.startOffset > 0
                ? container.childNodes[range.startOffset - 1]
                : null;
            if (prevNode && prevNode.nodeType === Node.ELEMENT_NODE && prevNode.tagName === 'HR') {
                return prevNode;
            }
        }
        // 水平線自体が直接選択されている場合
        if (range.startContainer.parentElement) {
            const parent = range.startContainer.parentElement;
            if (parent.tagName === 'HR') {
                return parent;
            }
        }
        return null;
    }

    // チェックボックス上にカーソルがあるかを判定
    // カーソル位置が { container: li, offset: 0 } でli先頭にチェックボックスがある場合に
    // そのチェックボックス要素を返す。それ以外はnull。
    function isCursorOnCheckbox() {
        const sel = window.getSelection();
        if (!sel || !sel.rangeCount || !sel.isCollapsed) return null;
        const range = sel.getRangeAt(0);
        const container = range.startContainer;
        const offset = range.startOffset;
        if (container.nodeType === Node.ELEMENT_NODE && container.tagName === 'LI'
            && hasCheckboxAtStart(container) && offset === 0) {
            return container.querySelector(':scope > input[type="checkbox"]');
        }
        return null;
    }

    // チェックボックス付きリストアイテムのテキスト先頭にカーソルがあるかを判定
    // テキスト先頭にある場合はそのLI要素を返す。それ以外はnull。
    function isCursorAtCheckboxTextStart() {
        const sel = window.getSelection();
        if (!sel || !sel.rangeCount || !sel.isCollapsed) return null;
        const range = sel.getRangeAt(0);
        const container = range.startContainer;
        const offset = range.startOffset;

        let li = container.nodeType === Node.TEXT_NODE ? container.parentElement : container;
        while (li && li.tagName !== 'LI') {
            li = li.parentElement;
        }
        if (!li || !hasCheckboxAtStart(li)) return null;

        const firstTextNode = getFirstDirectTextNodeAfterCheckbox(li);
        const minOffset = getCheckboxTextMinOffset(li);

        if (firstTextNode && container === firstTextNode && offset <= minOffset) {
            return li;
        }

        // Safari/WebView ではチェックボックス直後が { container: li, offset: 1 } になることがある
        if (container === li && offset === 1) {
            return li;
        }
        return null;
    }

    // チェックボックス付きリストアイテムを丸ごと削除し、カーソルを隣接アイテムへ移動
    // チェックボックス付きリストアイテムの中身を消して空の行にする
    // チェックボックス付きリストアイテムを削除し、空のパラグラフに置き換える
    function deleteCheckboxListItem(li) {
        if (!li) return;
        const sel = window.getSelection();
        if (!sel) return;

        const parentList = li.parentElement;
        const p = document.createElement('p');
        p.appendChild(document.createElement('br'));

        // トップレベルのブロック祖先（editorの直接の子）を探す
        let topLevelAncestor = parentList;
        while (topLevelAncestor.parentElement && topLevelAncestor.parentElement !== editor) {
            topLevelAncestor = topLevelAncestor.parentElement;
        }
        const isNested = (topLevelAncestor !== parentList);

        if (isNested) {
            // ネストされたチェックボックスの場合: liを削除してトップレベルにpを挿入
            li.remove();
            // 空になった親要素を上方向にクリーンアップ
            let current = parentList;
            while (current && current !== topLevelAncestor) {
                const parent = current.parentElement;
                if (current.children.length === 0) {
                    current.remove();
                }
                current = parent;
            }
            // トップレベル要素にliが残っていなければ置換、そうでなければ後ろにpを挿入
            if (topLevelAncestor.querySelectorAll('li').length === 0) {
                topLevelAncestor.replaceWith(p);
            } else {
                editor.insertBefore(p, topLevelAncestor.nextSibling);
            }
        } else if (li.previousElementSibling || li.nextElementSibling) {
            // 他のアイテムがある場合: liの位置にpを挿入してliを削除
            parentList.parentElement.insertBefore(p, parentList);
            // liより前のアイテムがあればそれをpの前の新リストに分割
            const prevSiblings = [];
            let prev = li.previousElementSibling;
            while (prev) {
                prevSiblings.unshift(prev);
                prev = prev.previousElementSibling;
            }
            if (prevSiblings.length > 0) {
                const beforeList = document.createElement(parentList.tagName);
                prevSiblings.forEach(s => beforeList.appendChild(s));
                p.parentElement.insertBefore(beforeList, p);
            }
            li.remove();
            // 残りのアイテムがなければリストを削除
            if (parentList.children.length === 0) {
                parentList.remove();
            }
        } else {
            // 唯一のアイテムの場合: リスト全体をpに置換
            parentList.replaceWith(p);
        }

        const nr = document.createRange();
        nr.setStart(p, 0);
        nr.collapse(true);
        sel.removeAllRanges();
        sel.addRange(nr);
        notifyChange();
    }

    function getSelectedCodeBlockLanguageLabel() {
        const selection = window.getSelection();
        if (!selection || selection.rangeCount === 0) return null;
        const range = selection.getRangeAt(0);
        let element = range.startContainer.nodeType === Node.ELEMENT_NODE
            ? range.startContainer
            : range.startContainer.parentElement;
        if (!element) return null;

        if (range.startContainer.nodeType === Node.ELEMENT_NODE &&
            range.startContainer === range.endContainer) {
            const child = range.startContainer.childNodes[range.startOffset];
            if (child && child.nodeType === Node.ELEMENT_NODE) {
                const label = child.classList.contains('code-block-language')
                    ? child
                    : (child.closest ? child.closest('.code-block-language') : null);
                if (label && !label.classList.contains('editing')) {
                    return label;
                }
            }
        }

        const label = element.closest ? element.closest('.code-block-language') : null;
        if (!label || label.classList.contains('editing')) return null;
        return label;
    }

    function setCodeBlockLanguageNavSelection(label) {
        editor.querySelectorAll('.code-block-language.nav-selected').forEach(el => {
            if (el !== label) {
                el.classList.remove('nav-selected');
            }
        });
        if (label) {
            label.classList.add('nav-selected');
        }
    }

    function startEditingCodeBlockLanguageLabel(label) {
        if (!label || label.classList.contains('editing')) return false;
        setCodeBlockLanguageNavSelection(null);
        if (typeof label.__startEditing === 'function') {
            label.__startEditing();
            return true;
        }
        if (typeof label.click === 'function') {
            label.click();
            return true;
        }
        return false;
    }

    function selectCodeBlockLanguageLabel(pre) {
        if (!pre || pre.tagName !== 'PRE') return false;
        const label = pre.querySelector('.code-block-language');
        const code = pre.querySelector('code');
        if (!label || !code || label.classList.contains('editing')) return false;
        const selection = window.getSelection();
        if (!selection) return false;
        const range = document.createRange();
        range.selectNode(label);
        selection.removeAllRanges();
        selection.addRange(range);
        setCodeBlockLanguageNavSelection(label);
        return true;
    }

    function moveCursorIntoCodeBlockFromLabel(label) {
        if (!label) return false;
        const pre = label.closest('pre');
        const code = pre ? pre.querySelector('code') : null;
        if (!pre || !code) return false;
        const selection = window.getSelection();
        if (!selection) return false;
        if (cursorManager.setCodeBlockCursorOffset(code, selection, 0)) {
            return true;
        }
        const firstNode = domUtils.getFirstTextNode(code);
        const range = document.createRange();
        if (firstNode) {
            range.setStart(firstNode, 0);
        } else {
            range.setStart(code, 0);
        }
        range.collapse(true);
        selection.removeAllRanges();
        selection.addRange(range);
        setCodeBlockLanguageNavSelection(null);
        return true;
    }

    function moveCursorAboveCodeBlockFromLabel(label) {
        if (!label) return false;
        const pre = label.closest('pre');
        if (!pre) return false;
        const selection = window.getSelection();
        if (!selection) return false;

        let prevElement = getPreviousElementSibling(pre);
        if (prevElement && prevElement.tagName === 'HR') {
            const newRange = document.createRange();
            newRange.selectNode(prevElement);
            selection.removeAllRanges();
            selection.addRange(newRange);
            return true;
        }

        if (prevElement) {
            const newRange = document.createRange();
            const firstNode = domUtils.getFirstTextNode(prevElement);
            if (firstNode) {
                newRange.setStart(firstNode, 0);
            } else {
                newRange.setStart(prevElement, 0);
            }
            newRange.collapse(true);
            selection.removeAllRanges();
            selection.addRange(newRange);
            editor.focus();
            return true;
        }

        const parent = pre.parentElement;
        if (!parent) return false;
        const newP = document.createElement('p');
        newP.appendChild(document.createElement('br'));
        parent.insertBefore(newP, pre);
        const newRange = document.createRange();
        newRange.setStart(newP, 0);
        newRange.collapse(true);
        selection.removeAllRanges();
        selection.addRange(newRange);
        editor.focus();
        notifyChange();
        return true;
    }

    function moveCursorAboveCodeBlockFromLabelToLineEnd(label) {
        if (!label) return false;
        const pre = label.closest('pre');
        if (!pre) return false;
        const selection = window.getSelection();
        if (!selection) return false;

        let prevElement = getPreviousElementSibling(pre);
        if (prevElement && prevElement.tagName === 'HR') {
            const newRange = document.createRange();
            newRange.selectNode(prevElement);
            selection.removeAllRanges();
            selection.addRange(newRange);
            setCodeBlockLanguageNavSelection(null);
            return true;
        }

        if (prevElement) {
            if (prevElement.tagName === 'PRE') {
                const code = prevElement.querySelector('code');
                if (code) {
                    const text = cursorManager.getCodeBlockText(code);
                    if (cursorManager.setCodeBlockCursorOffset(code, selection, text.length)) {
                        setCodeBlockLanguageNavSelection(null);
                        return true;
                    }
                }
            }

            const newRange = document.createRange();
            const lastNode = domUtils.getLastTextNode(prevElement);
            if (lastNode) {
                newRange.setStart(lastNode, lastNode.textContent.length);
            } else {
                if (prevElement.tagName === 'P') {
                    const hasText = (prevElement.textContent || '').replace(/[\u200B\u00A0]/g, '').trim() !== '';
                    const hasBr = !!prevElement.querySelector('br');
                    if (!hasText && !hasBr) {
                        prevElement.appendChild(document.createElement('br'));
                    }
                }
                newRange.setStart(prevElement, prevElement.childNodes.length);
            }
            newRange.collapse(true);
            selection.removeAllRanges();
            selection.addRange(newRange);
            setCodeBlockLanguageNavSelection(null);
            editor.focus();
            return true;
        }

        const parent = pre.parentElement;
        if (!parent) return false;
        const newP = document.createElement('p');
        newP.appendChild(document.createElement('br'));
        parent.insertBefore(newP, pre);
        const newRange = document.createRange();
        newRange.setStart(newP, newP.childNodes.length);
        newRange.collapse(true);
        selection.removeAllRanges();
        selection.addRange(newRange);
        setCodeBlockLanguageNavSelection(null);
        editor.focus();
        notifyChange();
        return true;
    }

    function moveCursorIntoCodeBlockFromToolbarTarget(target, selection) {
        if (!target) return false;
        const pre = target.closest ? target.closest('pre') : null;
        const code = pre ? pre.querySelector('code') : null;
        if (!pre || !code) return false;
        const sel = selection || window.getSelection();
        if (!sel) return false;
        if (cursorManager.setCodeBlockCursorOffset(code, sel, 0)) {
            return true;
        }
        const firstNode = domUtils.getFirstTextNode(code);
        const range = document.createRange();
        if (firstNode) {
            range.setStart(firstNode, 0);
        } else {
            range.setStart(code, 0);
        }
        range.collapse(true);
        sel.removeAllRanges();
        sel.addRange(range);
        return true;
    }

    function isCaretNearBlockBottom(range, block) {
        if (!range || !block || !block.getBoundingClientRect) return false;
        const rects = range.getClientRects ? range.getClientRects() : null;
        const rect = rects && rects.length > 0 ? rects[0] : range.getBoundingClientRect();
        if (!rect) return false;
        const currentY = rect.bottom || (rect.y + rect.height) || 0;
        const blockRect = block.getBoundingClientRect();
        return currentY + 20 >= blockRect.bottom || (blockRect.bottom - currentY) < 40;
    }

    function isCaretNearBlockTop(range, block) {
        if (!range || !block || !block.getBoundingClientRect) return false;
        const rects = range.getClientRects ? range.getClientRects() : null;
        const rect = rects && rects.length > 0 ? rects[0] : range.getBoundingClientRect();
        if (!rect) return false;
        const currentY = rect.top || rect.y || 0;
        const blockRect = block.getBoundingClientRect();
        const lineHeight = rect.height || 16;
        return currentY <= blockRect.top + lineHeight || (currentY - blockRect.top) < 40;
    }

    function isCaretOnLastVisualLine(range, block) {
        if (!range || !block || !block.getBoundingClientRect) return false;
        const rects = range.getClientRects ? range.getClientRects() : null;
        const rect = rects && rects.length > 0 ? rects[0] : range.getBoundingClientRect();
        if (!rect) return false;
        const blockRect = block.getBoundingClientRect();
        const lineHeight = rect.height || 16;
        const delta = blockRect.bottom - rect.bottom;
        return delta <= lineHeight;
    }

    function getCodeBlockLineInfoFromRange(range, codeBlock) {
        if (!range || !codeBlock) return null;
        try {
            const textForOffset = cursorManager.getCodeBlockText(codeBlock);
            const offset = getCodeBlockCursorOffset(codeBlock, range);
            if (offset !== null) {
                const { lines, currentLineIndex } = cursorManager.getCodeBlockLineInfo(textForOffset, offset);
                const isWhitespaceOnly = (value) => value.replace(/[\u200B\u00A0\s]/g, '') === '';
                let lastNonWhitespaceLineIndex = -1;
                for (let i = lines.length - 1; i >= 0; i--) {
                    if (!isWhitespaceOnly(lines[i])) {
                        lastNonWhitespaceLineIndex = i;
                        break;
                    }
                }
                const totalLines = Math.max(0, lastNonWhitespaceLineIndex + 1);
                const clampedIndex = Math.min(currentLineIndex, Math.max(0, totalLines - 1));
                return { currentLineIndex: clampedIndex, totalLines, hasLineBelow: clampedIndex < totalLines - 1 };
            }
            const isInCode = (node) => node === codeBlock || (node && codeBlock.contains(node));
            let effectiveRange = range;
            if (!isInCode(range.startContainer) && !isInCode(range.endContainer)) {
                const endRange = document.createRange();
                endRange.selectNodeContents(codeBlock);
                endRange.collapse(false);
                effectiveRange = endRange;
            }
            const fullText = (codeBlock.innerText !== undefined ? codeBlock.innerText : codeBlock.textContent) || '';
            const lines = fullText.split('\n');
            const isWhitespaceOnly = (value) => value.replace(/[\u200B\u00A0\s]/g, '') === '';
            while (lines.length > 0 && isWhitespaceOnly(lines[lines.length - 1])) {
                lines.pop();
            }
            const totalLines = lines.length;
            const beforeRange = document.createRange();
            beforeRange.selectNodeContents(codeBlock);
            beforeRange.setEnd(effectiveRange.startContainer, effectiveRange.startOffset);
            const beforeText = beforeRange.toString();
            let currentLineIndex = beforeText.split('\n').length - 1;
            if (totalLines <= 0) {
                return { currentLineIndex: 0, totalLines: 0, hasLineBelow: false };
            }
            if (currentLineIndex >= totalLines) {
                currentLineIndex = totalLines - 1;
            }
            return { currentLineIndex, totalLines, hasLineBelow: currentLineIndex < totalLines - 1 };
        } catch (e) {
            return null;
        }
    }

    function getCaretRangeFromPoint(x, y) {
        if (document.caretRangeFromPoint) {
            return document.caretRangeFromPoint(x, y);
        }
        if (document.caretPositionFromPoint) {
            const pos = document.caretPositionFromPoint(x, y);
            if (pos) {
                const r = document.createRange();
                r.setStart(pos.offsetNode, pos.offset);
                r.collapse(true);
                return r;
            }
        }
        return null;
    }

    function isEditorLevelWhitespaceTextNode(node) {
        if (!node || node.nodeType !== Node.TEXT_NODE || node.parentElement !== editor) {
            return false;
        }
        const text = (node.textContent || '').replace(/[\u200B\u00A0\uFEFF]/g, '');
        return text.trim() === '';
    }

    function createCollapsedRangeAtElementBoundary(element, boundary = 'start') {
        if (!element || element.nodeType !== Node.ELEMENT_NODE) {
            return null;
        }
        const range = document.createRange();
        if (boundary === 'end') {
            const lastTextNode = domUtils.getLastTextNode(element);
            if (lastTextNode) {
                range.setStart(lastTextNode, (lastTextNode.textContent || '').length);
            } else {
                range.selectNodeContents(element);
                range.collapse(false);
                return range;
            }
        } else {
            // リスト先頭境界は、LI/checkbox内のテキスト先頭に正規化する
            if (element.tagName === 'UL' || element.tagName === 'OL') {
                const firstLi = Array.from(element.children).find(
                    child => child && child.tagName === 'LI'
                );
                if (firstLi) {
                    if (hasCheckboxAtStart(firstLi)) {
                        let textNode = getFirstDirectTextNodeAfterCheckbox(firstLi);
                        if (!textNode) {
                            const checkbox = firstLi.querySelector(':scope > input[type="checkbox"]');
                            if (checkbox) {
                                const anchorNode = document.createTextNode('\u200B');
                                const firstSublist = Array.from(firstLi.children).find(
                                    child => child.tagName === 'UL' || child.tagName === 'OL'
                                );
                                if (firstSublist) {
                                    firstLi.insertBefore(anchorNode, firstSublist);
                                } else {
                                    const nextNode = checkbox.nextSibling;
                                    if (nextNode) {
                                        firstLi.insertBefore(anchorNode, nextNode);
                                    } else {
                                        firstLi.appendChild(anchorNode);
                                    }
                                }
                                textNode = anchorNode;
                            }
                        }
                        if (textNode) {
                            range.setStart(textNode, getCheckboxTextMinOffset(firstLi));
                            range.collapse(true);
                            return range;
                        }
                    } else {
                        const firstTextNodeInLi = getFirstDirectTextNode(firstLi) || getLastDirectTextNode(firstLi);
                        if (firstTextNodeInLi) {
                            const text = firstTextNodeInLi.textContent || '';
                            let startOffset = 0;
                            while (startOffset < text.length && /[\u200B\uFEFF]/.test(text[startOffset])) {
                                startOffset++;
                            }
                            range.setStart(firstTextNodeInLi, startOffset);
                            range.collapse(true);
                            return range;
                        }
                    }
                }
            }

            const firstTextNode = domUtils.getFirstTextNode(element);
            if (firstTextNode) {
                const text = firstTextNode.textContent || '';
                let startOffset = 0;
                while (startOffset < text.length && /[\u200B\uFEFF]/.test(text[startOffset])) {
                    startOffset++;
                }
                range.setStart(firstTextNode, startOffset);
            } else {
                range.selectNodeContents(element);
                range.collapse(true);
                return range;
            }
        }
        range.collapse(true);
        return range;
    }

    function getNearestBlockBoundaryRangeByY(y) {
        const blocks = Array.from(editor.children || []).filter((child) => {
            if (!child || child.nodeType !== Node.ELEMENT_NODE) return false;
            if (child.getAttribute && child.getAttribute('data-exclude-from-markdown') === 'true') return false;
            return true;
        });
        if (blocks.length === 0) {
            return null;
        }

        let previousBlock = null;
        let nextBlock = null;

        for (const block of blocks) {
            const rect = block.getBoundingClientRect();
            if (y < rect.top) {
                nextBlock = block;
                break;
            }
            previousBlock = block;
            if (y <= rect.bottom) {
                const centerY = rect.top + rect.height / 2;
                const boundary = y <= centerY ? 'start' : 'end';
                return createCollapsedRangeAtElementBoundary(block, boundary);
            }
        }

        if (!previousBlock) {
            return createCollapsedRangeAtElementBoundary(blocks[0], 'start');
        }
        if (!nextBlock) {
            return createCollapsedRangeAtElementBoundary(previousBlock, 'end');
        }

        const previousRect = previousBlock.getBoundingClientRect();
        const nextRect = nextBlock.getBoundingClientRect();
        const distToPrev = Math.abs(y - previousRect.bottom);
        const distToNext = Math.abs(nextRect.top - y);
        return distToPrev <= distToNext
            ? createCollapsedRangeAtElementBoundary(previousBlock, 'end')
            : createCollapsedRangeAtElementBoundary(nextBlock, 'start');
    }

    function hasMeaningfulTextContent(value) {
        if (typeof value !== 'string') return false;
        return value.replace(/[\u200B\u00A0\uFEFF]/g, '').trim() !== '';
    }

    function getClosestBlockElement(node) {
        let current = node && node.nodeType === Node.ELEMENT_NODE
            ? node
            : (node ? node.parentElement : null);
        while (current && current !== editor) {
            if (domUtils.isBlockElement(current)) {
                return current;
            }
            current = current.parentElement;
        }
        return null;
    }

    function isImageOnlyBlockElement(blockElement) {
        if (!blockElement || blockElement.nodeType !== Node.ELEMENT_NODE) {
            return false;
        }
        const clone = blockElement.cloneNode(true);
        clone.querySelectorAll('img').forEach((img) => img.remove());
        return !hasMeaningfulTextContent(clone.textContent || '');
    }

    function getImageCaretAnchorNode(image) {
        if (!image || image.tagName !== 'IMG') return null;
        let anchor = image;
        let current = image.parentElement;
        while (current && current !== editor) {
            if (current.tagName === 'A' && current.childNodes && current.childNodes.length === 1) {
                anchor = current;
                current = current.parentElement;
                continue;
            }
            break;
        }
        return anchor;
    }

    function createAfterImageRangeIfRightSide(image, x, y, requireRightEdge) {
        if (!image || !editor.contains(image)) {
            return null;
        }
        const rect = image.getBoundingClientRect ? image.getBoundingClientRect() : null;
        if (!rect || rect.width <= 0 || rect.height <= 0) {
            return null;
        }

        const verticalTolerancePx = 6;
        if (y < rect.top - verticalTolerancePx || y > rect.bottom + verticalTolerancePx) {
            return null;
        }

        const rightHalfThreshold = rect.left + rect.width * 0.55;
        if (requireRightEdge) {
            if (x < rect.right - 2) {
                return null;
            }
        } else if (x < rightHalfThreshold) {
            return null;
        }

        const caretAnchor = getImageCaretAnchorNode(image) || image;
        if (!caretAnchor.parentNode) {
            return null;
        }

        const range = document.createRange();
        range.setStartAfter(caretAnchor);
        range.collapse(true);
        return range;
    }

    function getRightEdgeImageCaretRangeFromClick(x, y, clickedElement) {
        if (!clickedElement) {
            return null;
        }

        const clickedImage = clickedElement.tagName === 'IMG'
            ? clickedElement
            : (clickedElement.closest ? clickedElement.closest('img') : null);
        const directImageRange = createAfterImageRangeIfRightSide(clickedImage, x, y, false);
        if (directImageRange) {
            return directImageRange;
        }

        const blockElement = getClosestBlockElement(clickedElement);
        if (!blockElement || blockElement === editor || !isImageOnlyBlockElement(blockElement)) {
            return null;
        }

        const images = Array.from(blockElement.querySelectorAll('img')).filter((img) => editor.contains(img));
        if (images.length !== 1) {
            return null;
        }

        return createAfterImageRangeIfRightSide(images[0], x, y, true);
    }

    function getStableGapClickRange(x, y, clickedElement, pointRange) {
        if (!clickedElement) {
            return null;
        }
        if (clickedElement.tagName === 'HR') {
            return null;
        }

        // リストの補正は専用ロジックで扱う
        if (domUtils.getParentElement(clickedElement, 'LI')) {
            return null;
        }

        const editorGapClick = clickedElement === editor;
        const clickedIsBlockElement =
            clickedElement.nodeType === Node.ELEMENT_NODE &&
            domUtils.isBlockElement(clickedElement);
        const pointRangeContainer = pointRange ? pointRange.startContainer : null;
        const pointRangeIsInsideClickedBlock = !!(
            pointRangeContainer &&
            clickedIsBlockElement &&
            (clickedElement === pointRangeContainer || clickedElement.contains(pointRangeContainer))
        );
        const unstablePoint =
            !pointRange ||
            pointRangeContainer === editor ||
            isEditorLevelWhitespaceTextNode(pointRangeContainer) ||
            (clickedIsBlockElement && !pointRangeIsInsideClickedBlock);

        if (!unstablePoint && !editorGapClick) {
            return null;
        }
        if (!editorGapClick && !clickedIsBlockElement) {
            return null;
        }

        return getNearestBlockBoundaryRangeByY(y);
    }

    function hasCodeBlockLineBelow(range, codeBlock) {
        if (!range || !codeBlock) return null;
        const rect = cursorManager._getCaretRect(range);
        if (!rect) return null;
        const computed = window.getComputedStyle(codeBlock);
        const lh = parseFloat(computed.lineHeight || '') || rect.height || 16;
        const targetX = rect.left + Math.min(Math.max(2, rect.width * 0.1), 10);
        const targetY = rect.bottom + Math.max(4, Math.min(20, lh));
        const nextRange = getCaretRangeFromPoint(targetX, targetY);
        if (!nextRange) return null;
        const node = nextRange.startContainer;
        if (!node || (!codeBlock.contains(node) && node !== codeBlock)) {
            return false;
        }
        const nextRect = nextRange.getBoundingClientRect ? nextRange.getBoundingClientRect() : null;
        if (!nextRect) {
            return null;
        }
        return nextRect.bottom > rect.bottom + 2;
    }

    function maybeSelectCodeBlockLabelBelow(range) {
        if (!range) return false;
        if (domUtils.getParentElement(range.startContainer, 'PRE')) return false;
        let currentBlock = range.startContainer.nodeType === Node.ELEMENT_NODE
            ? range.startContainer
            : range.startContainer.parentElement;
        while (currentBlock && currentBlock !== editor && !domUtils.isBlockElement(currentBlock)) {
            currentBlock = currentBlock.parentElement;
        }
        if (!currentBlock || currentBlock === editor) return false;
        const isEmptyBlock = isEffectivelyEmptyBlock(currentBlock);
        if (!isEmptyBlock && !isCaretNearBlockBottom(range, currentBlock)) return false;
        const nextElement = getNextElementSibling(currentBlock);
        if (nextElement && nextElement.tagName === 'PRE' && nextElement.querySelector('code')) {
            return selectCodeBlockLanguageLabel(nextElement);
        }
        return false;
    }

    function maybeSelectCodeBlockLabelAbove(range) {
        if (!range) return false;
        if (domUtils.getParentElement(range.startContainer, 'PRE')) return false;
        let currentBlock = range.startContainer.nodeType === Node.ELEMENT_NODE
            ? range.startContainer
            : range.startContainer.parentElement;
        while (currentBlock && currentBlock !== editor && !domUtils.isBlockElement(currentBlock)) {
            currentBlock = currentBlock.parentElement;
        }
        if (!currentBlock || currentBlock === editor) return false;
        const isEmptyBlock = isEffectivelyEmptyBlock(currentBlock);
        if (!isEmptyBlock && !isCaretNearBlockTop(range, currentBlock)) return false;
        const prevElement = getPreviousElementSibling(currentBlock);
        if (prevElement && prevElement.tagName === 'PRE' && prevElement.querySelector('code')) {
            return selectCodeBlockLanguageLabel(prevElement);
        }
        return false;
    }

    function moveCursorIntoCodeBlockFromEmptyBlockBelow(range, selection) {
        if (!range || !selection) return false;
        if (domUtils.getParentElement(range.startContainer, 'PRE')) return false;
        let currentBlock = range.startContainer.nodeType === Node.ELEMENT_NODE
            ? range.startContainer
            : range.startContainer.parentElement;
        while (currentBlock && currentBlock !== editor && !domUtils.isBlockElement(currentBlock)) {
            currentBlock = currentBlock.parentElement;
        }
        if (!currentBlock || currentBlock === editor) return false;
        if (!isEffectivelyEmptyBlock(currentBlock)) return false;
        const prevElement = getPreviousElementSibling(currentBlock);
        if (!prevElement || prevElement.tagName !== 'PRE') return false;
        const codeBlock = prevElement.querySelector('code');
        if (!codeBlock) return false;

        const text = cursorManager.getCodeBlockText(codeBlock);
        const { lines, lineStartOffsets } = cursorManager.getCodeBlockLineInfo(text, text.length);
        const isWhitespaceOnly = (value) => value.replace(/[\u200B\u00A0\s]/g, '') === '';
        let targetLineIndex = -1;
        for (let i = lines.length - 1; i >= 0; i--) {
            if (!isWhitespaceOnly(lines[i])) {
                targetLineIndex = i;
                break;
            }
        }
        if (targetLineIndex < 0) {
            targetLineIndex = Math.max(0, lines.length - 1);
        }
        const lineText = lines[targetLineIndex] || '';
        const lineStart = lineStartOffsets[targetLineIndex] || 0;
        const targetOffset = lineStart + lineText.length;
        if (cursorManager.setCodeBlockCursorOffset(codeBlock, selection, targetOffset)) {
            setCodeBlockLanguageNavSelection(null);
            return true;
        }
        return false;
    }

    function moveCursorIntoCodeBlockFromTextBlockBelow(range, selection) {
        if (!range || !selection || !range.collapsed) return false;
        if (domUtils.getParentElement(range.startContainer, 'PRE')) return false;

        let currentBlock = range.startContainer.nodeType === Node.ELEMENT_NODE
            ? range.startContainer
            : range.startContainer.parentElement;
        while (currentBlock && currentBlock !== editor && !domUtils.isBlockElement(currentBlock)) {
            currentBlock = currentBlock.parentElement;
        }
        if (!currentBlock || currentBlock === editor) return false;
        if (isEffectivelyEmptyBlock(currentBlock)) return false;
        if (!isAtBlockStartForRange(range, currentBlock) && !isCaretNearBlockTop(range, currentBlock)) {
            return false;
        }

        const prevElement = getPreviousElementSibling(currentBlock);
        if (!prevElement || prevElement.tagName !== 'PRE') return false;
        const codeBlock = prevElement.querySelector('code');
        if (!codeBlock) return false;

        let targetColumn = null;
        try {
            const beforeRange = document.createRange();
            beforeRange.selectNodeContents(currentBlock);
            beforeRange.setEnd(range.startContainer, range.startOffset);
            const beforeText = (beforeRange.toString() || '').replace(/\u200B/g, '');
            const lastNewline = beforeText.lastIndexOf('\n');
            targetColumn = Math.max(0, beforeText.length - (lastNewline + 1));
        } catch (e) {
            targetColumn = null;
        }

        const text = cursorManager.getCodeBlockText(codeBlock);
        const { lines, lineStartOffsets } = cursorManager.getCodeBlockLineInfo(text, text.length);
        const isWhitespaceOnly = (value) => value.replace(/[\u200B\u00A0\s]/g, '') === '';
        let targetLineIndex = -1;
        for (let i = lines.length - 1; i >= 0; i--) {
            if (!isWhitespaceOnly(lines[i])) {
                targetLineIndex = i;
                break;
            }
        }
        if (targetLineIndex < 0) {
            targetLineIndex = Math.max(0, lines.length - 1);
        }
        const lineText = lines[targetLineIndex] || '';
        const lineStart = lineStartOffsets[targetLineIndex] || 0;
        const column = Number.isInteger(targetColumn)
            ? Math.min(Math.max(targetColumn, 0), lineText.length)
            : lineText.length;
        const targetOffset = lineStart + column;
        if (cursorManager.setCodeBlockCursorOffset(codeBlock, selection, targetOffset)) {
            setCodeBlockLanguageNavSelection(null);
            return true;
        }
        return false;
    }

    function moveCursorIntoCodeBlockFromBlockStartBelow(range, selection) {
        if (!range || !selection || !range.collapsed) return false;
        if (domUtils.getParentElement(range.startContainer, 'PRE')) return false;

        let currentBlock = range.startContainer.nodeType === Node.ELEMENT_NODE
            ? range.startContainer
            : range.startContainer.parentElement;
        while (currentBlock && currentBlock !== editor && !domUtils.isBlockElement(currentBlock)) {
            currentBlock = currentBlock.parentElement;
        }
        if (!currentBlock || currentBlock === editor) return false;
        if (!isAtBlockStartForRange(range, currentBlock)) return false;

        const prevElement = getPreviousElementSibling(currentBlock);
        if (!prevElement || prevElement.tagName !== 'PRE') return false;
        const codeBlock = prevElement.querySelector('code');
        if (!codeBlock) return false;

        const text = cursorManager.getCodeBlockText(codeBlock);
        const { lines, lineStartOffsets } = cursorManager.getCodeBlockLineInfo(text, text.length);
        const isWhitespaceOnly = (value) => value.replace(/[\u200B\u00A0\s]/g, '') === '';
        let targetLineIndex = -1;
        for (let i = lines.length - 1; i >= 0; i--) {
            if (!isWhitespaceOnly(lines[i])) {
                targetLineIndex = i;
                break;
            }
        }
        if (targetLineIndex < 0) {
            targetLineIndex = Math.max(0, lines.length - 1);
        }
        const lineText = lines[targetLineIndex] || '';
        const lineStart = lineStartOffsets[targetLineIndex] || 0;
        const targetOffset = lineStart + lineText.length;
        if (cursorManager.setCodeBlockCursorOffset(codeBlock, selection, targetOffset)) {
            setCodeBlockLanguageNavSelection(null);
            return true;
        }
        return false;
    }

    function moveCursorDownFromEmptyBlock(range, selection) {
        if (!range || !selection || !range.collapsed) return false;
        if (domUtils.getParentElement(range.startContainer, 'PRE')) return false;

        let currentBlock = range.startContainer.nodeType === Node.ELEMENT_NODE
            ? range.startContainer
            : range.startContainer.parentElement;
        while (currentBlock && currentBlock !== editor && !domUtils.isBlockElement(currentBlock)) {
            currentBlock = currentBlock.parentElement;
        }

        if (currentBlock === editor) {
            const children = Array.from(editor.childNodes || []);
            if (children.length === 0) return false;
            const safeOffset = Math.max(0, Math.min(range.startOffset, children.length));
            const prev = safeOffset > 0 ? children[safeOffset - 1] : null;
            const next = safeOffset < children.length ? children[safeOffset] : null;
            const isBlockElementNode = (node) =>
                !!(node && node.nodeType === Node.ELEMENT_NODE && domUtils.isBlockElement(node));

            if (isBlockElementNode(prev)) {
                currentBlock = prev;
            } else if (isBlockElementNode(next)) {
                currentBlock = next;
            } else {
                return false;
            }
        }

        if (!currentBlock || currentBlock === editor) return false;
        if (!isEffectivelyEmptyBlock(currentBlock)) return false;

        const nextElement = getNextElementSibling(currentBlock);
        if (!nextElement) return false;
        if (nextElement.tagName === 'HR') {
            const newRange = document.createRange();
            newRange.selectNode(nextElement);
            selection.removeAllRanges();
            selection.addRange(newRange);
            return true;
        }
        if (nextElement.tagName === 'PRE' && nextElement.querySelector('code')) {
            return selectCodeBlockLanguageLabel(nextElement);
        }
        if (cursorManager &&
            typeof cursorManager._placeCursorBeforeLeadingInlineCode === 'function' &&
            cursorManager._placeCursorBeforeLeadingInlineCode(nextElement, selection)) {
            return true;
        }

        const newRange = document.createRange();
        const firstNode = getPreferredFirstTextNodeForElement(nextElement);
        if (firstNode) {
            newRange.setStart(firstNode, 0);
        } else {
            newRange.setStart(nextElement, 0);
        }
        newRange.collapse(true);
        selection.removeAllRanges();
        selection.addRange(newRange);
        return true;
    }

    function exitEmptyCodeBlockDownFromPre(preBlock, selection, allowNonEmpty = false, force = false) {
        if (!preBlock || !selection) return false;
        const codeBlock = preBlock.querySelector('code');
        if (!codeBlock) return false;

        const text = cursorManager.getCodeBlockText(codeBlock);
        const normalized = text.replace(/[\u200B\u00A0\s]/g, '');
        if (normalized !== '') {
            if (!allowNonEmpty && !force) return false;
            if (!force) {
                if (!selection.rangeCount) return false;
                const range = selection.getRangeAt(0);
                const cursorOffset = getCodeBlockCursorOffset(codeBlock, range);
                if (cursorOffset === null) return false;
                const trailing = text.slice(cursorOffset);
                const normalizedTrailing = trailing.replace(/[\u200B\u00A0\s]/g, '');
                if (normalizedTrailing !== '') return false;
            }
        }

        const nextNode = getNextNavigableNodeAfter(preBlock);
        if (nextNode && nextNode.nodeType === Node.ELEMENT_NODE && nextNode.tagName === 'HR') {
            const newRange = document.createRange();
            newRange.selectNode(nextNode);
            selection.removeAllRanges();
            selection.addRange(newRange);
            return true;
        }
        if (nextNode && nextNode.nodeType === Node.ELEMENT_NODE &&
            nextNode.tagName === 'PRE' && nextNode.querySelector('code')) {
            return selectCodeBlockLanguageLabel(nextNode);
        }
        if (nextNode && nextNode.nodeType === Node.TEXT_NODE) {
            const text = nextNode.textContent || '';
            let startOffset = 0;
            while (startOffset < text.length && /[\u200B\u00A0\s]/.test(text[startOffset])) {
                startOffset++;
            }
            const newRange = document.createRange();
            newRange.setStart(nextNode, Math.min(startOffset, text.length));
            newRange.collapse(true);
            selection.removeAllRanges();
            selection.addRange(newRange);
            editor.focus();
            return true;
        }
        if (nextNode) {
            const nextElement = nextNode;
            const newRange = document.createRange();
            const firstNode = getPreferredFirstTextNodeForElement(nextElement);
            if (firstNode) {
                newRange.setStart(firstNode, 0);
            } else if (nextElement.tagName === 'P') {
                const hasText = (nextElement.textContent || '').replace(/[\u200B\u00A0]/g, '').trim() !== '';
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
            editor.focus();
            return true;
        }

        const newParagraph = document.createElement('p');
        const zwsp = document.createTextNode('\u200B');
        newParagraph.appendChild(zwsp);
        let insertionAnchor = preBlock;
        while (insertionAnchor.parentElement && insertionAnchor.parentElement !== editor) {
            insertionAnchor = insertionAnchor.parentElement;
        }
        if (insertionAnchor.nextSibling) {
            insertionAnchor.parentElement.insertBefore(newParagraph, insertionAnchor.nextSibling);
        } else {
            insertionAnchor.parentElement.appendChild(newParagraph);
        }
        const newRange = document.createRange();
        newRange.setStart(zwsp, zwsp.textContent.length);
        newRange.collapse(true);
        selection.removeAllRanges();
        selection.addRange(newRange);
        editor.focus();
        notifyChange();
        return true;
    }

    function exitEmptyCodeBlockDownIfNeeded() {
        const selection = window.getSelection();
        if (!selection || selection.rangeCount === 0) return false;
        const range = selection.getRangeAt(0);

        let preBlock = domUtils.getParentElement(range.startContainer, 'PRE');
        if (!preBlock) {
            preBlock = domUtils.getParentElement(range.endContainer, 'PRE');
        }
        if (!preBlock) {
            const container = range.startContainer;
            if (container === editor && container.childNodes.length) {
                const idx = Math.min(range.startOffset, container.childNodes.length - 1);
                const candidate = container.childNodes[idx] || container.childNodes[idx - 1];
                if (candidate && candidate.nodeType === Node.ELEMENT_NODE) {
                    if (candidate.tagName === 'PRE') {
                        preBlock = candidate;
                    } else if (candidate.closest) {
                        preBlock = candidate.closest('pre');
                    }
                }
            }
        }
        if (!preBlock) return false;

        if (exitEmptyCodeBlockDownFromPre(preBlock, selection, true)) {
            return true;
        }
        const codeBlock = preBlock.querySelector('code');
        if (codeBlock) {
            const text = cursorManager.getCodeBlockText(codeBlock);
            const cursorOffset = getCodeBlockCursorOffset(codeBlock, range);
            let trailingText = null;
            try {
                const tailRange = document.createRange();
                tailRange.selectNodeContents(codeBlock);
                tailRange.setStart(range.endContainer, range.endOffset);
                trailingText = tailRange.toString();
            } catch (e) {
                trailingText = null;
            }
            if (cursorOffset !== null) {
                const { lines, currentLineIndex } = cursorManager.getCodeBlockLineInfo(text, cursorOffset);
                const isWhitespaceOnly = (value) => value.replace(/[\u200B\u00A0\s]/g, '') === '';
                let lastNonWhitespaceLineIndex = -1;
                for (let i = lines.length - 1; i >= 0; i--) {
                    if (!isWhitespaceOnly(lines[i])) {
                        lastNonWhitespaceLineIndex = i;
                        break;
                    }
                }
                if ((trailingText !== null && trailingText.replace(/[\u200B\u00A0\s]/g, '') === '') ||
                    lastNonWhitespaceLineIndex === -1 || currentLineIndex >= lastNonWhitespaceLineIndex ||
                    isCaretOnLastVisualLine(range, preBlock)) {
                    return exitEmptyCodeBlockDownFromPre(preBlock, selection, true, true);
                }
            }
        }
        const nextElement = getNextElementSibling(preBlock);
        if (!nextElement && isCaretNearBlockBottom(range, preBlock)) {
            return exitEmptyCodeBlockDownFromPre(preBlock, selection, true, true);
        }
        return false;
    }

    function exitCodeBlockDownIfAtEnd(range) {
        if (!range) return false;
        let preBlock = domUtils.getParentElement(range.startContainer, 'PRE');
        if (!preBlock) {
            preBlock = domUtils.getParentElement(range.endContainer, 'PRE');
        }
        if (!preBlock) return false;
        const codeBlock = preBlock.querySelector('code');
        if (!codeBlock) return false;
        const isRangeInCode = (node) => {
            if (!node) return false;
            return node === codeBlock || codeBlock.contains(node);
        };
        if (!isRangeInCode(range.startContainer) && !isRangeInCode(range.endContainer)) {
            // If selection is within PRE but not CODE, treat as end-of-code.
            return exitEmptyCodeBlockDownFromPre(preBlock, window.getSelection(), true, true);
        }

        let trailingText = null;
        try {
            const tailRange = document.createRange();
            tailRange.selectNodeContents(codeBlock);
            let startNode = range.endContainer;
            let startOffset = range.endOffset;
            if (!isRangeInCode(startNode)) {
                startNode = range.startContainer;
                startOffset = range.startOffset;
            }
            if (!isRangeInCode(startNode)) {
                return exitEmptyCodeBlockDownFromPre(preBlock, window.getSelection(), true, true);
            }
            tailRange.setStart(startNode, startOffset);
            trailingText = tailRange.toString();
        } catch (e) {
            trailingText = null;
        }

        if (trailingText !== null) {
            if (trailingText.replace(/[\u200B\u00A0\s]/g, '') !== '') {
                return false;
            }
        } else if (!isCaretOnLastVisualLine(range, preBlock) && !isCaretNearBlockBottom(range, preBlock)) {
            return false;
        }

        const selection = window.getSelection();
        if (!selection) return false;
        return exitEmptyCodeBlockDownFromPre(preBlock, selection, true, true);
    }

    function handleCodeBlockArrowDown(selection) {
        if (!selection || selection.rangeCount === 0) return null;
        const range = selection.getRangeAt(0);
        const selectedLabel = getSelectedCodeBlockLanguageLabel();
        if (selectedLabel) {
            return null;
        }

        const scheduleEnsureExitFromPre = (pre) => {
            if (!pre) return;
            setTimeout(() => {
                const sel = window.getSelection();
                if (!sel || !sel.rangeCount) return;
                const r = sel.getRangeAt(0);
                const stillInPre = pre.contains(r.startContainer) || pre.contains(r.endContainer);
                if (stillInPre) {
                    const forced = exitEmptyCodeBlockDownFromPre(pre, sel, true, true);
                }
            }, 0);
        };

        let preBlock = domUtils.getParentElement(range.startContainer, 'PRE');
        if (!preBlock) {
            preBlock = domUtils.getParentElement(range.endContainer, 'PRE');
        }
        if (!preBlock) return null;

        const codeBlock = preBlock.querySelector('code');
        if (!codeBlock) return null;

        const inPre = preBlock.contains(range.startContainer) ||
            preBlock.contains(range.endContainer) ||
            range.startContainer === preBlock ||
            range.endContainer === preBlock;
        if (!inPre) return null;

        const inCode = codeBlock.contains(range.startContainer) ||
            codeBlock.contains(range.endContainer) ||
            range.startContainer === codeBlock ||
            range.endContainer === codeBlock;
        if (!inCode) {
            const label = preBlock.querySelector('.code-block-language');
            if (label && moveCursorIntoCodeBlockFromLabel(label)) {
                return { handled: true, exited: false };
            }
            if (cursorManager.setCodeBlockCursorOffset(codeBlock, selection, 0)) {
                return { handled: true, exited: false };
            }
            const firstNode = domUtils.getFirstTextNode(codeBlock);
            const newRange = document.createRange();
            if (firstNode) {
                newRange.setStart(firstNode, 0);
            } else {
                newRange.setStart(codeBlock, 0);
            }
            newRange.collapse(true);
            selection.removeAllRanges();
            selection.addRange(newRange);
            return { handled: true, exited: false };
        }

        const text = cursorManager.getCodeBlockText(codeBlock);
        const cursorOffset = getCodeBlockCursorOffset(codeBlock, range);
        if (cursorOffset !== null) {
            const { lines, lineStartOffsets, currentLineIndex, column } =
                cursorManager.getCodeBlockLineInfo(text, cursorOffset);
            const isWhitespaceOnly = (value) => value.replace(/[\u200B\u00A0\s]/g, '') === '';
            let lastNonWhitespaceLineIndex = -1;
            for (let i = lines.length - 1; i >= 0; i--) {
                if (!isWhitespaceOnly(lines[i])) {
                    lastNonWhitespaceLineIndex = i;
                    break;
                }
            }

            if (lastNonWhitespaceLineIndex === -1 || currentLineIndex >= lastNonWhitespaceLineIndex) {
                const exited = exitEmptyCodeBlockDownFromPre(preBlock, selection, true, true);
                if (exited) scheduleEnsureExitFromPre(preBlock);
                return exited ? { handled: true, exited: true } : null;
            }

            const targetLineIndex = Math.min(currentLineIndex + 1, lines.length - 1);
            const targetLineStart = lineStartOffsets[targetLineIndex];
            if (typeof targetLineStart === 'number') {
                const targetOffset = targetLineStart +
                    Math.min(column, (lines[targetLineIndex] || '').length);
                if (cursorManager.setCodeBlockCursorOffset(codeBlock, selection, targetOffset)) {
                    return { handled: true, exited: false };
                }
            }
        }

        // Fallback: move down via cursor manager, then exit if still stuck in code block.
        const beforeRange = selection.getRangeAt(0);
        const beforeRect = cursorManager._getCaretRect(beforeRange);
        cursorManager.moveCursorDown();
        normalizeVerticalEntryAtLeadingInlineCodeToOutsideLeft(beforeRange);
        const afterSelection = window.getSelection();
        if (afterSelection && afterSelection.rangeCount > 0) {
            const afterRange = afterSelection.getRangeAt(0);
            const afterCode = domUtils.getParentElement(afterRange.startContainer, 'CODE') ||
                domUtils.getParentElement(afterRange.endContainer, 'CODE');
            const afterPre = afterCode ? domUtils.getParentElement(afterCode, 'PRE') : null;
            if (afterPre && afterPre === preBlock) {
                const afterRect = cursorManager._getCaretRect(afterRange);
                const movedDown = beforeRect && afterRect
                    ? (afterRect.bottom || 0) > (beforeRect.bottom || 0) + 2
                    : false;
                if (!movedDown) {
                    const exited = exitEmptyCodeBlockDownFromPre(preBlock, selection, true, true);
                    if (exited) scheduleEnsureExitFromPre(preBlock);
                    return exited ? { handled: true, exited: true } : null;
                }
                return { handled: true, exited: false };
            }
            return { handled: true, exited: true };
        }

        return null;
    }

    function handleCodeBlockArrowUp(selection) {
        if (!selection || selection.rangeCount === 0) return null;
        const range = selection.getRangeAt(0);
        let preBlock = domUtils.getParentElement(range.startContainer, 'PRE');
        if (!preBlock) {
            preBlock = domUtils.getParentElement(range.endContainer, 'PRE');
        }
        if (!preBlock) return null;
        const codeBlock = preBlock.querySelector('code');
        if (!codeBlock) return null;

        const inCode = codeBlock.contains(range.startContainer) ||
            codeBlock.contains(range.endContainer) ||
            range.startContainer === codeBlock ||
            range.endContainer === codeBlock;
        if (!inCode) return null;

        const text = cursorManager.getCodeBlockText(codeBlock);
        const normalizedText = text.replace(/[\u200B\u00A0\s]/g, '');
        if (normalizedText === '') {
            if (selectCodeBlockLanguageLabel(preBlock)) {
                return { handled: true, moved: true };
            }
            cursorManager.setCodeBlockCursorOffset(codeBlock, selection, 0);
            return { handled: true, moved: false };
        }
        const cursorOffset = getCodeBlockCursorOffset(codeBlock, range);
        if (cursorOffset === null) {
            if (cursorManager.setCodeBlockCursorOffset(codeBlock, selection, 0)) {
                return { handled: true, moved: false };
            }
            return { handled: true, moved: false };
        }

        const { lines, lineStartOffsets, currentLineIndex, column } =
            cursorManager.getCodeBlockLineInfo(text, cursorOffset);
        if (currentLineIndex <= 0) {
            if (selectCodeBlockLanguageLabel(preBlock)) {
                return { handled: true, moved: true };
            }
            cursorManager.setCodeBlockCursorOffset(codeBlock, selection, 0);
            return { handled: true, moved: false };
        }

        const targetLineIndex = Math.max(0, currentLineIndex - 1);
        const targetLineStart = lineStartOffsets[targetLineIndex];
        if (typeof targetLineStart === 'number') {
            const targetOffset = targetLineStart +
                Math.min(column, (lines[targetLineIndex] || '').length);
            if (cursorManager.setCodeBlockCursorOffset(codeBlock, selection, targetOffset)) {
                return { handled: true, moved: true };
            }
        }
        return { handled: true, moved: false };
    }

    function handleCodeBlockArrowLeft(selection) {
        if (!selection || selection.rangeCount === 0) return null;
        const range = selection.getRangeAt(0);
        if (!range.collapsed) return null;

        let preBlock = domUtils.getParentElement(range.startContainer, 'PRE');
        if (!preBlock) {
            preBlock = domUtils.getParentElement(range.endContainer, 'PRE');
        }
        if (!preBlock) return null;
        const codeBlock = preBlock.querySelector('code');
        if (!codeBlock) return null;

        const inCode = codeBlock.contains(range.startContainer) ||
            codeBlock.contains(range.endContainer) ||
            range.startContainer === codeBlock ||
            range.endContainer === codeBlock;
        if (!inCode) return null;

        const text = cursorManager.getCodeBlockText(codeBlock);
        const normalizedText = text.replace(/[\u200B\u00A0\s]/g, '');
        if (normalizedText === '') {
            if (selectCodeBlockLanguageLabel(preBlock)) {
                return { handled: true, moved: true };
            }
            return { handled: true, moved: false };
        }

        const cursorOffset = getCodeBlockCursorOffset(codeBlock, range);
        if (cursorOffset === null) return null;

        const { lines, lineStartOffsets, currentLineIndex, column } =
            cursorManager.getCodeBlockLineInfo(text, cursorOffset);
        if (currentLineIndex > 0) return null;

        const lineIndex = Math.max(0, Math.min(currentLineIndex, lines.length - 1));
        const lineText = lines[lineIndex] || '';
        const safeColumn = Math.max(0, Math.min(column, lineText.length));
        const lineStartOffset = lineStartOffsets[lineIndex] || 0;
        const beforeCursor = lineText.slice(0, safeColumn);
        const atLineStart = cursorOffset <= lineStartOffset ||
            beforeCursor.replace(/[\u200B\u00A0]/g, '') === '';
        if (!atLineStart) return null;

        if (selectCodeBlockLanguageLabel(preBlock)) {
            return { handled: true, moved: true };
        }
        return { handled: true, moved: false };
    }

    function placeCursorAtElementBoundary(element, boundary) {
        const selection = window.getSelection();
        if (!selection || !element) return false;

        const newRange = document.createRange();
        if (boundary === 'start') {
            const firstTextNode = domUtils.getFirstTextNode(element);
            if (firstTextNode) {
                newRange.setStart(firstTextNode, 0);
            } else {
                newRange.setStart(element, 0);
            }
        } else {
            const lastTextNode = domUtils.getLastTextNode(element);
            if (lastTextNode) {
                newRange.setStart(lastTextNode, lastTextNode.textContent.length);
            } else {
                newRange.setStart(element, element.childNodes.length);
            }
        }
        newRange.collapse(true);
        selection.removeAllRanges();
        selection.addRange(newRange);
        return true;
    }

    // 水平線から指定方向にカーソルを移動
    function navigateFromHR(hr, direction) {
        const selection = window.getSelection();
        if (!selection) return false;
        const newRange = document.createRange();

        if (direction === 'up' || direction === 'left') {
            // 水平線の前の要素へ移動
            let prevElement = hr.previousElementSibling;
            if (prevElement) {
                // 前の要素がHRの場合はそのHRを選択
                if (prevElement.tagName === 'HR') {
                    newRange.selectNode(prevElement);
                    selection.removeAllRanges();
                    selection.addRange(newRange);
                    return true;
                }
                return placeCursorAtElementBoundary(prevElement, 'end');
            }
            // 前に要素がない場合、新しい段落を作成
            const newParagraph = document.createElement('p');
            newParagraph.appendChild(document.createElement('br'));
            hr.before(newParagraph);
            return placeCursorAtElementBoundary(newParagraph, 'start');
        } else if (direction === 'down' || direction === 'right') {
            // 水平線の後の要素へ移動
            let nextElement = hr.nextElementSibling;
            if (nextElement) {
                // 次の要素がHRの場合はそのHRを選択
                if (nextElement.tagName === 'HR') {
                    newRange.selectNode(nextElement);
                    selection.removeAllRanges();
                    selection.addRange(newRange);
                    return true;
                }
                return placeCursorAtElementBoundary(nextElement, 'start');
            }
            // 後ろに要素がない場合、新しい段落を作成
            const newParagraph = document.createElement('p');
            const br = document.createElement('br');
            newParagraph.appendChild(br);
            hr.after(newParagraph);
            return placeCursorAtElementBoundary(newParagraph, 'start');
        }
        return false;
    }

    function getTopLevelBlock(node) {
        if (!node || node === editor) return null;
        let current = node;
        while (current.parentElement && current.parentElement !== editor) {
            current = current.parentElement;
        }
        return current.parentElement === editor ? current : null;
    }

    function getPreviousTopLevelNavigableSibling(node) {
        if (!node || !node.parentNode) return null;
        let prev = node.previousSibling;
        while (prev) {
            if (prev.nodeType === Node.TEXT_NODE) {
                const text = (prev.textContent || '').replace(/[\u200B\uFEFF\u00A0]/g, '');
                if (text.trim() !== '') {
                    return prev;
                }
                prev = prev.previousSibling;
                continue;
            }
            if (prev.nodeType === Node.ELEMENT_NODE) {
                if (isNavigationExcludedElement(prev)) {
                    prev = prev.previousSibling;
                    continue;
                }
                return prev;
            }
            prev = prev.previousSibling;
        }
        return null;
    }

    function isRangeOnFirstLogicalLineInTopLevelNode(range, topLevelNode) {
        if (!range || !topLevelNode) return false;
        try {
            const beforeRange = document.createRange();
            beforeRange.selectNodeContents(topLevelNode);
            beforeRange.setEnd(range.startContainer, range.startOffset);
            const beforeText = (beforeRange.toString() || '').replace(/[\u200B\uFEFF]/g, '');
            return !beforeText.includes('\n');
        } catch (e) {
            return false;
        }
    }

    function shouldUseNativeArrowForTopLine(e) {
        if (e.key !== 'ArrowUp' && e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') {
            return false;
        }

        const selection = window.getSelection();
        if (!selection || !selection.rangeCount || !selection.isCollapsed) {
            return false;
        }

        const range = selection.getRangeAt(0);
        if (!editor.contains(range.startContainer)) {
            return false;
        }
        if (isCursorOnCheckbox() || isHRSelected()) {
            return false;
        }
        if (domUtils.getParentElement(range.startContainer, 'TABLE')) {
            return false;
        }
        // リスト内の上下左右は独自ナビゲーションで安定化しているため、
        // ネイティブ矢印移動へフォールバックしない。
        if ((range.startContainer.nodeType === Node.ELEMENT_NODE &&
                (range.startContainer.tagName === 'LI' ||
                    range.startContainer.tagName === 'UL' ||
                    range.startContainer.tagName === 'OL')) ||
            domUtils.getParentElement(range.startContainer, 'LI') ||
            domUtils.getParentElement(range.startContainer, 'UL') ||
            domUtils.getParentElement(range.startContainer, 'OL')) {
            return false;
        }

        const currentCode = domUtils.getParentElement(range.startContainer, 'CODE');
        if (currentCode) {
            return false;
        }
        if (domUtils.getParentElement(range.startContainer, 'PRE')) {
            return false;
        }
        // 画像境界（左/右エッジ）では独自ナビゲーションを優先する。
        // ネイティブ矢印にフォールバックすると、WebView実装依存で
        // 移動できないことがあるため。
        if (cursorManager) {
            const imageAhead = typeof cursorManager._getImageAheadFromCollapsedRange === 'function'
                ? cursorManager._getImageAheadFromCollapsedRange(range)
                : null;
            const imageBehind = typeof cursorManager._getImageBehindFromCollapsedRange === 'function'
                ? cursorManager._getImageBehindFromCollapsedRange(range)
                : null;
            if (imageAhead || imageBehind) {
                return false;
            }
        }

        const anchorNode = (() => {
            if (range.startContainer !== editor) {
                return range.startContainer;
            }
            const children = Array.from(editor.childNodes || []);
            const safeOffset = Math.max(0, Math.min(range.startOffset, children.length));
            if (safeOffset > 0) {
                return children[safeOffset - 1];
            }
            if (safeOffset < children.length) {
                return children[safeOffset];
            }
            return null;
        })();

        const topLevelBlock = getTopLevelBlock(anchorNode || range.startContainer);
        if (!topLevelBlock) {
            return false;
        }

        if (topLevelBlock.nodeType === Node.ELEMENT_NODE &&
            (topLevelBlock.tagName === 'LI' || topLevelBlock.tagName === 'TD' ||
                topLevelBlock.tagName === 'TH' || topLevelBlock.tagName === 'PRE')) {
            return false;
        }
        if (topLevelBlock.nodeType === Node.ELEMENT_NODE &&
            !isCaretNearBlockTop(range, topLevelBlock)) {
            return false;
        }
        if (getPreviousTopLevelNavigableSibling(topLevelBlock)) {
            return false;
        }
        return isRangeOnFirstLogicalLineInTopLevelNode(range, topLevelBlock);
    }

    function handleArrowKeydown(e) {
        // 水平線が選択されている場合の処理
        const selectedHR = isHRSelected();
        if (selectedHR && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
            if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
                e.preventDefault();
                navigateFromHR(selectedHR, e.key === 'ArrowUp' ? 'up' : 'left');
                return true;
            }
            if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
                e.preventDefault();
                navigateFromHR(selectedHR, e.key === 'ArrowDown' ? 'down' : 'right');
                // チェックボックス行に移動した場合、カーソル位置を補正
                setTimeout(() => correctCheckboxCursorPosition(), 0);
                return true;
            }
        }

        if (tableManager.handleArrowKeydown(e)) {
            return true;
        }
        if (shouldUseNativeArrowForTopLine(e)) {
            return false;
        }

        // 矢印キー
        if (e.key === 'ArrowUp' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
            // チェックボックス上で↑ → 上のリストアイテムのチェックボックスへ移動
            {
                const cbOnCursor = isCursorOnCheckbox();
                if (cbOnCursor) {
                    const li = cbOnCursor.parentElement;
                    if (li) {
                        const prevLi = cursorManager && typeof cursorManager._getAdjacentListItem === 'function'
                            ? cursorManager._getAdjacentListItem(li, 'prev')
                            : li.previousElementSibling;
                        if (prevLi && hasCheckboxAtStart(prevLi)) {
                            e.preventDefault();
                            const sel = window.getSelection();
                            const nr = document.createRange();
                            nr.setStart(prevLi, 0);
                            nr.collapse(true);
                            sel.removeAllRanges();
                            sel.addRange(nr);
                            return true;
                        }
                    }
                }
            }
            const selectedLabel = getSelectedCodeBlockLanguageLabel();
            if (selectedLabel) {
                e.preventDefault();
                e.stopPropagation();
                if (moveCursorAboveCodeBlockFromLabel(selectedLabel)) {
                    return true;
                }
                return true;
            } else {
                const selection = window.getSelection();
                if (selection && selection.rangeCount > 0) {
                    const range = selection.getRangeAt(0);
                    if (handleEmptyLineAboveCodeBlockNav(range, selection, 'up')) {
                        e.preventDefault();
                        e.stopPropagation();
                        return true;
                    }
                    if (tableManager.handleCtrlNavKeydown(e)) {
                        return true;
                    }
                    if (moveCursorIntoCodeBlockFromEmptyBlockBelow(range, selection)) {
                        e.preventDefault();
                        e.stopPropagation();
                        return true;
                    }
                    if (moveCursorIntoCodeBlockFromTextBlockBelow(range, selection)) {
                        e.preventDefault();
                        e.stopPropagation();
                        return true;
                    }
                    if (maybeSelectCodeBlockLabelAbove(range)) {
                        e.preventDefault();
                        e.stopPropagation();
                        return true;
                    }
                    const node = range.startContainer.nodeType === Node.ELEMENT_NODE
                        ? range.startContainer
                        : range.startContainer.parentElement;
                    const toolbarTarget = node && node.closest
                        ? node.closest('.code-block-toolbar, .code-block-language')
                        : null;
                    if (toolbarTarget) {
                        e.preventDefault();
                        e.stopPropagation();
                        if (moveCursorIntoCodeBlockFromToolbarTarget(toolbarTarget, selection)) {
                            return true;
                        }
                    }
                    const result = handleCodeBlockArrowUp(selection);
                    if (result && result.handled) {
                        e.preventDefault();
                        e.stopPropagation();
                        return true;
                    }
                }
            }
            e.preventDefault();
            e.stopPropagation();
            moveCursorUpWithListFallback();
            return true;
        }
        if (e.key === 'ArrowDown' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
            // 空のチェックボックス行では、隣接する次行へ1ステップずつ移動する
            {
                const selection = window.getSelection();
                if (selection && selection.rangeCount > 0) {
                    const range = selection.getRangeAt(0);
                    if (moveDownFromEmptyCheckboxListItemOneStep(range, selection)) {
                        e.preventDefault();
                        e.stopPropagation();
                        setTimeout(() => correctCheckboxCursorPosition(), 0);
                        return true;
                    }
                }
            }
            // リスト末尾からの下移動で HR を飛び越えるケースを防ぐ。
            {
                const selection = window.getSelection();
                if (selection && selection.rangeCount > 0) {
                    const range = selection.getRangeAt(0);
                    const currentListItem = getListItemFromRange(range, 'down');
                    if (currentListItem && isCaretNearBlockBottom(range, currentListItem)) {
                        const hasNextListItem = cursorManager &&
                            typeof cursorManager._getAdjacentListItem === 'function'
                            ? !!cursorManager._getAdjacentListItem(currentListItem, 'next')
                            : !!currentListItem.nextElementSibling;
                        if (!hasNextListItem) {
                            let outerList = currentListItem.parentElement;
                            while (outerList && outerList.parentElement && outerList.parentElement.tagName === 'LI') {
                                const parentLi = outerList.parentElement;
                                const parentList = parentLi ? parentLi.parentElement : null;
                                if (parentList && (parentList.tagName === 'UL' || parentList.tagName === 'OL')) {
                                    outerList = parentList;
                                } else {
                                    break;
                                }
                            }
                            const listBoundary = outerList || currentListItem;
                            const nextAfterList = getNextElementSibling(listBoundary);
                            if (nextAfterList && nextAfterList.tagName === 'HR') {
                                e.preventDefault();
                                const hrRange = document.createRange();
                                hrRange.selectNode(nextAfterList);
                                selection.removeAllRanges();
                                selection.addRange(hrRange);
                                return true;
                            }
                        }
                    }
                }
            }
            // チェックボックス上で↓ → 下のリストアイテムのチェックボックスへ移動
            {
                const cbOnCursor = isCursorOnCheckbox();
                if (cbOnCursor) {
                    const li = cbOnCursor.parentElement;
                    if (li) {
                        const nextLi = cursorManager && typeof cursorManager._getAdjacentListItem === 'function'
                            ? cursorManager._getAdjacentListItem(li, 'next')
                            : li.nextElementSibling;
                        if (nextLi && hasCheckboxAtStart(nextLi)) {
                            e.preventDefault();
                            const sel = window.getSelection();
                            const nr = document.createRange();
                            nr.setStart(nextLi, 0);
                            nr.collapse(true);
                            sel.removeAllRanges();
                            sel.addRange(nr);
                            return true;
                        }
                    }
                }
            }
            // If the caret is in a top-level text node, move to the next block element first.
            {
                const selection = window.getSelection();
                if (selection && selection.rangeCount > 0) {
                    const range = selection.getRangeAt(0);
                    if (handleEmptyLineAboveCodeBlockNav(range, selection, 'down')) {
                        e.preventDefault();
                        return true;
                    }
                    if (moveCursorDownFromEmptyBlock(range, selection)) {
                        e.preventDefault();
                        return true;
                    }
                    if (range.collapsed) {
                        const container = range.startContainer;
                        if (container.nodeType === Node.TEXT_NODE && container.parentElement === editor) {
                            const nextElement = getNextElementSibling(container);
                            if (nextElement) {
                                e.preventDefault();
                                if (nextElement.tagName === 'HR') {
                                    const hrRange = document.createRange();
                                    hrRange.selectNode(nextElement);
                                    selection.removeAllRanges();
                                    selection.addRange(hrRange);
                                    return true;
                                }
                                if (nextElement.tagName === 'PRE' && nextElement.querySelector('code')) {
                                    if (selectCodeBlockLanguageLabel(nextElement)) {
                                        return true;
                                    }
                                }
                                if (cursorManager &&
                                    typeof cursorManager._placeCursorBeforeLeadingInlineCode === 'function' &&
                                    cursorManager._placeCursorBeforeLeadingInlineCode(nextElement, selection)) {
                                    return true;
                                }
                                const newRange = document.createRange();
                                const firstNode = getPreferredFirstTextNodeForElement(nextElement);
                                if (firstNode) {
                                    newRange.setStart(firstNode, 0);
                                } else {
                                    newRange.setStart(nextElement, 0);
                                }
                                newRange.collapse(true);
                                selection.removeAllRanges();
                                selection.addRange(newRange);
                                return true;
                            }
                        }
                    }
                }
            }
            {
                const selectedLabel = getSelectedCodeBlockLanguageLabel();
                if (selectedLabel) {
                    e.preventDefault();
                    if (moveCursorIntoCodeBlockFromLabel(selectedLabel)) {
                        return true;
                    }
                }
            }
            {
                const selection = window.getSelection();
                if (selection && selection.rangeCount > 0) {
                    const range = selection.getRangeAt(0);
                    const currentListItem = getListItemFromRange(range, 'down');
                    if (currentListItem && isRangeAtListItemStart(range, currentListItem)) {
                        let nextListItem = null;
                        if (cursorManager && typeof cursorManager._getAdjacentListItem === 'function') {
                            nextListItem = cursorManager._getAdjacentListItem(currentListItem, 'next');
                        } else {
                            nextListItem = currentListItem.nextElementSibling;
                        }
                        if (nextListItem) {
                            let moved = false;
                            if (cursorManager &&
                                typeof cursorManager._placeCursorInListItemAtX === 'function' &&
                                typeof cursorManager._getCaretRect === 'function') {
                                const currentRect = cursorManager._getCaretRect(range);
                                if (currentRect) {
                                    const currentX = currentRect.left || currentRect.x || 0;
                                    moved = cursorManager._placeCursorInListItemAtX(nextListItem, currentX, 'down', selection);
                                }
                            }
                            if (!moved) {
                                moved = placeCursorAtListItemStart(nextListItem);
                            }
                            if (moved) {
                                e.preventDefault();
                                e.stopPropagation();
                                return true;
                            }
                        }
                    }
                }
            }
            {
                const selection = window.getSelection();
                if (selection && selection.rangeCount > 0) {
                    const result = handleCodeBlockArrowDown(selection);
                    if (result && result.handled) {
                        e.preventDefault();
                        if (result.exited) {
                            notifyChange();
                            setTimeout(() => correctCheckboxCursorPosition(), 0);
                        }
                        return true;
                    }
                }
            }
            // If we're inside a code block, use visual caret probing to decide exit.
            {
                const selection = window.getSelection();
                if (selection && selection.rangeCount > 0) {
                    const range = selection.getRangeAt(0);
                    let preBlock = domUtils.getParentElement(range.startContainer, 'PRE');
                    if (!preBlock) {
                        preBlock = domUtils.getParentElement(range.endContainer, 'PRE');
                    }
                    if (preBlock) {
                        const codeBlock = preBlock.querySelector('code');
                        if (codeBlock) {
                            let shouldExit = true;
                            const rect = cursorManager._getCaretRect(range);
                            if (rect) {
                                const probeX = rect.left + Math.min(10, Math.max(2, rect.width * 0.1));
                                const probeY = rect.bottom + Math.max(4, Math.min(20, rect.height || 16));
                                const nextRange = getCaretRangeFromPoint(probeX, probeY);
                                if (nextRange) {
                                    const node = nextRange.startContainer;
                                    if (node && (node === codeBlock || codeBlock.contains(node))) {
                                        shouldExit = false;
                                    }
                                }
                            }
                            if (shouldExit) {
                                e.preventDefault();
                                if (exitEmptyCodeBlockDownFromPre(preBlock, selection, true, true)) {
                                    notifyChange();
                                    setTimeout(() => correctCheckboxCursorPosition(), 0);
                                    return true;
                                }
                            }
                        }
                    }
                }
            }
            // If selection sits on a PRE but not inside CODE, treat as end-of-code and exit.
            {
                const selection = window.getSelection();
                if (selection && selection.rangeCount > 0) {
                    const range = selection.getRangeAt(0);
                    let preBlock = domUtils.getParentElement(range.startContainer, 'PRE');
                    if (!preBlock) {
                        preBlock = domUtils.getParentElement(range.endContainer, 'PRE');
                    }
                    if (preBlock) {
                        const codeBlock = preBlock.querySelector('code');
                        if (codeBlock) {
                            const inCode = codeBlock.contains(range.startContainer) ||
                                codeBlock.contains(range.endContainer) ||
                                range.startContainer === codeBlock ||
                                range.endContainer === codeBlock;
                            if (!inCode) {
                                e.preventDefault();
                                if (exitEmptyCodeBlockDownFromPre(preBlock, selection, true, true)) {
                                    notifyChange();
                                    setTimeout(() => correctCheckboxCursorPosition(), 0);
                                    return true;
                                }
                            }
                        }
                    }
                }
            }
            // If we're in a code block and there is no visual line below, exit immediately.
            {
                const selection = window.getSelection();
                if (selection && selection.rangeCount > 0) {
                    const range = selection.getRangeAt(0);
                    const codeBlock = domUtils.getParentElement(range.startContainer, 'CODE');
                    const preBlock = codeBlock ? domUtils.getParentElement(codeBlock, 'PRE') : null;
                    if (codeBlock && preBlock) {
                        const lineInfo = getCodeBlockLineInfoFromRange(range, codeBlock);
                        if (lineInfo && !lineInfo.hasLineBelow) {
                            e.preventDefault();
                            if (exitEmptyCodeBlockDownFromPre(preBlock, selection, true, true)) {
                                notifyChange();
                                setTimeout(() => correctCheckboxCursorPosition(), 0);
                                return true;
                            }
                        }
                    }
                }
            }
            let codeBlockHasLineBelow = false;
            {
                const selection = window.getSelection();
                if (selection && selection.rangeCount > 0) {
                    const range = selection.getRangeAt(0);
                    const codeBlock = domUtils.getParentElement(range.startContainer, 'CODE');
                    const preBlock = codeBlock ? domUtils.getParentElement(codeBlock, 'PRE') : null;
                    if (codeBlock && preBlock) {
                        const hasBelow = hasCodeBlockLineBelow(range, codeBlock);
                        if (hasBelow === true) {
                            codeBlockHasLineBelow = true;
                        } else if (hasBelow === false) {
                            e.preventDefault();
                            if (exitEmptyCodeBlockDownFromPre(preBlock, selection, true, true)) {
                                notifyChange();
                                setTimeout(() => correctCheckboxCursorPosition(), 0);
                                return true;
                            }
                        }
                    }
                }
            }
            // If we're inside a code block and already at the end, exit immediately.
            {
                if (!codeBlockHasLineBelow) {
                    const selection = window.getSelection();
                    if (selection && selection.rangeCount > 0) {
                        const range = selection.getRangeAt(0);
                        if (exitCodeBlockDownIfAtEnd(range)) {
                            e.preventDefault();
                            notifyChange();
                            setTimeout(() => correctCheckboxCursorPosition(), 0);
                            return true;
                        }
                    }
                }
            }
            // If we're inside a code block and at the last meaningful line, exit below.
            {
                if (!codeBlockHasLineBelow) {
                    const selection = window.getSelection();
                    if (selection && selection.rangeCount > 0) {
                        const range = selection.getRangeAt(0);
                        let preBlock = domUtils.getParentElement(range.startContainer, 'PRE');
                        if (!preBlock) {
                            preBlock = domUtils.getParentElement(range.endContainer, 'PRE');
                        }
                        if (preBlock) {
                            const codeBlock = preBlock.querySelector('code');
                            if (codeBlock) {
                                const text = cursorManager.getCodeBlockText(codeBlock);
                                const cursorOffset = getCodeBlockCursorOffset(codeBlock, range);
                                let shouldExit = false;
                                let trailingText = null;
                                try {
                                    const tailRange = document.createRange();
                                    tailRange.selectNodeContents(codeBlock);
                                    tailRange.setStart(range.endContainer, range.endOffset);
                                    trailingText = tailRange.toString();
                                } catch (e) {
                                    trailingText = null;
                                }
                                if (trailingText !== null) {
                                    if (trailingText.replace(/[\u200B\u00A0\s]/g, '') === '') {
                                        shouldExit = true;
                                    }
                                }
                                if (!shouldExit) {
                                    if (cursorOffset === null) {
                                        shouldExit = isCaretNearBlockBottom(range, preBlock);
                                    } else {
                                        const { lines, currentLineIndex } = cursorManager.getCodeBlockLineInfo(text, cursorOffset);
                                        const isWhitespaceOnly = (value) => value.replace(/[\u200B\u00A0\s]/g, '') === '';
                                        let lastNonWhitespaceLineIndex = -1;
                                        for (let i = lines.length - 1; i >= 0; i--) {
                                            if (!isWhitespaceOnly(lines[i])) {
                                                lastNonWhitespaceLineIndex = i;
                                                break;
                                            }
                                        }
                                        if (lastNonWhitespaceLineIndex === -1 || currentLineIndex >= lastNonWhitespaceLineIndex) {
                                            shouldExit = true;
                                        }
                                    }
                                }
                                if (!shouldExit && isCaretOnLastVisualLine(range, preBlock)) {
                                    shouldExit = true;
                                }
                                if (shouldExit) {
                                    e.preventDefault();
                                    if (exitEmptyCodeBlockDownFromPre(preBlock, selection, true, true)) {
                                        notifyChange();
                                        // チェックボックス行に入った場合、カーソル位置を補正
                                        setTimeout(() => correctCheckboxCursorPosition(), 0);
                                        return true;
                                    }
                                }
                            }
                        }
                    }
                }
            }
            // Check if we should exit a blockquote
            if (isAtBlockquoteEnd() || shouldExitBlockquoteDownByVisualPosition()) {
                e.preventDefault();
                exitBlockquoteAfter({ preferTopLevelGap: true });
                notifyChange();
                return true;
            }
            if (exitEmptyCodeBlockDownIfNeeded()) {
                e.preventDefault();
                return true;
            }
            const selectedLabel = getSelectedCodeBlockLanguageLabel();
            if (selectedLabel) {
                if (moveCursorIntoCodeBlockFromLabel(selectedLabel)) {
                    e.preventDefault();
                    return true;
                }
            }
            const selection = window.getSelection();
            if (selection && selection.rangeCount > 0) {
                const range = selection.getRangeAt(0);
                if (maybeSelectCodeBlockLabelBelow(range)) {
                    e.preventDefault();
                    return true;
                }
            }
            const selectionBefore = window.getSelection();
            const snapshotBefore = selectionBefore && selectionBefore.rangeCount > 0 ? (() => {
                const r = selectionBefore.getRangeAt(0);
                return {
                    sc: r.startContainer,
                    so: r.startOffset,
                    ec: r.endContainer,
                    eo: r.endOffset
                };
            })() : null;
            const beforeRange = selectionBefore && selectionBefore.rangeCount > 0 ? selectionBefore.getRangeAt(0) : null;
            let beforePreBlock = null;
            let beforeCaretRect = null;
            if (beforeRange) {
                beforePreBlock = domUtils.getParentElement(beforeRange.startContainer, 'PRE') ||
                    domUtils.getParentElement(beforeRange.endContainer, 'PRE');
                if (beforePreBlock) {
                    beforeCaretRect = cursorManager._getCaretRect(beforeRange);
                }
            }
            e.preventDefault();
            cursorManager.moveCursorDown(notifyChange);
            normalizeVerticalEntryAtLeadingInlineCodeToOutsideLeft(beforeRange);
            const selectionAfter = window.getSelection();
            const snapshotAfter = selectionAfter && selectionAfter.rangeCount > 0 ? (() => {
                const r = selectionAfter.getRangeAt(0);
                return {
                    sc: r.startContainer,
                    so: r.startOffset,
                    ec: r.endContainer,
                    eo: r.endOffset
                };
            })() : null;
            const selectionUnchanged = snapshotBefore && snapshotAfter &&
                snapshotBefore.sc === snapshotAfter.sc &&
                snapshotBefore.so === snapshotAfter.so &&
                snapshotBefore.ec === snapshotAfter.ec &&
                snapshotBefore.eo === snapshotAfter.eo;
            if (selectionUnchanged && selectionAfter && selectionAfter.rangeCount > 0) {
                const rangeAfter = selectionAfter.getRangeAt(0);
                let preBlock = domUtils.getParentElement(rangeAfter.startContainer, 'PRE');
                if (!preBlock) {
                    preBlock = domUtils.getParentElement(rangeAfter.endContainer, 'PRE');
                }
                if (preBlock) {
                    const codeBlock = preBlock.querySelector('code');
                    if (codeBlock) {
                        const text = cursorManager.getCodeBlockText(codeBlock);
                        const cursorOffset = getCodeBlockCursorOffset(codeBlock, rangeAfter);
                        let shouldExit = false;
                        if (cursorOffset === null) {
                            shouldExit = true;
                        } else {
                            const { lines, currentLineIndex } = cursorManager.getCodeBlockLineInfo(text, cursorOffset);
                            const isWhitespaceOnly = (value) => value.replace(/[\u200B\u00A0\s]/g, '') === '';
                            let lastNonWhitespaceLineIndex = -1;
                            for (let i = lines.length - 1; i >= 0; i--) {
                                if (!isWhitespaceOnly(lines[i])) {
                                    lastNonWhitespaceLineIndex = i;
                                    break;
                                }
                            }
                            if (lastNonWhitespaceLineIndex === -1 || currentLineIndex >= lastNonWhitespaceLineIndex) {
                                shouldExit = true;
                            }
                        }
                        if (!shouldExit && isCaretOnLastVisualLine(rangeAfter, preBlock)) {
                            shouldExit = true;
                        }
                        if (shouldExit) {
                            if (exitEmptyCodeBlockDownFromPre(preBlock, selectionAfter, true, true)) {
                                // チェックボックス行に入った場合、カーソル位置を補正
                                setTimeout(() => correctCheckboxCursorPosition(), 0);
                                return true;
                            }
                        }
                    }
                }
            }
            if (selectionAfter && selectionAfter.rangeCount > 0 && beforePreBlock) {
                const rangeAfter = selectionAfter.getRangeAt(0);
                const afterPreBlock = domUtils.getParentElement(rangeAfter.startContainer, 'PRE') ||
                    domUtils.getParentElement(rangeAfter.endContainer, 'PRE');
                if (afterPreBlock && afterPreBlock === beforePreBlock) {
                    const afterRect = cursorManager._getCaretRect(rangeAfter);
                    if (beforeCaretRect && afterRect) {
                        const movedDown = (afterRect.bottom || 0) > (beforeCaretRect.bottom || 0) + 2;
                        if (!movedDown) {
                            const codeBlock = afterPreBlock.querySelector('code');
                            if (codeBlock) {
                                if (exitEmptyCodeBlockDownFromPre(afterPreBlock, selectionAfter, true, true)) {
                                    setTimeout(() => correctCheckboxCursorPosition(), 0);
                                    return true;
                                }
                            }
                        }
                    }
                }
            }
            // チェックボックス行に入った場合、カーソル位置を補正
            setTimeout(() => correctCheckboxCursorPosition(), 0);
            return true;
        }
        if (e.key === 'ArrowLeft' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
            const selectedLabel = getSelectedCodeBlockLanguageLabel();
            if (selectedLabel) {
                e.preventDefault();
                e.stopPropagation();
                if (moveCursorAboveCodeBlockFromLabelToLineEnd(selectedLabel)) {
                    return true;
                }
                return true;
            }
            {
                const selection = window.getSelection();
                if (selection && selection.rangeCount > 0) {
                    const result = handleCodeBlockArrowLeft(selection);
                    if (result && result.handled) {
                        e.preventDefault();
                        e.stopPropagation();
                        return true;
                    }
                }
            }
            {
                const selection = window.getSelection();
                if (selection && selection.rangeCount > 0) {
                    const range = selection.getRangeAt(0);
                    if (moveCursorIntoCodeBlockFromBlockStartBelow(range, selection)) {
                        e.preventDefault();
                        e.stopPropagation();
                        return true;
                    }
                }
            }
            // チェックボックスli内での左矢印ナビゲーション
            // テキスト先頭 → チェックボックス位置、チェックボックス位置 → 前の要素
            {
                const sel = window.getSelection();
                if (sel && sel.rangeCount > 0 && sel.isCollapsed) {
                    const r = sel.getRangeAt(0);
                    const c = r.startContainer;
                    const o = r.startOffset;
                    const li = domUtils.getParentElement(c, 'LI');
                    if (li && hasCheckboxAtStart(li)) {
                        const firstTN = getFirstDirectTextNodeAfterCheckbox(li);
                        const minOffset = getCheckboxTextMinOffset(li);
                        const isAtTextStart = (c === firstTN && o <= minOffset);
                        const isAtElementPos1 = (c === li && o === 1);
                        const isOnCheckbox = (c === li && o === 0);

                        // テキスト先頭 or offset=1 → チェックボックス位置へ移動
                        if (isAtTextStart || isAtElementPos1) {
                            e.preventDefault();
                            const nr = document.createRange();
                            nr.setStart(li, 0);
                            nr.collapse(true);
                            sel.removeAllRanges();
                            sel.addRange(nr);
                            return true;
                        }

                        // チェックボックス位置 → 前のリストアイテムの末尾へ移動
                        if (isOnCheckbox) {
                            const prevLi = li.previousElementSibling;
                            if (prevLi) {
                                // ネストされたリストがある場合、最深の最後のリストアイテムへ移動
                                let targetLi = prevLi;
                                while (targetLi) {
                                    const nestedList = targetLi.querySelector(':scope > ul, :scope > ol');
                                    if (nestedList) {
                                        let lastLi = null;
                                        for (let i = nestedList.children.length - 1; i >= 0; i--) {
                                            if (nestedList.children[i].tagName === 'LI') {
                                                lastLi = nestedList.children[i];
                                                break;
                                            }
                                        }
                                        if (lastLi) {
                                            targetLi = lastLi;
                                            continue;
                                        }
                                    }
                                    break;
                                }
                                const lastTN = getLastDirectTextNode(targetLi);
                                if (lastTN) {
                                    e.preventDefault();
                                    const nr = document.createRange();
                                    nr.setStart(lastTN, lastTN.textContent.length);
                                    nr.collapse(true);
                                    sel.removeAllRanges();
                                    sel.addRange(nr);
                                    return true;
                                }
                            }
                            // 前のリストアイテムがない場合、親リストアイテムのテキスト末尾へ
                            const parentList = li.parentElement;
                            if (parentList && (parentList.tagName === 'UL' || parentList.tagName === 'OL')) {
                                const parentLi = domUtils.getParentElement(parentList, 'LI');
                                if (parentLi) {
                                    const lastTN = getLastDirectTextNode(parentLi);
                                    if (lastTN) {
                                        e.preventDefault();
                                        const nr = document.createRange();
                                        nr.setStart(lastTN, lastTN.textContent.length);
                                        nr.collapse(true);
                                        sel.removeAllRanges();
                                        sel.addRange(nr);
                                        return true;
                                    }
                                }
                            }
                            // 親リストアイテムがない場合、リストの前の要素へ
                            const prevEl = parentList ? parentList.previousElementSibling : null;
                            if (prevEl) {
                                const lastTN = domUtils.getLastTextNode(prevEl);
                                if (lastTN) {
                                    e.preventDefault();
                                    const nr = document.createRange();
                                    nr.setStart(lastTN, lastTN.textContent.length);
                                    nr.collapse(true);
                                    sel.removeAllRanges();
                                    sel.addRange(nr);
                                    return true;
                                }
                            }
                            // 移動先がない場合は通常の処理にフォールスルー
                        }
                    }
                }
            }
            if (cursorManager.moveCursorBackward(notifyChange)) {
                e.preventDefault();
                return true;
            }
            return false;
        }
        if (e.key === 'ArrowRight' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
            if (moveCursorOutOfInlineCodeRight()) {
                e.preventDefault();
                e.stopPropagation();
                return true;
            }
            // チェックボックス位置から右矢印 → テキスト先頭へ移動
            {
                const checkboxOnCursor = isCursorOnCheckbox();
                if (checkboxOnCursor) {
                    const li = checkboxOnCursor.parentElement;
                    if (li) {
                        const textNode = getFirstDirectTextNodeAfterCheckbox(li);
                        if (textNode) {
                            const minOffset = getCheckboxTextMinOffset(li);
                            e.preventDefault();
                            const sel = window.getSelection();
                            const nr = document.createRange();
                            nr.setStart(textNode, minOffset);
                            nr.collapse(true);
                            sel.removeAllRanges();
                            sel.addRange(nr);
                            return true;
                        }
                    }
                }
            }
            const selectedLabel = getSelectedCodeBlockLanguageLabel();
            if (selectedLabel) {
                e.preventDefault();
                e.stopPropagation();
                if (moveCursorIntoCodeBlockFromLabel(selectedLabel)) {
                    return true;
                }
                return true;
            }
            {
                const selection = window.getSelection();
                if (selection && selection.rangeCount > 0) {
                    const range = selection.getRangeAt(0);
                    if (exitCodeBlockDownIfAtEnd(range)) {
                        e.preventDefault();
                        e.stopPropagation();
                        notifyChange();
                        setTimeout(() => correctCheckboxCursorPosition(), 0);
                        return true;
                    }
                }
            }

            // Check if we should exit a blockquote
            if (isAtBlockquoteEnd()) {
                e.preventDefault();
                exitBlockquoteAfter();
                notifyChange();
                return true;
            }

            if (cursorManager.isAtLogicalEditorEnd && cursorManager.isAtLogicalEditorEnd()) {
                e.preventDefault();
                return true;
            }

            if (cursorManager.moveCursorForward(notifyChange)) {
                e.preventDefault();
                // チェックボックス行に入った場合、カーソル位置を補正
                correctCheckboxCursorPosition();
                return true;
            }
            // ブラウザのデフォルト動作後にチェックボックスのカーソル位置を補正
            setTimeout(() => correctCheckboxCursorPosition(), 0);
            return false;
        }
        return false;
    }

    function moveCursorUpWithListFallback() {
        const selection = window.getSelection();
        if (!selection || !selection.rangeCount) {
            cursorManager.moveCursorUp(notifyChange);
            return;
        }

        const beforeRange = selection.getRangeAt(0).cloneRange();
        const beforeContainer = beforeRange.startContainer;
        const beforeOffset = beforeRange.startOffset;
        const currentListItem = getListItemFromRange(beforeRange, 'up');
        const beforeRect = cursorManager && typeof cursorManager._getCaretRect === 'function'
            ? cursorManager._getCaretRect(beforeRange)
            : null;
        const beforeX = beforeRect ? (beforeRect.left || beforeRect.x || 0) : 0;
        const beforeTop = beforeRect ? (beforeRect.top || beforeRect.y || 0) : null;

        cursorManager.moveCursorUp(notifyChange);
        normalizeVerticalEntryAtLeadingInlineCodeToOutsideLeft(beforeRange);

        const afterSelection = window.getSelection();
        if (!afterSelection || !afterSelection.rangeCount) {
            return;
        }

        const afterRange = afterSelection.getRangeAt(0);
        const moved =
            afterRange.startContainer !== beforeContainer ||
            afterRange.startOffset !== beforeOffset;
        const afterRect = cursorManager && typeof cursorManager._getCaretRect === 'function'
            ? cursorManager._getCaretRect(afterRange)
            : null;
        const afterTop = afterRect ? (afterRect.top || afterRect.y || 0) : null;
        const movedDownByMistake = Number.isFinite(beforeTop) &&
            Number.isFinite(afterTop) &&
            afterTop > beforeTop + 2;

        if (!currentListItem) {
            return;
        }

        if (!cursorManager ||
            typeof cursorManager._getAdjacentListItem !== 'function' ||
            typeof cursorManager._placeCursorInListItemAtX !== 'function') {
            return;
        }

        const prevListItem = cursorManager._getAdjacentListItem(currentListItem, 'prev');
        if (!prevListItem || prevListItem === currentListItem) {
            return;
        }

        if (!moved || movedDownByMistake) {
            cursorManager._placeCursorInListItemAtX(prevListItem, beforeX, 'up', afterSelection);
            return;
        }
    }

    function normalizeVerticalEntryAtLeadingInlineCodeToOutsideLeft(beforeRange = null) {
        const selection = window.getSelection();
        if (!selection || !selection.rangeCount || !selection.isCollapsed) {
            return false;
        }

        const afterRange = selection.getRangeAt(0);
        const codeElement = domUtils.getParentElement(afterRange.startContainer, 'CODE');
        const preBlock = codeElement ? domUtils.getParentElement(codeElement, 'PRE') : null;
        if (!codeElement || preBlock) {
            return false;
        }

        if (beforeRange && beforeRange.collapsed) {
            const beforeCode = domUtils.getParentElement(beforeRange.startContainer, 'CODE');
            const beforePre = beforeCode ? domUtils.getParentElement(beforeCode, 'PRE') : null;
            if (beforeCode === codeElement && !beforePre) {
                return false;
            }
        }

        let atInlineCodeStart = false;
        try {
            const tempRange = document.createRange();
            tempRange.selectNodeContents(codeElement);
            tempRange.setEnd(afterRange.startContainer, afterRange.startOffset);
            const logicalOffset = (tempRange.toString() || '').replace(/[\u200B\uFEFF]/g, '').length;
            atInlineCodeStart = logicalOffset <= 0;
        } catch (e) {
            try {
                const startRange = document.createRange();
                startRange.selectNodeContents(codeElement);
                startRange.collapse(true);
                atInlineCodeStart = afterRange.compareBoundaryPoints(Range.START_TO_START, startRange) === 0;
            } catch (_err) {
                atInlineCodeStart = false;
            }
        }
        if (!atInlineCodeStart) {
            return false;
        }

        let block = codeElement.parentElement;
        while (block && block !== editor && !domUtils.isBlockElement(block)) {
            block = block.parentElement;
        }
        if (!block || block === editor) {
            return false;
        }

        const leadingInlineCode = typeof cursorManager._getLeadingInlineCodeElement === 'function'
            ? cursorManager._getLeadingInlineCodeElement(block)
            : null;
        if (leadingInlineCode !== codeElement) {
            return false;
        }

        if (typeof cursorManager._placeCursorBeforeInlineCodeElement !== 'function') {
            return false;
        }
        return !!cursorManager._placeCursorBeforeInlineCodeElement(codeElement, selection);
    }

    const ctrlNavSuppressWindowMs = 80;

    function recordCtrlNavHandled(direction, fromCommand) {
        if (!direction) return;
        lastCtrlNavDirection = direction;
        if (fromCommand) {
            lastCtrlNavCommandTs = Date.now();
        } else {
            lastCtrlNavKeydownTs = Date.now();
        }
    }

    function shouldSuppressKeydownNav(direction) {
        if (!direction) return false;
        if (lastCtrlNavDirection !== direction) return false;
        return Date.now() - lastCtrlNavCommandTs < ctrlNavSuppressWindowMs;
    }

    function shouldSuppressCommandNav(direction) {
        if (!direction) return false;
        if (lastCtrlNavDirection !== direction) return false;
        return Date.now() - lastCtrlNavKeydownTs < ctrlNavSuppressWindowMs;
    }

    function createArrowNavEventFromDirection(direction, repeat = false) {
        const keyMap = {
            up: 'ArrowUp',
            down: 'ArrowDown',
            left: 'ArrowLeft',
            right: 'ArrowRight',
        };
        const arrowKey = keyMap[direction];
        if (!arrowKey) return null;

        return {
            key: arrowKey,
            ctrlKey: false,
            metaKey: false,
            altKey: false,
            shiftKey: false,
            repeat: !!repeat,
            isComposing: false,
            preventDefault: () => { },
            stopPropagation: () => { }
        };
    }

    function moveSelectionWithNativeNav(direction) {
        const selection = window.getSelection();
        if (!selection || !selection.rangeCount || !selection.isCollapsed) {
            return false;
        }
        if (typeof selection.modify !== 'function') {
            return false;
        }

        const navMap = {
            up: { alter: 'backward', granularity: 'line' },
            down: { alter: 'forward', granularity: 'line' },
            left: { alter: 'backward', granularity: 'character' },
            right: { alter: 'forward', granularity: 'character' },
        };
        const nav = navMap[direction];
        if (!nav) {
            return false;
        }

        const restoreRange = selection.getRangeAt(0).cloneRange();
        try {
            selection.modify('move', nav.alter, nav.granularity);
        } catch (e) {
            return false;
        }

        if (!selection.rangeCount) {
            selection.addRange(restoreRange);
            return false;
        }
        const afterRange = selection.getRangeAt(0);
        if (!editor.contains(afterRange.startContainer)) {
            selection.removeAllRanges();
            selection.addRange(restoreRange);
            return false;
        }
        return true;
    }

    function handleEmacsNavKeydown(e) {
        if (!isMac) return false;
        const ctrlKey = e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey;
        const key = e.key.toLowerCase();
        const fromCommand = !!e.__fromCommand;
        const directionMap = {
            p: 'up',
            n: 'down',
            b: 'left',
            f: 'right',
        };
        const direction = directionMap[key] || null;
        const syncDirection = direction === 'up' || direction === 'down' ? direction : null;

        if (!fromCommand && syncDirection && shouldSuppressKeydownNav(syncDirection)) {
            e.preventDefault();
            e.stopPropagation();
            return true;
        }

        if (ctrlKey && direction) {
            const arrowEvent = createArrowNavEventFromDirection(direction, e.repeat);
            if (arrowEvent && handleArrowKeydown(arrowEvent)) {
                e.preventDefault();
                e.stopPropagation();
                if (syncDirection) {
                    recordCtrlNavHandled(syncDirection, fromCommand);
                }
                return true;
            }
            if (arrowEvent && shouldUseNativeArrowForTopLine(arrowEvent) &&
                moveSelectionWithNativeNav(direction)) {
                e.preventDefault();
                e.stopPropagation();
                if (syncDirection) {
                    recordCtrlNavHandled(syncDirection, fromCommand);
                }
                return true;
            }
        }

        if (tableManager.handleCtrlNavKeydown(e)) {
            if (syncDirection) {
                recordCtrlNavHandled(syncDirection, fromCommand);
            }
            return true;
        }
        if (ctrlKey && key === 'p') {
            const selection = window.getSelection();
            if (selection && selection.rangeCount > 0) {
                const range = selection.getRangeAt(0);
                if (handleTableEdgeUpFromBelow(range, selection)) {
                    e.preventDefault();
                    e.stopPropagation();
                    recordCtrlNavHandled('up', fromCommand);
                    return true;
                }
            }
        }
        if (settingsState.useVsCodeCtrlP && ctrlKey && key === 'p' && !fromCommand) {
            const selection = window.getSelection();
            if (!selection || !selection.rangeCount) {
                return false;
            }
            const range = selection.getRangeAt(0);
            const codeBlock = domUtils.getParentElement(range.startContainer, 'CODE') ||
                domUtils.getParentElement(range.endContainer, 'CODE');
            const selectedLabel = getSelectedCodeBlockLanguageLabel();
            const node = range.startContainer.nodeType === Node.ELEMENT_NODE
                ? range.startContainer
                : range.startContainer.parentElement;
            const toolbarTarget = node && node.closest
                ? node.closest('.code-block-toolbar, .code-block-language')
                : null;
            if (!codeBlock && !selectedLabel && !toolbarTarget) {
                if (handleEmptyLineAboveCodeBlockNav(range, selection, 'up')) {
                    e.preventDefault();
                    e.stopPropagation();
                    recordCtrlNavHandled('up', fromCommand);
                    return true;
                }
                if (moveCursorIntoCodeBlockFromEmptyBlockBelow(range, selection)) {
                    e.preventDefault();
                    e.stopPropagation();
                    recordCtrlNavHandled('up', fromCommand);
                    return true;
                }
                if (moveCursorIntoCodeBlockFromTextBlockBelow(range, selection)) {
                    e.preventDefault();
                    e.stopPropagation();
                    recordCtrlNavHandled('up', fromCommand);
                    return true;
                }
                return false;
            }
        }
        // Ctrl+P (上に移動) - macOS/Emacsスタイル
        if (ctrlKey && key === 'p') {
            // チェックボックス上でCtrl+P → 上のリストアイテムのチェックボックスへ移動
            const cbOnCursorP = isCursorOnCheckbox();
            if (cbOnCursorP) {
                const li = cbOnCursorP.parentElement;
                if (li) {
                    const prevLi = cursorManager._getAdjacentListItem(li, 'prev');
                    if (prevLi && hasCheckboxAtStart(prevLi)) {
                        e.preventDefault();
                        e.stopPropagation();
                        const sel = window.getSelection();
                        const nr = document.createRange();
                        nr.setStart(prevLi, 0);
                        nr.collapse(true);
                        sel.removeAllRanges();
                        sel.addRange(nr);
                        recordCtrlNavHandled('up', fromCommand);
                        return true;
                    }
                }
            }
            // 水平線が選択されている場合の処理
            const selectedHRUp = isHRSelected();
            if (selectedHRUp) {
                e.preventDefault();
                navigateFromHR(selectedHRUp, 'up');
                recordCtrlNavHandled('up', fromCommand);
                return true;
            }
            const selectedLabel = getSelectedCodeBlockLanguageLabel();
            if (selectedLabel) {
                e.preventDefault();
                e.stopPropagation();
                if (moveCursorAboveCodeBlockFromLabel(selectedLabel)) {
                    recordCtrlNavHandled('up', fromCommand);
                    return true;
                }
                recordCtrlNavHandled('up', fromCommand);
                return true;
            } else {
                const selection = window.getSelection();
                if (selection && selection.rangeCount > 0) {
                    const range = selection.getRangeAt(0);
                    if (handleEmptyLineAboveCodeBlockNav(range, selection, 'up')) {
                        e.preventDefault();
                        e.stopPropagation();
                        recordCtrlNavHandled('up', fromCommand);
                        return true;
                    }
                    if (moveCursorIntoCodeBlockFromEmptyBlockBelow(range, selection)) {
                        e.preventDefault();
                        e.stopPropagation();
                        recordCtrlNavHandled('up', fromCommand);
                        return true;
                    }
                    if (moveCursorIntoCodeBlockFromTextBlockBelow(range, selection)) {
                        e.preventDefault();
                        e.stopPropagation();
                        recordCtrlNavHandled('up', fromCommand);
                        return true;
                    }
                    if (maybeSelectCodeBlockLabelAbove(range)) {
                        e.preventDefault();
                        e.stopPropagation();
                        recordCtrlNavHandled('up', fromCommand);
                        return true;
                    }
                    const node = range.startContainer.nodeType === Node.ELEMENT_NODE
                        ? range.startContainer
                        : range.startContainer.parentElement;
                    const toolbarTarget = node && node.closest
                        ? node.closest('.code-block-toolbar, .code-block-language')
                        : null;
                    if (toolbarTarget) {
                        e.preventDefault();
                        e.stopPropagation();
                        if (moveCursorIntoCodeBlockFromToolbarTarget(toolbarTarget, selection)) {
                            recordCtrlNavHandled('up', fromCommand);
                            return true;
                        }
                    }
                    const result = handleCodeBlockArrowUp(selection);
                    if (result && result.handled) {
                        e.preventDefault();
                        e.stopPropagation();
                        recordCtrlNavHandled('up', fromCommand);
                        return true;
                    }
                }
            }
            e.preventDefault();
            e.stopPropagation();
            moveCursorUpWithListFallback();
            recordCtrlNavHandled('up', fromCommand);
            return true;
        }

        // Ctrl+N (下に移動) - macOS/Emacsスタイル
        if (ctrlKey && key === 'n') {
            // チェックボックス上でCtrl+N → 下のリストアイテムのチェックボックスへ移動
            const cbOnCursorN = isCursorOnCheckbox();
            if (cbOnCursorN) {
                const li = cbOnCursorN.parentElement;
                if (li) {
                    const nextLi = cursorManager._getAdjacentListItem(li, 'next');
                    if (nextLi && hasCheckboxAtStart(nextLi)) {
                        e.preventDefault();
                        e.stopPropagation();
                        const sel = window.getSelection();
                        const nr = document.createRange();
                        nr.setStart(nextLi, 0);
                        nr.collapse(true);
                        sel.removeAllRanges();
                        sel.addRange(nr);
                        recordCtrlNavHandled('down', fromCommand);
                        return true;
                    }
                }
            }
            // 水平線が選択されている場合の処理
            const selectedHRDown = isHRSelected();
            if (selectedHRDown) {
                e.preventDefault();
                navigateFromHR(selectedHRDown, 'down');
                // チェックボックス行に移動した場合、カーソル位置を補正
                setTimeout(() => correctCheckboxCursorPosition(), 0);
                recordCtrlNavHandled('down', fromCommand);
                return true;
            }
            const selectedLabel = getSelectedCodeBlockLanguageLabel();
            if (selectedLabel) {
                e.preventDefault();
                if (moveCursorIntoCodeBlockFromLabel(selectedLabel)) {
                    recordCtrlNavHandled('down', fromCommand);
                    return true;
                }
            } else {
                const selection = window.getSelection();
                if (selection && selection.rangeCount > 0) {
                    const range = selection.getRangeAt(0);
                    if (handleEmptyLineAboveCodeBlockNav(range, selection, 'down')) {
                        e.preventDefault();
                        recordCtrlNavHandled('down', fromCommand);
                        return true;
                    }
                    const node = range.startContainer.nodeType === Node.ELEMENT_NODE
                        ? range.startContainer
                        : range.startContainer.parentElement;
                    const toolbarTarget = node && node.closest
                        ? node.closest('.code-block-toolbar, .code-block-language')
                        : null;
                    if (toolbarTarget) {
                        e.preventDefault();
                        if (moveCursorIntoCodeBlockFromToolbarTarget(toolbarTarget, selection)) {
                            recordCtrlNavHandled('down', fromCommand);
                            return true;
                        }
                    }
                }
            }
            // Check if we should exit a blockquote
            if (isAtBlockquoteEnd() || shouldExitBlockquoteDownByVisualPosition()) {
                e.preventDefault();
                exitBlockquoteAfter({ preferTopLevelGap: true });
                notifyChange();
                recordCtrlNavHandled('down', fromCommand);
                return true;
            }
            if (exitEmptyCodeBlockDownIfNeeded()) {
                e.preventDefault();
                recordCtrlNavHandled('down', fromCommand);
                return true;
            }
            const selection = window.getSelection();
            if (selection && selection.rangeCount > 0) {
                const range = selection.getRangeAt(0);
                if (maybeSelectCodeBlockLabelBelow(range)) {
                    e.preventDefault();
                    recordCtrlNavHandled('down', fromCommand);
                    return true;
                }
            }
            e.preventDefault();
            const beforeSelection = window.getSelection();
            const beforeRange = beforeSelection && beforeSelection.rangeCount > 0
                ? beforeSelection.getRangeAt(0).cloneRange()
                : null;
            cursorManager.moveCursorDown(notifyChange);
            normalizeVerticalEntryAtLeadingInlineCodeToOutsideLeft(beforeRange);
            // チェックボックス行に入った場合、カーソル位置を補正
            setTimeout(() => correctCheckboxCursorPosition(), 0);
            recordCtrlNavHandled('down', fromCommand);
            return true;
        }

        // Ctrl+B (左に移動) - macOS/Emacsスタイル
        if (ctrlKey && key === 'b') {
            const selectedLabel = getSelectedCodeBlockLanguageLabel();
            if (selectedLabel) {
                e.preventDefault();
                e.stopPropagation();
                if (moveCursorAboveCodeBlockFromLabelToLineEnd(selectedLabel)) {
                    return true;
                }
                return true;
            }
            {
                const selection = window.getSelection();
                if (selection && selection.rangeCount > 0) {
                    const result = handleCodeBlockArrowLeft(selection);
                    if (result && result.handled) {
                        e.preventDefault();
                        e.stopPropagation();
                        return true;
                    }
                }
            }
            {
                const selection = window.getSelection();
                if (selection && selection.rangeCount > 0) {
                    const range = selection.getRangeAt(0);
                    if (moveCursorIntoCodeBlockFromBlockStartBelow(range, selection)) {
                        e.preventDefault();
                        e.stopPropagation();
                        return true;
                    }
                }
            }
            // チェックボックスli内のテキスト先頭での左移動 → チェックボックスをスキップ
            // チェックボックスが先頭にある場合のみ
            {
                const sel = window.getSelection();
                if (sel && sel.rangeCount > 0 && sel.isCollapsed) {
                    const r = sel.getRangeAt(0);
                    const c = r.startContainer;
                    const o = r.startOffset;
                    const li = domUtils.getParentElement(c, 'LI');
                    if (li && hasCheckboxAtStart(li)) {
                        const firstTN = getFirstDirectTextNodeAfterCheckbox(li);
                        const minOffset = getCheckboxTextMinOffset(li);
                        const isAtTextStart = (c === firstTN && o <= minOffset);
                        const isAtElementPos = (c === li && o <= 1);
                        if (isAtTextStart || isAtElementPos) {
                            // 前のリストアイテムの末尾へ移動
                            const prevLi = li.previousElementSibling;
                            if (prevLi) {
                                // ネストされたリストがある場合、最深の最後のリストアイテムへ移動
                                let targetLi = prevLi;
                                while (targetLi) {
                                    const nestedList = targetLi.querySelector(':scope > ul, :scope > ol');
                                    if (nestedList) {
                                        let lastLi = null;
                                        for (let i = nestedList.children.length - 1; i >= 0; i--) {
                                            if (nestedList.children[i].tagName === 'LI') {
                                                lastLi = nestedList.children[i];
                                                break;
                                            }
                                        }
                                        if (lastLi) {
                                            targetLi = lastLi;
                                            continue;
                                        }
                                    }
                                    break;
                                }
                                const lastTN = getLastDirectTextNode(targetLi);
                                if (lastTN) {
                                    e.preventDefault();
                                    const nr = document.createRange();
                                    nr.setStart(lastTN, lastTN.textContent.length);
                                    nr.collapse(true);
                                    sel.removeAllRanges();
                                    sel.addRange(nr);
                                    return true;
                                }
                            }
                            // 前のリストアイテムがない場合、親リストアイテムのテキスト末尾へ
                            const parentList = li.parentElement;
                            if (parentList && (parentList.tagName === 'UL' || parentList.tagName === 'OL')) {
                                const parentLi = domUtils.getParentElement(parentList, 'LI');
                                if (parentLi) {
                                    const lastTN = getLastDirectTextNode(parentLi);
                                    if (lastTN) {
                                        e.preventDefault();
                                        const nr = document.createRange();
                                        nr.setStart(lastTN, lastTN.textContent.length);
                                        nr.collapse(true);
                                        sel.removeAllRanges();
                                        sel.addRange(nr);
                                        return true;
                                    }
                                }
                            }
                            // 親リストアイテムもない場合、リストの前の要素へ
                            const prevEl = parentList ? parentList.previousElementSibling : null;
                            if (prevEl) {
                                const lastTN = domUtils.getLastTextNode(prevEl);
                                if (lastTN) {
                                    e.preventDefault();
                                    const nr = document.createRange();
                                    nr.setStart(lastTN, lastTN.textContent.length);
                                    nr.collapse(true);
                                    sel.removeAllRanges();
                                    sel.addRange(nr);
                                    return true;
                                }
                            }
                            // 移動先がない場合は通常の処理にフォールスルー
                        }
                    }
                }
            }
            // Normal backward movement
            if (cursorManager.moveCursorBackward(notifyChange)) {
                e.preventDefault();
                return true;
            }
            return false;
        }

        // Ctrl+F (右に移動) - macOS/Emacsスタイル
        if (e.ctrlKey && e.key === 'f' && !e.shiftKey && !e.metaKey && !e.altKey) {
            // チェックボックス上でCtrl+F → 下のリストアイテムのチェックボックスへ移動
            const cbOnCursorF = isCursorOnCheckbox();
            if (cbOnCursorF) {
                const li = cbOnCursorF.parentElement;
                if (li) {
                    const nextLi = cursorManager._getAdjacentListItem(li, 'next');
                    if (nextLi && hasCheckboxAtStart(nextLi)) {
                        e.preventDefault();
                        e.stopPropagation();
                        const sel = window.getSelection();
                        const nr = document.createRange();
                        nr.setStart(nextLi, 0);
                        nr.collapse(true);
                        sel.removeAllRanges();
                        sel.addRange(nr);
                        return true;
                    }
                }
            }
            if (moveCursorOutOfInlineCodeRight()) {
                e.preventDefault();
                e.stopPropagation();
                return true;
            }
            const selectedLabel = getSelectedCodeBlockLanguageLabel();
            if (selectedLabel) {
                e.preventDefault();
                e.stopPropagation();
                if (moveCursorIntoCodeBlockFromLabel(selectedLabel)) {
                    return true;
                }
                return true;
            }
            {
                const selection = window.getSelection();
                if (selection && selection.rangeCount > 0) {
                    const range = selection.getRangeAt(0);
                    if (handleEmptyLineAboveCodeBlockNav(range, selection, 'down')) {
                        e.preventDefault();
                        e.stopPropagation();
                        return true;
                    }
                }
            }
            {
                const selection = window.getSelection();
                if (selection && selection.rangeCount > 0) {
                    const range = selection.getRangeAt(0);
                    if (exitCodeBlockDownIfAtEnd(range)) {
                        e.preventDefault();
                        e.stopPropagation();
                        notifyChange();
                        setTimeout(() => correctCheckboxCursorPosition(), 0);
                        return true;
                    }
                }
            }

            // Check if we should exit a blockquote
            if (isAtBlockquoteEnd()) {
                e.preventDefault();
                exitBlockquoteAfter();
                notifyChange();
                return true;
            }

            if (cursorManager.isAtLogicalEditorEnd && cursorManager.isAtLogicalEditorEnd()) {
                e.preventDefault();
                return true;
            }

            e.preventDefault();
            cursorManager.moveCursorForward(notifyChange);
            // チェックボックス行に入った場合、カーソル位置を補正
            // setTimeout to ensure cursor is positioned after moveCursorForward completes
            setTimeout(() => correctCheckboxCursorPosition(), 0);
            return true;
        }

        return false;
    }

    function moveCursorOutOfInlineCodeRight() {
        const selection = window.getSelection();
        if (!selection || !selection.rangeCount || !selection.isCollapsed) {
            return false;
        }

        const range = selection.getRangeAt(0);
        const codeElement = domUtils.getParentElement(range.startContainer, 'CODE');
        const preBlock = codeElement ? domUtils.getParentElement(codeElement, 'PRE') : null;
        if (!codeElement || preBlock) {
            return false;
        }

        let atInlineCodeEnd = false;
        let hasCursorInfo = false;
        try {
            const tempRange = document.createRange();
            tempRange.selectNodeContents(codeElement);
            tempRange.setEnd(range.startContainer, range.startOffset);
            const offset = tempRange.toString().replace(/\u200B/g, '').length;
            const total = (codeElement.textContent || '').replace(/\u200B/g, '').length;
            hasCursorInfo = true;
            atInlineCodeEnd = offset >= total;
        } catch (e) {
            atInlineCodeEnd = false;
            hasCursorInfo = false;
        }
        if (!atInlineCodeEnd) {
            try {
                const endRange = document.createRange();
                endRange.selectNodeContents(codeElement);
                endRange.collapse(false);
                atInlineCodeEnd = range.compareBoundaryPoints(Range.START_TO_START, endRange) === 0;
            } catch (e) {
                atInlineCodeEnd = false;
            }
        }
        if (!atInlineCodeEnd && !hasCursorInfo) {
            const container = range.startContainer;
            const offset = range.startOffset;
            if (container === codeElement) {
                atInlineCodeEnd = offset >= (codeElement.childNodes ? codeElement.childNodes.length : 0);
            } else if (container && container.nodeType === Node.TEXT_NODE && codeElement.contains(container)) {
                const text = container.textContent || '';
                if (text.length === 0) {
                    atInlineCodeEnd = true;
                } else {
                    // Safari/WebView can report one-char-short offset when a leading ZWSP exists.
                    // Keep that tolerance only when the legacy leading ZWSP is present.
                    const threshold = text[0] === '\u200B'
                        ? Math.max(0, text.length - 1)
                        : text.length;
                    if (offset >= threshold) {
                        atInlineCodeEnd = true;
                    }
                }
            }
        }
        if (!atInlineCodeEnd) {
            return false;
        }

        const parent = codeElement.parentElement;
        if (!parent) {
            return false;
        }

        const newRange = document.createRange();
        const immediateNext = codeElement.nextSibling;
        let placeholder = null;
        if (immediateNext && immediateNext.nodeType === Node.TEXT_NODE) {
            const text = immediateNext.textContent || '';
            if (text.replace(/\u200B/g, '') === '') {
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
        newRange.setStart(placeholder, placeholder.textContent.length);
        newRange.collapse(true);
        selection.removeAllRanges();
        selection.addRange(newRange);
        return true;
    }

    function createCommandNavEvent(direction) {
        const key = direction === 'up' ? 'p' : 'n';
        return {
            key,
            ctrlKey: true,
            metaKey: false,
            altKey: false,
            shiftKey: false,
            repeat: false,
            __fromCommand: true,
            preventDefault: () => {},
            stopPropagation: () => {}
        };
    }

    function handleLineBoundaryKeydown(e) {
        if (tableManager.handleLineBoundaryKeydown(e)) {
            return true;
        }

        // Ctrl+A (行頭) - macOS Emacsキーバインド
        if (isMac && e.ctrlKey && !e.metaKey && e.key === 'a' && !e.shiftKey) {
            e.preventDefault();
            // チェックボックス上にカーソルがある場合はそのまま
            if (isCursorOnCheckbox()) {
                return true;
            }
            // チェックボックスのテキスト先頭にカーソルがある場合はチェックボックスに移動
            const checkboxTextStartLi = isCursorAtCheckboxTextStart();
            if (checkboxTextStartLi) {
                const sel = window.getSelection();
                const nr = document.createRange();
                nr.setStart(checkboxTextStartLi, 0);
                nr.collapse(true);
                sel.removeAllRanges();
                sel.addRange(nr);
                return true;
            }
            cursorManager.moveCursorToLineStart();
            return true;
        }

        // Ctrl+E (行末) - macOS Emacsキーバインド
        if (isMac && e.ctrlKey && !e.metaKey && e.key === 'e' && !e.shiftKey) {
            e.preventDefault();
            // チェックボックス上にカーソルがある場合はそのテキストの末尾に移動
            const cbForEnd = isCursorOnCheckbox();
            if (cbForEnd) {
                const li = cbForEnd.parentElement;
                if (li) {
                    const lastTN = getLastDirectTextNode(li);
                    if (lastTN) {
                        const sel = window.getSelection();
                        const nr = document.createRange();
                        nr.setStart(lastTN, lastTN.textContent.length);
                        nr.collapse(true);
                        sel.removeAllRanges();
                        sel.addRange(nr);
                        return true;
                    }
                }
            }
            cursorManager.moveCursorToLineEnd();
            return true;
        }

        return false;
    }

    function handleTableStructureSelectKeydown(e) {
        const isMacStyle = !e.metaKey && e.ctrlKey && e.altKey && e.shiftKey;
        const isWinLinuxStyle = !e.metaKey && e.ctrlKey && e.altKey && !e.shiftKey;
        if (!isMacStyle && !isWinLinuxStyle) return false;

        let command = null;
        if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            command = 'selectColumn';
        } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
            command = 'selectRow';
        }
        if (!command) return false;
        if (!tableManager.isSelectionInTableContext()) return false;

        const handled = tableManager.executeTableCommand(command);
        if (!handled) return false;

        e.preventDefault();
        e.stopPropagation();
        return true;
    }

    function restoreSelectionFromCheckboxTarget(target) {
        if (!target || !target.closest) return null;
        const checkbox = target.closest('input[type="checkbox"]');
        if (!checkbox || !editor.contains(checkbox)) return null;
        const listItem = domUtils.getParentElement(checkbox, 'LI');
        if (!listItem) return null;

        const selection = window.getSelection();
        if (!selection) return null;
        const range = document.createRange();
        range.setStart(listItem, 0);
        range.collapse(true);
        selection.removeAllRanges();
        selection.addRange(range);
        return selection;
    }

    function handleKeydown(e) {
        if (handleTableStructureSelectKeydown(e)) {
            return;
        }

        if (handleUndoRedoKeydown(e)) {
            return;
        }

        if (handleFormatShortcutKeydown(e)) {
            return;
        }

        if (searchManager.handleKeydown(e)) {
            return;
        }

        if (handleSlashCommandKeydown(e)) {
            return;
        }

        let selection = window.getSelection();
        if ((!selection || !selection.rangeCount) && e.key === 'Tab' && !e.isComposing) {
            const restoredSelection = restoreSelectionFromCheckboxTarget(e.target);
            if (restoredSelection && restoredSelection.rangeCount) {
                selection = restoredSelection;
            }
        }
        if (!selection || !selection.rangeCount) {
            if ((e.key === 'ArrowDown' || (isMac && e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'n'))) {
                const target = e.target;
                const preBlock = target && target.closest ? target.closest('pre') : domUtils.getParentElement(target, 'PRE');
                if (exitEmptyCodeBlockDownFromPre(preBlock, window.getSelection())) {
                    e.preventDefault();
                    return;
                }
            }
            return;
        }

        let range = selection.getRangeAt(0);
        if (tableManager.handleEdgeTextInputKeydown(e)) {
            return;
        }
        const selectedLabel = getSelectedCodeBlockLanguageLabel();
        if (selectedLabel) {
            const key = e.key.toLowerCase();
            const isCtrlK = isMac && e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && key === 'k';
            const isBackspace = e.key === 'Backspace' || e.key === 'Delete' ||
                (isMac && e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && key === 'h');
            if (isCtrlK) {
                const pre = selectedLabel.closest ? selectedLabel.closest('pre') : null;
                const code = pre ? pre.querySelector('code') : null;
                if (pre && code) {
                    const codeText = cursorManager.getCodeBlockText(code);
                    const normalized = codeText.replace(/[\u200B\uFEFF]/g, '');
                    if (normalized.trim() === '') {
                        e.preventDefault();
                        e.stopPropagation();
                        stateManager.saveState();
                        deleteCodeBlock(pre, selection);
                        notifyChange();
                        return;
                    }
                }
            }
            if (isBackspace) {
                e.preventDefault();
                e.stopPropagation();
                if (startEditingCodeBlockLanguageLabel(selectedLabel)) {
                    setTimeout(() => {
                        if (!selectedLabel.classList.contains('editing')) return;
                        selectedLabel.textContent = '';
                        const sel = window.getSelection();
                        if (sel) {
                            const r = document.createRange();
                            r.selectNodeContents(selectedLabel);
                            r.collapse(true);
                            sel.removeAllRanges();
                            sel.addRange(r);
                        }
                        selectedLabel.dispatchEvent(new Event('input', { bubbles: true }));
                    }, 0);
                }
                return;
            }
            const isPrintable = e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey;
            if (isPrintable && !e.isComposing) {
                startEditingCodeBlockLanguageLabel(selectedLabel);
                return;
            }
        }
        if (e.key === 'ArrowDown' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
            if (selectedLabel) {
                e.preventDefault();
                if (moveCursorIntoCodeBlockFromLabel(selectedLabel)) {
                    return;
                }
            } else {
                const node = range.startContainer.nodeType === Node.ELEMENT_NODE
                    ? range.startContainer
                    : range.startContainer.parentElement;
                const toolbarTarget = node && node.closest
                    ? node.closest('.code-block-toolbar, .code-block-language')
                    : null;
                if (toolbarTarget) {
                    e.preventDefault();
                    if (moveCursorIntoCodeBlockFromToolbarTarget(toolbarTarget, selection)) {
                        return;
                    }
                }
            }
        }

        const container = range.commonAncestorContainer;
        const listItem = domUtils.getParentElement(container, 'LI') ||
            getListItemFromRange(range, 'down') ||
            getListItemFromRange(range, 'up');
        const context = { selection, range, container, listItem };

        if (tableManager.handleKeydown(e)) {
            return;
        }

        if (tableManager.handleEnterKeydown(e, isComposing)) {
            return;
        }

        if (tableManager.handleDeleteTableKeydown(e)) {
            return;
        }

        if (isMac && e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k' && listItem && range.collapsed) {
            // チェックボックス上でCtrl+K → リストアイテム全体を削除
            const checkboxForCtrlK = isCursorOnCheckbox();
            if (checkboxForCtrlK) {
                e.preventDefault();
                stateManager.saveState();
                deleteCheckboxListItem(checkboxForCtrlK.parentElement);
                return;
            }
            // 空のリストアイテムでCtrl+K → リストアイテムを削除
            if (!hasDirectTextContent(listItem)) {
                e.preventDefault();
                stateManager.saveState();
                const parentList = listItem.parentElement;

                // 次の兄弟リストアイテムがある場合 → 空アイテムを削除して次のアイテムにカーソル移動
                const nextSibling = listItem.nextElementSibling;
                if (nextSibling && nextSibling.tagName === 'LI') {
                    // ネストされた子リストがあれば次の兄弟の前に昇格
                    const nestedList = Array.from(listItem.children).find(
                        child => child.tagName === 'UL' || child.tagName === 'OL'
                    );
                    let firstPromotedItem = null;
                    if (nestedList && nestedList.children.length > 0) {
                        firstPromotedItem = nestedList.children[0];
                        while (nestedList.children.length > 0) {
                            parentList.insertBefore(nestedList.children[0], listItem);
                        }
                    }
                    listItem.remove();
                    // ネストされた子があった場合は昇格した最初のアイテムに、なければ次の兄弟にカーソル
                    const cursorTarget = firstPromotedItem || nextSibling;
                    const newRange = document.createRange();
                    let targetNode = null;
                    for (const child of cursorTarget.childNodes) {
                        if (child.nodeType === Node.TEXT_NODE) {
                            targetNode = child;
                            break;
                        }
                    }
                    if (!targetNode) {
                        targetNode = cursorTarget;
                    }
                    newRange.setStart(targetNode, 0);
                    newRange.collapse(true);
                    selection.removeAllRanges();
                    selection.addRange(newRange);
                    notifyChange();
                    return;
                }

                // ネストされた子リストがある場合（次の兄弟なし）→ 子アイテムを親レベルに昇格
                const nestedList = Array.from(listItem.children).find(
                    child => child.tagName === 'UL' || child.tagName === 'OL'
                );
                if (nestedList && nestedList.children.length > 0) {
                    const firstPromotedItem = nestedList.children[0];
                    while (nestedList.children.length > 0) {
                        parentList.insertBefore(nestedList.children[0], listItem);
                    }
                    listItem.remove();
                    const newRange = document.createRange();
                    let targetNode = null;
                    for (const child of firstPromotedItem.childNodes) {
                        if (child.nodeType === Node.TEXT_NODE) {
                            targetNode = child;
                            break;
                        }
                    }
                    if (!targetNode) {
                        targetNode = firstPromotedItem;
                    }
                    newRange.setStart(targetNode, 0);
                    newRange.collapse(true);
                    selection.removeAllRanges();
                    selection.addRange(newRange);
                    notifyChange();
                    return;
                }

                const grandParentItem = parentList ? parentList.parentElement : null;
                if (grandParentItem && grandParentItem.tagName === 'LI') {
                    // ネストされたリスト → アウトデント
                    const textNode = container.nodeType === 3 ? container : container.firstChild;
                    const offset = range.startOffset;
                    listManager.outdentListItem(listItem, textNode, offset);
                } else {
                    // トップレベルリスト → パラグラフに変換
                    const p = document.createElement('p');
                    const br = document.createElement('br');
                    p.appendChild(br);
                    if (listItem.previousElementSibling || listItem.nextElementSibling) {
                        parentList.parentElement.insertBefore(p, parentList.nextSibling);
                        listItem.remove();
                        if (parentList.children.length === 0) {
                            parentList.remove();
                        }
                    } else {
                        parentList.replaceWith(p);
                    }
                    const newRange = document.createRange();
                    newRange.setStart(p, 0);
                    newRange.collapse(true);
                    selection.removeAllRanges();
                    selection.addRange(newRange);
                }
                notifyChange();
                return;
            }
            pendingDeleteListItem = listItem;
        }

        if (handleCtrlKEmptyLineBeforeTableKeydown(e, context)) {
            return;
        }

        if (handleCodeBlockFenceEnterKeydown(e, context)) {
            return;
        }

        // チェックボックス上でEnter → チェック状態をトグル
        if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey && !e.isComposing && !isComposing) {
            const checkboxForEnter = isCursorOnCheckbox();
            if (checkboxForEnter) {
                e.preventDefault();
                stateManager.saveState();
                checkboxForEnter.checked = !checkboxForEnter.checked;
                // checked属性をプロパティと同期（innerHTMLに反映させるため）
                if (checkboxForEnter.checked) {
                    checkboxForEnter.setAttribute('checked', '');
                } else {
                    checkboxForEnter.removeAttribute('checked');
                }
                notifyChange();
                return;
            }
        }

        if (handleCodeBlockEnterKeydown(e, context)) {
            return;
        }

        if (handleListItemEnterKeydown(e, context)) {
            return;
        }

        if (handlePlainEnterKeydown(e, context)) {
            return;
        }

        if (handleTabKeydown(e, context)) {
            return;
        }

        if (handleBackspaceKeydown(e, context)) {
            return;
        }

        if (handleArrowKeydown(e)) {
            return;
        }

        if (handleEmacsNavKeydown(e)) {
            return;
        }

        handleLineBoundaryKeydown(e);
    }

    // エディタのセットアップ
    function setupEditor() {
        // フォーカス監視
        let lastFocusTime = Date.now();
        let focusCheckInterval = null;

        editor.addEventListener('focus', () => {
            lastFocusTime = Date.now();
            if (focusCheckInterval) {
                clearInterval(focusCheckInterval);
            }
            focusCheckInterval = setInterval(() => {
                if (!editor.contains(document.activeElement) &&
                    Date.now() - lastFocusTime < 2000 &&
                    !isUpdating) {
                    const activeElement = document.activeElement;
                    if (!activeElement || activeElement === document.body) {
                        editor.focus();
                    }
                }
            }, 100);
        });

        editor.addEventListener('blur', () => {
            if (focusCheckInterval) {
                clearInterval(focusCheckInterval);
                focusCheckInterval = null;
            }
            hideSlashCommandMenu();
        });

        if (editorScrollbarIndicator && editorScrollbarThumb) {
            const stopScrollbarDrag = () => {
                if (!scrollbarDragState) return;
                scrollbarDragState = null;
                document.body.classList.remove('scrollbar-dragging');
            };

            const scrollFromClientY = (clientY) => {
                if (!scrollbarDragState) return;
                const metrics = getEditorScrollbarMetrics();
                if (!metrics) {
                    stopScrollbarDrag();
                    return;
                }
                const editorRect = editor.getBoundingClientRect();
                const rawThumbTop = clientY - editorRect.top - scrollbarDragState.pointerOffset;
                applyScrollFromThumbPosition(rawThumbTop, metrics);
            };

            editorScrollbarIndicator.addEventListener('mousedown', (e) => {
                if (e.button !== 0) return;
                if (!editorScrollbarIndicator.classList.contains('visible')) return;
                const metrics = getEditorScrollbarMetrics();
                if (!metrics) return;

                const clickedThumb = e.target === editorScrollbarThumb;
                const thumbRect = editorScrollbarThumb.getBoundingClientRect();
                const pointerOffset = clickedThumb
                    ? (e.clientY - thumbRect.top)
                    : (metrics.thumbHeight / 2);

                scrollbarDragState = { pointerOffset };
                document.body.classList.add('scrollbar-dragging');

                if (!clickedThumb) {
                    scrollFromClientY(e.clientY);
                }

                e.preventDefault();
                e.stopPropagation();
            });

            document.addEventListener('mousemove', (e) => {
                if (!scrollbarDragState) return;
                scrollFromClientY(e.clientY);
                e.preventDefault();
            });

            document.addEventListener('mouseup', stopScrollbarDrag);
            window.addEventListener('blur', stopScrollbarDrag);
        }

        // Ensure table cell range deletion works even if editor doesn't have focus
        document.addEventListener('keydown', (e) => {
            if (editor.contains(e.target)) return;
            if (!tableManager.hasActiveTableSelection()) return;
            if (e.key === 'Escape' && !e.metaKey && !e.ctrlKey && !e.altKey) {
                tableManager.handleKeydown(e);
                return;
            }
            tableManager.handleBackspaceKeydown(e);
        }, true);

        // IME composition
        editor.addEventListener('compositionstart', (e) => {
            isComposing = true;
            tableManager.handleEdgeCompositionStart();
            hideSlashCommandMenu();
        });

        editor.addEventListener('compositionend', (e) => {
            isComposing = false;
            if (tableManager.handleEdgeCompositionEnd()) {
                return;
            }
            if (!isUpdating) {
                setTimeout(() => {
                    const converted = markdownConverter.convertMarkdownSyntax(notifyChange);
                    if (!converted) {
                        notifyChange();
                    }
                    editor.focus();
                }, 0);
            }
        });

        editor.addEventListener('beforeinput', (e) => {
            if (tableManager.handleEdgeBeforeInput(e)) {
                return;
            }

            if (typeof e.inputType === 'string' && e.inputType.startsWith('delete')) {
                const selection = window.getSelection();
                const range = selection && selection.rangeCount ? selection.getRangeAt(0) : null;
                if (shouldFlagStrikeCleanupForDelete(range)) {
                    pendingStrikeCleanup = true;
                }
            }

            const isInsertTextInput =
                e.inputType === 'insertText' ||
                e.inputType === 'insertCompositionText';
            if (isInsertTextInput) {
                if (e.inputType === 'insertText' && !isComposing && !e.isComposing && typeof e.data === 'string' && e.data.length > 0) {
                    const selection = window.getSelection();
                    const range = selection && selection.rangeCount ? selection.getRangeAt(0) : null;
                    const emptyListItem = getEmptyListItemAtRange(range);
                    pendingEmptyListItemInsert = emptyListItem;
                    if (emptyListItem) {
                        e.preventDefault();
                        stateManager.saveState();
                        const inserted = insertPlainTextAtSelection(e.data);
                        if (inserted) {
                            emptyListItem.removeAttribute('data-preserve-empty');
                            // 文字入力後に残ったプレースホルダー文字を除去
                            Array.from(emptyListItem.childNodes).forEach(child => {
                                if (child.nodeType !== Node.TEXT_NODE) return;
                                const text = child.textContent || '';
                                const cleaned = text.replace(/[\u00A0\u200B]/g, '');
                                if (cleaned.trim() === '') {
                                    child.remove();
                                } else if (cleaned !== text) {
                                    child.textContent = cleaned;
                                }
                            });
                            updateListItemClasses();
                            scheduleMarkdownConversion(() => {
                                const converted = markdownConverter.convertMarkdownSyntax(notifyChange);
                                if (!converted) {
                                    notifyChange();
                                }
                            });
                        }
                        pendingEmptyListItemInsert = null;
                        return;
                    }
                } else if (e.inputType !== 'insertCompositionText') {
                    pendingEmptyListItemInsert = null;
                }

                if (pendingStrikeCleanup && e.inputType === 'insertText') {
                    e.preventDefault();
                    stateManager.saveState();
                    const inserted = insertPlainTextAtSelection(e.data || '');
                    pendingStrikeCleanup = false;
                    if (inserted) {
                        clearStrikeThroughState();
                        updateListItemClasses();

                        const selection = window.getSelection();
                        let isInCodeBlock = false;
                        if (selection && selection.rangeCount > 0) {
                            const range = selection.getRangeAt(0);
                            const container = range.commonAncestorContainer;
                            const codeBlock = domUtils.getParentElement(container, 'CODE');
                            const preBlock = codeBlock ? domUtils.getParentElement(codeBlock, 'PRE') : null;
                            isInCodeBlock = !!(preBlock && codeBlock);
                        }

                        if (!isInCodeBlock) {
                            scheduleMarkdownConversion(() => {
                                const converted = markdownConverter.convertMarkdownSyntax(notifyChange);
                                if (!converted) {
                                    notifyChange();
                                }
                            });
                        } else {
                            notifyChange();
                        }
                    }
                    return;
                }

                const removedStrike = cleanupEmptyStrikeAtSelection() || cleanupEmptyStrikes();
                if (removedStrike) {
                    pendingStrikeCleanup = true;
                }
                cleanupEmptyStrikes();
                if (!isSelectionInStrike()) {
                    clearStrikeThroughState();
                }
            }
        });

        editor.addEventListener('input', (e) => {
            if (!isUpdating) {
                if (tableManager._compositionBlockedEdge) {
                    tableManager._compositionBlockedEdge.textContent = '\u00A0';
                    return;
                }
                stateManager.saveStateDebounced();

                const isInsertTextInput =
                    e.inputType === 'insertText' ||
                    e.inputType === 'insertCompositionText' ||
                    e.inputType === 'insertFromPaste';
                let caretFixListItem = null;
                if (isInsertTextInput && !isComposing && !e.isComposing) {
                    const selection = window.getSelection();
                    if (selection && selection.rangeCount > 0) {
                        const range = selection.getRangeAt(0);
                        const activeListItem = domUtils.getParentElement(range.commonAncestorContainer, 'LI');
                        if (activeListItem &&
                            activeListItem.getAttribute('data-preserve-empty') === 'true' &&
                            hasNestedListChild(activeListItem)) {
                            caretFixListItem = activeListItem;
                        }
                    }
                }

                if (isInsertTextInput && pendingEmptyListItemInsert) {
                    normalizeCaretIfStuckAtListItemStart(pendingEmptyListItemInsert);
                    pendingEmptyListItemInsert = null;
                }
                if (isInsertTextInput && !isComposing && !e.isComposing) {
                    const selection = window.getSelection();
                    if (selection && selection.rangeCount > 0) {
                        const range = selection.getRangeAt(0);
                        const activeListItem = domUtils.getParentElement(range.startContainer, 'LI') ||
                            getListItemFromRange(range, 'down');
                        if (activeListItem) {
                            normalizeCaretIfStuckAtListItemStart(activeListItem);
                        }
                    }
                }

                const isDeleteInput = typeof e.inputType === 'string' && e.inputType.startsWith('delete');
                if (isDeleteInput) {
                    if (pendingDeleteListItem) {
                        preserveEmptyListItemAfterDelete(pendingDeleteListItem);
                    }
                    pendingDeleteListItem = null;
                    const removedStrike = cleanupEmptyStrikeAtSelection() || cleanupEmptyStrikes();
                    if (removedStrike) {
                        pendingStrikeCleanup = true;
                    }
                    if (!isSelectionInStrike()) {
                        clearStrikeThroughState();
                    }
                } else if (pendingDeleteListItem) {
                    pendingDeleteListItem = null;
                }

                // Update list item classes on input
                updateListItemClasses();

                if (isComposing || e.isComposing) {
                    hideSlashCommandMenu();
                    notifyChange();
                    return;
                }

                if (e.inputType === 'insertText' || e.inputType === 'insertLineBreak') {
                    const selection = window.getSelection();
                    let isInCodeBlock = false;

                    if (selection && selection.rangeCount > 0) {
                        const range = selection.getRangeAt(0);
                        const container = range.commonAncestorContainer;
                        const codeBlock = domUtils.getParentElement(container, 'CODE');
                        const preBlock = codeBlock ? domUtils.getParentElement(codeBlock, 'PRE') : null;
                        isInCodeBlock = !!(preBlock && codeBlock);
                    }

                    if (!isInCodeBlock) {
                        if (pendingStrikeCleanup) {
                            pendingStrikeCleanup = false;
                            if (unwrapStrikeAtSelection()) {
                                clearStrikeThroughState();
                            } else {
                                clearStrikeThroughState();
                            }
                        }
                        // 変換を早めに実行（入力後のラグを減らす）
                        scheduleMarkdownConversion(() => {
                            const converted = markdownConverter.convertMarkdownSyntax(notifyChange);
                            if (converted) {
                                // 変換が行われた場合はnotifyChangeがコールバックで呼ばれる
                            } else {
                                // 変換が行われなかった場合でも、内容が変更されているので通知
                                notifyChange();
                            }
                        });
                    } else {
                        notifyChange();
                    }

                    setTimeout(() => domUtils.cleanupEmptyListItems(), 0);
                } else {
                    notifyChange();
                }

                if (caretFixListItem && caretFixListItem.isConnected) {
                    const directText = getDirectTextContent(caretFixListItem);
                    const directTextWithoutPlaceholders = directText.replace(/[\u00A0\u200B]/g, '');
                    if (directTextWithoutPlaceholders.trim() !== '') {
                        const lastDirectTextNode =
                            getLastMeaningfulDirectTextNode(caretFixListItem) ||
                            getLastDirectTextNode(caretFixListItem);
                        if (lastDirectTextNode) {
                            try {
                                const selection = window.getSelection();
                                if (selection) {
                                    const range = document.createRange();
                                    const text = lastDirectTextNode.textContent || '';
                                    let offset = text.length;
                                    while (offset > 0 && /[\u200B\u00A0]/.test(text[offset - 1])) {
                                        offset--;
                                    }
                                    range.setStart(lastDirectTextNode, offset);
                                    range.collapse(true);
                                    selection.removeAllRanges();
                                    selection.addRange(range);
                                }
                            } catch (e) {
                                console.error('Failed to normalize caret position:', e);
                            }
                        }
                    }
                }

                // コードブロック内の編集をチェック
                const selection = window.getSelection();
                if (selection && selection.rangeCount > 0) {
                    const range = selection.getRangeAt(0);
                    const container = range.commonAncestorContainer;
                    const codeBlock = domUtils.getParentElement(container, 'CODE');
                    const preBlock = codeBlock ? domUtils.getParentElement(codeBlock, 'PRE') : null;

                    if (preBlock && codeBlock) {
                        const codeText = codeBlock.textContent;

                        if (codeText.trim() === '') {
                            if (codeText === '') {
                                codeBlock.textContent = '\n';

                                const newRange = document.createRange();
                                const textNode = codeBlock.firstChild;
                                if (textNode) {
                                    newRange.setStart(textNode, 0);
                                    newRange.collapse(true);
                                    selection.removeAllRanges();
                                    selection.addRange(newRange);
                                }
                            }
                        } else if (codeBlock.className.match(/language-\w+/)) {
                            setTimeout(() => {
                                codeBlockManager.highlightSingleCodeBlock(codeBlock);
                            }, 50);
                        }
                    }
                }

                updateSlashCommandMenu();
                syncImageResizeOverlayPosition();
            }
        });

        editor.addEventListener('scroll', () => {
            if (slashMenuState.visible) {
                hideSlashCommandMenu();
            }
            syncImageResizeOverlayPosition();
            scheduleEditorOverflowStateUpdate();
        });

        // URLかどうかを判定するヘルパー関数
        const isUrl = (text) => {
            const urlPattern = /^https?:\/\/[^\s]+$/i;
            return urlPattern.test(text.trim());
        };

        const isImageFile = (file) => {
            if (!file) return false;
            if (file.type && file.type.indexOf('image/') === 0) {
                return true;
            }
            const filename = (file.name || '').toLowerCase();
            return /\.(png|jpe?g|gif|bmp|webp|svg|avif|ico|heic|heif|tiff?)$/.test(filename);
        };

        const hasFileDragPayload = (dataTransfer) => {
            if (!dataTransfer) return false;

            if (dataTransfer.files && dataTransfer.files.length > 0) {
                return true;
            }

            if (dataTransfer.items && dataTransfer.items.length > 0) {
                for (let i = 0; i < dataTransfer.items.length; i++) {
                    if (dataTransfer.items[i].kind === 'file') {
                        return true;
                    }
                }
            }

            if (dataTransfer.types && dataTransfer.types.length > 0) {
                for (let i = 0; i < dataTransfer.types.length; i++) {
                    if (String(dataTransfer.types[i]).toLowerCase() === 'files') {
                        return true;
                    }
                }
            }

            return false;
        };

        const shouldInterceptExternalDrop = (dataTransfer) => {
            if (!dataTransfer) return false;
            if (hasFileDragPayload(dataTransfer)) return true;

            const types = dataTransfer.types;
            if (!types || types.length === 0) {
                return true;
            }

            for (let i = 0; i < types.length; i++) {
                const t = String(types[i]).toLowerCase();
                if (
                    t === 'files' ||
                    t === 'public.file-url' ||
                    t === 'application/x-moz-file' ||
                    t === 'text/uri-list'
                ) {
                    return true;
                }
            }

            return false;
        };

        const extractImageFileFromDataTransfer = (dataTransfer) => {
            if (!dataTransfer) return null;

            if (dataTransfer.files && dataTransfer.files.length > 0) {
                for (let i = 0; i < dataTransfer.files.length; i++) {
                    const file = dataTransfer.files[i];
                    if (isImageFile(file)) {
                        return file;
                    }
                }
            }

            if (dataTransfer.items && dataTransfer.items.length > 0) {
                for (let i = 0; i < dataTransfer.items.length; i++) {
                    const item = dataTransfer.items[i];
                    if (item.kind !== 'file') continue;
                    if (item.type && item.type.indexOf('image/') !== 0) continue;
                    const file = item.getAsFile();
                    if (isImageFile(file)) {
                        return file;
                    }
                }
            }

            return null;
        };

        const isImagePathLike = (value) => {
            if (!value) return false;
            const normalized = String(value).split('#')[0].split('?')[0].toLowerCase();
            return /\.(png|jpe?g|gif|bmp|webp|svg|avif|ico|heic|heif|tiff?)$/.test(normalized);
        };

        const extractImageUriFromDataTransfer = (dataTransfer) => {
            if (!dataTransfer || typeof dataTransfer.getData !== 'function') return null;

            const parseUriList = (uriListValue) => {
                if (!uriListValue) return null;
                const lines = String(uriListValue).split(/\r?\n/);
                for (let i = 0; i < lines.length; i++) {
                    const line = lines[i].trim();
                    if (!line || line.startsWith('#')) continue;
                    if (isImagePathLike(line)) {
                        return line;
                    }
                }
                return null;
            };

            const uriList = dataTransfer.getData('text/uri-list');
            const fromUriList = parseUriList(uriList);
            if (fromUriList) return fromUriList;

            const plainText = (dataTransfer.getData('text/plain') || '').trim();
            if (isImagePathLike(plainText)) {
                return plainText;
            }

            return null;
        };

        const moveCaretToClientPoint = (x, y) => {
            const selection = window.getSelection();
            if (!selection) return false;

            const pointRange = getCaretRangeFromPoint(x, y);
            if (pointRange && editor.contains(pointRange.startContainer)) {
                selection.removeAllRanges();
                selection.addRange(pointRange);
                return true;
            }

            return false;
        };

        const ensureSelectionAtEditorEnd = () => {
            const selection = window.getSelection();
            if (!selection) return false;

            const range = document.createRange();
            range.selectNodeContents(editor);
            range.collapse(false);
            selection.removeAllRanges();
            selection.addRange(range);
            return true;
        };

        const saveImageFileToWorkspace = (file) => {
            if (!file) return;

            const reader = new FileReader();
            reader.onload = (event) => {
                const dataUrl = event && event.target ? event.target.result : null;
                if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) {
                    return;
                }

                let mimeType = file.type || '';
                if (!mimeType) {
                    const match = dataUrl.match(/^data:([^;]+);/);
                    if (match) {
                        mimeType = match[1];
                    }
                }

                vscode.postMessage({
                    type: 'saveImage',
                    dataUrl: dataUrl,
                    mimeType: mimeType || 'image/png'
                });
            };

            reader.readAsDataURL(file);
        };

        // 画像のペースト・リンクのペースト
        editor.addEventListener('paste', (e) => {
            if (!isUpdating) {
                if (tableManager.handleEdgePaste(e)) {
                    return;
                }
                if (tableManager.handlePaste(e)) {
                    return;
                }
                const items = e.clipboardData.items;
                let hasImageFile = false;

                // 選択範囲があり、URLがペーストされた場合はリンクを作成
                const selection = window.getSelection();
                const pastedText = e.clipboardData.getData('text/plain');

                if (selection && !selection.isCollapsed && pastedText && isUrl(pastedText)) {
                    e.preventDefault();

                    const selectedText = selection.toString();
                    const range = selection.getRangeAt(0);

                    // リンク要素を作成
                    const link = document.createElement('a');
                    link.href = pastedText.trim();
                    link.textContent = selectedText;

                    // 選択範囲をリンクで置換
                    range.deleteContents();
                    range.insertNode(link);

                    // カーソルをリンクの後ろに移動
                    const newRange = document.createRange();
                    newRange.setStartAfter(link);
                    newRange.collapse(true);
                    selection.removeAllRanges();
                    selection.addRange(newRange);

                    stateManager.saveStateDebounced();
                    notifyChange();
                    return;
                }

                // URLがペーストされた場合（選択なし）、自動的にリンクを作成
                if (selection && selection.isCollapsed && pastedText && isUrl(pastedText)) {
                    const range = selection.getRangeAt(0);
                    const container = range.commonAncestorContainer;
                    const codeElement = domUtils.getParentElement(container, 'CODE');
                    if (!codeElement) {
                        e.preventDefault();

                        const url = pastedText.trim();
                        const link = document.createElement('a');
                        link.href = url;
                        link.textContent = url;

                        range.deleteContents();
                        range.insertNode(link);

                        // カーソルをリンクの後ろに移動
                        const newRange = document.createRange();
                        newRange.setStartAfter(link);
                        newRange.collapse(true);
                        selection.removeAllRanges();
                        selection.addRange(newRange);

                        stateManager.saveStateDebounced();
                        notifyChange();
                        return;
                    }
                }

                for (let i = 0; i < items.length; i++) {
                    if (items[i].type.indexOf('image') !== -1) {
                        hasImageFile = true;
                        e.preventDefault();

                        const file = items[i].getAsFile();
                        saveImageFileToWorkspace(file);
                        break;
                    }
                }

                if (!hasImageFile) {
                    setTimeout(() => {
                        domUtils.ensureInlineCodeSpaces();
                        domUtils.cleanupGhostStyles();
                        tableManager.wrapTables();
                        applyImageRenderSizes();
                        notifyChange();
                    }, 0);
                }
            }
        });

        // 画像上で右クリックしたらその画像を選択（Copy/Cutを使いやすくする）
        editor.addEventListener('contextmenu', (e) => {
            if (isUpdating) return;
            const image = e.target && e.target.closest ? e.target.closest('img') : null;
            if (!image || !editor.contains(image)) return;

            const selection = window.getSelection();
            if (!selection) return;
            const range = document.createRange();
            range.selectNode(image);
            selection.removeAllRanges();
            selection.addRange(range);

            hideLinkPopover(true);
            showImageResizeOverlay(image);
        });

        // 画像を含む選択のコピーを補助（右クリックコピー・範囲選択コピー対応）
        editor.addEventListener('copy', (e) => {
            if (isUpdating || e.defaultPrevented) return;
            const selection = window.getSelection();
            if (!selection || !selection.rangeCount) return;
            if (!selectionContainsImage(selection)) return;

            const payload = createClipboardPayloadFromSelection(selection);
            if (!payload || !e.clipboardData) return;

            e.preventDefault();
            if (payload.html) {
                e.clipboardData.setData('text/html', payload.html);
            }
            if (payload.text) {
                e.clipboardData.setData('text/plain', payload.text);
            } else {
                const fallbackText = selection.toString();
                if (fallbackText) {
                    e.clipboardData.setData('text/plain', fallbackText);
                }
            }
        });

        // 画像を含む選択のカットを補助（右クリックカット・範囲選択カット対応）
        editor.addEventListener('cut', (e) => {
            if (isUpdating || e.defaultPrevented) return;
            const selection = window.getSelection();
            if (!selection || !selection.rangeCount) return;
            if (!selectionContainsImage(selection)) return;

            const payload = createClipboardPayloadFromSelection(selection);
            if (!payload || !e.clipboardData) return;

            e.preventDefault();
            if (payload.html) {
                e.clipboardData.setData('text/html', payload.html);
            }
            if (payload.text) {
                e.clipboardData.setData('text/plain', payload.text);
            } else {
                const fallbackText = selection.toString();
                if (fallbackText) {
                    e.clipboardData.setData('text/plain', fallbackText);
                }
            }

            const range = selection.getRangeAt(0);
            stateManager.saveState();
            range.deleteContents();
            range.collapse(true);
            selection.removeAllRanges();
            selection.addRange(range);

            hideImageResizeOverlay();
            notifyChange();
        });

        // キーボードイベント
        editor.addEventListener('keydown', handleKeydown);

        // mousedownイベント - 箇条書きでのカーソル位置を修正（clickより先に実行）
        editor.addEventListener('mousedown', (e) => {
            if (isUpdating) return;
            pendingListMouseAdjustment = null;
            pendingMouseDriftCorrection = null;

            // 左クリックのみ処理
            if (e.button !== 0) return;
            lastPointerCaretIntentTs = Date.now();
            const pointerTarget = e.target;
            const pointerCheckbox = pointerTarget && pointerTarget.closest
                ? pointerTarget.closest('input[type="checkbox"]')
                : null;
            lastPointerCheckboxClickTs = (pointerCheckbox && editor.contains(pointerCheckbox))
                ? Date.now()
                : 0;

            if (tableManager.handleMouseDown(e)) {
                return;
            }

            // クリック位置を取得
            const x = e.clientX;
            const y = e.clientY;

            // クリック位置の要素を取得
            const clickedElement = document.elementFromPoint(x, y);
            if (!clickedElement || !editor.contains(clickedElement)) return;

            if (!e.shiftKey) {
                const imageRightEdgeRange = getRightEdgeImageCaretRangeFromClick(x, y, clickedElement);
                if (imageRightEdgeRange) {
                    e.preventDefault();
                    if (document.activeElement !== editor) {
                        try {
                            editor.focus({ preventScroll: true });
                        } catch (focusError) {
                            editor.focus();
                        }
                    }
                    const selection = window.getSelection();
                    if (!selection) return;
                    selection.removeAllRanges();
                    selection.addRange(imageRightEdgeRange);
                    return;
                }
            }

            const pointRange = getCaretRangeFromPoint(x, y);
            const stabilizedGapRange = getStableGapClickRange(x, y, clickedElement, pointRange);
            if (stabilizedGapRange) {
                e.preventDefault();
                const selection = window.getSelection();
                if (!selection) return;
                selection.removeAllRanges();
                selection.addRange(stabilizedGapRange);
                return;
            }

            if (clickedElement === editor) {
                pendingMouseDriftCorrection = {
                    startX: x,
                    startY: y,
                    moved: false,
                    clickedElement
                };
            }

            // 水平線がクリックされた場合、水平線全体を選択
            if (clickedElement.tagName === 'HR') {
                e.preventDefault();
                const hr = clickedElement;
                const selection = window.getSelection();
                const newRange = document.createRange();
                newRange.selectNode(hr);
                selection.removeAllRanges();
                selection.addRange(newRange);
                return;
            }

            // リストアイテム内かチェック
            const listItem = domUtils.getParentElement(clickedElement, 'LI');
            if (!listItem) return;

            // チェックボックス左側（マーカー領域）クリックは、
            // clickedElementがLI以外でもテキスト先頭にカーソルを配置する
            const checkboxAtStart = listItem.querySelector(':scope > input[type="checkbox"]');
            const clickedCheckbox = clickedElement && clickedElement.closest
                ? clickedElement.closest('input[type="checkbox"]')
                : null;
            if (!e.shiftKey &&
                checkboxAtStart &&
                checkboxAtStart.parentElement === listItem &&
                !(clickedCheckbox && clickedCheckbox === checkboxAtStart)) {
                const firstTextAfterCheckbox = getFirstDirectTextNodeAfterCheckbox(listItem);
                let markerThreshold = null;
                if (firstTextAfterCheckbox) {
                    const firstTextRange = document.createRange();
                    firstTextRange.selectNodeContents(firstTextAfterCheckbox);
                    const firstTextRect = firstTextRange.getBoundingClientRect();
                    if (firstTextRect && Number.isFinite(firstTextRect.left)) {
                        markerThreshold = firstTextRect.left - 2;
                    }
                }
                if (!Number.isFinite(markerThreshold)) {
                    const checkboxRect = checkboxAtStart.getBoundingClientRect
                        ? checkboxAtStart.getBoundingClientRect()
                        : null;
                    markerThreshold = checkboxRect && Number.isFinite(checkboxRect.right)
                        ? checkboxRect.right + 4
                        : null;
                }

                if (Number.isFinite(markerThreshold) && x < markerThreshold) {
                    let targetTextNode = firstTextAfterCheckbox;
                    if (!targetTextNode) {
                        const anchorNode = document.createTextNode('\u200B');
                        const firstSublist = Array.from(listItem.children).find(
                            child => child.tagName === 'UL' || child.tagName === 'OL'
                        );
                        if (firstSublist) {
                            listItem.insertBefore(anchorNode, firstSublist);
                        } else {
                            const nextNode = checkboxAtStart.nextSibling;
                            if (nextNode) {
                                listItem.insertBefore(anchorNode, nextNode);
                            } else {
                                listItem.appendChild(anchorNode);
                            }
                        }
                        targetTextNode = anchorNode;
                    }

                    const selection = window.getSelection();
                    if (!selection) return;
                    const newRange = document.createRange();
                    newRange.setStart(targetTextNode, getCheckboxTextMinOffset(listItem));
                    newRange.collapse(true);
                    e.preventDefault();
                    selection.removeAllRanges();
                    selection.addRange(newRange);
                    return;
                }
            }

            // テキスト要素自体をクリックした場合はブラウザ標準の配置を優先
            if (clickedElement !== listItem) return;

            // caretRangeFromPoint 互換APIでカーソル位置を取得
            const range = pointRange || getCaretRangeFromPoint(x, y);
            if (!range) return;

            const container = range.startContainer;

            // リストアイテムのテキスト部分（ネストされたリストを除く）のテキストノードを取得
            const textNodes = [];
            const walker = document.createTreeWalker(
                listItem,
                NodeFilter.SHOW_TEXT,
                {
                    acceptNode: function (node) {
                        // このテキストノードがネストされたリスト内にあるかチェック
                        let parent = node.parentElement;
                        while (parent && parent !== listItem) {
                            if (parent.tagName === 'UL' || parent.tagName === 'OL') {
                                return NodeFilter.FILTER_REJECT;
                            }
                            parent = parent.parentElement;
                        }
                        return node.textContent.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
                    }
                },
                false
            );

            let textNode;
            while (textNode = walker.nextNode()) {
                textNodes.push(textNode);
            }

            if (textNodes.length === 0) return;

            let newRange = null;
            let shouldApplyImmediately = false;

            // 行間クリック等で先頭へ強制ジャンプしないよう、左側のマーカー領域クリック時だけ補正する
            if (container.nodeType !== Node.TEXT_NODE || !textNodes.includes(container)) {
                const firstTextNode = textNodes[0];
                const firstTextRange = document.createRange();
                firstTextRange.selectNodeContents(firstTextNode);
                const firstTextRect = firstTextRange.getBoundingClientRect();
                const markerThreshold = firstTextRect.left - 2;

                if (x < markerThreshold) {
                    newRange = document.createRange();
                    newRange.setStart(firstTextNode, 0);
                    newRange.collapse(true);
                }
            } else {
                // テキストノード内をクリックした場合、クリック位置がテキストの範囲内かチェック
                const textRange = document.createRange();
                textRange.selectNodeContents(container);
                const textRect = textRange.getBoundingClientRect();

                // クリック位置がテキストの右側（範囲外）の場合、テキストの末尾に移動
                if (x > textRect.right) {
                    // 最後のテキストノードの末尾にカーソルを設定
                    const lastTextNode = textNodes[textNodes.length - 1];
                    newRange = document.createRange();
                    newRange.setStart(lastTextNode, lastTextNode.textContent.length);
                    newRange.collapse(true);
                    // mouseupまで待つと一瞬左端に出るため、右側余白クリックは即時適用する
                    shouldApplyImmediately = !e.shiftKey;
                }
            }

            // 右側余白クリックは即時適用し、左端→右端の一瞬のジャンプを防ぐ
            if (newRange) {
                if (shouldApplyImmediately) {
                    e.preventDefault();
                    const selection = window.getSelection();
                    if (!selection) return;
                    selection.removeAllRanges();
                    selection.addRange(newRange.cloneRange());
                    return;
                }

                // クリック候補を保持し、ドラッグしていない mouseup 時にのみ適用
                pendingListMouseAdjustment = {
                    listItem,
                    startX: x,
                    startY: y,
                    moved: false,
                    range: newRange.cloneRange()
                };
            }
        });

        document.addEventListener('mousemove', (e) => {
            if (pendingListMouseAdjustment) {
                if (Math.abs(e.clientX - pendingListMouseAdjustment.startX) > 3 ||
                    Math.abs(e.clientY - pendingListMouseAdjustment.startY) > 3) {
                    pendingListMouseAdjustment.moved = true;
                }
            }
            if (pendingMouseDriftCorrection) {
                if (Math.abs(e.clientX - pendingMouseDriftCorrection.startX) > 3 ||
                    Math.abs(e.clientY - pendingMouseDriftCorrection.startY) > 3) {
                    pendingMouseDriftCorrection.moved = true;
                }
            }
        });

        document.addEventListener('mouseup', (e) => {
            const pendingList = pendingListMouseAdjustment;
            pendingListMouseAdjustment = null;
            if (pendingList) {
                if (e.button === 0 && !pendingList.moved &&
                    pendingList.listItem && pendingList.listItem.isConnected && pendingList.range) {
                    const selection = window.getSelection();
                    if (selection && (!selection.rangeCount || selection.isCollapsed)) {
                        let canApply = true;
                        if (selection.rangeCount) {
                            const currentRange = selection.getRangeAt(0);
                            const currentListItem = domUtils.getParentElement(currentRange.startContainer, 'LI');
                            canApply = currentListItem === pendingList.listItem;
                        }
                        if (canApply) {
                            selection.removeAllRanges();
                            selection.addRange(pendingList.range.cloneRange());
                        }
                    }
                }
            }

            const pendingDrift = pendingMouseDriftCorrection;
            pendingMouseDriftCorrection = null;
            if (!pendingDrift) return;
            if (e.button !== 0 || pendingDrift.moved) return;
            if (pendingDrift.clickedElement !== editor) return;

            const selection = window.getSelection();
            if (!selection || !selection.rangeCount || !selection.isCollapsed) return;
            const currentRange = selection.getRangeAt(0);
            if (!editor.contains(currentRange.startContainer)) return;

            const currentRect = (cursorManager && typeof cursorManager._getCaretRect === 'function')
                ? cursorManager._getCaretRect(currentRange)
                : (currentRange.getClientRects && currentRange.getClientRects().length ? currentRange.getClientRects()[0] : null);
            const currentCenterY = currentRect ? (currentRect.top + currentRect.bottom) / 2 : null;
            if (currentCenterY === null) return;
            const driftTooLarge = Math.abs(currentCenterY - pendingDrift.startY) > 120;
            if (!driftTooLarge) return;

            const pointRange = getCaretRangeFromPoint(pendingDrift.startX, pendingDrift.startY);
            const stableRange =
                getStableGapClickRange(pendingDrift.startX, pendingDrift.startY, pendingDrift.clickedElement, pointRange) ||
                getNearestBlockBoundaryRangeByY(pendingDrift.startY);
            if (!stableRange) return;

            selection.removeAllRanges();
            selection.addRange(stableRange);
        });

        const suppressWorkbenchFileDrop = (e) => {
            if (isUpdating) return;
            if (!shouldInterceptExternalDrop(e.dataTransfer)) return;

            e.preventDefault();
            e.stopPropagation();
        };

        // WebView外側にドロップとして解釈されるとVSCodeが別タブで開くため抑止
        document.addEventListener('dragenter', suppressWorkbenchFileDrop);
        document.addEventListener('dragover', suppressWorkbenchFileDrop);
        document.addEventListener('drop', suppressWorkbenchFileDrop);

        editor.addEventListener('dragover', (e) => {
            if (isUpdating) return;
            if (!shouldInterceptExternalDrop(e.dataTransfer)) return;

            e.preventDefault();
            if (e.dataTransfer) {
                e.dataTransfer.dropEffect = 'copy';
            }
        });

        // ドラッグ&ドロップ画像の貼り付け
        editor.addEventListener('drop', (e) => {
            if (isUpdating) return;

            const imageFile = extractImageFileFromDataTransfer(e.dataTransfer);
            const imageUri = imageFile ? null : extractImageUriFromDataTransfer(e.dataTransfer);
            e.preventDefault();
            e.stopPropagation();
            if (!imageFile && !imageUri) return;

            editor.focus();

            const moved = moveCaretToClientPoint(e.clientX, e.clientY);
            if (!moved) {
                ensureSelectionAtEditorEnd();
            }

            if (imageFile) {
                saveImageFileToWorkspace(imageFile);
                return;
            }

            vscode.postMessage({
                type: 'saveImageFromUri',
                uri: imageUri
            });
        });

        // リンクポップオーバー
        let linkPopover = null;
        let currentLink = null;
        let imageResizeOverlay = null;
        let activeResizeImage = null;
        let imageResizeState = null;

        function createLinkPopover() {
            const popover = document.createElement('div');
            popover.className = 'link-popover';
            popover.innerHTML = `
                <input type="text" class="link-popover-input" placeholder="URL">
                <button class="link-popover-btn danger" data-action="unlink">Unlink</button>
                <button class="link-popover-btn primary" data-action="open">Open</button>
            `;
            document.body.appendChild(popover);
            return popover;
        }

        function showLinkPopover(link) {
            if (!linkPopover) {
                linkPopover = createLinkPopover();
            }

            currentLink = link;
            const input = linkPopover.querySelector('.link-popover-input');
            input.value = link.getAttribute('href') || '';

            // リンクの位置に合わせてポップオーバーを表示
            const rect = link.getBoundingClientRect();
            linkPopover.style.display = 'flex';
            linkPopover.style.top = `${rect.bottom + window.scrollY + 4}px`;
            linkPopover.style.left = `${rect.left + window.scrollX}px`;

            // 画面外にはみ出す場合は調整
            const popoverRect = linkPopover.getBoundingClientRect();
            if (popoverRect.right > window.innerWidth) {
                linkPopover.style.left = `${window.innerWidth - popoverRect.width - 8}px`;
            }

            // 入力フィールドにフォーカス
            setTimeout(() => input.select(), 0);
        }

        function saveLinkUrlIfChanged() {
            if (currentLink && linkPopover) {
                const input = linkPopover.querySelector('.link-popover-input');
                const newUrl = input.value.trim();
                const oldUrl = currentLink.getAttribute('href') || '';
                if (newUrl && newUrl !== oldUrl) {
                    currentLink.setAttribute('href', newUrl);
                    stateManager.saveStateDebounced();
                    notifyChange();
                }
            }
        }

        function hideLinkPopover(skipSave = false) {
            if (!skipSave) {
                saveLinkUrlIfChanged();
            }
            if (linkPopover) {
                linkPopover.style.display = 'none';
            }
            currentLink = null;
        }

        function unlinkLink() {
            if (currentLink) {
                const text = currentLink.textContent;
                const textNode = document.createTextNode(text);
                currentLink.parentNode.replaceChild(textNode, currentLink);
                stateManager.saveStateDebounced();
                notifyChange();
            }
            hideLinkPopover(true); // 保存をスキップ（リンク削除済み）
        }

        function openLink() {
            // 先にURLを保存してから開く
            saveLinkUrlIfChanged();
            if (currentLink) {
                const url = currentLink.getAttribute('href');
                if (url) {
                    vscode.postMessage({
                        type: 'openLink',
                        url: url
                    });
                }
            }
            hideLinkPopover(true); // 既に保存済み
        }

        function syncImageResizeOverlayPosition() {
            if (!imageResizeOverlay) return;
            if (!activeResizeImage || !activeResizeImage.isConnected || !editor.contains(activeResizeImage)) {
                imageResizeOverlay.style.display = 'none';
                activeResizeImage = null;
                return;
            }
            const rect = activeResizeImage.getBoundingClientRect();
            imageResizeOverlay.style.display = 'block';
            imageResizeOverlay.style.top = `${rect.top + window.scrollY}px`;
            imageResizeOverlay.style.left = `${rect.left + window.scrollX}px`;
            imageResizeOverlay.style.width = `${rect.width}px`;
            imageResizeOverlay.style.height = `${rect.height}px`;
        }

        function hideImageResizeOverlay() {
            if (imageResizeOverlay) {
                imageResizeOverlay.style.display = 'none';
            }
            activeResizeImage = null;
            imageResizeState = null;
            document.body.classList.remove('image-resizing');
        }

        function placeCaretAfterImageRemoval(parentNode, nextSibling, prevSibling) {
            const selection = window.getSelection();
            if (!selection || !parentNode) return;

            const range = document.createRange();
            if (nextSibling && nextSibling.parentNode === parentNode) {
                if (nextSibling.nodeType === Node.TEXT_NODE) {
                    range.setStart(nextSibling, 0);
                } else {
                    const firstText = domUtils.getFirstTextNode(nextSibling);
                    if (firstText) {
                        range.setStart(firstText, 0);
                    } else {
                        const offset = Array.prototype.indexOf.call(parentNode.childNodes, nextSibling);
                        range.setStart(parentNode, Math.max(0, offset));
                    }
                }
            } else if (prevSibling && prevSibling.parentNode === parentNode) {
                if (prevSibling.nodeType === Node.TEXT_NODE) {
                    range.setStart(prevSibling, (prevSibling.textContent || '').length);
                } else {
                    const lastText = domUtils.getLastTextNode(prevSibling);
                    if (lastText) {
                        range.setStart(lastText, (lastText.textContent || '').length);
                    } else {
                        const prevOffset = Array.prototype.indexOf.call(parentNode.childNodes, prevSibling);
                        range.setStart(parentNode, Math.max(0, prevOffset + 1));
                    }
                }
            } else if (parentNode === editor) {
                const paragraph = document.createElement('p');
                paragraph.appendChild(document.createElement('br'));
                editor.appendChild(paragraph);
                range.setStart(paragraph, 0);
            } else if (parentNode.nodeType === Node.ELEMENT_NODE) {
                const parentElement = parentNode;
                if (isEffectivelyEmptyBlock(parentElement) && parentElement.tagName === 'P') {
                    if (!parentElement.querySelector('br')) {
                        parentElement.appendChild(document.createElement('br'));
                    }
                    range.setStart(parentElement, 0);
                } else {
                    range.selectNodeContents(parentElement);
                    range.collapse(false);
                }
            } else {
                return;
            }

            range.collapse(true);
            selection.removeAllRanges();
            selection.addRange(range);
        }

        function deleteActiveResizeImage() {
            const image = activeResizeImage;
            if (!image || !image.isConnected || !editor.contains(image)) {
                hideImageResizeOverlay();
                return false;
            }

            let target = image;
            const parentLink = image.parentElement;
            if (parentLink && parentLink.tagName === 'A' && parentLink.childNodes.length === 1) {
                target = parentLink;
            }

            const parentNode = target.parentNode;
            if (!parentNode) {
                hideImageResizeOverlay();
                return false;
            }

            const nextSibling = target.nextSibling;
            const prevSibling = target.previousSibling;

            target.remove();
            hideImageResizeOverlay();
            editor.focus();
            placeCaretAfterImageRemoval(parentNode, nextSibling, prevSibling);
            scheduleEditorOverflowStateUpdate();
            return true;
        }

        function ensureImageResizeOverlay() {
            if (imageResizeOverlay) return imageResizeOverlay;

            const overlay = document.createElement('div');
            overlay.className = 'image-resize-overlay';
            overlay.setAttribute('data-exclude-from-markdown', 'true');
            ['nw', 'ne', 'sw', 'se'].forEach((corner) => {
                const handle = document.createElement('div');
                handle.className = `image-resize-handle ${corner}`;
                handle.setAttribute('data-corner', corner);
                overlay.appendChild(handle);
            });

            overlay.addEventListener('mousedown', (e) => {
                const handle = e.target && e.target.closest ? e.target.closest('.image-resize-handle') : null;
                if (!handle || !activeResizeImage) return;
                e.preventDefault();
                e.stopPropagation();

                const rect = activeResizeImage.getBoundingClientRect();
                const startWidth = rect.width;
                const startHeight = rect.height;
                const naturalWidth = activeResizeImage.naturalWidth || startWidth;
                const naturalHeight = activeResizeImage.naturalHeight || startHeight;
                const aspectRatio = (naturalWidth > 0 && naturalHeight > 0)
                    ? naturalWidth / naturalHeight
                    : (startWidth > 0 && startHeight > 0 ? startWidth / startHeight : 1);
                const corner = handle.getAttribute('data-corner') || 'se';

                imageResizeState = {
                    corner,
                    startX: e.clientX,
                    startY: e.clientY,
                    startWidth,
                    aspectRatio,
                    changed: false
                };
                document.body.classList.add('image-resizing');

                const onMouseMove = (moveEvent) => {
                    if (!imageResizeState || !activeResizeImage) return;
                    moveEvent.preventDefault();

                    const dx = moveEvent.clientX - imageResizeState.startX;
                    const dy = moveEvent.clientY - imageResizeState.startY;
                    const signX = imageResizeState.corner.includes('w') ? -1 : 1;
                    const signY = imageResizeState.corner.includes('n') ? -1 : 1;
                    const deltaX = dx * signX;
                    const deltaY = dy * signY;

                    const widthFromX = imageResizeState.startWidth + deltaX;
                    const widthFromY = imageResizeState.startWidth + (deltaY * imageResizeState.aspectRatio);
                    let targetWidth = Math.abs(deltaX) >= Math.abs(deltaY * imageResizeState.aspectRatio)
                        ? widthFromX
                        : widthFromY;

                    const minWidth = 40;
                    const maxWidth = Math.max(minWidth, getImageRenderMaxWidth());
                    targetWidth = Math.max(minWidth, Math.min(targetWidth, maxWidth));
                    const targetHeight = targetWidth / imageResizeState.aspectRatio;

                    setImageRenderSize(activeResizeImage, targetWidth, targetHeight);
                    imageResizeState.changed = true;
                    syncImageResizeOverlayPosition();
                };

                const onMouseUp = () => {
                    document.removeEventListener('mousemove', onMouseMove);
                    document.removeEventListener('mouseup', onMouseUp);
                    document.documentElement.removeEventListener('mouseleave', onMouseUp);
                    document.body.classList.remove('image-resizing');

                    const resized = !!(imageResizeState && imageResizeState.changed && activeResizeImage);
                    imageResizeState = null;

                    if (resized && activeResizeImage) {
                        if (syncImageAltSizeFromRenderedSize(activeResizeImage)) {
                            stateManager.saveStateDebounced();
                            notifyChange();
                        }
                    }
                    syncImageResizeOverlayPosition();
                };

                document.addEventListener('mousemove', onMouseMove);
                document.addEventListener('mouseup', onMouseUp);
                document.documentElement.addEventListener('mouseleave', onMouseUp);
            });

            document.body.appendChild(overlay);
            imageResizeOverlay = overlay;
            return overlay;
        }

        function showImageResizeOverlay(image) {
            if (!image || image.tagName !== 'IMG' || !editor.contains(image)) return;
            ensureImageResizeOverlay();
            activeResizeImage = image;
            syncImageResizeOverlayPosition();
        }

        window.addEventListener('resize', () => {
            syncImageResizeOverlayPosition();
            scheduleEditorOverflowStateUpdate();
        });

        document.addEventListener('keydown', (e) => {
            if (!activeResizeImage) return;

            const key = (e.key || '').toLowerCase();
            const isCtrlH = isMac && e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && key === 'h';
            const isBackspace = e.key === 'Backspace' && !e.metaKey && !e.altKey;
            if (!isBackspace && !isCtrlH) return;

            e.preventDefault();
            e.stopPropagation();
            stateManager.saveState();
            if (deleteActiveResizeImage()) {
                notifyChange();
            }
        }, true);

        // リンクのmousedownイベント（デフォルト動作を防ぐ）
        editor.addEventListener('mousedown', (e) => {
            const link = e.target.closest('a');
            if (link && editor.contains(link)) {
                // Command+クリック（Mac）またはCtrl+クリック（Windows/Linux）でリンクを開く
                if (e.metaKey || e.ctrlKey) {
                    e.preventDefault();
                    e.stopPropagation();
                    const url = link.getAttribute('href');
                    if (url) {
                        vscode.postMessage({
                            type: 'openLink',
                            url: url
                        });
                    }
                }
            }
        }, true);

        // コードブロック言語ラベルのクリックで編集開始
        editor.addEventListener('click', (e) => {
            const label = e.target && e.target.closest ? e.target.closest('.code-block-language') : null;
            if (label && editor.contains(label) && !label.classList.contains('editing')) {
                e.preventDefault();
                e.stopPropagation();
                if (typeof label.__startEditing === 'function') {
                    label.__startEditing();
                } else if (typeof label.click === 'function') {
                    label.click();
                }
            }
        }, true);

        // チェックボックスクリックイベント
        editor.addEventListener('click', (e) => {
            if (isUpdating) return;

            const checkbox = e.target;
            if (checkbox.tagName === 'INPUT' && checkbox.type === 'checkbox') {
                // Toggle checked state is handled by the browser automatically
                // Just notify the change
                stateManager.saveState();
                notifyChange();
            }
        });

        // リンククリックイベント
        editor.addEventListener('click', (e) => {
            if (isUpdating) return;

            const link = e.target.closest('a');
            if (link && editor.contains(link)) {
                e.preventDefault();
                e.stopPropagation();

                // Command+クリック時は既にmousedownで処理済み
                if (e.metaKey || e.ctrlKey) {
                    return;
                }

                hideImageResizeOverlay();
                showLinkPopover(link);
                return;
            }

            // ポップオーバー外をクリックしたら閉じる
            if (linkPopover && !linkPopover.contains(e.target)) {
                hideLinkPopover();
            }
        });

        // 画像クリックイベント（ドラッグリサイズ用ハンドル表示）
        editor.addEventListener('click', (e) => {
            if (isUpdating) return;

            const parentLink = e.target && e.target.closest ? e.target.closest('a') : null;
            if (parentLink && editor.contains(parentLink)) {
                return;
            }

            const image = e.target && e.target.closest ? e.target.closest('img') : null;
            if (image && editor.contains(image)) {
                e.preventDefault();
                e.stopPropagation();
                hideLinkPopover();
                showImageResizeOverlay(image);
                return;
            }
        });

        // 画像ダブルクリックで画像ファイルを別タブで開く
        editor.addEventListener('dblclick', (e) => {
            if (isUpdating) return;
            const image = e.target && e.target.closest ? e.target.closest('img') : null;
            if (!image || !editor.contains(image)) return;

            const src = image.getAttribute('src') || image.currentSrc;
            if (!src) return;

            e.preventDefault();
            e.stopPropagation();
            hideLinkPopover(true);
            hideImageResizeOverlay();
            vscode.postMessage({
                type: 'openImage',
                src
            });
        });

        // ポップオーバー内のボタンクリック
        document.addEventListener('click', (e) => {
            if (linkPopover) {
                const linkBtn = e.target.closest('.link-popover-btn');
                if (linkBtn && linkPopover.contains(linkBtn)) {
                    const action = linkBtn.dataset.action;
                    if (action === 'unlink') {
                        unlinkLink();
                    } else if (action === 'open') {
                        openLink();
                    }
                }
            }

            if (imageResizeOverlay && activeResizeImage) {
                const target = e.target;
                const clickedImage = target && target.closest ? target.closest('img') : null;
                const clickedActiveImage = clickedImage && clickedImage === activeResizeImage;
                const clickedOverlay = imageResizeOverlay.contains(target);
                if (!clickedActiveImage && !clickedOverlay) {
                    hideImageResizeOverlay();
                }
            }
        });

        // ポップオーバー内でEnter/Escapeキーで閉じる
        document.addEventListener('keydown', (e) => {
            if (activeResizeImage && e.key === 'Escape') {
                e.preventDefault();
                hideImageResizeOverlay();
                return;
            }
            if (linkPopover && linkPopover.style.display !== 'none') {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    hideLinkPopover(); // 自動保存される
                } else if (e.key === 'Escape') {
                    e.preventDefault();
                    hideLinkPopover();
                }
            }
        });

        // 水平線の選択状態を視覚的に反映 & チェックボックス付近のカーソル補正
        let isCorrectingCheckboxCursor = false;
        document.addEventListener('selectionchange', () => {
            // すべてのHRから選択状態を解除
            editor.querySelectorAll('hr.selected').forEach(hr => hr.classList.remove('selected'));

            // 現在選択されているHRがあれば選択状態にする
            const selectedHR = isHRSelected();
            if (selectedHR) {
                selectedHR.classList.add('selected');
            }

            // コードブロック言語ラベルの選択状態を反映
            setCodeBlockLanguageNavSelection(getSelectedCodeBlockLanguageLabel());

            // チェックボックスのフォーカス表示管理
            editor.querySelectorAll('input[type="checkbox"].cursor-on').forEach(cb => cb.classList.remove('cursor-on'));
            const cursorCheckbox = isCursorOnCheckbox();
            if (cursorCheckbox) {
                cursorCheckbox.classList.add('cursor-on');
            }

            // チェックボックス付近のカーソル補正
            // チェックボックスが先頭にある場合のみ適用
            if (isUpdating || isCorrectingCheckboxCursor) return;
            const sel = window.getSelection();
            if (!sel || !sel.rangeCount || !sel.isCollapsed) return;
            const range = sel.getRangeAt(0);
            const container = range.startContainer;
            const offset = range.startOffset;
            const pointerAdjustWindowMs = 450;
            const pointerRecent = Date.now() - lastPointerCaretIntentTs < pointerAdjustWindowMs;

            const placeCheckboxCaretAtTextStart = (li) => {
                if (!li || !hasCheckboxAtStart(li)) return false;
                let textNode = getFirstDirectTextNodeAfterCheckbox(li);
                if (!textNode) {
                    const checkbox = li.querySelector(':scope > input[type="checkbox"]');
                    if (!checkbox) return false;
                    const anchorNode = document.createTextNode('\u200B');
                    const firstSublist = Array.from(li.children).find(
                        child => child.tagName === 'UL' || child.tagName === 'OL'
                    );
                    if (firstSublist) {
                        li.insertBefore(anchorNode, firstSublist);
                    } else {
                        const nextNode = checkbox.nextSibling;
                        if (nextNode) {
                            li.insertBefore(anchorNode, nextNode);
                        } else {
                            li.appendChild(anchorNode);
                        }
                    }
                    textNode = anchorNode;
                }

                const minOffset = getCheckboxTextMinOffset(li);
                isCorrectingCheckboxCursor = true;
                const newRange = document.createRange();
                newRange.setStart(textNode, minOffset);
                newRange.collapse(true);
                sel.removeAllRanges();
                sel.addRange(newRange);
                setTimeout(() => { isCorrectingCheckboxCursor = false; }, 0);
                return true;
            };

            // カーソルがINPUT要素（チェックボックス）自体にある場合
            // → li, offset=0（チェックボックス位置）に移動
            if (container.nodeType === Node.ELEMENT_NODE && container.tagName === 'INPUT') {
                const li = container.parentElement;
                if (li && li.tagName === 'LI' && hasCheckboxAtStart(li)) {
                    if (pointerRecent && placeCheckboxCaretAtTextStart(li)) {
                        return;
                    }
                    isCorrectingCheckboxCursor = true;
                    const newRange = document.createRange();
                    newRange.setStart(li, 0);
                    newRange.collapse(true);
                    sel.removeAllRanges();
                    sel.addRange(newRange);
                    setTimeout(() => { isCorrectingCheckboxCursor = false; }, 0);
                    return;
                }
            }

            // カーソルが要素レベル（テキストノード以外）でli内にある場合
            if (container.nodeType === Node.ELEMENT_NODE && container.tagName === 'LI' && hasCheckboxAtStart(container)) {
                // offset === 0 はチェックボックス位置 → 補正しない
                if (offset === 0) {
                    if (pointerRecent && placeCheckboxCaretAtTextStart(container)) {
                        return;
                    }
                    tableManager.updateEdgeActive();
                    return;
                }
                // offset === 1 はチェックボックス直後 → テキスト先頭へ補正
                if (offset === 1) {
                    const textNode = getFirstDirectTextNodeAfterCheckbox(container);
                    if (textNode) {
                        const minOffset = getCheckboxTextMinOffset(container);
                        isCorrectingCheckboxCursor = true;
                        const newRange = document.createRange();
                        newRange.setStart(textNode, minOffset);
                        newRange.collapse(true);
                        sel.removeAllRanges();
                        sel.addRange(newRange);
                        setTimeout(() => { isCorrectingCheckboxCursor = false; }, 0);
                        return;
                    }
                }
            }

            // カーソルがテキストノード内でもチェックボックスli内の先頭空白位置にある場合
            if (container.nodeType === Node.TEXT_NODE) {
                const li = domUtils.getParentElement(container, 'LI');
                if (li && hasCheckboxAtStart(li)) {
                    const firstTN = getFirstDirectTextNodeAfterCheckbox(li);
                    if (container === firstTN) {
                        const minOffset = getCheckboxTextMinOffset(li);
                        if (offset < minOffset) {
                            isCorrectingCheckboxCursor = true;
                            const newRange = document.createRange();
                            newRange.setStart(firstTN, minOffset);
                            newRange.collapse(true);
                            sel.removeAllRanges();
                            sel.addRange(newRange);
                            setTimeout(() => { isCorrectingCheckboxCursor = false; }, 0);
                            return;
                        }
                    }
                }
            }

            tableManager.updateEdgeActive();
        });

        document.addEventListener('selectionchange', () => {
            if (isUpdating) {
                hideSlashCommandMenu();
                return;
            }
            updateSlashCommandMenu();
            scheduleEnsureCaretVisible();
        });

        scheduleEditorOverflowStateUpdate();
    }

    // 初期化
    function init() {
        toolbarManager.setup();
        tableManager.setup({ notifyChange });
        setupEditor();
        tableManager.wrapTables();
        tocManager.setup();

        vscode.postMessage({ type: 'ready' });
    }

    // VSCodeからのメッセージ処理
    window.addEventListener('message', event => {
        const message = event.data;

        switch (message.type) {
            case 'init':
                isUpdating = true;
                editor.innerHTML = message.content;
                isUpdating = false;
                scheduleEditorOverflowStateUpdate();
                normalizeCheckboxListItems();
                applyImageRenderSizes();
                setTimeout(() => {
                    try {
                        domUtils.ensureInlineCodeSpaces();
                        domUtils.cleanupGhostStyles();
                        tableManager.ensureInsertLines();
                        tableManager.wrapTables();
                        applyImageRenderSizes();
                        updateListItemClasses();
                        stateManager.saveState();
                    } catch (error) {
                        console.error('Error in saveState:', error);
                    }
                    tocManager.update();
                    codeBlockManager.highlightCodeBlocks();
                    scheduleEditorOverflowStateUpdate();
                }, 100);
                break;
            case 'update':
                if (!editor.contains(document.activeElement)) {
                    isUpdating = true;
                    const scrollTop = editor.scrollTop;
                    editor.innerHTML = message.content;
                    editor.scrollTop = scrollTop;
                    isUpdating = false;
                    normalizeCheckboxListItems();
                    domUtils.ensureInlineCodeSpaces();
                    domUtils.cleanupGhostStyles();
                    tableManager.ensureInsertLines();
                    tableManager.wrapTables();
                    applyImageRenderSizes();
                    updateListItemClasses();
                    tocManager.update();
                    codeBlockManager.highlightCodeBlocks();
                    scheduleEditorOverflowStateUpdate();
                }
                break;
            case 'refresh':
                isUpdating = true;
                const scrollTopRefresh = editor.scrollTop;
                editor.innerHTML = message.content;
                editor.scrollTop = scrollTopRefresh;
                isUpdating = false;
                normalizeCheckboxListItems();
                tableManager.ensureInsertLines();
                tableManager.wrapTables();
                applyImageRenderSizes();
                updateListItemClasses();
                tocManager.update();
                codeBlockManager.highlightCodeBlocks();
                scheduleEditorOverflowStateUpdate();
                break;
            case 'settings':
                applySettings(message.settings);
                break;
            case 'insertImage':
                {
                    const selection = window.getSelection();
                    if (selection && selection.rangeCount === 0) {
                        const fallbackRange = document.createRange();
                        fallbackRange.selectNodeContents(editor);
                        fallbackRange.collapse(false);
                        selection.removeAllRanges();
                        selection.addRange(fallbackRange);
                    }
                    if (selection && selection.rangeCount > 0) {
                        const range = selection.getRangeAt(0);
                        const img = document.createElement('img');
                        img.src = message.src;
                        img.alt = 'image';
                        applyImageRenderSizeFromAlt(img);

                        const isCollapsedTextCaret = (() => {
                            if (!selection.isCollapsed) return false;
                            const container = range.startContainer;
                            if (container.nodeType === Node.TEXT_NODE) {
                                return true;
                            }
                            if (container.nodeType !== Node.ELEMENT_NODE) {
                                return false;
                            }
                            if (container === editor) {
                                return false;
                            }
                            const block = domUtils.isBlockElement(container)
                                ? container
                                : (() => {
                                    let current = container.parentElement;
                                    while (current && current !== editor && !domUtils.isBlockElement(current)) {
                                        current = current.parentElement;
                                    }
                                    return current;
                                })();
                            if (!block || block === editor) {
                                return false;
                            }
                            const meaningfulText = (block.textContent || '').replace(/[\u200B\u00A0]/g, '').trim();
                            return meaningfulText.length > 0;
                        })();

                        if (isCollapsedTextCaret) {
                            let block = range.startContainer.nodeType === Node.ELEMENT_NODE
                                ? range.startContainer
                                : range.startContainer.parentElement;
                            while (block && block !== editor && !domUtils.isBlockElement(block)) {
                                block = block.parentElement;
                            }

                            if (block && block !== editor && block.parentNode) {
                                const imageParagraph = document.createElement('p');
                                imageParagraph.appendChild(img);

                                if (block.nextSibling) {
                                    block.parentNode.insertBefore(imageParagraph, block.nextSibling);
                                } else {
                                    block.parentNode.appendChild(imageParagraph);
                                }

                                const newRange = document.createRange();
                                newRange.setStartAfter(imageParagraph);
                                newRange.collapse(true);
                                selection.removeAllRanges();
                                selection.addRange(newRange);

                                notifyChange();
                                break;
                            }
                        }

                        range.deleteContents();
                        range.insertNode(img);

                        range.setStartAfter(img);
                        range.collapse(true);
                        selection.removeAllRanges();
                        selection.addRange(range);

                        notifyChange();
                    }
                }
                break;
            case 'tableCommand':
                tableManager.executeTableCommand(message.command);
                break;
            case 'cursorMove':
                if (message.direction === 'up') {
                    if (shouldSuppressCommandNav('up')) {
                        break;
                    }
                    if (moveSlashCommandSelection(-1)) {
                        recordCtrlNavHandled('up', true);
                        break;
                    }
                    if (!shouldSuppressCommandNav('up')) {
                        handleEmacsNavKeydown(createCommandNavEvent('up'));
                        setTimeout(() => correctCheckboxCursorPosition(), 0);
                    }
                }
                if (message.direction === 'down') {
                    if (shouldSuppressCommandNav('down')) {
                        break;
                    }
                    if (moveSlashCommandSelection(1)) {
                        recordCtrlNavHandled('down', true);
                        break;
                    }
                    if (!shouldSuppressCommandNav('down')) {
                        handleEmacsNavKeydown(createCommandNavEvent('down'));
                        setTimeout(() => correctCheckboxCursorPosition(), 0);
                    }
                }
                break;
        }
    });

    // DOM準備完了時に初期化
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();

// Made with Bob
