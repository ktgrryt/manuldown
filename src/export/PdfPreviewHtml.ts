import * as vscode from 'vscode';
import { getNonce } from '../utils/getNonce';
import { getLoadingSpinnerCss } from '../utils/loadingSpinner';
import { escapePdfHtml } from './PdfHtmlBuilder';

export function getPdfPreviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
    const nonce = getNonce();
    const asset = (relative: string) => escapePdfHtml(webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', relative)).toString());
    const paths = {
        sidebar: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18M6 7h0M6 12h0M6 17h0"/>',
        layout: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9zM14 3v6h6M8 13h8M8 17h5"/>',
        pagebreak: '<path d="M6 10V3h9l3 3v4M15 3v4h3M6 17v4h12v-4M3 13h3m3 0h3m3 0h3m3 0h0"/>',
        refresh: '<path d="M20 7v5h-5M4 17v-5h5M6 7a7 7 0 0 1 12-1l2 3M4 15l2 3a7 7 0 0 0 12-1"/>',
        download: '<path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/>',
        undo: '<path d="m9 5-5 5 5 5M4 10h10a6 6 0 0 1 6 6v3"/>',
        redo: '<path d="m15 5 5 5-5 5M20 10H10a6 6 0 0 0-6 6v3"/>',
        check: '<path d="m5 12 4 4L19 6"/>',
        previous: '<path d="m15 6-6 6 6 6"/>',
        next: '<path d="m9 6 6 6-6 6"/>',
        minus: '<path d="M5 12h14"/>',
        plus: '<path d="M5 12h14M12 5v14"/>',
    };
    const icon = (name: keyof typeof paths) => `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${paths[name]}</svg>`;
    return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data: blob:; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource} blob: data:; script-src 'nonce-${nonce}' ${webview.cspSource} 'wasm-unsafe-eval'; worker-src blob:; connect-src ${webview.cspSource}; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'">
<title>PDF preview</title><style>${getLoadingSpinnerCss('.pdf-loading-spinner')}</style><link rel="stylesheet" href="${asset('ui-chrome.css')}"><link rel="stylesheet" href="${asset('pdf-preview.css')}">
</head><body class="pdf-preview md-preview" data-assets="${asset('vendor/pdfjs/')}">
<header class="preview-toolbar md-preview-toolbar">
 <div class="preview-title"><button id="toggle-thumbnails" class="icon-button" type="button" aria-expanded="true" aria-controls="thumbnail-panel" aria-label="Hide thumbnails" title="Hide thumbnails">${icon('sidebar')}</button><span id="document-name"></span></div>
 <div class="preview-actions">
  <button id="break-panel" type="button" aria-pressed="false" aria-controls="pages break-tools" aria-label="Adjust page breaks" title="Adjust page breaks">${icon('pagebreak')}<span class="action-label">Page breaks</span></button>
  <details id="layout-panel"><summary class="viewer-control" aria-label="Page layout" title="Page layout">${icon('layout')}<span class="action-label">Layout</span></summary><div class="popover layout-fields">
   <strong class="popover-title">Page layout</strong>
   <label>Paper<select id="paper"><option>A4</option><option>Letter</option></select></label>
   <label>Orientation<select id="orientation"><option value="portrait">Portrait</option><option value="landscape">Landscape</option></select></label>
   <label>Margins<select id="margin"><option value="narrow">Narrow</option><option value="standard" selected>Standard</option><option value="wide">Wide</option></select></label>
   <label>Text size<select id="font-size"><option value="small">Small</option><option value="standard" selected>Standard</option><option value="large">Large</option></select></label>
   <label class="check"><input type="checkbox" id="page-numbers" checked>Page numbers</label>
  </div></details>
  <button id="reload" class="icon-button" type="button" aria-label="Refresh preview" title="Refresh preview">${icon('refresh')}</button>
  <span class="viewer-divider md-preview-divider" aria-hidden="true"></span>
  <button id="export" class="export-action" type="button" disabled title="Export PDF">${icon('download')}<span>Export…</span></button>
 </div>
</header>
<div id="break-tools" hidden>
 <div class="break-description"><strong>Page breaks</strong><span id="break-count"></span><span class="break-hint">Click a line between blocks to add a page break</span></div>
 <div class="break-actions"><button id="undo" class="icon-button" type="button" aria-label="Undo" title="Undo (Ctrl/Cmd+Z)">${icon('undo')}</button><button id="redo" class="icon-button" type="button" aria-label="Redo" title="Redo (Ctrl+Y / Cmd+Shift+Z)">${icon('redo')}</button><span class="viewer-divider md-preview-divider" aria-hidden="true"></span><button id="reset-breaks" type="button" title="Remove all manual page breaks">Clear all</button><button id="finish-breaks" type="button">${icon('check')}Done</button></div>
</div>
<div id="stale" class="notice" hidden><span>The document changed.</span><button id="reload-latest" type="button">${icon('refresh')}Refresh preview</button></div>
<div id="error" class="notice error" role="alert" hidden><span></span><button id="settings" type="button">PDF settings</button></div>
<details id="warnings" class="notice" hidden><summary></summary><ul></ul></details>
<div class="preview-workspace">
 <nav id="thumbnail-panel" aria-label="Page thumbnails"><div class="thumbnail-heading"><span>Pages</span><span id="thumbnail-count"></span></div><div id="thumbnails"><p class="thumbnail-empty">Preparing pages…</p></div></nav>
 <div id="pages" role="region" aria-label="PDF pages" aria-busy="true" tabindex="0"><div id="empty"></div></div>
 <div id="preview-loading" role="status" aria-live="polite" aria-atomic="true"><span class="pdf-loading-spinner" aria-hidden="true"></span><span id="preview-loading-label">Preparing PDF…</span></div>
 <div id="break-feedback" hidden><span id="break-feedback-text" role="status" aria-live="polite"></span><button id="undo-break" type="button">Undo</button></div>
</div>
<footer class="preview-footer md-preview-footer">
 <div class="page-navigation" role="group" aria-label="Page navigation">
  <button id="previous-page" class="icon-button" type="button" disabled aria-label="Previous page" title="Previous page">${icon('previous')}</button>
  <label class="page-entry"><span class="sr-only">Page number</span><input id="page-number" type="number" min="1" step="1" value="1" disabled title="Enter a page number and press Enter"></label><span id="page-count">/ —</span>
  <button id="next-page" class="icon-button" type="button" disabled aria-label="Next page" title="Next page">${icon('next')}</button>
 </div>
 <div class="preview-zoom md-preview-actions" role="group" aria-label="Zoom">
 <div class="md-preview-zoom">
  <button id="zoom-out" class="icon-button" type="button" disabled aria-label="Zoom out" title="Zoom out (−)">${icon('minus')}</button>
  <label class="zoom-value"><span class="sr-only">Zoom level</span><output id="zoom-level" class="md-preview-scale" aria-hidden="true">—</output><select id="zoom" title="Zoom level"><option value="fit">Fit width</option><option value="0.25">25%</option><option value="0.5">50%</option><option value="0.75">75%</option><option value="1">100%</option><option value="1.25">125%</option><option value="1.5">150%</option><option value="1.75">175%</option><option value="2">200%</option></select></label>
  <button id="zoom-in" class="icon-button" type="button" disabled aria-label="Zoom in" title="Zoom in (+)">${icon('plus')}</button>
 </div>
  <span class="viewer-divider md-preview-divider" aria-hidden="true"></span><button id="zoom-actual" type="button" disabled title="Actual size (0)">100%</button>
  <span class="zoom-fit-divider md-preview-divider" aria-hidden="true"></span><button id="zoom-fit" type="button" disabled aria-label="Fit width" title="Fit width (F)">Fit</button>
 </div>
 <div class="preview-status" role="status" aria-live="polite"><span id="activity-indicator" class="pdf-loading-spinner" aria-hidden="true"></span><span id="status">Preparing PDF…</span></div>
</footer>
<script type="module" nonce="${nonce}" src="${asset('pdf-preview.js')}"></script></body></html>`;
}
