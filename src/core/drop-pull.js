import { storage } from './storage.js';

/**
 * Shared lossless pull function for relay drop boxes (R3).
 *
 * Loops keyset pages until `more` is false.
 * Calls `onItem(item, dropId)` for each item.
 * Collects failures as `{ id, error, item }` without stopping the loop.
 * Advances cursor in `relay_cursors[dropId]` to the last item processed,
 * whether it succeeded or failed, so bad items don't block the queue.
 * Drains `dropHistory` (e.g. `publish.relay_history`) as well as the active `dropId`.
 *
 * @param {object} opts
 * @param {object} opts.transport - RelayTransport instance
 * @param {string} opts.dropId - active drop box ID
 * @param {Array<string|object>} [opts.dropHistory] - previous drop box records / IDs
 * @param {Function} opts.onItem - async function(item, dropId) returning { duplicate?: boolean }
 * @returns {Promise<{ count: number, imported: number, duplicates: number, failures: Array<{ id: string, error: string, item?: object }> }>}
 */
export async function pullDrop({ transport, dropId, dropHistory = [], onItem }) {
  if (!transport || !dropId) {
    return { count: 0, imported: 0, duplicates: 0, failures: [] };
  }

  const allDrops = [dropId];
  if (Array.isArray(dropHistory)) {
    for (const h of dropHistory) {
      const oldId = typeof h === 'string' ? h : (h?.drop_id || h?.id);
      if (oldId && !allDrops.includes(oldId)) {
        allDrops.push(oldId);
      }
    }
  }

  const cursors = (await storage.getMetadata('relay_cursors')) || {};
  let totalCount = 0;
  let importedCount = 0;
  let dupCount = 0;
  const failures = [];

  for (const dId of allDrops) {
    let after = cursors[dId] || null;
    let hasMore = true;

    while (hasMore) {
      let page;
      try {
        page = await transport.listDrop(dId, { after, limit: 100 });
      } catch (err) {
        console.warn(`[drop-pull] Failed to fetch drop ${dId}:`, err);
        failures.push({ id: dId, error: err.message || String(err) });
        break;
      }

      const items = page.items || [];
      if (!items.length) {
        hasMore = false;
        break;
      }

      for (const item of items) {
        totalCount++;
        try {
          const res = await onItem(item, dId);
          if (res?.duplicate) {
            dupCount++;
          } else {
            importedCount++;
          }
        } catch (itemErr) {
          console.warn(`[drop-pull] Error processing item ${item.id} from drop ${dId}:`, itemErr);
          failures.push({ id: item.id || `sub_${totalCount}`, error: itemErr.message || String(itemErr), item });
        }

        // Advance cursor to last processed item
        if (item.received_at && item.id) {
          after = `${item.received_at}|${item.id}`;
        } else if (item.received_at) {
          after = item.received_at;
        }
      }

      cursors[dId] = after;
      await storage.setMetadata('relay_cursors', cursors);

      hasMore = Boolean(page.more && page.next_after);
    }
  }

  return {
    count: totalCount,
    imported: importedCount,
    duplicates: dupCount,
    failures
  };
}
