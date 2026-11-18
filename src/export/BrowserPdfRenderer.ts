import { ChildProcess, spawn } from 'child_process';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { Readable, Writable } from 'stream';
import { PdfBoundary, PdfLayout } from './PdfExportSession';
import { escapePdfHtml } from './PdfHtmlBuilder';
import { getNonce } from '../utils/getNonce';

type PendingCall = { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };

/** The small, stable CDP surface needed for printing, over private OS pipes.
 * No debugging port, browser download, or dependency on VS Code's Electron. */
export class ChromiumConnection {
    private sequence = 0;
    private chunks: Buffer[] = [];
    private pending = new Map<number, PendingCall>();
    private closed = false;
    private failure: Error | null = null;
    private readonly writer: Writable;

    constructor(public readonly process: ChildProcess) {
        this.writer = process.stdio[3] as Writable;
        const reader = process.stdio[4] as Readable;
        reader.on('data', (chunk: Buffer) => this.receive(chunk));
        reader.on('error', error => this.fail(error));
        this.writer.on('error', error => this.fail(error));
        process.on('error', error => this.fail(error));
        process.on('exit', () => this.fail(new Error('The PDF browser closed unexpectedly.')));
        // Drain stderr so a browser warning cannot block its printing pipe.
        process.stderr?.resume();
    }

    private fail(error: Error): void {
        this.failure = error;
        for (const call of this.pending.values()) { clearTimeout(call.timer); call.reject(error); }
        this.pending.clear();
    }

    private receive(chunk: Buffer): void {
        this.chunks.push(chunk);
        if (!chunk.includes(0)) { return; }
        const bytes = Buffer.concat(this.chunks);
        let start = 0;
        for (let end = bytes.indexOf(0); end >= 0; end = bytes.indexOf(0, start)) {
            const raw = bytes.toString('utf8', start, end);
            start = end + 1;
            try {
                const message = JSON.parse(raw);
                const call = this.pending.get(message.id);
                if (!call) { continue; }
                this.pending.delete(message.id);
                clearTimeout(call.timer);
                if (message.error) { call.reject(new Error(message.error.message)); }
                else { call.resolve(message.result); }
            } catch { this.fail(new Error('Invalid response from the PDF browser.')); }
        }
        this.chunks = start < bytes.length ? [bytes.subarray(start)] : [];
    }

    send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<any> {
        if (this.failure || this.closed) { return Promise.reject(this.failure || new Error('PDF generation cancelled.')); }
        const id = ++this.sequence;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`The PDF browser timed out (${method}).`));
            }, 45_000);
            this.pending.set(id, { resolve, reject, timer });
            this.writer.write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0');
        });
    }

    close(): void {
        if (this.closed) { return; }
        this.closed = true;
        this.fail(new Error('PDF generation cancelled.'));
        this.writer.destroy();
        this.process.kill();
    }
}

export async function findPdfBrowser(configuredPath = ''): Promise<string> {
    let configured = configuredPath.trim();
    if (process.platform === 'darwin' && configured.endsWith('.app')) {
        const name = path.basename(configured, '.app');
        configured = path.join(configured, 'Contents', 'MacOS', name);
    }
    const candidates = configured ? [configured] : process.platform === 'darwin' ? [
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
        '/Applications/Chromium.app/Contents/MacOS/Chromium',
        path.join(os.homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
    ] : process.platform === 'win32' ? [
        ...[process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA]
            .filter((root): root is string => !!root)
            .flatMap(root => ['Google/Chrome/Application/chrome.exe', 'Microsoft/Edge/Application/msedge.exe']
                .map(relative => path.join(root, relative))),
    ] : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium',
        '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge', '/opt/google/chrome/chrome', '/snap/bin/chromium'];
    for (const candidate of candidates) {
        if (!path.isAbsolute(candidate)) { continue; }
        try {
            if ((await fs.stat(candidate)).isFile()) { return candidate; }
        } catch { /* Try the next installed browser. */ }
    }
    throw new Error(configured
        ? 'The configured PDF browser was not found. Check ManulDown: PDF Browser Path in Settings.'
        : 'PDF export needs Google Chrome or Microsoft Edge. Install one, or set ManulDown: PDF Browser Path in Settings.');
}

export async function openPdfBrowser(executable: string): Promise<{ connection: ChromiumConnection; dispose: () => Promise<void> }> {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'manuldown-pdf-'));
    let connection: ChromiumConnection;
    try {
        connection = new ChromiumConnection(spawn(executable, [
            '--headless=new', '--remote-debugging-pipe', `--user-data-dir=${directory}`,
            '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
            '--disable-component-update', '--disable-extensions', '--disable-sync', '--disable-crash-reporter',
            '--metrics-recording-only', '--disable-features=Translate,MediaRouter', 'about:blank',
        ], { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'], windowsHide: true }));
    } catch (error) {
        await fs.rm(directory, { recursive: true, force: true });
        throw error;
    }
    let disposed = false;
    return { connection, dispose: async () => {
        if (disposed) { return; }
        disposed = true;
        const child = connection.process;
        const exited = child.exitCode !== null || child.signalCode !== null;
        const exit = exited ? Promise.resolve() : new Promise<void>(resolve => child.once('exit', () => resolve()));
        connection.close();
        let timer: NodeJS.Timeout | undefined;
        await Promise.race([exit, new Promise<void>(resolve => {
            timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 1500);
        })]);
        clearTimeout(timer);
        await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
    } };
}

const pdfFontFamily = '-apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans CJK JP", "Noto Sans JP", "Hiragino Sans", "Yu Gothic", Meiryo, sans-serif';
const assetCache = new Map<string, Promise<string>>();
function readAsset(root: string, relative: string): Promise<string> {
    const key = path.join(root, relative);
    if (!assetCache.has(key)) { assetCache.set(key, fs.readFile(key, 'utf8')); }
    return assetCache.get(key)!;
}

async function buildExportPage(
    mediaRoot: string, html: string, title: string, layout: PdfLayout, breaks: readonly string[], probePrefix = '', format: 'pdf' | 'html' = 'pdf',
): Promise<string> {
    const margin = { narrow: 12, standard: 18, wide: 24 }[layout.margin];
    const fontSize = { small: 9.5, standard: 10.5, large: 12 }[layout.fontSize];
    const paper = layout.paper === 'Letter' ? [215.9, 279.4] : [210, 297];
    const [width, height] = layout.landscape ? [paper[1], paper[0]] : paper;
    const hasMath = /data-mdw-math=|language-math/.test(html);
    const hasMermaid = /language-mermaid/.test(html);
    const [css, script, prism, katex, mermaid] = await Promise.all([
        readAsset(mediaRoot, 'export.css'), readAsset(mediaRoot, 'export.js'),
        readAsset(mediaRoot, 'vendor/prism.bundle.js'),
        hasMath ? readAsset(mediaRoot, 'vendor/katex/katex.min.js') : '',
        hasMermaid ? readAsset(mediaRoot, 'vendor/mermaid.bundle.js') : '',
    ]);
    let mathCss = hasMath ? await readAsset(mediaRoot, 'vendor/katex/katex.min.css') : '';
    const fontFiles = [...mathCss.matchAll(/url\((fonts\/[^)]+\.woff2)\)/g)];
    const fonts = await Promise.all([...new Set(fontFiles.map(match => match[1]))].map(async relative => {
        const bytes = await fs.readFile(path.join(mediaRoot, 'vendor/katex', relative));
        return [relative, `data:font/woff2;base64,${bytes.toString('base64')}`] as const;
    }));
    for (const [relative, data] of fonts) { mathCss = mathCss.split(`url(${relative})`).join(`url(${data})`); }
    const config = JSON.stringify({ format, breaks, probePrefix, width: (width - margin * 2) * 96 / 25.4,
        height: (height - margin * 2) * 96 / 25.4 }).replace(/</g, '\\u003c');
    const scripts = [prism, katex, mermaid, `window.manulPdfConfig=${config};\n${script}`]
        .filter(Boolean).map(source => `<script nonce="manul-pdf">${source.replace(/<\/script/gi, '<\\/script')}</script>`).join('');
    return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-manul-pdf'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'">
<title>${escapePdfHtml(title)}</title><style>${css}\n${mathCss}
@page { size: ${layout.paper} ${layout.landscape ? 'landscape' : 'portrait'}; margin: ${margin}mm; }
:root { --pdf-width: ${width - 2 * margin}mm; --pdf-height: ${height - 2 * margin}mm; --pdf-font-size: ${fontSize}pt; --pdf-font-family: ${pdfFontFamily}; }
${format === 'html' ? `
body { width: auto; max-width: 960px; margin: 0 auto; padding: 32px; font-size: 16px; }
img, .export-diagram svg { max-height: none; }
pre, .export-diagram, .katex-display { overflow-x: auto; }
@media (max-width: 600px) { body { padding: 20px 16px; } }
@media print { body { max-width: none; padding: 0; } }
` : ''}
</style></head><body><main id="pdf-content">${html}</main>${scripts}</body></html>`;
}

export async function buildPdfPage(
    mediaRoot: string, html: string, title: string, layout: PdfLayout, breaks: readonly string[], probePrefix = '',
): Promise<string> {
    return buildExportPage(mediaRoot, html, title, layout, breaks, probePrefix);
}

/** A portable page with embedded styles, renderers and math fonts. */
export async function buildHtmlPage(mediaRoot: string, html: string, title: string): Promise<string> {
    return buildExportPage(mediaRoot, html, title, {
        paper: 'A4', landscape: false, margin: 'standard', fontSize: 'standard', pageNumbers: false,
    }, [], '', 'html');
}

export async function renderPdf(options: {
    mediaRoot: string; html: string; title: string; layout: PdfLayout; breaks: string[];
    browserPath?: string; signal: AbortSignal;
}): Promise<{ bytes: Buffer; warnings: string[]; boundaries: PdfBoundary[] }> {
    if (options.signal.aborted) { throw new Error('PDF generation cancelled.'); }
    const executable = await findPdfBrowser(options.browserPath);
    const probePrefix = `https://manuldown.invalid/pdf-boundary/${getNonce()}/`;
    const html = await buildPdfPage(options.mediaRoot, options.html, options.title, options.layout, options.breaks, probePrefix);
    if (options.signal.aborted) { throw new Error('PDF generation cancelled.'); }
    const browser = await openPdfBrowser(executable);
    const abort = () => browser.connection.close();
    options.signal.addEventListener('abort', abort, { once: true });
    try {
        if (options.signal.aborted) { throw new Error('PDF generation cancelled.'); }
        const cdp = browser.connection;
        const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
        const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
        await cdp.send('Emulation.setEmulatedMedia', { media: 'print' }, sessionId);
        await cdp.send('Network.enable', {}, sessionId);
        await cdp.send('Network.setBlockedURLs', { urls: ['http://*', 'https://*', 'file://*', 'ftp://*', 'ws://*', 'wss://*'] }, sessionId);
        const { frameTree } = await cdp.send('Page.getFrameTree', {}, sessionId);
        await cdp.send('Page.setDocumentContent', { frameId: frameTree.frame.id, html }, sessionId);
        const result = await cdp.send('Runtime.evaluate', {
            expression: 'window.manulPdfReady', awaitPromise: true, returnByValue: true,
        }, sessionId);
        if (result.exceptionDetails) {
            throw new Error(result.exceptionDetails.exception?.description?.split('\n')[0] || 'PDF layout failed.');
        }
        if (!Array.isArray(result.result?.value)) { throw new Error('PDF content could not be prepared.'); }
        const { data } = await cdp.send('Page.printToPDF', {
            printBackground: true, preferCSSPageSize: true,
            displayHeaderFooter: options.layout.pageNumbers,
            headerTemplate: '<div></div>',
            footerTemplate: `<div style="font-family:${escapePdfHtml(pdfFontFamily)};font-size:11px;font-weight:400;font-style:normal;color:#666;text-align:center;width:100%"><span class="pageNumber"></span> / <span class="totalPages"></span></div>`,
        }, sessionId);
        const bytes = Buffer.from(data, 'base64');
        if (bytes.subarray(0, 5).toString() !== '%PDF-') { throw new Error('The browser did not produce a PDF.'); }
        const { extractPdfBoundaries } = await import('./PdfBoundaryMap');
        const mapped = await extractPdfBoundaries(bytes, probePrefix);
        if (options.signal.aborted) { throw new Error('PDF generation cancelled.'); }
        return { ...mapped, warnings: result.result.value };
    } finally {
        options.signal.removeEventListener('abort', abort);
        await browser.dispose();
    }
}
