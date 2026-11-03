// A single clipboard item can offer both a PNG and rich HTML. Multiple images
// belong in one HTML fragment: Chromium cannot write multiple clipboard items.
const MAX_IMAGE_PIXELS = 32 * 1024 * 1024;
const MAX_CLIPBOARD_IMAGE_BYTES = 20 * 1024 * 1024;

export function createImageClipboardSnapshot(html, { document, imageAltText, serializePlainText }) {
    const container = document.createElement('div');
    container.innerHTML = html;
    const images = Array.from(container.querySelectorAll('img'));
    if (images.length === 0) return null;

    const originalImages = images.map(image => ({
        alt: image.getAttribute('alt') || '',
        markdownPath: image.getAttribute('data-md-path') || image.getAttribute('src') || ''
    }));
    const textContainer = container.cloneNode(true);
    const textImages = Array.from(textContainer.querySelectorAll('img'));
    // Alt text is a useful plain-text fallback; Markdown image syntax belongs
    // to Copy as Markdown, not to normal copy.
    textImages.forEach(image => image.replaceWith(document.createTextNode(imageAltText(image))));
    const text = serializePlainText(textContainer);

    const imageOnlyContainer = container.cloneNode(true);
    imageOnlyContainer.querySelectorAll('img').forEach(image => image.remove());
    const singleImage = images.length === 1 &&
        !imageOnlyContainer.textContent.replace(/[\s\u200B\u2060\uFEFF]/g, '') &&
        !imageOnlyContainer.querySelector('hr, table, pre, input, [data-mdw-math]');
    return { container, images, originalImages, text, singleImage };
}

export async function rasterizeClipboardImage(image) {
    if (image.hasAttribute('data-remote-image-blocked')) {
        throw new Error('Remote image loading is disabled.');
    }
    const src = image.getAttribute('src');
    if (!src) throw new Error('The image is not loaded.');
    const document = image.ownerDocument;
    const view = document.defaultView;
    const decoded = new view.Image();
    // Webview resource responses allow CORS. Reload in anonymous CORS mode so
    // drawing a local image does not taint the canvas. Remote servers must also
    // allow CORS; copying never bypasses the editor's image/network policy.
    decoded.crossOrigin = 'anonymous';
    let timeout;
    const canvas = document.createElement('canvas');
    try {
        await new Promise((resolve, reject) => {
            timeout = view.setTimeout(() => reject(new Error('Loading the image timed out.')), 10000);
            decoded.onload = resolve;
            decoded.onerror = () => reject(new Error('The image could not be read. It may be unavailable or block cross-origin access.'));
            decoded.src = src;
        });
        view.clearTimeout(timeout);
        const width = decoded.naturalWidth;
        const height = decoded.naturalHeight;
        if (!width || !height || width * height > MAX_IMAGE_PIXELS) {
            throw new Error('The image is too large to copy.');
        }
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext('2d');
        if (!context) throw new Error('Image conversion is unavailable.');
        context.drawImage(decoded, 0, 0);
        const blob = await new Promise((resolve, reject) => {
            canvas.toBlob(value => value ? resolve(value) : reject(new Error('PNG conversion failed.')), 'image/png');
        });
        if (blob.size > MAX_CLIPBOARD_IMAGE_BYTES) throw new Error('The image is too large to copy.');
        const dataUrl = await new Promise((resolve, reject) => {
            const reader = new view.FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => reject(new Error('PNG conversion failed.'));
            reader.readAsDataURL(blob);
        });
        return { blob, dataUrl };
    } finally {
        view.clearTimeout(timeout);
        decoded.onload = decoded.onerror = null;
        decoded.removeAttribute('src');
        canvas.width = canvas.height = 0;
    }
}

export function writeImageClipboard(snapshot, {
    clipboard,
    ClipboardItem,
    Blob,
    markHtml,
    isCurrent = () => true,
    rasterizeImage = rasterizeClipboardImage
}) {
    if (!clipboard || typeof clipboard.write !== 'function' || typeof ClipboardItem !== 'function') {
        return Promise.reject(new Error('Image clipboard access is unavailable.'));
    }

    const prepare = async () => {
        const cache = new Map();
        let totalBytes = 0;
        let png;
        for (const image of snapshot.images) {
            if (!isCurrent()) throw new Error('Copy superseded.');
            const src = image.getAttribute('src');
            // Do not turn a blocked-image placeholder into a successful copy.
            if (image.hasAttribute('data-remote-image-blocked') || !src) {
                throw new Error('An image is blocked or is not loaded.');
            }
            let converted = cache.get(src);
            if (!converted) {
                converted = await rasterizeImage(image);
                totalBytes += converted.blob.size;
                if (totalBytes > MAX_CLIPBOARD_IMAGE_BYTES) throw new Error('The selected images are too large to copy.');
                cache.set(src, converted);
            }
            png = converted.blob;
            image.setAttribute('src', converted.dataUrl);
            image.removeAttribute('srcset');
            // Keep original paths only in the editor's in-memory clipboard
            // record. The portable HTML has no dependency on local files.
            Array.from(image.attributes).forEach(attribute => {
                if (attribute.name.startsWith('data-')) image.removeAttribute(attribute.name);
            });
        }
        if (!isCurrent()) throw new Error('Copy superseded.');
        return { html: snapshot.container.innerHTML, png };
    };

    // Start write() in the copy event, while user activation is still present.
    // ClipboardItem accepts promises so decoding may finish asynchronously.
    const prepared = prepare();
    const html = prepared.then(result => new Blob([markHtml(result.html)], { type: 'text/html' }));
    const png = snapshot.singleImage ? prepared.then(result => result.png) : null;
    // If constructing/writing the item fails early, its data promises must not
    // become unhandled rejections later when an image fails to decode.
    for (const promise of [prepared, html, png]) promise?.catch(() => {});
    try {
        const formats = {
            'text/html': html,
            'text/plain': new Blob([snapshot.text], { type: 'text/plain' })
        };
        if (png) formats['image/png'] = png;
        return Promise.resolve(clipboard.write([new ClipboardItem(formats)]))
            .then(() => prepared);
    } catch (error) {
        return Promise.reject(error);
    }
}
