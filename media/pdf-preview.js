import { createPdfPreviewRuntime } from './modules/PdfPreviewWorkers.js';
import { PdfThumbnails } from './modules/PdfThumbnails.js';
import { PdfPageBreakControls } from './modules/PdfPageBreakControls.js';

const vscode = acquireVsCodeApi();
const element = id => document.getElementById(id);
const pages = element('pages');
const assets = document.body.dataset.assets.replace(/\/?$/, '/');
const viewerStartedAt = performance.now();
const runtime = createPdfPreviewRuntime(assets);
const library = runtime.ready;
// A load failure is reported in the panel, even before a PDF arrives.
library.catch(() => {
    const message = 'PDF viewer could not load. Refresh the preview.';
    viewerError = message;
    element('status').textContent = message;
    if (element('empty')) element('empty').textContent = message;
    updateLoadingState();
});
let state = null;
let viewerError = '';
let hasDisplayedPreview = false;
let pdf = null;
let loadingTask = null;
let observer = null;
let generation = 0;
let currentPdfKey = '';
let documentIdentity = null;
let acknowledgedPdfKey = '';
let firstVisiblePage = 1;
let pageSize = null;
let pageNodes = [];
let boundaries = [];
let displayedBreaks = new Set();
let renderedScale = 1;
let editingBreaks = false;
let pendingScrollAnchor = null;
let awaitingAdjustment = false;
let pendingFocusBoundary = null;
let breakFeedback = null;
let feedbackTimer = null;
const tasks = new Map();
const rendered = new Set();
const breakControls = new PdfPageBreakControls((id, enabled) => {
    if (canEditBreaks()) adjust('break', { id, enabled });
});
const thumbnails = new PdfThumbnails(element('thumbnails'), {
    navigate: jumpToPage,
    pageCanvas: number => rendered.has(number) ? pageNodes[number - 1]?.querySelector('canvas') : null,
});

function syncPageNavigation(number = currentPageNumber()) {
    const input = element('page-number');
    input.disabled = !pdf;
    input.max = String(pdf?.numPages || 1);
    if (document.activeElement !== input) input.value = String(number);
    element('previous-page').disabled = !pdf || number <= 1;
    element('next-page').disabled = !pdf || number >= pdf.numPages;
}

function syncZoomControls() {
    element('zoom-out').disabled = !pdf || renderedScale <= .25;
    element('zoom-in').disabled = !pdf || renderedScale >= 2;
    element('zoom-actual').disabled = !pdf;
    element('zoom-fit').disabled = !pdf;
    element('zoom-fit').setAttribute('aria-pressed', String(element('zoom').value === 'fit'));
    element('zoom-actual').setAttribute('aria-pressed', String(element('zoom').value === '1'));
    const label = pdf ? `${Math.round(renderedScale * 100)}%` : '—';
    element('zoom-level').textContent = label;
    element('zoom').title = `Zoom level: ${label}. Choose a preset.`;
}

function zoomTo(value) {
    if (!pdf || !pageSize) return;
    element('zoom').value = String(value);
    installPages();
}

function stepZoom(direction) {
    const steps = [.25, .5, .75, 1, 1.25, 1.5, 1.75, 2];
    const target = direction > 0 ? steps.find(value => value > renderedScale + .001)
        : [...steps].reverse().find(value => value < renderedScale - .001);
    if (target !== undefined) zoomTo(target);
}

function commitPageNumber() {
    if (!pdf) return;
    const input = element('page-number');
    const number = Number(input.value);
    if (Number.isInteger(number) && input.value.trim()) {
        const target = Math.max(1, Math.min(pdf.numPages, number));
        input.value = String(target);
        jumpToPage(target);
    } else input.value = String(currentPageNumber());
}

function currentPageNumber() {
    if (!pageNodes.length) return 1;
    const viewport = pages.getBoundingClientRect();
    let low = 0, high = pageNodes.length;
    // Find visible pages without walking an entire long document on scroll.
    while (low < high) {
        const middle = (low + high) >>> 1;
        if (pageNodes[middle].getBoundingClientRect().bottom <= viewport.top) low = middle + 1;
        else high = middle;
    }
    // The page touching the viewport's top edge is current. In a page gap,
    // use the following page; before/after the document, clamp to its ends.
    return Math.min(low + 1, pageNodes.length);
}

function updatePageEndSpacing() {
    const last = pageNodes.at(-1);
    // Even a short last page must be able to reach the top when navigated to.
    if (last) last.style.marginBottom = `${Math.max(40, pages.clientHeight - last.offsetHeight - 38)}px`;
}

function jumpToPage(number) {
    if (!pdf || !pageNodes[number - 1]) return;
    const holder = pageNodes[number - 1];
    pages.scrollTop += holder.getBoundingClientRect().top - pages.getBoundingClientRect().top - 38;
    thumbnails.selectPage(number);
    syncPageNavigation(number);
    firstVisiblePage = number;
    const token = generation;
    if (!rendered.has(number)) thumbnails.suspend();
    void renderPage(number, token).then(() => {
        if (token === generation) thumbnails.resume();
    }).catch(error => reportPageError(error, token));
}

function send(type, extra = {}) {
    vscode.postMessage({ type, sessionId: state?.sessionId, revision: state?.revision, ...extra });
}

function adjust(type, extra = {}) {
    if (awaitingAdjustment || !state || state.stale || state.reloading || state.saving) return;
    if (['break', 'resetBreaks', 'undo', 'redo'].includes(type) && !canEditBreaks()) return;
    pendingScrollAnchor = captureScrollAnchor(extra.id);
    pendingFocusBoundary = extra.id || document.activeElement?.closest('[data-boundary-focus]')?.dataset.boundaryFocus || null;
    clearBreakFeedback();
    if (type === 'break' || type === 'resetBreaks') {
        breakFeedback = { sessionId: state.sessionId, revision: state.revision + 1, id: extra.id,
            message: type === 'resetBreaks' ? 'Page breaks cleared.' : extra.enabled ? 'Page break added.' : 'Page break removed.',
            complete: false };
    }
    awaitingAdjustment = true;
    element('export').disabled = true;
    updateEditingState();
    renderGuides();
    send(type, extra);
}

function clearBreakFeedback() {
    clearTimeout(feedbackTimer);
    feedbackTimer = null;
    breakFeedback = null;
    element('break-feedback').hidden = true;
}

function syncBreakFeedback() {
    if (!breakFeedback) return;
    if (!editingBreaks || state?.stale || state?.reloading || state?.error ||
        state?.sessionId !== breakFeedback.sessionId || state.revision > breakFeedback.revision) {
        clearBreakFeedback();
        return;
    }
    const ready = canEditBreaks() && state.revision === breakFeedback.revision;
    element('break-feedback').hidden = !ready;
    element('break-feedback-text').textContent = ready ? breakFeedback.message : 'Updating preview…';
    element('undo-break').disabled = !ready || !state.canUndo;
    if (ready && !breakFeedback.complete) {
        breakFeedback.complete = true;
        feedbackTimer = setTimeout(clearBreakFeedback, 6000);
    }
}

function showState(next) {
    awaitingAdjustment = false;
    state = next;
    element('export').disabled = !next.canExport;
    element('stale').hidden = !next.stale;
    element('reload').disabled = next.reloading || next.saving;
    element('reload-latest').disabled = next.reloading || next.saving;
    element('reload').classList.toggle('is-stale', next.stale);
    element('document-name').textContent = next.documentName || '';
    element('document-name').title = next.documentName || '';
    element('error').hidden = !next.error;
    element('error').querySelector('span').textContent = next.error || '';
    element('status').textContent = viewerError || (next.saving ? 'Saving…'
        : next.stale ? 'Document changed'
            : next.busy ? 'Preparing PDF…'
                : next.canExport ? ''
                    : next.error ? 'PDF needs attention' : 'Loading preview…');
    if (element('empty')) element('empty').textContent = next.error || viewerError ||
        (next.stale && !next.reloading ? 'Refresh the preview to see your changes.' : '');
    const disabled = !next.layout || next.reloading || next.saving || next.stale;
    for (const id of ['paper', 'orientation', 'margin', 'font-size', 'page-numbers']) element(id).disabled = disabled;
    if (next.layout) {
        element('paper').value = next.layout.paper;
        element('orientation').value = next.layout.landscape ? 'landscape' : 'portrait';
        element('margin').value = next.layout.margin;
        element('font-size').value = next.layout.fontSize;
        element('page-numbers').checked = next.layout.pageNumbers;
    }
    const count = next.breaks.length;
    element('break-count').textContent = count ? `${count} manual break${count === 1 ? '' : 's'}` : 'No manual breaks';
    element('warnings').hidden = !next.warnings.length;
    element('warnings').querySelector('summary').textContent = `${next.warnings.length} output notice${next.warnings.length === 1 ? '' : 's'}`;
    element('warnings').querySelector('ul').replaceChildren(...next.warnings.map(warning => {
        const item = document.createElement('li'); item.textContent = warning; return item;
    }));
    element('break-panel').disabled = !next.layout;
    updateEditingState();
    renderGuides();
}

function canEditBreaks() {
    return !!state && state.canExport && !awaitingAdjustment && !state.busy && !state.reloading && !state.saving && !state.stale &&
        documentIdentity?.sessionId === state.sessionId && documentIdentity?.revision === state.revision;
}

function updateLoadingState() {
    const failed = !!viewerError || !!state?.error;
    const preparing = !failed && !state?.saving && (!state?.stale || state?.reloading) &&
        (!state || awaitingAdjustment || state.busy || state.reloading || !state.canExport);
    const loading = element('preview-loading');
    loading.hidden = !preparing;
    loading.classList.toggle('is-refreshing', hasDisplayedPreview);
    element('preview-loading-label').textContent = !state || awaitingAdjustment || state.busy || state.reloading
        ? 'Preparing PDF…' : 'Loading preview…';
    element('activity-indicator').hidden = failed || !(preparing || state?.saving && !state?.stale);
    element('status').parentElement.setAttribute('aria-live', preparing ? 'off' : 'polite');
    pages.setAttribute('aria-busy', String(!!preparing));
}

function updateEditingState() {
    element('break-panel').setAttribute('aria-pressed', String(editingBreaks));
    element('break-tools').hidden = !editingBreaks;
    pages.classList.toggle('editing-breaks', editingBreaks);
    pages.classList.toggle('breaks-pending', !canEditBreaks());
    updatePageEndSpacing();
    updateLoadingState();
    element('undo').disabled = !canEditBreaks() || !state.canUndo;
    element('redo').disabled = !canEditBreaks() || !state.canRedo;
    element('reset-breaks').disabled = !canEditBreaks() || !state.breaks.length;
    syncBreakFeedback();
}

function setEditingBreaks(enabled) {
    editingBreaks = enabled;
    if (!enabled) { pendingFocusBoundary = null; clearBreakFeedback(); }
    element('layout-panel').open = false;
    updateEditingState();
    renderGuides();
    syncPageNavigation();
}

function boundaryPosition(boundary, factor = renderedScale) {
    const rect = [...pageSize.convertToViewportPoint(boundary.rect[0], boundary.rect[1]),
        ...pageSize.convertToViewportPoint(boundary.rect[2], boundary.rect[3])];
    return { left: Math.min(rect[0], rect[2]) * factor,
        top: Math.max(8, (Math.min(rect[1], rect[3]) - 5) * factor),
        width: Math.abs(rect[2] - rect[0]) * factor };
}

function captureScrollAnchor(preferred) {
    if (!pageSize || !pageNodes.length) return null;
    const viewportTop = pages.getBoundingClientRect().top;
    const candidates = boundaries.filter(boundary => pageNodes[boundary.page - 1]).map(boundary => ({ id: boundary.id,
        offset: pageNodes[boundary.page - 1].getBoundingClientRect().top + boundaryPosition(boundary).top - viewportTop,
        scrollTop: pages.scrollTop }));
    return candidates.find(anchor => anchor.id === preferred) || candidates.sort((a, b) => Math.abs(a.offset - 70) - Math.abs(b.offset - 70))[0] || null;
}

function renderGuides() {
    const focused = document.activeElement?.closest('[data-boundary-focus]')?.dataset.boundaryFocus || pendingFocusBoundary;
    if (!editingBreaks || !pageSize || !state || documentIdentity?.sessionId !== state.sessionId) {
        breakControls.clear(pageNodes);
        return;
    }
    breakControls.render({ pageNodes, boundaries, blocks: state.blocks, breaks: displayedBreaks,
        position: boundaryPosition, enabled: canEditBreaks(), pendingId: breakFeedback?.complete ? null : breakFeedback?.id });
    if (focused) pendingFocusBoundary = focused;
    focusPendingBoundary();
}

function focusPendingBoundary() {
    if (!pendingFocusBoundary || !canEditBreaks()) return;
    const guide = pages.querySelector(`.page-rendered [data-boundary-focus="${CSS.escape(pendingFocusBoundary)}"]`);
    if (guide) {
        // Focus the position, not Remove: a second Enter must not undo insertion.
        guide.focus({ preventScroll: true });
        pendingFocusBoundary = null;
    } else {
        const boundary = boundaries.find(item => item.id === pendingFocusBoundary);
        if (boundary?.atPageStart && pageNodes[boundary.page - 1]?.classList.contains('page-rendered')) {
            pages.focus({ preventScroll: true });
            pendingFocusBoundary = null;
        }
    }
}

function cancelPages() {
    thumbnails.suspend();
    observer?.disconnect();
    for (const task of tasks.values()) task.cancel();
    tasks.clear();
    rendered.clear();
}

function scale() {
    const style = window.getComputedStyle(pages);
    const padding = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight) + 8;
    return element('zoom').value === 'fit' ? Math.max(.25, (pages.clientWidth - padding) / pageSize.width) : Number(element('zoom').value);
}

async function renderPage(number, token) {
    if (!pdf || token !== generation || rendered.has(number)) return;
    if (tasks.has(number)) return tasks.get(number).promise;
    const current = pdf;
    const page = await current.getPage(number);
    if (token !== generation || current !== pdf) return;
    if (tasks.has(number)) return tasks.get(number).promise;
    const viewport = page.getViewport({ scale: scale() });
    const outputScale = Math.min(window.devicePixelRatio || 1, 2);
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width * outputScale);
    canvas.height = Math.ceil(viewport.height * outputScale);
    canvas.setAttribute('aria-label', `Page ${number}`);
    const holder = pageNodes[number - 1];
    holder.querySelector('canvas')?.remove();
    holder.appendChild(canvas);
    const task = page.render({ canvasContext: canvas.getContext('2d'), viewport,
        transform: outputScale === 1 ? null : [outputScale, 0, 0, outputScale, 0, 0], background: '#ffffff' });
    tasks.set(number, task);
    try {
        await task.promise;
        if (token === generation) {
            rendered.add(number);
            holder.classList.add('page-rendered');
            hasDisplayedPreview = true;
            updateLoadingState();
            focusPendingBoundary();
            if (number === firstVisiblePage && acknowledgedPdfKey !== currentPdfKey &&
                documentIdentity?.sessionId === state?.sessionId && documentIdentity?.revision === state?.revision) {
                acknowledgedPdfKey = currentPdfKey;
                send('displayed', documentIdentity);
                console.info('[ManulDown PDF] First page displayed', { elapsedMs: Math.round(performance.now() - viewerStartedAt) });
            }
        }
    } finally {
        if (tasks.get(number) === task) tasks.delete(number);
    }
}

function reportPageError(error, token) {
    if (token === generation && error.name !== 'RenderingCancelledException') {
        viewerError = 'Could not display the PDF.';
        element('status').textContent = viewerError;
        updateLoadingState();
        send('displayError', documentIdentity || {});
    }
}

function installPages(scrollTop = pages.scrollTop, anchor = captureScrollAnchor()) {
    const token = ++generation;
    cancelPages();
    const factor = scale();
    renderedScale = factor;
    pageNodes = Array.from({ length: pdf.numPages }, (_, index) => {
        const holder = document.createElement('div');
        holder.className = 'pdf-page';
        holder.style.width = `${pageSize.width * factor}px`;
        holder.style.height = `${pageSize.height * factor}px`;
        holder.dataset.page = String(index + 1);
        const caption = document.createElement('span');
        caption.className = 'page-caption';
        caption.textContent = `${index + 1} / ${pdf.numPages}`;
        holder.appendChild(caption);
        return holder;
    });
    pages.replaceChildren(...pageNodes);
    updatePageEndSpacing();
    pages.scrollTop = scrollTop;
    let anchoredPage = null;
    if (anchor && Math.abs(anchor.scrollTop - scrollTop) < 3) {
        const boundary = boundaries.find(item => item.id === anchor.id);
        const holder = boundary && pageNodes[boundary.page - 1];
        if (holder) {
            const offset = holder.getBoundingClientRect().top + boundaryPosition(boundary).top - pages.getBoundingClientRect().top;
            pages.scrollTop += offset - anchor.offset;
            if (anchor.offset >= 0 && anchor.offset < pages.clientHeight) anchoredPage = boundary.page;
        }
    }
    updateEditingState();
    renderGuides();
    firstVisiblePage = anchoredPage || Math.min(pdf.numPages, Math.max(1, Math.floor(pages.scrollTop / (pageSize.height * factor + 40)) + 1));
    thumbnails.selectPage(currentPageNumber());
    syncPageNavigation();
    syncZoomControls();
    // Show the requested page before spending CPU/bitmaps on adjacent pages.
    // The display acknowledgement belongs to renderPage, so a resize during
    // first load can cancel and restart rendering without losing it forever.
    void renderPage(firstVisiblePage, token).then(() => {
        if (token !== generation) return;
        thumbnails.resume();
        observer = new window.IntersectionObserver(entries => {
            for (const entry of entries) if (entry.isIntersecting) {
                void renderPage(Number(entry.target.dataset.page), token).catch(error => reportPageError(error, token));
            }
        }, { root: pages, rootMargin: '800px' });
        for (const holder of pageNodes) observer.observe(holder);
    }).catch(error => reportPageError(error, token));
    return token;
}

async function showPdf(message) {
    if (!state || message.sessionId !== state.sessionId || message.revision !== state.revision) return;
    const key = `${message.sessionId}:${message.revision}`;
    if (key === currentPdfKey) return;
    currentPdfKey = key;
    ++generation;
    cancelPages();
    const anchor = pendingScrollAnchor || captureScrollAnchor();
    const oldLoading = loadingTask;
    loadingTask = null;
    pdf = null;
    viewerError = '';
    updateLoadingState();
    syncPageNavigation();
    syncZoomControls();
    await oldLoading?.destroy();
    try {
        const pdfjs = await library;
        if (currentPdfKey !== key) return;
        const data = Uint8Array.from(window.atob(message.data), character => character.charCodeAt(0));
        const task = pdfjs.getDocument({ data, isEvalSupported: false, enableXfa: false,
            useWorkerFetch: false, cMapUrl: `${assets}cmaps/`, cMapPacked: true,
            standardFontDataUrl: `${assets}standard_fonts/`, wasmUrl: `${assets}wasm/` });
        loadingTask = task;
        const loaded = await task.promise;
        if (currentPdfKey !== key || state.sessionId !== message.sessionId || state.revision !== message.revision) {
            await task.destroy(); return;
        }
        pdf = loaded;
        documentIdentity = { sessionId: message.sessionId, revision: message.revision };
        pageSize = (await pdf.getPage(1)).getViewport({ scale: 1 });
        boundaries = Array.isArray(message.boundaries) ? message.boundaries : [];
        displayedBreaks = new Set(state.breaks);
        element('page-count').textContent = `/ ${pdf.numPages}`;
        element('page-count').setAttribute('aria-label', `${pdf.numPages} pages`);
        element('thumbnail-count').textContent = String(pdf.numPages);
        thumbnails.setDocument(pdf, pageSize);
        // A user can scroll while printing; respect that newer position.
        installPages(pages.scrollTop, anchor);
        pendingScrollAnchor = null;
    } catch (error) {
        if (currentPdfKey === key) {
            currentPdfKey = '';
            viewerError = 'Could not display the PDF.';
            element('status').textContent = viewerError;
            updateLoadingState();
            send('displayError', { sessionId: message.sessionId, revision: message.revision });
            console.error('PDF preview:', error);
        }
    }
}

window.addEventListener('message', event => {
    if (event.data?.type === 'state') showState(event.data);
    if (event.data?.type === 'pdf') void showPdf(event.data);
});
for (const id of ['paper', 'orientation', 'margin', 'font-size', 'page-numbers']) {
    element(id).addEventListener('change', () => adjust('layout', { layout: {
        paper: element('paper').value, landscape: element('orientation').value === 'landscape',
        margin: element('margin').value, fontSize: element('font-size').value, pageNumbers: element('page-numbers').checked,
    } }));
}
for (const id of ['undo', 'redo', 'reset-breaks']) element(id).addEventListener('click', () => adjust(id === 'reset-breaks' ? 'resetBreaks' : id));
element('undo-break').addEventListener('click', () => {
    if (breakFeedback?.complete && canEditBreaks() && state.canUndo) adjust('undo');
});
element('export').addEventListener('click', () => { element('export').disabled = true; send('export'); });
for (const id of ['reload', 'reload-latest']) element(id).addEventListener('click', () => {
    element('export').disabled = true; send('reload');
});
element('settings').addEventListener('click', () => send('settings'));
element('toggle-thumbnails').addEventListener('click', () => {
    const button = element('toggle-thumbnails');
    const anchor = captureScrollAnchor();
    const visible = button.getAttribute('aria-expanded') !== 'true';
    element('thumbnail-panel').hidden = !visible;
    button.setAttribute('aria-expanded', String(visible));
    const label = visible ? 'Hide thumbnails' : 'Show thumbnails';
    button.setAttribute('aria-label', label);
    button.title = label;
    thumbnails.setVisible(visible);
    if (pdf && pageSize && element('zoom').value === 'fit') installPages(pages.scrollTop, anchor);
});
element('break-panel').addEventListener('click', () => {
    setEditingBreaks(!editingBreaks);
});
element('finish-breaks').addEventListener('click', () => {
    setEditingBreaks(false);
    element('break-panel').focus({ preventScroll: true });
});
document.addEventListener('pointerdown', event => {
    if (!element('layout-panel').contains(event.target)) element('layout-panel').open = false;
});
document.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
        if (element('layout-panel').open) {
            element('layout-panel').open = false;
            element('layout-panel').querySelector('summary').focus();
        } else if (editingBreaks) {
            setEditingBreaks(false);
            element('break-panel').focus();
        }
        event.preventDefault();
    }
    if (event.target.matches('input,select,textarea,[contenteditable=true]')) return;
    const key = event.key.toLowerCase();
    if (!event.metaKey && !event.ctrlKey && !event.altKey) {
        if (key === '+' || key === '=') stepZoom(1);
        else if (key === '-') stepZoom(-1);
        else if (key === '0') zoomTo(1);
        else if (key === 'f') zoomTo('fit');
        else return;
        event.preventDefault();
        return;
    }
    if (!editingBreaks || !(event.metaKey || event.ctrlKey) || event.altKey) return;
    const direction = key === 'z' ? event.shiftKey ? 'redo' : 'undo' : key === 'y' ? 'redo' : null;
    if (direction) {
        event.preventDefault();
        if (!element(direction).disabled) adjust(direction);
    }
});
element('zoom').addEventListener('change', () => { if (pdf && pageSize) installPages(); });
element('zoom-in').addEventListener('click', () => stepZoom(1));
element('zoom-out').addEventListener('click', () => stepZoom(-1));
element('zoom-actual').addEventListener('click', () => zoomTo(1));
element('zoom-fit').addEventListener('click', () => zoomTo('fit'));
element('previous-page').addEventListener('click', () => jumpToPage(currentPageNumber() - 1));
element('next-page').addEventListener('click', () => jumpToPage(currentPageNumber() + 1));
element('page-number').addEventListener('change', commitPageNumber);
element('page-number').addEventListener('keydown', event => {
    if (event.key === 'Enter') {
        event.preventDefault();
        commitPageNumber();
        pages.focus({ preventScroll: true });
    }
    if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        element('page-number').value = String(currentPageNumber());
        pages.focus({ preventScroll: true });
    }
});
let resizeTimer;
window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
        if (pdf && pageSize && element('zoom').value === 'fit') installPages();
        else updatePageEndSpacing();
    }, 150);
});
let scrollFrame = null;
pages.addEventListener('scroll', () => {
    if (scrollFrame !== null) return;
    scrollFrame = requestAnimationFrame(() => {
        scrollFrame = null;
        thumbnails.selectPage(currentPageNumber());
        syncPageNavigation();
        // Release distant canvases; long documents should not retain every bitmap.
        const boundary = pages.getBoundingClientRect();
        for (const number of rendered) {
            const holder = pageNodes[number - 1];
            const box = holder.getBoundingClientRect();
            if (box.bottom < boundary.top - pages.clientHeight * 3 || box.top > boundary.bottom + pages.clientHeight * 3) {
                const canvas = holder.querySelector('canvas');
                if (canvas) { canvas.width = 0; canvas.height = 0; canvas.remove(); }
                rendered.delete(number);
                holder.classList.remove('page-rendered');
            }
        }
    });
}, { passive: true });
window.addEventListener('pagehide', () => {
    if (scrollFrame !== null) cancelAnimationFrame(scrollFrame);
    clearTimeout(resizeTimer);
    clearTimeout(feedbackTimer);
    cancelPages(); thumbnails.dispose(); void loadingTask?.destroy(); runtime.dispose();
});
send('ready');
