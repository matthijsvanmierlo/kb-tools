import { generateUUID } from '../utils/uuid.js';
import { normalizeSketchData } from '../core/validator.js';

/**
 * DrawBoard - Vector Drawing and Annotation Board (KB-DRAW-001)
 *
 * Supports pen strokes, shapes (rect, ellipse, line, arrow), text, element selection/deletion,
 * 50-step undo/redo, and read-only student base layer for teacher annotation overlay.
 * Uses logical 1000x600 coordinate space.
 */

export class DrawBoard {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {object} [opts]
   * @param {object} [opts.doc] - editable document { version: 2, width: 1000, height: 600, elements: [] }
   * @param {object} [opts.baseDoc] - read-only underlying student document
   * @param {boolean} [opts.readOnly=false]
   * @param {function} [opts.onChange]
   */
  constructor(canvas, opts = {}) {
    if (canvas && !canvas.getContext && typeof canvas === 'object' && canvas.tagName !== 'CANVAS') {
      opts = canvas;
      canvas = null;
    }
    this.canvas = canvas || (typeof document !== 'undefined' ? document.createElement('canvas') : null);
    this.ctx = this.canvas && this.canvas.getContext ? this.canvas.getContext('2d') : null;
    this.logicalWidth = opts.width || 1000;
    this.logicalHeight = opts.height || 600;

    this.readOnly = Boolean(opts.readOnly);
    this.baseDoc = opts.baseDoc ? normalizeSketchData(opts.baseDoc) : null;
    this.doc = normalizeSketchData(opts.doc);

    this.currentTool = 'pen'; // 'pen' | 'eraser' | 'select' | 'rect' | 'ellipse' | 'line' | 'arrow' | 'text'
    this.currentColor = opts.color || '#2563eb';
    this.currentSize = opts.size || 4;
    this.currentFill = Boolean(opts.fill);
    this.fontSize = opts.fontSize || 20;

    this.selectedElementId = null;
    this.isDragging = false;
    this.dragStart = null;
    this.currentElement = null;

    this.undoStack = [];
    this.redoStack = [];
    this.maxHistory = 50;
    this.onChange = opts.onChange || null;

    this._init();
  }

  _init() {
    if (this.canvas && this.canvas.classList) {
      this.canvas.classList.add('kb-draw-board');
    }
    this.resize();
    if (!this.readOnly && this.canvas && typeof this.canvas.addEventListener === 'function') {
      this._bindEvents();
    }
  }

  resize() {
    if (!this.canvas) return;
    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    const rect = this.canvas.getBoundingClientRect ? this.canvas.getBoundingClientRect() : { width: 500, height: 300 };
    const width = rect.width || 500;
    const height = rect.height || 300;

    this.canvas.width = width * dpr;
    this.canvas.height = height * dpr;
    if (this.ctx) {
      if (this.ctx.resetTransform) this.ctx.resetTransform();
      if (this.ctx.scale) this.ctx.scale((width * dpr) / this.logicalWidth, (height * dpr) / this.logicalHeight);
    }
    this.redraw();
  }

  _bindEvents() {
    this.canvas.addEventListener('pointerdown', (e) => this._onPointerDown(e));
    this.canvas.addEventListener('pointermove', (e) => this._onPointerMove(e));
    this.canvas.addEventListener('pointerup', (e) => this._onPointerUp(e));
    this.canvas.addEventListener('pointercancel', (e) => this._onPointerUp(e));

    // Keyboard shortcuts: Delete/Backspace removes selected element
    if (typeof window !== 'undefined') {
      this._keydownHandler = (e) => {
        if ((e.key === 'Delete' || e.key === 'Backspace') && this.selectedElementId) {
          const target = e.target;
          if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
          this.deleteSelected();
        }
      };
      window.addEventListener('keydown', this._keydownHandler);
    }
  }

  _getNormalizedPoint(e) {
    const rect = this.canvas.getBoundingClientRect ? this.canvas.getBoundingClientRect() : { left: 0, top: 0, width: 500, height: 300 };
    const clientX = e.clientX - rect.left;
    const clientY = e.clientY - rect.top;

    const x = Math.round((clientX / (rect.width || 500)) * this.logicalWidth);
    const y = Math.round((clientY / (rect.height || 300)) * this.logicalHeight);
    const p = Math.round((e.pressure || 0.5) * 100) / 100;
    return [Math.max(0, Math.min(this.logicalWidth, x)), Math.max(0, Math.min(this.logicalHeight, y)), p];
  }

  _onPointerDown(e) {
    if (this.readOnly) return;
    this.isDragging = true;
    const [x, y, p] = this._getNormalizedPoint(e);
    this.dragStart = { x, y };

    if (this.currentTool === 'select') {
      const hit = this.hitTest(x, y);
      this.selectedElementId = hit ? hit.id : null;
      if (hit) {
        this.selectedElementInitial = JSON.parse(JSON.stringify(hit));
      }
      this.redraw();
      return;
    }

    if (this.currentTool === 'eraser') {
      const hit = this.hitTest(x, y);
      if (hit) {
        this._recordOp({ type: 'delete', element: JSON.parse(JSON.stringify(hit)) });
        this.doc.elements = this.doc.elements.filter(el => el.id !== hit.id);
        this._notify();
        this.redraw();
      }
      return;
    }

    if (this.currentTool === 'text') {
      this._promptText(x, y);
      this.isDragging = false;
      return;
    }

    if (this.currentTool === 'pen') {
      this.currentElement = {
        id: generateUUID(),
        type: 'stroke',
        color: this.currentColor,
        size: this.currentSize,
        points: [[x, y, p]]
      };
      return;
    }

    // Shapes: rect, ellipse, line, arrow
    if (['rect', 'ellipse', 'line', 'arrow'].includes(this.currentTool)) {
      this.currentElement = {
        id: generateUUID(),
        type: 'shape',
        shape: this.currentTool,
        x,
        y,
        w: 0,
        h: 0,
        color: this.currentColor,
        size: this.currentSize,
        fill: this.currentFill
      };
    }
  }

  _onPointerMove(e) {
    if (!this.isDragging) return;
    const [x, y, p] = this._getNormalizedPoint(e);

    if (this.currentTool === 'select' && this.selectedElementId) {
      const el = this.doc.elements.find(item => item.id === this.selectedElementId);
      if (el && this.dragStart) {
        const dx = x - this.dragStart.x;
        const dy = y - this.dragStart.y;
        this._moveElement(el, dx, dy);
        this.dragStart = { x, y };
        this.redraw();
      }
      return;
    }

    if (this.currentTool === 'eraser') {
      const hit = this.hitTest(x, y);
      if (hit) {
        this._recordOp({ type: 'delete', element: JSON.parse(JSON.stringify(hit)) });
        this.doc.elements = this.doc.elements.filter(item => item.id !== hit.id);
        this._notify();
        this.redraw();
      }
      return;
    }

    if (this.currentElement) {
      if (this.currentElement.type === 'stroke') {
        this.currentElement.points.push([x, y, p]);
        this.redraw();
      } else if (this.currentElement.type === 'shape') {
        this.currentElement.w = x - this.dragStart.x;
        this.currentElement.h = y - this.dragStart.y;
        this.redraw();
      }
    }
  }

  _onPointerUp() {
    if (!this.isDragging) return;
    this.isDragging = false;

    if (this.currentTool === 'select' && this.selectedElementId && this.selectedElementInitial) {
      const current = this.doc.elements.find(item => item.id === this.selectedElementId);
      if (current && JSON.stringify(current) !== JSON.stringify(this.selectedElementInitial)) {
        this._recordOp({
          type: 'move',
          id: current.id,
          before: this.selectedElementInitial,
          after: JSON.parse(JSON.stringify(current))
        });
        this._notify();
      }
      this.selectedElementInitial = null;
      return;
    }

    if (this.currentElement) {
      // Ignore zero-size shapes/strokes
      let keep = true;
      if (this.currentElement.type === 'stroke' && this.currentElement.points.length < 2) keep = false;
      if (this.currentElement.type === 'shape' && Math.abs(this.currentElement.w) < 3 && Math.abs(this.currentElement.h) < 3) keep = false;

      if (keep) {
        // Normalize rect/ellipse coordinates so w,h are positive
        if (this.currentElement.shape === 'rect' || this.currentElement.shape === 'ellipse') {
          if (this.currentElement.w < 0) {
            this.currentElement.x += this.currentElement.w;
            this.currentElement.w = Math.abs(this.currentElement.w);
          }
          if (this.currentElement.h < 0) {
            this.currentElement.y += this.currentElement.h;
            this.currentElement.h = Math.abs(this.currentElement.h);
          }
        }
        this.doc.elements.push(this.currentElement);
        this._recordOp({ type: 'add', element: JSON.parse(JSON.stringify(this.currentElement)) });
        this._notify();
      }
      this.currentElement = null;
      this.redraw();
    }
  }

  _moveElement(el, dx, dy) {
    if (el.type === 'stroke') {
      el.points = el.points.map(([px, py, pp]) => [px + dx, py + dy, pp]);
    } else if (el.type === 'shape' || el.type === 'text') {
      el.x += dx;
      el.y += dy;
    }
  }

  _promptText(x, y) {
    const text = prompt('Enter text for canvas:');
    if (text && text.trim()) {
      const el = {
        id: generateUUID(),
        type: 'text',
        x,
        y,
        text: text.trim(),
        color: this.currentColor,
        fontSize: this.fontSize
      };
      this.doc.elements.push(el);
      this._recordOp({ type: 'add', element: JSON.parse(JSON.stringify(el)) });
      this._notify();
      this.redraw();
    }
  }

  deleteSelected() {
    if (!this.selectedElementId) return;
    const hit = this.doc.elements.find(el => el.id === this.selectedElementId);
    if (hit) {
      this._recordOp({ type: 'delete', element: JSON.parse(JSON.stringify(hit)) });
      this.doc.elements = this.doc.elements.filter(el => el.id !== this.selectedElementId);
      this.selectedElementId = null;
      this._notify();
      this.redraw();
    }
  }

  hitTest(x, y) {
    // Test top-to-bottom (newest first)
    for (let i = this.doc.elements.length - 1; i >= 0; i--) {
      const el = this.doc.elements[i];
      if (DrawBoard.hitTestElement(el, x, y)) {
        return el;
      }
    }
    return null;
  }

  static hitTestElement(el, x, y) {
    if (!el) return false;
    const pad = 6;
    const shapeType = el.shape || el.type;

    if (el.type === 'stroke' || el.type === 'path') {
      const radius = ((el.size || el.width || 3) / 2) + pad;
      for (const pt of el.points || []) {
        const px = Array.isArray(pt) ? pt[0] : pt.x;
        const py = Array.isArray(pt) ? pt[1] : pt.y;
        const dist = Math.hypot(px - x, py - y);
        if (dist <= radius) return true;
      }
      return false;
    }

    if (el.type === 'shape' || shapeType === 'rect' || shapeType === 'ellipse' || shapeType === 'line' || shapeType === 'arrow') {
      const size = el.size || el.width || 3;
      if (shapeType === 'rect') {
        const minX = Math.min(el.x, el.x + el.w);
        const maxX = Math.max(el.x, el.x + el.w);
        const minY = Math.min(el.y, el.y + el.h);
        const maxY = Math.max(el.y, el.y + el.h);
        if (el.fill) {
          return x >= minX - pad && x <= maxX + pad && y >= minY - pad && y <= maxY + pad;
        }
        // Outline hit test
        const inOuter = x >= minX - pad && x <= maxX + pad && y >= minY - pad && y <= maxY + pad;
        const inInner = x > minX + size + pad && x < maxX - size - pad && y > minY + size + pad && y < maxY - size - pad;
        return inOuter && !inInner;
      }

      if (shapeType === 'ellipse') {
        const rx = Math.abs(el.w) / 2;
        const ry = Math.abs(el.h) / 2;
        if (rx === 0 || ry === 0) return false;
        const cx = el.x + el.w / 2;
        const cy = el.y + el.h / 2;
        const norm = Math.pow((x - cx) / (rx + pad), 2) + Math.pow((y - cy) / (ry + pad), 2);
        if (el.fill) return norm <= 1;
        const innerNorm = Math.pow((x - cx) / Math.max(1, rx - pad - size), 2) + Math.pow((y - cy) / Math.max(1, ry - pad - size), 2);
        return norm <= 1 && innerNorm >= 1;
      }

      if (shapeType === 'line' || shapeType === 'arrow') {
        const x1 = el.x;
        const y1 = el.y;
        const x2 = el.x + el.w;
        const y2 = el.y + el.h;
        const dist = distToSegment({ x, y }, { x: x1, y: y1 }, { x: x2, y: y2 });
        return dist <= (size / 2) + pad;
      }
    }

    if (el.type === 'text') {
      const fs = el.fontSize || 20;
      const w = (el.text || '').length * (fs * 0.6);
      return x >= el.x - pad && x <= el.x + w + pad && y >= el.y - fs - pad && y <= el.y + pad;
    }

    return false;
  }

  _recordOp(op) {
    this.undoStack.push(op);
    if (this.undoStack.length > this.maxHistory) this.undoStack.shift();
    this.redoStack = [];
  }

  undo() {
    if (!this.undoStack.length) return false;
    const op = this.undoStack.pop();
    this.redoStack.push(op);

    if (op.type === 'add') {
      this.doc.elements = this.doc.elements.filter(el => el.id !== op.element.id);
    } else if (op.type === 'delete') {
      this.doc.elements.push(op.element);
    } else if (op.type === 'move') {
      const idx = this.doc.elements.findIndex(el => el.id === op.id);
      if (idx !== -1) this.doc.elements[idx] = JSON.parse(JSON.stringify(op.before));
    }

    this._notify();
    this.redraw();
    return true;
  }

  redo() {
    if (!this.redoStack.length) return false;
    const op = this.redoStack.pop();
    this.undoStack.push(op);

    if (op.type === 'add') {
      this.doc.elements.push(op.element);
    } else if (op.type === 'delete') {
      this.doc.elements = this.doc.elements.filter(el => el.id !== op.element.id);
    } else if (op.type === 'move') {
      const idx = this.doc.elements.findIndex(el => el.id === op.id);
      if (idx !== -1) this.doc.elements[idx] = JSON.parse(JSON.stringify(op.after));
    }

    this._notify();
    this.redraw();
    return true;
  }

  clear() {
    if (!this.doc.elements.length) return;
    this._recordOp({
      type: 'clear',
      elements: JSON.parse(JSON.stringify(this.doc.elements))
    });
    this.doc.elements = [];
    this.selectedElementId = null;
    this._notify();
    this.redraw();
  }

  _notify() {
    if (typeof this.onChange === 'function') {
      this.onChange(this.getDoc());
    }
  }

  getDoc() {
    return JSON.parse(JSON.stringify(this.doc));
  }

  toJSON() {
    return this.getDoc();
  }

  getElements() {
    return this.doc.elements;
  }

  addElement(el) {
    if (!el) return null;
    const item = { ...el };
    if (!item.id) item.id = 'el_' + Math.random().toString(36).slice(2, 10);
    this.doc.elements.push(item);
    this._recordOp({ type: 'add', element: JSON.parse(JSON.stringify(item)) });
    this._notify();
    this.redraw();
    return item;
  }

  canUndo() {
    return this.undoStack.length > 0;
  }

  canRedo() {
    return this.redoStack.length > 0;
  }

  getElementAt(x, y) {
    return this.hitTest(x, y);
  }

  redraw() {
    if (!this.ctx) return;
    this.ctx.clearRect(0, 0, this.logicalWidth, this.logicalHeight);

    // 1. Render base student document (if in teacher annotation mode)
    if (this.baseDoc) {
      DrawBoard.renderElementsToCanvas(this.ctx, this.baseDoc);
    }

    // 2. Render editable overlay elements
    DrawBoard.renderElementsToCanvas(this.ctx, this.doc);

    // 3. Render current active drag element preview
    if (this.currentElement) {
      DrawBoard.renderElement(this.ctx, this.currentElement);
    }

    // 4. Highlight selected element
    if (this.selectedElementId) {
      const el = this.doc.elements.find(item => item.id === this.selectedElementId);
      if (el) {
        this._renderSelectionBox(el);
      }
    }
  }

  _renderSelectionBox(el) {
    if (!this.ctx) return;
    this.ctx.save();
    this.ctx.strokeStyle = '#3b82f6';
    this.ctx.lineWidth = 1.5;
    this.ctx.setLineDash([4, 4]);

    const bounds = this._getElementBounds(el);
    if (bounds) {
      this.ctx.strokeRect(bounds.x - 4, bounds.y - 4, bounds.w + 8, bounds.h + 8);
    }
    this.ctx.restore();
  }

  _getElementBounds(el) {
    if (el.type === 'stroke') {
      if (!el.points || !el.points.length) return null;
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (const [px, py] of el.points) {
        if (px < minX) minX = px;
        if (px > maxX) maxX = px;
        if (py < minY) minY = py;
        if (py > maxY) maxY = py;
      }
      return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
    }
    if (el.type === 'shape') {
      return {
        x: Math.min(el.x, el.x + el.w),
        y: Math.min(el.y, el.y + el.h),
        w: Math.abs(el.w),
        h: Math.abs(el.h)
      };
    }
    if (el.type === 'text') {
      const fs = el.fontSize || 20;
      const w = (el.text || '').length * (fs * 0.6);
      return { x: el.x, y: el.y - fs, w, h: fs };
    }
    return null;
  }

  /**
   * Static renderer for drawing a DrawDoc to any 2D canvas context.
   */
  static renderElementsToCanvas(ctx, doc) {
    if (!ctx || !doc || !Array.isArray(doc.elements)) return;
    for (const el of doc.elements) {
      DrawBoard.renderElement(ctx, el);
    }
  }

  static renderElement(ctx, el) {
    if (!ctx || !el) return;
    ctx.save();
    const shapeType = el.shape || el.type;

    if (el.type === 'stroke' || el.type === 'path') {
      const pts = el.points || [];
      if (pts.length > 0) {
        ctx.strokeStyle = el.color || '#000000';
        ctx.lineWidth = el.size || el.width || 3;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.beginPath();
        const p0x = Array.isArray(pts[0]) ? pts[0][0] : pts[0].x;
        const p0y = Array.isArray(pts[0]) ? pts[0][1] : pts[0].y;
        ctx.moveTo(p0x, p0y);
        for (let i = 1; i < pts.length; i++) {
          const px = Array.isArray(pts[i]) ? pts[i][0] : pts[i].x;
          const py = Array.isArray(pts[i]) ? pts[i][1] : pts[i].y;
          ctx.lineTo(px, py);
        }
        ctx.stroke();
      }
    } else if (el.type === 'shape' || shapeType === 'rect' || shapeType === 'ellipse' || shapeType === 'line' || shapeType === 'arrow') {
      ctx.strokeStyle = el.color || '#000000';
      ctx.fillStyle = el.color || '#000000';
      ctx.lineWidth = el.size || el.width || 3;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';

      if (shapeType === 'rect') {
        if (el.fill) ctx.fillRect(el.x, el.y, el.w, el.h);
        else ctx.strokeRect(el.x, el.y, el.w, el.h);
      } else if (shapeType === 'ellipse') {
        ctx.beginPath();
        const rx = Math.abs(el.w) / 2;
        const ry = Math.abs(el.h) / 2;
        if (rx > 0 && ry > 0) {
          const cx = el.x + el.w / 2;
          const cy = el.y + el.h / 2;
          ctx.ellipse(cx, cy, rx, ry, 0, 0, 2 * Math.PI);
          if (el.fill) ctx.fill();
          else ctx.stroke();
        }
      } else if (shapeType === 'line') {
        ctx.beginPath();
        ctx.moveTo(el.x, el.y);
        ctx.lineTo(el.x + el.w, el.y + el.h);
        ctx.stroke();
      } else if (shapeType === 'arrow') {
        const x1 = el.x;
        const y1 = el.y;
        const x2 = el.x + el.w;
        const y2 = el.y + el.h;
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();

        // Arrow head
        const angle = Math.atan2(y2 - y1, x2 - x1);
        const headlen = Math.max(10, (el.size || el.width || 3) * 3);
        ctx.beginPath();
        ctx.moveTo(x2, y2);
        ctx.lineTo(x2 - headlen * Math.cos(angle - Math.PI / 6), y2 - headlen * Math.sin(angle - Math.PI / 6));
        ctx.lineTo(x2 - headlen * Math.cos(angle + Math.PI / 6), y2 - headlen * Math.sin(angle + Math.PI / 6));
        ctx.closePath();
        ctx.fillStyle = el.color || '#000000';
        ctx.fill();
      }
    } else if (el.type === 'text') {
      ctx.font = `${el.fontSize || 20}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
      ctx.fillStyle = el.color || '#000000';
      ctx.fillText(el.text || '', el.x, el.y);
    }

    ctx.restore();
  }

  destroy() {
    if (this._keydownHandler && typeof window !== 'undefined') {
      window.removeEventListener('keydown', this._keydownHandler);
    }
  }
}

function distToSegment(p, v, w) {
  const l2 = Math.pow(v.x - w.x, 2) + Math.pow(v.y - w.y, 2);
  if (l2 === 0) return Math.hypot(p.x - v.x, p.y - v.y);
  let t = ((p.x - v.x) * (w.x - v.x) + (p.y - v.y) * (w.y - v.y)) / l2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (v.x + t * (w.x - v.x)), p.y - (v.y + t * (w.y - v.y)));
}
