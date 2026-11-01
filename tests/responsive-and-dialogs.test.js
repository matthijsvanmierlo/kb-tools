// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AlertDialog, ConfirmDialog, PromptDialog, kbModal } from '../src/utils/dialogs.js';
import { validateRelayUrl } from '../src/modules/settings/index.js';
import fs from 'node:fs';
import path from 'node:path';

describe('Responsive UI & Accessible Dialogs (WS5)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  describe('AlertDialog.show', () => {
    it('creates a dialog and resolves when OK is clicked', async () => {
      const promise = AlertDialog.show({
        title: 'Heads Up',
        message: 'Something happened!',
        okText: 'Understood'
      });

      const dialog = document.querySelector('sl-dialog.kb-alert-dialog');
      expect(dialog).not.toBeNull();
      expect(dialog.label).toBe('Heads Up');
      expect(dialog.textContent).toContain('Something happened!');

      const okBtn = dialog.querySelector('#kb-dialog-ok');
      expect(okBtn.textContent).toBe('Understood');

      okBtn.click();
      await promise;
    });
  });

  describe('ConfirmDialog.show', () => {
    it('resolves true when confirmed', async () => {
      const promise = ConfirmDialog.show({
        title: 'Delete Item',
        message: 'Are you sure?',
        confirmText: 'Yes, Delete',
        cancelText: 'No'
      });

      const dialog = document.querySelector('sl-dialog.kb-confirm-dialog');
      expect(dialog).not.toBeNull();
      const confirmBtn = dialog.querySelector('#kb-dialog-confirm');
      confirmBtn.click();

      const res = await promise;
      expect(res).toBe(true);
    });

    it('resolves false when cancelled', async () => {
      const promise = ConfirmDialog.show({
        title: 'Delete Item',
        message: 'Are you sure?'
      });

      const dialog = document.querySelector('sl-dialog.kb-confirm-dialog');
      const cancelBtn = dialog.querySelector('#kb-dialog-cancel');
      cancelBtn.click();

      const res = await promise;
      expect(res).toBe(false);
    });
  });

  describe('PromptDialog.show', () => {
    it('resolves with entered text when confirmed', async () => {
      const promise = PromptDialog.show({
        title: 'Rename File',
        defaultValue: 'initial.txt'
      });

      const dialog = document.querySelector('sl-dialog.kb-prompt-dialog');
      const input = dialog.querySelector('#kb-prompt-input');
      input.value = 'updated.txt';

      const confirmBtn = dialog.querySelector('#kb-dialog-confirm');
      confirmBtn.click();

      const res = await promise;
      expect(res).toBe('updated.txt');
    });

    it('resolves with null when cancelled', async () => {
      const promise = PromptDialog.show({
        title: 'Rename File'
      });

      const dialog = document.querySelector('sl-dialog.kb-prompt-dialog');
      const cancelBtn = dialog.querySelector('#kb-dialog-cancel');
      cancelBtn.click();

      const res = await promise;
      expect(res).toBeNull();
    });
  });

  describe('kbModal', () => {
    it('opens modal with custom actions and resolves selected action', async () => {
      const promise = kbModal({
        title: 'Test Modal',
        body: '<p id="modal-test-content">Content</p>',
        actions: [
          { value: 'cancel', label: 'Cancel', dismiss: true },
          { value: 'save', label: 'Save', variant: 'primary' }
        ]
      });

      const dialog = document.querySelector('sl-dialog.kb-dialog-sheet');
      expect(dialog).not.toBeNull();
      expect(dialog.label).toBe('Test Modal');

      const saveBtn = dialog.querySelector('[data-kb-action="save"]');
      saveBtn.click();

      // Trigger after-hide cleanup
      dialog.dispatchEvent(new Event('sl-after-hide'));

      const res = await promise;
      expect(res).not.toBeNull();
      expect(res.value).toBe('save');
    });
  });

  describe('validateRelayUrl', () => {
    it('allows https URLs', () => {
      expect(validateRelayUrl('https://relay.example.com').valid).toBe(true);
    });

    it('allows localhost and 127.0.0.1 over http', () => {
      expect(validateRelayUrl('http://localhost:8787').valid).toBe(true);
      expect(validateRelayUrl('http://127.0.0.1:8787').valid).toBe(true);
    });

    it('allows local mDNS .local over http', () => {
      expect(validateRelayUrl('http://raspberrypi.local:8787').valid).toBe(true);
    });

    it('rejects public http URLs', () => {
      const res = validateRelayUrl('http://public-relay.example.com');
      expect(res.valid).toBe(false);
      expect(res.error).toContain('HTTPS');
    });

    it('rejects invalid or empty URLs', () => {
      expect(validateRelayUrl('').valid).toBe(false);
      expect(validateRelayUrl('not a url').valid).toBe(false);
    });
  });

  describe('CSS safe area & 44px icon buttons', () => {
    it('contains .kb-icon-btn with min 44px target and safe-area styles in app.css', () => {
      const cssPath = path.resolve(__dirname, '../css/app.css');
      const css = fs.readFileSync(cssPath, 'utf8');

      expect(css).toMatch(/\.kb-icon-btn\s*\{[^}]*width:\s*44px/);
      expect(css).toMatch(/\.kb-icon-btn\s*\{[^}]*height:\s*44px/);
      expect(css).toContain('safe-area-inset-top');
      expect(css).toContain('safe-area-inset-bottom');
      expect(css).toContain('kb-debug-safe-area');
      expect(css).toContain('100dvh');
    });
  });
});
