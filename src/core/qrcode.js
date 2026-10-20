import qrcode from 'qrcode-generator';

/**
 * QR Code Generator Utility (KB-CORE-QRCODE)
 * Wraps qrcode-generator to render scalable SVGs for classes and course links.
 */
export const QRCode = {
  /**
   * Generate an inline SVG string for the given text.
   * @param {string} text
   * @param {{ size?: number, margin?: number, errorCorrectionLevel?: 'L'|'M'|'Q'|'H' }} [options]
   * @returns {string} SVG tag string
   */
  generateSVG(text, { size = 128, margin = 4, errorCorrectionLevel = 'M' } = {}) {
    if (!text) return '';
    try {
      const qr = qrcode(0, errorCorrectionLevel);
      qr.addData(String(text), 'Byte');
      qr.make();
      const count = qr.getModuleCount();
      const cellSize = Math.max(1, Math.floor(size / (count + margin * 2)));
      return qr.createSvgTag({ cellSize, margin, scalable: true });
    } catch (err) {
      console.warn('[QRCode] Failed to generate SVG:', err);
      return '';
    }
  }
};

export default QRCode;
