import lzLib from 'lz-string';

const LZString = lzLib.compressToEncodedURIComponent ? lzLib : (lzLib.default || lzLib);

/**
 * CryptoShareEngine - KB-CORE-004
 * Zero-backend cryptographic sharing using Web Crypto API (PBKDF2 + AES-GCM 256)
 * and LZ-String URL serialization.
 */
export class CryptoShareEngine {
  /**
   * Derive AES-GCM key from passphrase and 16-byte salt via PBKDF2
   * @param {string} passphrase
   * @param {Uint8Array} saltUint8
   * @returns {Promise<CryptoKey>}
   */
  static async deriveKey(passphrase, saltUint8) {
    const enc = new TextEncoder();
    const subtle = typeof crypto !== 'undefined' ? crypto.subtle : globalThis.crypto?.subtle;
    if (!subtle) throw new Error('Web Crypto API is not available');

    const keyMaterial = await subtle.importKey(
      'raw',
      enc.encode(passphrase),
      { name: 'PBKDF2' },
      false,
      ['deriveKey']
    );

    return subtle.deriveKey(
      {
        name: 'PBKDF2',
        salt: saltUint8,
        iterations: 100000,
        hash: 'SHA-256'
      },
      keyMaterial,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  }

  /**
   * Serialize and optionally encrypt a payload for URL or .kbshare file sharing
   * @param {string} moduleType - 'flashcards' | 'timeline' | 'video' | 'gradebook' | 'student_grade_report'
   * @param {object} dataObject - Dataset to share
   * @param {string} [passphrase=''] - Optional encryption passphrase
   * @returns {Promise<{ url: string, exceedsUrlLimit: boolean, rawFileContent: string, length: number }>}
   */
  static async createSharePayload(moduleType, dataObject, passphrase = '') {
    const envelope = JSON.stringify({ v: 1, type: moduleType, payload: dataObject });
    let compressed;
    let isEncrypted = false;

    if (passphrase && passphrase.trim().length > 0) {
      isEncrypted = true;
      const subtle = typeof crypto !== 'undefined' ? crypto.subtle : globalThis.crypto?.subtle;
      const salt = crypto.getRandomValues(new Uint8Array(16));
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const key = await this.deriveKey(passphrase, salt);
      const plaintextBytes = new TextEncoder().encode(envelope);
      const ciphertextBuf = await subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintextBytes);

      const packed = new Uint8Array(16 + 12 + ciphertextBuf.byteLength);
      packed.set(salt, 0);
      packed.set(iv, 16);
      packed.set(new Uint8Array(ciphertextBuf), 28);

      // Convert binary Uint8Array to binary string for LZString
      let binStr = '';
      for (let i = 0; i < packed.byteLength; i++) {
        binStr += String.fromCharCode(packed[i]);
      }
      compressed = LZString.compressToEncodedURIComponent(binStr);
    } else {
      compressed = LZString.compressToEncodedURIComponent(envelope);
    }

    const baseUrl = typeof window !== 'undefined'
      ? `${window.location.origin}${window.location.pathname}`
      : 'http://localhost/';
    const shareUrl = `${baseUrl}#/share?enc=${isEncrypted ? '1' : '0'}&d=${compressed}`;

    return {
      url: shareUrl,
      exceedsUrlLimit: shareUrl.length > 2048,
      length: shareUrl.length,
      rawFileContent: JSON.stringify({ enc: isEncrypted ? 1 : 0, d: compressed })
    };
  }

  /**
   * Unpack and optionally decrypt a shared payload
   * @param {string} dParam - LZString-compressed payload string
   * @param {boolean} isEncrypted - Whether AES-GCM decryption is required
   * @param {string} [passphrase=''] - User-entered passphrase
   * @returns {Promise<{ v: number, type: string, payload: any }>}
   */
  static async unpackSharePayload(dParam, isEncrypted, passphrase = '') {
    const decompressed = LZString.decompressFromEncodedURIComponent(dParam);
    if (!decompressed) throw new Error('CORRUPTED_PAYLOAD');

    if (!isEncrypted) {
      try {
        return JSON.parse(decompressed);
      } catch (e) {
        throw new Error('CORRUPTED_PAYLOAD');
      }
    }

    const packed = new Uint8Array(decompressed.length);
    for (let i = 0; i < decompressed.length; i++) {
      packed[i] = decompressed.charCodeAt(i);
    }

    if (packed.length < 28) {
      throw new Error('CORRUPTED_PAYLOAD');
    }

    const salt = packed.slice(0, 16);
    const iv = packed.slice(16, 28);
    const ciphertext = packed.slice(28);

    const subtle = typeof crypto !== 'undefined' ? crypto.subtle : globalThis.crypto?.subtle;
    const key = await this.deriveKey(passphrase, salt);

    try {
      const decryptedBuf = await subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
      const jsonStr = new TextDecoder().decode(decryptedBuf);
      return JSON.parse(jsonStr);
    } catch (err) {
      throw new Error('INVALID_PASSPHRASE');
    }
  }

  /**
   * Helper to trigger download of a .kbshare file
   */
  static downloadKbShareFile(rawFileContent, filename = 'lesson.kbshare') {
    if (typeof document === 'undefined') return;
    const blob = new Blob([rawFileContent], { type: 'application/json' });
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
}

export default CryptoShareEngine;
