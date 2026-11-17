/** VS Code workers cannot import extension resource URLs. Fetch each complete
 * bundle in the Webview, then pass Blob-backed workers directly to PDF.js. */
export function createPdfPreviewRuntime(assets) {
    const controller = new window.AbortController();
    const workers = [];
    const urls = [];
    let disposed = false;
    const dispose = () => {
        if (disposed) return;
        disposed = true;
        controller.abort();
        for (const worker of workers) worker.terminate();
        for (const url of urls) URL.revokeObjectURL(url);
    };
    const loadWorker = async filename => {
        const response = await window.fetch(`${assets}${filename}`, { signal: controller.signal });
        if (!response.ok) throw new Error('Could not load the PDF viewer worker. Please refresh the preview.');
        const url = URL.createObjectURL(new window.Blob([await response.arrayBuffer()], { type: 'text/javascript' }));
        urls.push(url);
        if (disposed) { URL.revokeObjectURL(url); throw new Error('PDF preview was closed.'); }
        const worker = new window.Worker(url, { type: 'module' });
        workers.push(worker);
        await new Promise((resolve, reject) => {
            const cleanup = () => {
                worker.removeEventListener('message', ready);
                worker.removeEventListener('error', failed);
                controller.signal.removeEventListener('abort', aborted);
            };
            const ready = event => {
                if (event.data?.action !== 'ready') return;
                cleanup();
                resolve();
            };
            const failed = () => { cleanup(); reject(new Error('Could not start the PDF viewer worker. Please refresh the preview.')); };
            const aborted = () => { cleanup(); reject(new Error('PDF viewer loading was cancelled or timed out. Please refresh the preview.')); };
            worker.addEventListener('message', ready);
            worker.addEventListener('error', failed);
            controller.signal.addEventListener('abort', aborted, { once: true });
        });
        return worker;
    };
    let timeout;
    const deadline = new Promise((_, reject) => {
        timeout = setTimeout(() => {
            reject(new Error('PDF viewer loading timed out. Please refresh the preview.'));
            controller.abort();
        }, 15000);
    });
    const loading = Promise.all([
        import(`${assets}pdf.mjs`), loadWorker('pdf.worker.mjs'), loadWorker('pdf.renderer.mjs'),
    ]).then(([pdfjs, parser, renderer]) => {
        if (disposed) throw new Error('PDF preview was closed.');
        pdfjs.GlobalWorkerOptions.workerPort = parser;
        pdfjs.GlobalWorkerOptions.rendererPorts = [renderer];
        return pdfjs;
    });
    const ready = Promise.race([loading, deadline]).catch(error => {
        dispose(); throw error;
    }).finally(() => clearTimeout(timeout));
    return { ready, dispose };
}
