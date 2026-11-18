const Module = require('node:module');
const path = require('node:path');

function uri(filePath) {
    return {
        scheme: 'file', path: filePath, fsPath: filePath,
        toString: () => `file://${filePath}`,
        with: changes => uri(changes.path || filePath),
    };
}

function loadPdfModules(extra = {}) {
    const vscode = {
        Uri: { file: uri, joinPath: (base, ...parts) => uri(path.posix.join(base.path, ...parts)) },
        workspace: { getConfiguration: () => ({ get: (_key, fallback) => fallback }) },
        ...extra,
    };
    const original = Module._load;
    Module._load = function (name, ...args) {
        return name === 'vscode' ? vscode : original.call(this, name, ...args);
    };
    try {
        return {
            ...require('../../out/export/PdfExportSession'),
            ...require('../../out/export/PdfHtmlBuilder'),
            ...require('../../out/export/HtmlExport'),
            ...require('../../out/export/WordExport'),
            ...require('../../out/export/BrowserPdfRenderer'),
            ...require('../../out/export/PdfPreviewHtml'),
            ...require('../../out/export/PdfBreakAnchors'),
            ...require('../../out/export/PdfBoundaryMap'),
            PdfPreviewProvider: require('../../out/export/PdfPreviewProvider').PdfPreviewProvider,
            renderer: require('../../out/export/BrowserPdfRenderer'),
        };
    } finally { Module._load = original; }
}

module.exports = { loadPdfModules, uri };
