import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFRef, PDFString } from 'pdf-lib';
import { PdfBoundary } from './PdfExportSession';

/** Read Chromium's *printed* link rectangles, then remove our private probes.
 * Actual document links, page streams and text remain intact. No probe URL is
 * shipped in the saved PDF and no second, potentially different print is made. */
export async function extractPdfBoundaries(bytes: Buffer, prefix: string): Promise<{ bytes: Buffer; boundaries: PdfBoundary[] }> {
    const document = await PDFDocument.load(bytes, { updateMetadata: false });
    const boundaries = new Map<string, PdfBoundary>();
    const previousEnds = new Map<string, number>();
    let removed = false;
    for (const [index, page] of document.getPages().entries()) {
        const annotations = page.node.Annots();
        if (!annotations) { continue; }
        for (let i = annotations.size() - 1; i >= 0; i--) {
            const ref = annotations.get(i);
            const annotation = document.context.lookup(ref);
            if (!(annotation instanceof PDFDict)) { continue; }
            const action = annotation.lookup(PDFName.of('A'));
            if (!(action instanceof PDFDict)) { continue; }
            const uri = action.lookup(PDFName.of('URI'));
            if (!(uri instanceof PDFString || uri instanceof PDFHexString)) { continue; }
            const url = uri.decodeText();
            if (!url.startsWith(prefix)) { continue; }
            const target = /^(block-[a-f0-9]{32}-\d+)(\/previous-end)?$/.exec(url.slice(prefix.length));
            const rectangle = annotation.lookup(PDFName.of('Rect'));
            if (target && rectangle instanceof PDFArray && rectangle.size() === 4) {
                const id = target[1];
                const rect = Array.from({ length: 4 }, (_, n) => rectangle.lookup(n, PDFNumber).asNumber()) as PdfBoundary['rect'];
                const previous = boundaries.get(id);
                if (target[2] && rect.every(Number.isFinite)) {
                    previousEnds.set(id, Math.max(previousEnds.get(id) || 0, index + 1));
                } else if (rect.every(Number.isFinite) && (!previous || index + 1 < previous.page ||
                    index + 1 === previous.page && rect[3] > previous.rect[3])) {
                    boundaries.set(id, { id, page: index + 1, rect });
                }
            }
            annotations.remove(i);
            if (ref instanceof PDFRef) { document.context.delete(ref); }
            removed = true;
        }
        if (!annotations.size()) { page.node.delete(PDFName.of('Annots')); }
    }
    // A block starts a page only when its preceding block actually ended on
    // an earlier printed page. The first start probe on a page alone is not
    // enough: a table, paragraph or code block may continue above it.
    for (const boundary of boundaries.values()) {
        const previousEnd = previousEnds.get(boundary.id);
        boundary.atPageStart = previousEnd !== undefined && previousEnd < boundary.page;
    }
    return { bytes: removed ? Buffer.from(await document.save({ updateFieldAppearances: false })) : bytes,
        boundaries: [...boundaries.values()] };
}
