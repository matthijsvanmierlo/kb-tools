/**
 * Pressure-Sensitive Vector Sketch Pad (KB-CARD-001)
 * Normalized to 1000x600 logical coordinate space with 20-step undo/redo stack.
 */
export class SketchCanvas {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {object} [options]
   */
  constructor(canvas, options = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.logicalWidth = 1000;
    this.logicalHeight = 600;

    this.currentColor = options.color || '#2563eb';
    this.currentSize = options.size || 4;
    this.currentMode = 'pen'; // 'pen' | 'eraser'

    this.strokes = []; // Array of Stroke objects
    this.redoStack = []; // Max 20 states
    this.currentStroke = null;
    this.isDrawing = false;
    this.onChange = options.onChange || null;

    this._initCanvas();
    this._bindEvents();
  }

  _initCanvas() {
    this.canvas.classList.add('kb-sketch-pad');
    this.resize();
  }

  resize() {
    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    const rect = this.canvas.getBoundingClientRect();
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
  }

  _getNormalizedPoint(e) {
    const rect = this.canvas.getBoundingClientRect();
    const clientX = e.clientX - rect.left;
    const clientY = e.clientY - rect.top;

    const x = Math.round((clientX / rect.width) * this.logicalWidth);
    const y = Math.round((clientY / rect.height) * this.logicalHeight);
    const p = Math.round((e.pressure || 0.5) * 100) / 100;

    return [x, y, p];
  }

  _onPointerDown(e) {
    this.isDrawing = true;
    this.canvas.setPointerCapture(e.pointerId);

    const pt = this._getNormalizedPoint(e);
    this.currentStroke = {
      color: this.currentColor,
      size: this.currentSize,
      mode: this.currentMode,
      points: [pt]
    };

    this.strokes.push(this.currentStroke);
    this.redoStack = []; // Clear redo stack on new stroke
    this._renderSegment(pt, pt, this.currentStroke);
  }

  _onPointerMove(e) {
    if (!this.isDrawing || !this.currentStroke) return;

    const pt = this._getNormalizedPoint(e);
    const points = this.currentStroke.points;
    const prevPt = points[points.length - 1];
    points.push(pt);

    this._renderSegment(prevPt, pt, this.currentStroke);
  }

  _onPointerUp(e) {
    if (!this.isDrawing) return;
    this.isDrawing = false;
    this.currentStroke = null;
    try {
      this.canvas.releasePointerCapture(e.pointerId);
    } catch (_) {}

    if (typeof this.onChange === 'function') {
      this.onChange(this.getStrokes());
    }
  }

  _renderSegment(p1, p2, stroke) {
    const ctx = this.ctx;
    if (!ctx) return;
    ctx.save();

    if (stroke.mode === 'eraser') {
      ctx.globalCompositeOperation = 'destination-out';
      ctx.strokeStyle = 'rgba(0,0,0,1)';
      ctx.lineWidth = stroke.size * 3;
    } else {
      ctx.globalCompositeOperation = 'source-over';
      ctx.strokeStyle = stroke.color;
      ctx.lineWidth = stroke.size * (0.5 + (p2[2] || 0.5) * 1.5);
    }

    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    ctx.beginPath();
    ctx.moveTo(p1[0], p1[1]);
    ctx.lineTo(p2[0], p2[1]);
    ctx.stroke();

    ctx.restore();
  }

  redraw() {
    const ctx = this.ctx;
    if (!ctx) return;
    ctx.save();
    ctx.clearRect(0, 0, this.logicalWidth, this.logicalHeight);

    for (const stroke of this.strokes) {
      if (!stroke.points || stroke.points.length === 0) continue;
      if (stroke.points.length === 1) {
        this._renderSegment(stroke.points[0], stroke.points[0], stroke);
        continue;
      }
      for (let i = 1; i < stroke.points.length; i++) {
        this._renderSegment(stroke.points[i - 1], stroke.points[i], stroke);
      }
    }

    ctx.restore();
  }

  undo() {
    if (this.strokes.length === 0) return;
    const popped = this.strokes.pop();
    this.redoStack.push(popped);
    if (this.redoStack.length > 20) this.redoStack.shift();
    this.redraw();
    if (typeof this.onChange === 'function') this.onChange(this.getStrokes());
  }

  redo() {
    if (this.redoStack.length === 0) return;
    const restored = this.redoStack.pop();
    this.strokes.push(restored);
    this.redraw();
    if (typeof this.onChange === 'function') this.onChange(this.getStrokes());
  }

  clear() {
    if (this.strokes.length === 0) return;
    this.redoStack.push([...this.strokes]);
    if (this.redoStack.length > 20) this.redoStack.shift();
    this.strokes = [];
    this.redraw();
    if (typeof this.onChange === 'function') this.onChange(this.getStrokes());
  }

  setColor(color) {
    this.currentColor = color;
    this.currentMode = 'pen';
  }

  setSize(size) {
    this.currentSize = size;
  }

  setMode(mode) {
    this.currentMode = mode; // 'pen' or 'eraser'
  }

  getStrokes() {
    return JSON.parse(JSON.stringify(this.strokes));
  }

  loadStrokes(strokes) {
    this.strokes = Array.isArray(strokes) ? JSON.parse(JSON.stringify(strokes)) : [];
    this.redoStack = [];
    this.redraw();
  }

  toDataURL() {
    return this.canvas.toDataURL('image/png');
  }

  /**
   * Static helper to render strokes to any read-only canvas element
   */
  static renderStrokesToCanvas(canvas, strokes) {
    if (!canvas || !Array.isArray(strokes) || strokes.length === 0) return;
    const ctx = canvas.getContext ? canvas.getContext('2d') : null;
    if (!ctx) return;

    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    const rect = canvas.getBoundingClientRect();
    const width = rect.width || canvas.width || 300;
    const height = rect.height || canvas.height || 180;

    canvas.width = width * dpr;
    canvas.height = height * dpr;

    ctx.save();
    if (ctx.resetTransform) ctx.resetTransform();
    ctx.scale((width * dpr) / 1000, (height * dpr) / 600);
    ctx.clearRect(0, 0, 1000, 600);

    for (const stroke of strokes) {
      if (!stroke.points || stroke.points.length === 0) continue;
      ctx.save();
      ctx.strokeStyle = stroke.mode === 'eraser' ? '#ffffff' : (stroke.color || '#2563eb');
      ctx.lineWidth = stroke.size || 4;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';

      ctx.beginPath();
      ctx.moveTo(stroke.points[0][0], stroke.points[0][1]);
      for (let i = 1; i < stroke.points.length; i++) {
        ctx.lineTo(stroke.points[i][0], stroke.points[i][1]);
      }
      ctx.stroke();
      ctx.restore();
    }
    ctx.restore();
  }
}

export default SketchCanvas;
