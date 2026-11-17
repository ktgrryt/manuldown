import { TextDecoder } from 'util';

const extensions = new Map<string, string>([
    ['image/png', 'png'], ['image/jpeg', 'jpg'], ['image/gif', 'gif'],
    ['image/bmp', 'bmp'], ['image/webp', 'webp'], ['image/svg+xml', 'svg'],
    ['image/avif', 'avif'], ['image/x-icon', 'ico'], ['image/heic', 'heic'],
    ['image/heif', 'heif'], ['image/tiff', 'tiff'],
]);

export function normalizeImageMimeType(value: string): string | null {
    let mime = String(value || '').split(';')[0].trim().toLowerCase();
    if (mime === 'image/jpg') { mime = 'image/jpeg'; }
    if (mime === 'image/vnd.microsoft.icon') { mime = 'image/x-icon'; }
    return extensions.has(mime) ? mime : null;
}

export function imageExtension(mime: string): string {
    // Never derive filesystem extensions from an untrusted MIME subtype.
    const extension = extensions.get(mime);
    if (!extension) { throw new Error('Unsupported image format.'); }
    return extension;
}

/** Check the format bytes as well as the caller's MIME declaration. */
export function imageMatchesMimeType(bytes: Uint8Array, mime: string): boolean {
    const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const text = (start: number, end: number) => data.toString('ascii', start, end);
    switch (mime) {
        case 'image/png':
            return data.length >= 24 && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
                text(12, 16) === 'IHDR' && data.readUInt32BE(16) > 0 && data.readUInt32BE(20) > 0;
        case 'image/jpeg':
            return data.length >= 4 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
        case 'image/gif':
            return data.length >= 13 && ['GIF87a', 'GIF89a'].includes(text(0, 6));
        case 'image/bmp':
            return data.length >= 26 && text(0, 2) === 'BM';
        case 'image/webp':
            return data.length >= 16 && text(0, 4) === 'RIFF' && text(8, 12) === 'WEBP' &&
                ['VP8 ', 'VP8L', 'VP8X'].includes(text(12, 16));
        case 'image/x-icon':
            return data.length >= 22 && data.readUInt32LE(0) === 0x00010000 && data.readUInt16LE(4) > 0;
        case 'image/tiff':
            return data.length >= 8 && ['49492a00', '4d4d002a', '49492b00', '4d4d002b'].includes(data.subarray(0, 4).toString('hex'));
        case 'image/avif':
        case 'image/heic':
        case 'image/heif': {
            if (data.length < 16 || text(4, 8) !== 'ftyp') { return false; }
            const end = data.readUInt32BE(0);
            if (end < 16 || end > data.length || end % 4 !== 0) { return false; }
            const brands = [text(8, 12)];
            for (let offset = 16; offset < end; offset += 4) { brands.push(text(offset, offset + 4)); }
            const avif = brands.some(brand => ['avif', 'avis'].includes(brand));
            if (mime === 'image/avif') { return avif; }
            return !avif && brands.some(brand => ['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1'].includes(brand));
        }
        case 'image/svg+xml': {
            let source: string;
            try { source = new TextDecoder('utf-8', { fatal: true }).decode(data); } catch { return false; }
            // No DTD/entities: image import must not accept XML entity payloads.
            if (/<!DOCTYPE|<!ENTITY|\u0000/i.test(source)) { return false; }
            source = source.replace(/^\uFEFF/, '').trim()
                .replace(/^<\?xml\s[^?]*\?>\s*/i, '')
                .replace(/^(?:<!--[\s\S]*?-->\s*)+/, '');
            return /^<svg(?:\s[^<>]*?)?(?:\/>|>[\s\S]*<\/svg\s*>)\s*$/.test(source);
        }
        default:
            return false;
    }
}
