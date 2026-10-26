import lzLib from 'lz-string';
import { DrawBoard } from '../../components/draw-board.js';
import { uploadStudentFile } from '../../utils/student-media.js';
import { generateUUID } from '../../utils/uuid.js';

const LZString = lzLib.compressToBase64 ? lzLib : (lzLib.default || lzLib);

export const DRAWING_MAX_INLINE_BYTES = 96 * 1024; // 96 KB
export const CODE_MAX_INLINE_BYTES = 64 * 1024;    // 64 KB

/**
 * Detect programming language from filename extension.
 * @param {string} filename
 * @returns {string}
 */
export function detectCodeLanguage(filename = '') {
  const ext = filename.split('.').pop()?.toLowerCase() || '';
  switch (ext) {
    case 'py': return 'python';
    case 'js': case 'mjs': case 'cjs': return 'javascript';
    case 'ts': return 'typescript';
    case 'html': case 'htm': return 'html';
    case 'css': return 'css';
    case 'java': return 'java';
    case 'cpp': case 'cc': case 'cxx': case 'c': case 'h': case 'hpp': return 'cpp';
    case 'sql': return 'sql';
    case 'json': return 'json';
    default: return 'python';
  }
}

/**
 * Compresses a DrawDoc object into a base64 string using LZ-String.
 * @param {object} doc
 * @returns {string|null}
 */
export function compressDrawDoc(doc) {
  if (!doc) return null;
  const json = JSON.stringify(doc);
  return LZString.compressToBase64(json);
}

/**
 * Decompresses an LZ-String compressed DrawDoc.
 * @param {string} compressed
 * @returns {object|null}
 */
export function decompressDrawDoc(compressed) {
  if (!compressed) return null;
  try {
    const raw = LZString.decompressFromBase64(compressed) || LZString.decompressFromUTF16(compressed);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

/**
 * Rasterizes a DrawDoc onto an HTMLCanvasElement.
 * @param {object} doc
 * @param {object} [opts]
 * @param {number} [opts.width]
 * @param {number} [opts.height]
 * @returns {HTMLCanvasElement}
 */
export function rasterizeDrawDocToCanvas(doc, opts = {}) {
  const width = opts.width || doc?.width || 1000;
  const height = opts.height || doc?.height || 600;

  let canvas;
  if (typeof document !== 'undefined') {
    canvas = document.createElement('canvas');
  } else {
    canvas = { width, height };
  }
  canvas.width = width;
  canvas.height = height;

  const ctx = canvas.getContext ? canvas.getContext('2d') : null;
  if (ctx) {
    // Fill white background for clear PNG export
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
    DrawBoard.renderElementsToCanvas(ctx, doc);
  }

  return canvas;
}

/**
 * Converts a DrawDoc to a PNG Blob.
 * @param {object} doc
 * @param {object} [opts]
 * @returns {Promise<Blob>}
 */
export async function rasterizeDrawDocToBlob(doc, opts = {}) {
  const canvas = rasterizeDrawDocToCanvas(doc, opts);

  if (typeof canvas.toBlob === 'function') {
    try {
      const blob = await new Promise((resolve) => {
        const timer = setTimeout(() => resolve(null), 100);
        try {
          canvas.toBlob((b) => {
            clearTimeout(timer);
            resolve(b);
          }, 'image/png');
        } catch (_) {
          clearTimeout(timer);
          resolve(null);
        }
      });
      if (blob) return blob;
    } catch (_) {}
  }

  // Fallback for jsdom / Node environments
  const dataUrl = await rasterizeDrawDocToDataUrl(doc, opts);
  const base64 = (dataUrl.split(',')[1] || '').trim();
  const binary = atob(base64 || 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==');
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: 'image/png' });
}

/**
 * Converts a DrawDoc to a data: image/png base64 URL.
 * @param {object} doc
 * @param {object} [opts]
 * @returns {Promise<string>}
 */
export async function rasterizeDrawDocToDataUrl(doc, opts = {}) {
  const canvas = rasterizeDrawDocToCanvas(doc, opts);
  if (typeof canvas.toDataURL === 'function') {
    try {
      const res = canvas.toDataURL('image/png');
      if (typeof res === 'string' && res.startsWith('data:')) {
        return res;
      }
    } catch (_) {}
  }
  return 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
}

/**
 * Prepares drawing data for submission envelope based on the stroke budget tier:
 * 1. Inline LZ-String compressed if <= 96 KB
 * 2. If > 96 KB and CDN available: rasterize to PNG and upload via student presign
 * 3. If > 96 KB and no CDN: downscale and embed data: URI for .kbsub export
 *
 * @param {object} drawing - DrawDoc object
 * @param {object} relayInfo - Relay drop & endpoint info
 * @param {object} [options]
 * @param {number} [options.maxInlineBytes=96*1024]
 * @param {boolean} [options.offline=false]
 * @returns {Promise<object|null>}
 */
export async function prepareDrawingForSubmission(drawing, relayInfo = {}, options = {}) {
  if (!drawing || !Array.isArray(drawing.elements) || drawing.elements.length === 0) {
    return null;
  }

  const maxInline = options.maxInlineBytes || DRAWING_MAX_INLINE_BYTES;
  const compressed = compressDrawDoc(drawing);
  const compressedBytes = new TextEncoder().encode(compressed || '').length;

  // Tier 1: Fits inline budget
  if (compressedBytes <= maxInline) {
    return {
      version: drawing.version || 2,
      width: drawing.width || 1000,
      height: drawing.height || 600,
      elements: drawing.elements,
      compressed
    };
  }

  // Tier 2: Exceeds 96 KB budget -> rasterize to PNG
  const endpoint = relayInfo.endpoint || relayInfo.baseUrl;
  const dropId = relayInfo.drop_id || relayInfo.dropId;
  const canUploadToCdn = Boolean(endpoint && dropId && !options.offline);

  if (canUploadToCdn) {
    const pngBlob = await rasterizeDrawDocToBlob(drawing);
    const pngFile = new File([pngBlob], `drawing-${Date.now()}.png`, { type: 'image/png' });
    const cdnRef = await uploadStudentFile(pngFile, relayInfo, options);

    return {
      version: drawing.version || 2,
      width: drawing.width || 1000,
      height: drawing.height || 600,
      png_ref: cdnRef
    };
  }

  // Tier 3: Exceeds budget without CDN -> downscale PNG & embed as data: URL
  const dataUrl = await rasterizeDrawDocToDataUrl(drawing, { width: 800, height: 480 });
  return {
    version: drawing.version || 2,
    width: drawing.width || 1000,
    height: drawing.height || 600,
    png_data: dataUrl
  };
}

/**
 * Process a student uploaded code file:
 * - If <= 64 KB: read body and return as inline code file
 * - If > 64 KB: upload to CDN as generic file attachment
 *
 * @param {File} file
 * @param {object} relayInfo
 * @param {object} [options]
 * @returns {Promise<{ type: 'code'|'attachment', file?: object, attachment?: object }>}
 */
export async function processUploadedCodeFile(file, relayInfo = {}, options = {}) {
  if (!file) throw new Error('File is required');

  if (file.size <= CODE_MAX_INLINE_BYTES) {
    const body = await file.text();
    const language = detectCodeLanguage(file.name);
    return {
      type: 'code',
      file: {
        id: generateUUID(),
        filename: file.name,
        language,
        body,
        origin: 'upload'
      }
    };
  }

  // Large code file > 64KB -> route to CDN attachment
  const cdnRef = await uploadStudentFile(file, relayInfo, options);
  return {
    type: 'attachment',
    attachment: {
      id: generateUUID(),
      name: file.name,
      size: file.size,
      mime: file.type || 'text/plain',
      ref: cdnRef
    }
  };
}
