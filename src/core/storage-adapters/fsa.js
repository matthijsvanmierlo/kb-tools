/**
 * File System Access backup locations.
 *
 * FsaFolderAdapter is the zero-setup cloud option: pick a folder that Google Drive for desktop,
 * OneDrive or ChromeOS Files → Google Drive already syncs, and the school's cloud receives the
 * encrypted files with no sign-in or admin configuration. FsaFileAdapter is the original single
 * auto-sync file (no rotation), kept for existing setups.
 */

async function permission(handle, interactive) {
  if (typeof handle.queryPermission !== 'function') return 'granted';
  const state = await handle.queryPermission({ mode: 'readwrite' });
  if (state !== 'prompt' || !interactive) return state;
  return handle.requestPermission({ mode: 'readwrite' });
}

/** createWritable writes to a temporary file that replaces the target only on close() */
async function writeAtomically(fileHandle, text) {
  const writable = await fileHandle.createWritable();
  try {
    await writable.write(text);
    await writable.close();
  } catch (err) {
    await writable.abort?.().catch(() => {});
    throw err;
  }
}

export class FsaFolderAdapter {
  constructor(dirHandle) {
    this.handle = dirHandle;
    this.id = 'fsa-folder';
    this.rotates = true;
  }

  get label() {
    return `Folder “${this.handle.name || 'backups'}”`;
  }

  static async pick() {
    const handle = await window.showDirectoryPicker({ id: 'kennisboost-backups', mode: 'readwrite', startIn: 'documents' });
    return new FsaFolderAdapter(handle);
  }

  access({ interactive = false } = {}) {
    return permission(this.handle, interactive);
  }

  async put(name, text) {
    await writeAtomically(await this.handle.getFileHandle(name, { create: true }), text);
  }

  async get(name) {
    try {
      const file = await (await this.handle.getFileHandle(name)).getFile();
      return file.text();
    } catch (err) {
      if (err?.name === 'NotFoundError') return null;
      throw err;
    }
  }

  async list() {
    const out = [];
    for await (const [name, entry] of this.handle.entries()) {
      if (entry.kind !== 'file') continue;
      let modified = null;
      try {
        modified = new Date((await entry.getFile()).lastModified).toISOString();
      } catch (_) {}
      out.push({ name, modified });
    }
    return out;
  }

  async delete(name) {
    try {
      await this.handle.removeEntry(name);
    } catch (err) {
      if (err?.name !== 'NotFoundError') throw err;
    }
  }

  toConfig() {
    return { type: 'fsa-folder', handle: this.handle };
  }
}

export class FsaFileAdapter {
  constructor(fileHandle) {
    this.handle = fileHandle;
    this.id = 'fsa-file';
    this.rotates = false;
  }

  get label() {
    return `File “${this.handle.name || 'backup'}”`;
  }

  access({ interactive = false } = {}) {
    return permission(this.handle, interactive);
  }

  /** A single file holds only the latest backup, whatever name is asked for */
  async put(_name, text) {
    await writeAtomically(this.handle, text);
  }

  async get() {
    return (await this.handle.getFile()).text();
  }

  async list() {
    return [{ name: this.handle.name, modified: null }];
  }

  async delete() {}

  toConfig() {
    return { type: 'fsa-file', handle: this.handle };
  }
}
