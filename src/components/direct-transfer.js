import { toast } from '../utils/toast.js';
import { DirectTransfer, supportsDirectTransfer } from '../core/p2p.js';
import { showCode, showCodeAndWait, receiveCode } from './code-exchange.js';

/**
 * Screen flows for core/p2p.js: one device sends a text straight to another on the same network.
 * Two codes change hands (the sender's offer, the receiver's reply); then the data goes directly.
 */

const UNREACHABLE_HINT = 'The devices could not connect directly (school Wi-Fi often blocks this). Use the school server, QR codes or a file instead.';

/**
 * @returns {Promise<'sent'|'cancelled'|'unreachable'|'failed'>}
 */
export async function sendDirect(text, { label = 'Send directly', receiverSteps = 'On the other device, choose "Receive directly" and scan this code.' } = {}) {
  if (!supportsDirectTransfer()) {
    toast.warning('This browser cannot send directly. Use another way.');
    return 'failed';
  }
  const transfer = new DirectTransfer();
  try {
    const offer = await transfer.createOffer();
    const next = await showCodeAndWait(offer, {
      label,
      intro: receiverSteps,
      hint: 'Both devices must be on the same network.',
      ariaLabel: 'Direct transfer code',
      nextLabel: 'Next: scan the reply'
    });
    if (!next) return 'cancelled';
    const reply = await receiveCode({ label: 'Scan the reply', intro: 'Scan or paste the reply code the other device shows.' });
    if (!reply) return 'cancelled';
    await transfer.acceptAnswer(reply);
    toast.info('Connecting…', 3000);
    await transfer.sendText(text);
    toast.success('Sent directly. The other device confirmed it arrived intact.');
    return 'sent';
  } catch (err) {
    if (err?.code === 'UNREACHABLE') {
      toast.warning(UNREACHABLE_HINT, 10000);
      return 'unreachable';
    }
    toast.danger(err?.message || 'Direct transfer failed.');
    return 'failed';
  } finally {
    transfer.close();
  }
}

/**
 * @returns {Promise<string|null>} the received text
 */
export async function receiveDirect({ label = 'Receive directly', senderSteps = 'Scan or paste the code shown on the sending device.' } = {}) {
  if (!supportsDirectTransfer()) {
    toast.warning('This browser cannot receive directly.');
    return null;
  }
  const offer = await receiveCode({ label, intro: senderSteps });
  if (!offer) return null;
  // The sender still has to scan our reply, so allow minutes, not seconds, before giving up
  const transfer = new DirectTransfer({ connectTimeoutMs: 3 * 60 * 1000 });
  let dialog = null;
  try {
    const reply = await transfer.answerOffer(offer);
    dialog = await showCode(reply, {
      label: 'Show this reply to the sender',
      intro: 'Let the sending device scan this. The transfer starts by itself and this window closes when it is done.',
      ariaLabel: 'Direct transfer reply code'
    });
    // Closing the reply dialog cancels the wait
    const cancelled = new Promise((resolve) => dialog?.addEventListener('sl-after-hide', (e) => { if (e.target === dialog) resolve(null); }));
    const text = await Promise.race([transfer.receiveText(), cancelled]);
    if (text === null) return null;
    dialog?.hide();
    toast.success('Received.');
    return text;
  } catch (err) {
    dialog?.hide();
    if (err?.code === 'UNREACHABLE') toast.warning(UNREACHABLE_HINT, 10000);
    else toast.danger(err?.message || 'Direct transfer failed.');
    return null;
  } finally {
    transfer.close();
  }
}
