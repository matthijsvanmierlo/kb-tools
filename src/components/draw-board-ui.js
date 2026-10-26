import { DrawBoard } from './draw-board.js';

/**
 * DrawBoardUI - Renders a complete interactive drawing canvas with toolbar.
 */
export class DrawBoardUI {
  /**
   * Mounts the DrawBoard and its toolbar into a container element.
   *
   * @param {HTMLElement} container
   * @param {object} [opts]
   * @param {object} [opts.doc]
   * @param {object} [opts.baseDoc]
   * @param {boolean} [opts.readOnly=false]
   * @param {function} [opts.onChange]
   * @returns {{ board: DrawBoard, container: HTMLElement, destroy: () => void }}
   */
  static mount(container, opts = {}) {
    container.innerHTML = '';
    const wrapper = document.createElement('div');
    wrapper.className = 'kb-drawboard-container flex flex-col rounded-xl border border-slate-200 bg-white shadow-xs overflow-hidden';

    const colors = ['#0f172a', '#dc2626', '#2563eb', '#16a34a', '#d97706', '#9333ea'];
    const sizes = [2, 4, 8, 14];

    if (!opts.readOnly) {
      const toolbar = document.createElement('div');
      toolbar.className = 'kb-drawboard-toolbar p-2 border-b border-slate-200 bg-slate-50 flex items-center justify-between gap-2 flex-wrap text-xs';
      toolbar.innerHTML = `
        <div class="flex items-center gap-1 flex-wrap">
          <div class="inline-flex rounded-lg border border-slate-200 bg-white p-0.5 shadow-2xs gap-0.5">
            <button type="button" class="tool-btn px-2.5 py-1 rounded font-medium transition-colors bg-blue-100 text-blue-700" data-tool="pen" title="Pen">
              <sl-icon name="pencil"></sl-icon>
            </button>
            <button type="button" class="tool-btn px-2.5 py-1 rounded font-medium transition-colors text-slate-700 hover:bg-slate-100" data-tool="select" title="Select / Move">
              <sl-icon name="cursor"></sl-icon>
            </button>
            <button type="button" class="tool-btn px-2.5 py-1 rounded font-medium transition-colors text-slate-700 hover:bg-slate-100" data-tool="eraser" title="Eraser">
              <sl-icon name="eraser"></sl-icon>
            </button>
            <button type="button" class="tool-btn px-2.5 py-1 rounded font-medium transition-colors text-slate-700 hover:bg-slate-100" data-tool="rect" title="Rectangle">
              <sl-icon name="square"></sl-icon>
            </button>
            <button type="button" class="tool-btn px-2.5 py-1 rounded font-medium transition-colors text-slate-700 hover:bg-slate-100" data-tool="ellipse" title="Ellipse">
              <sl-icon name="circle"></sl-icon>
            </button>
            <button type="button" class="tool-btn px-2.5 py-1 rounded font-medium transition-colors text-slate-700 hover:bg-slate-100" data-tool="line" title="Line">
              <sl-icon name="slash-lg"></sl-icon>
            </button>
            <button type="button" class="tool-btn px-2.5 py-1 rounded font-medium transition-colors text-slate-700 hover:bg-slate-100" data-tool="arrow" title="Arrow">
              <sl-icon name="arrow-up-right"></sl-icon>
            </button>
            <button type="button" class="tool-btn px-2.5 py-1 rounded font-medium transition-colors text-slate-700 hover:bg-slate-100" data-tool="text" title="Text">
              <sl-icon name="fonts"></sl-icon>
            </button>
          </div>

          <div class="h-4 w-px bg-slate-300 mx-1"></div>

          <!-- Color swatches -->
          <div class="flex items-center gap-1">
            ${colors.map((c, i) => `
              <button type="button" class="color-btn w-6 h-6 rounded-full border border-slate-300 ${i === 2 ? 'ring-2 ring-blue-500 ring-offset-1' : ''}" data-color="${c}" style="background-color: ${c};" title="${c}"></button>
            `).join('')}
          </div>

          <div class="h-4 w-px bg-slate-300 mx-1"></div>

          <!-- Stroke Size -->
          <div class="inline-flex rounded-lg border border-slate-200 bg-white p-0.5 shadow-2xs gap-0.5">
            ${sizes.map((s, i) => `
              <button type="button" class="size-btn px-2 py-0.5 rounded text-[11px] font-medium transition-colors ${i === 1 ? 'bg-blue-100 text-blue-700' : 'text-slate-600 hover:bg-slate-100'}" data-size="${s}">
                ${s}px
              </button>
            `).join('')}
          </div>

          <!-- Fill toggle -->
          <label class="flex items-center gap-1 cursor-pointer text-slate-600 ml-1">
            <input type="checkbox" id="chk-draw-fill" class="rounded text-blue-600"> Fill
          </label>
        </div>

        <div class="flex items-center gap-1">
          <button type="button" id="btn-draw-undo" class="px-2 py-1 rounded border border-slate-200 bg-white hover:bg-slate-100 text-slate-700" title="Undo">
            <sl-icon name="arrow-counterclockwise"></sl-icon>
          </button>
          <button type="button" id="btn-draw-redo" class="px-2 py-1 rounded border border-slate-200 bg-white hover:bg-slate-100 text-slate-700" title="Redo">
            <sl-icon name="arrow-clockwise"></sl-icon>
          </button>
          <button type="button" id="btn-draw-clear" class="px-2.5 py-1 rounded border border-slate-200 bg-white hover:bg-rose-50 text-rose-600 font-medium" title="Clear Canvas">
            Clear
          </button>
        </div>
      `;
      wrapper.appendChild(toolbar);
    }

    const canvasWrapper = document.createElement('div');
    canvasWrapper.className = 'kb-drawboard-canvas-wrap relative w-full bg-white overflow-hidden flex items-center justify-center';
    canvasWrapper.style.minHeight = '360px';
    canvasWrapper.style.touchAction = 'none';

    const canvas = document.createElement('canvas');
    canvas.className = 'w-full h-full block cursor-crosshair';
    canvas.style.aspectRatio = '1000 / 600';
    canvas.style.maxHeight = '600px';

    canvasWrapper.appendChild(canvas);
    wrapper.appendChild(canvasWrapper);
    container.appendChild(wrapper);

    const board = new DrawBoard(canvas, {
      ...opts,
      onChange: (doc) => {
        if (typeof opts.onChange === 'function') opts.onChange(doc);
      }
    });

    // Resize observer to keep aspect ratio sharp
    let ro = null;
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(() => board.resize());
      ro.observe(canvasWrapper);
    }

    if (!opts.readOnly) {
      // Bind toolbar events
      wrapper.querySelectorAll('.tool-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          wrapper.querySelectorAll('.tool-btn').forEach(b => {
            b.classList.remove('bg-blue-100', 'text-blue-700');
            b.classList.add('text-slate-700');
          });
          btn.classList.add('bg-blue-100', 'text-blue-700');
          btn.classList.remove('text-slate-700');
          board.currentTool = btn.dataset.tool;
        });
      });

      wrapper.querySelectorAll('.color-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          wrapper.querySelectorAll('.color-btn').forEach(b => b.classList.remove('ring-2', 'ring-blue-500', 'ring-offset-1'));
          btn.classList.add('ring-2', 'ring-blue-500', 'ring-offset-1');
          board.currentColor = btn.dataset.color;
        });
      });

      wrapper.querySelectorAll('.size-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          wrapper.querySelectorAll('.size-btn').forEach(b => {
            b.classList.remove('bg-blue-100', 'text-blue-700');
            b.classList.add('text-slate-600');
          });
          btn.classList.add('bg-blue-100', 'text-blue-700');
          btn.classList.remove('text-slate-600');
          board.currentSize = Number(btn.dataset.size);
        });
      });

      wrapper.querySelector('#chk-draw-fill')?.addEventListener('change', (e) => {
        board.currentFill = e.target.checked;
      });

      wrapper.querySelector('#btn-draw-undo')?.addEventListener('click', () => board.undo());
      wrapper.querySelector('#btn-draw-redo')?.addEventListener('click', () => board.redo());
      wrapper.querySelector('#btn-draw-clear')?.addEventListener('click', () => {
        if (confirm('Clear the entire canvas?')) board.clear();
      });
    }

    return {
      board,
      container: wrapper,
      destroy: () => {
        if (ro) ro.disconnect();
        board.destroy();
      }
    };
  }
}
