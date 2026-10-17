import lzLib from 'lz-string';
import * as jspdfLib from 'jspdf';
import * as autotableLib from 'jspdf-autotable';

const LZString = lzLib.compressToEncodedURIComponent ? lzLib : (lzLib.default || lzLib);
const jsPDFClass = jspdfLib.jsPDF || jspdfLib.default;
const autoTable = autotableLib.autoTable || autotableLib.default;

/**
 * Kiosk Performance Report & Cryptographic Receipt (.kbr) (KB-VID-002)
 */
export class KioskReportEngine {
  /**
   * Compute hex SHA-256 digest of a string
   * @param {string} text
   * @returns {Promise<string>} Hex string
   */
  static async computeSHA256Hex(text) {
    const subtle = typeof crypto !== 'undefined' ? crypto.subtle : globalThis.crypto?.subtle;
    if (!subtle) throw new Error('Web Crypto API is not available');

    const bytes = new TextEncoder().encode(text);
    const hashBuf = await subtle.digest('SHA-256', bytes);
    const hashArray = Array.from(new Uint8Array(hashBuf));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  }

  /**
   * Generate signed .kbr receipt payload
   */
  static async generateReceipt(studentName, assessmentId, assessmentTitle, responseLogs, totalScore, maxScore) {
    const completedAt = new Date().toISOString();
    const signaturePayload = `${studentName}|${assessmentId}|${totalScore}|${completedAt}|${JSON.stringify(responseLogs)}`;
    const signature = await this.computeSHA256Hex(signaturePayload);

    const receipt = {
      version: 1,
      studentName,
      assessmentId,
      assessmentTitle,
      totalScore,
      maxScore,
      percent: maxScore > 0 ? Math.round((totalScore / maxScore) * 100) : 100,
      completedAt,
      responseLogs,
      signature
    };

    const compressed = LZString.compressToEncodedURIComponent(JSON.stringify(receipt));

    return {
      receipt,
      kbrString: compressed,
      filename: `${studentName.replace(/\s+/g, '_')}_result.kbr`
    };
  }

  /**
   * Verify an imported .kbr file string
   */
  static async verifyReceipt(kbrString) {
    const decompressed = LZString.decompressFromEncodedURIComponent(kbrString.trim());
    if (!decompressed) {
      return { isValid: false, error: 'CORRUPTED_OR_INVALID_FILE' };
    }

    let receipt;
    try {
      receipt = JSON.parse(decompressed);
    } catch (_) {
      return { isValid: false, error: 'INVALID_JSON_STRUCTURE' };
    }

    if (!receipt.studentName || !receipt.assessmentId || !receipt.signature) {
      return { isValid: false, error: 'MISSING_MANDATORY_FIELDS' };
    }

    const payload = `${receipt.studentName}|${receipt.assessmentId}|${receipt.totalScore}|${receipt.completedAt}|${JSON.stringify(receipt.responseLogs)}`;
    const expectedSig = await this.computeSHA256Hex(payload);

    const isValid = expectedSig === receipt.signature;
    return {
      isValid,
      receipt,
      error: isValid ? null : 'CRYPTOGRAPHIC_SIGNATURE_MISMATCH'
    };
  }

  /**
   * Download .kbr file to client
   */
  static downloadKBRFile(kbrString, filename) {
    if (typeof document === 'undefined') return;
    const blob = new Blob([kbrString], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      a.remove();
      URL.revokeObjectURL(url);
    }, 100);
  }

  /**
   * Generate and trigger PDF download of student performance report
   */
  static generatePDFReport(receipt) {
    const doc = new jsPDFClass({ orientation: 'portrait', unit: 'pt', format: 'letter' });

    // Header block
    doc.setFillColor(30, 41, 59); // Slate 800
    doc.rect(0, 0, 612, 60, 'F');

    doc.setTextColor(255, 255, 255);
    doc.setFontSize(18);
    doc.text('Video Assessment Performance Report', 40, 36);

    doc.setTextColor(30, 41, 59);
    doc.setFontSize(11);
    doc.text(`Student Name: ${receipt.studentName}`, 40, 90);
    doc.text(`Assessment: ${receipt.assessmentTitle}`, 40, 106);
    doc.text(`Completed: ${receipt.completedAt.replace('T', ' ').slice(0, 19)} UTC`, 40, 122);
    doc.text(`Final Score: ${receipt.totalScore} / ${receipt.maxScore} (${receipt.percent}%)`, 40, 138);

    doc.setFontSize(8);
    doc.setTextColor(100, 116, 139);
    doc.text(`Cryptographic Signature (SHA-256): ${receipt.signature}`, 40, 160);

    const rows = (receipt.responseLogs || []).map((log, idx) => [
      `#${idx + 1}`,
      Array.isArray(log.studentAnswer) ? log.studentAnswer.join(', ') : String(log.studentAnswer || ''),
      log.isCorrect ? 'Pass' : 'Review Needed',
      `${log.earnedPoints} / ${log.maxPoints}`,
      `${(log.latencyMs / 1000).toFixed(1)}s`
    ]);

    if (typeof doc.autoTable === 'function') {
      doc.autoTable({
        startY: 180,
        head: [['Question', 'Student Answer', 'Result', 'Score', 'Response Time']],
        body: rows,
        theme: 'grid',
        headStyles: { fillColor: [37, 99, 235] },
        styles: { fontSize: 9 }
      });
    } else if (typeof autoTable === 'function') {
      autoTable(doc, {
        startY: 180,
        head: [['Question', 'Student Answer', 'Result', 'Score', 'Response Time']],
        body: rows,
        theme: 'grid',
        headStyles: { fillColor: [37, 99, 235] },
        styles: { fontSize: 9 }
      });
    }

    doc.save(`${receipt.studentName.replace(/\s+/g, '_')}_Report.pdf`);
    return doc;
  }
}

export default KioskReportEngine;
