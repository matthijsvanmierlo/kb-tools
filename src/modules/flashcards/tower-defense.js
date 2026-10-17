import { storage } from '../../core/storage.js';
import { toast } from '../../utils/toast.js';

/**
 * TowerDefenseEngine - KB-CARD-003
 * 60 FPS HTML5 Canvas Tower Defense Study Game with procedural vector sprites,
 * quiz-driven energy economics, and Web Audio API synthesized sound effects.
 */
export class TowerDefenseEngine {
  constructor(canvas, deck, options = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.deck = deck;
    this.cards = deck.cards || [];
    this.onEndGame = options.onEndGame || null;

    this.logicalWidth = 960;
    this.logicalHeight = 420;

    this.waypoints = [
      { x: 0, y: 120 },
      { x: 260, y: 120 },
      { x: 260, y: 300 },
      { x: 640, y: 300 },
      { x: 640, y: 160 },
      { x: 920, y: 160 }
    ];

    this.buildPads = [
      { id: 1, x: 130, y: 60, tower: null },
      { id: 2, x: 130, y: 180, tower: null },
      { id: 3, x: 380, y: 240, tower: null },
      { id: 4, x: 500, y: 360, tower: null },
      { id: 5, x: 520, y: 100, tower: null },
      { id: 6, x: 780, y: 220, tower: null }
    ];

    // State
    this.baseHealth = 100;
    this.energy = 100;
    this.score = 0;
    this.streak = 0;
    this.longestStreak = 0;
    this.totalQuestions = 0;
    this.correctAnswers = 0;
    this.wave = 1;
    this.maxWaves = 10;
    this.isGameOver = false;
    this.isVictory = false;
    this.isRunning = false;
    this.globalTurretJamUntil = 0;

    // Entities
    this.monsters = [];
    this.projectiles = [];
    this.particles = [];
    this.spawnQueue = [];
    this.lastSpawnTime = 0;
    this.selectedPad = null;
    this.selectedTowerType = 'archer'; // 'archer' | 'freeze' | 'cannon'

    // Quiz State
    this.currentQuestion = null;
    this.audioCtx = null;
  }

  init() {
    this._initAudio();
    this._initCanvas();
    this._startWave(1);
    this._loadNextQuestion();
    this.startLoop();
  }

  _initAudio() {
    try {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (AudioContextClass) {
        this.audioCtx = new AudioContextClass();
      }
    } catch (_) {}
  }

  playChime() {
    if (!this.audioCtx) return;
    try {
      if (this.audioCtx.state === 'suspended') this.audioCtx.resume();
      const notes = [523.25, 659.25, 783.99]; // C5, E5, G5 major triad
      notes.forEach((freq, idx) => {
        const osc = this.audioCtx.createOscillator();
        const gain = this.audioCtx.createGain();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(freq, this.audioCtx.currentTime + idx * 0.08);

        gain.gain.setValueAtTime(0.15, this.audioCtx.currentTime + idx * 0.08);
        gain.gain.exponentialRampToValueAtTime(0.001, this.audioCtx.currentTime + idx * 0.08 + 0.3);

        osc.connect(gain);
        gain.connect(this.audioCtx.destination);
        osc.start(this.audioCtx.currentTime + idx * 0.08);
        osc.stop(this.audioCtx.currentTime + idx * 0.08 + 0.3);
      });
    } catch (_) {}
  }

  playBuzz() {
    if (!this.audioCtx) return;
    try {
      if (this.audioCtx.state === 'suspended') this.audioCtx.resume();
      const osc = this.audioCtx.createOscillator();
      const gain = this.audioCtx.createGain();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(130, this.audioCtx.currentTime); // Low C3

      gain.gain.setValueAtTime(0.2, this.audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, this.audioCtx.currentTime + 0.4);

      osc.connect(gain);
      gain.connect(this.audioCtx.destination);
      osc.start();
      osc.stop(this.audioCtx.currentTime + 0.4);
    } catch (_) {}
  }

  _initCanvas() {
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = this.logicalWidth * dpr;
    this.canvas.height = this.logicalHeight * dpr;
    if (this.ctx) {
      if (this.ctx.resetTransform) this.ctx.resetTransform();
      if (this.ctx.scale) this.ctx.scale(dpr, dpr);
    }

    this.canvas.addEventListener('click', (e) => this._onCanvasClick(e));
  }

  _onCanvasClick(e) {
    const rect = this.canvas.getBoundingClientRect();
    const scaleX = this.logicalWidth / rect.width;
    const scaleY = this.logicalHeight / rect.height;
    const x = (e.clientX - rect.left) * scaleX;
    const y = (e.clientY - rect.top) * scaleY;

    // Check build pads
    for (const pad of this.buildPads) {
      const dist = Math.hypot(pad.x - x, pad.y - y);
      if (dist <= 26) {
        this.selectedPad = pad;
        if (!pad.tower) {
          this.buildTower(pad, this.selectedTowerType);
        }
        return;
      }
    }
  }

  buildTower(pad, type) {
    const costs = { archer: 50, freeze: 75, cannon: 100 };
    const cost = costs[type] || 50;

    if (this.energy < cost) {
      toast.warning(`Not enough energy! Requires ${cost} Energy. Answer questions to earn energy.`);
      return false;
    }

    this.energy -= cost;
    pad.tower = {
      type,
      x: pad.x,
      y: pad.y,
      level: 1,
      range: type === 'freeze' ? 110 : (type === 'cannon' ? 160 : 140),
      damage: type === 'archer' ? 25 : (type === 'freeze' ? 10 : 45),
      fireRate: type === 'archer' ? 1.2 : (type === 'freeze' ? 0.6 : 0.4),
      lastFire: 0,
      slowFactor: type === 'freeze' ? 0.45 : 1,
      splashRadius: type === 'cannon' ? 65 : 0
    };

    toast.info(`Built ${type.toUpperCase()} Tower!`);
    return true;
  }

  _startWave(waveNum) {
    this.wave = waveNum;
    const monsterCount = 5 + waveNum * 3;
    const baseHp = 50 + waveNum * 25;
    const baseSpeed = 1.0 + Math.min(1.2, waveNum * 0.1);

    this.spawnQueue = [];
    for (let i = 0; i < monsterCount; i++) {
      this.spawnQueue.push({
        hp: baseHp,
        maxHp: baseHp,
        speed: baseSpeed,
        x: this.waypoints[0].x,
        y: this.waypoints[0].y,
        wpIdx: 0,
        slowUntil: 0,
        radius: 14 + (waveNum % 2) * 2
      });
    }
  }

  _loadNextQuestion() {
    if (this.cards.length === 0) return null;

    // Pick card (random or due)
    const cardIdx = Math.floor(Math.random() * this.cards.length);
    const targetCard = this.cards[cardIdx];

    const correctAnswer = targetCard.back?.text || targetCard.answer || 'Answer';
    const questionText = targetCard.front?.text || targetCard.question || 'Question';

    // Pick 3 distractors
    const distractors = this.cards
      .filter((_, idx) => idx !== cardIdx)
      .map(c => c.back?.text || c.answer || '')
      .filter(t => t && t !== correctAnswer);

    while (distractors.length < 3) {
      distractors.push(`Variation ${distractors.length + 1}`);
    }

    const options = [correctAnswer, ...distractors.slice(0, 3)]
      .sort(() => Math.random() - 0.5);

    this.currentQuestion = {
      prompt: questionText,
      correct: correctAnswer,
      options
    };

    this._renderQuestionUI();
    return this.currentQuestion;
  }

  _renderQuestionUI() {
    const container = document.getElementById('td-question-dock');
    if (!container || !this.currentQuestion) return;

    const { prompt, options } = this.currentQuestion;
    container.innerHTML = `
      <div class="bg-white p-4 rounded-lg border border-slate-200 shadow-sm space-y-3">
        <div class="flex items-center justify-between">
          <span class="text-xs font-semibold uppercase tracking-wider text-blue-600">Flashcard Energy Question</span>
          <span class="text-xs text-slate-500 font-mono">Streak: ${this.streak} (Longest: ${this.longestStreak})</span>
        </div>
        <p class="font-medium text-slate-900 text-sm">${prompt}</p>
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-2" id="td-answers-grid">
          ${options.map((opt, i) => `
            <button data-opt-idx="${i}" class="text-left px-3 py-2 border rounded text-xs hover:bg-blue-50 hover:border-blue-300 transition-colors flex items-center gap-2">
              <span class="w-5 h-5 rounded-full bg-slate-100 flex items-center justify-center font-bold text-slate-600 text-xs">${i + 1}</span>
              <span class="truncate">${opt}</span>
            </button>
          `).join('')}
        </div>
      </div>
    `;

    container.querySelectorAll('button[data-opt-idx]').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = Number(btn.getAttribute('data-opt-idx'));
        this.answerQuestion(options[idx], btn);
      });
    });
  }

  answerQuestion(selectedText, btnEl = null) {
    if (!this.currentQuestion || this.isGameOver) return;

    this.totalQuestions += 1;
    const isCorrect = selectedText === this.currentQuestion.correct;

    if (isCorrect) {
      this.correctAnswers += 1;
      this.energy += 35;
      this.score += 50 * (1 + this.streak * 0.1);
      this.streak += 1;
      if (this.streak > this.longestStreak) this.longestStreak = this.streak;

      this.playChime();
      if (btnEl) btnEl.classList.add('bg-emerald-100', 'border-emerald-500');

      setTimeout(() => this._loadNextQuestion(), 300);
    } else {
      this.streak = 0;
      this.globalTurretJamUntil = performance.now() + 2000;
      this.playBuzz();

      if (btnEl) btnEl.classList.add('bg-red-100', 'border-red-500');

      // Highlight correct answer
      const buttons = document.querySelectorAll('#td-answers-grid button');
      buttons.forEach(b => {
        if (b.textContent.includes(this.currentQuestion.correct)) {
          b.classList.add('bg-emerald-100', 'border-emerald-500');
        }
      });

      setTimeout(() => this._loadNextQuestion(), 1200);
    }
  }

  startLoop() {
    this.isRunning = true;
    let lastTime = performance.now();

    const loop = (now) => {
      if (!this.isRunning) return;
      const dt = Math.min(0.1, (now - lastTime) / 1000);
      lastTime = now;

      this.update(dt, now);
      this.render(now);

      if (!this.isGameOver) {
        requestAnimationFrame(loop);
      }
    };

    requestAnimationFrame(loop);
  }

  stop() {
    this.isRunning = false;
  }

  update(dt, now) {
    if (this.isGameOver) return;

    // 1. Spawning
    if (this.spawnQueue.length > 0 && now - this.lastSpawnTime > 1400) {
      this.lastSpawnTime = now;
      this.monsters.push(this.spawnQueue.shift());
    }

    // 2. Monsters along waypoints
    const reachedBase = [];
    for (let i = this.monsters.length - 1; i >= 0; i--) {
      const m = this.monsters[i];
      const targetWp = this.waypoints[m.wpIdx + 1];

      if (!targetWp) {
        reachedBase.push(i);
        continue;
      }

      const dx = targetWp.x - m.x;
      const dy = targetWp.y - m.y;
      const dist = Math.hypot(dx, dy);

      const isSlowed = m.slowUntil > now;
      const speed = m.speed * (isSlowed ? 0.45 : 1.0) * 60;
      const step = speed * dt;

      if (dist <= step) {
        m.x = targetWp.x;
        m.y = targetWp.y;
        m.wpIdx += 1;
        if (m.wpIdx >= this.waypoints.length - 1) {
          reachedBase.push(i);
        }
      } else {
        m.x += (dx / dist) * step;
        m.y += (dy / dist) * step;
      }
    }

    // Handle monsters reaching base
    for (const idx of reachedBase) {
      this.monsters.splice(idx, 1);
      this.baseHealth = Math.max(0, this.baseHealth - 15);
      if (this.baseHealth <= 0) {
        this.endGame(false);
        return;
      }
    }

    // 3. Turret targeting & shooting
    const isJammed = this.globalTurretJamUntil > now;
    if (!isJammed) {
      for (const pad of this.buildPads) {
        const tower = pad.tower;
        if (!tower) continue;

        if (now - tower.lastFire >= 1000 / tower.fireRate) {
          // Find closest monster in range
          let target = null;
          let minDist = tower.range;
          for (const m of this.monsters) {
            const d = Math.hypot(m.x - tower.x, m.y - tower.y);
            if (d <= minDist) {
              minDist = d;
              target = m;
            }
          }

          if (target) {
            tower.lastFire = now;
            this.projectiles.push({
              x: tower.x,
              y: tower.y,
              target,
              type: tower.type,
              damage: tower.damage,
              splashRadius: tower.splashRadius,
              slowFactor: tower.slowFactor
            });
          }
        }
      }
    }

    // 4. Projectiles
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const p = this.projectiles[i];
      const dx = p.target.x - p.x;
      const dy = p.target.y - p.y;
      const dist = Math.hypot(dx, dy);
      const speed = 400 * dt;

      if (dist <= speed || !this.monsters.includes(p.target)) {
        // Hit
        this._applyHit(p, now);
        this.projectiles.splice(i, 1);
      } else {
        p.x += (dx / dist) * speed;
        p.y += (dy / dist) * speed;
      }
    }

    // 5. Check Wave End
    if (this.spawnQueue.length === 0 && this.monsters.length === 0) {
      if (this.wave < this.maxWaves) {
        this._startWave(this.wave + 1);
        toast.success(`Wave ${this.wave} incoming! Base Health: ${this.baseHealth} HP`);
      } else {
        this.endGame(true);
      }
    }
  }

  _applyHit(p, now) {
    if (p.splashRadius > 0) {
      // Area of effect
      for (const m of this.monsters) {
        if (Math.hypot(m.x - p.x, m.y - p.y) <= p.splashRadius) {
          m.hp -= p.damage;
        }
      }
    } else {
      p.target.hp -= p.damage;
      if (p.type === 'freeze') {
        p.target.slowUntil = now + 3000;
      }
    }

    // Remove dead monsters
    for (let i = this.monsters.length - 1; i >= 0; i--) {
      if (this.monsters[i].hp <= 0) {
        this.monsters.splice(i, 1);
        this.energy += 10;
        this.score += 20;
      }
    }
  }

  render(now) {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.logicalWidth, this.logicalHeight);

    // Background Map
    ctx.fillStyle = '#f1f5f9';
    ctx.fillRect(0, 0, this.logicalWidth, this.logicalHeight);

    // Draw Path
    ctx.strokeStyle = '#cbd5e1';
    ctx.lineWidth = 42;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(this.waypoints[0].x, this.waypoints[0].y);
    for (let i = 1; i < this.waypoints.length; i++) {
      ctx.lineTo(this.waypoints[i].x, this.waypoints[i].y);
    }
    ctx.stroke();

    // Draw Player Base
    const baseWp = this.waypoints[this.waypoints.length - 1];
    ctx.fillStyle = '#dc2626';
    ctx.beginPath();
    ctx.arc(baseWp.x, baseWp.y, 22, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 10px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(`${this.baseHealth}HP`, baseWp.x, baseWp.y + 4);

    // Draw Build Pads
    for (const pad of this.buildPads) {
      ctx.fillStyle = pad.tower ? '#334155' : '#94a3b8';
      ctx.beginPath();
      ctx.arc(pad.x, pad.y, 20, 0, Math.PI * 2);
      ctx.fill();

      if (pad.tower) {
        // Draw Tower Vector Sprite
        this._renderTowerSprite(ctx, pad.tower, now);
      } else {
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.fillStyle = '#ffffff';
        ctx.font = '10px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('+', pad.x, pad.y + 3);
      }
    }

    // Draw Monsters
    for (const m of this.monsters) {
      this._renderMonsterSprite(ctx, m, now);
    }

    // Draw Projectiles
    for (const p of this.projectiles) {
      ctx.fillStyle = p.type === 'freeze' ? '#06b6d4' : (p.type === 'cannon' ? '#f59e0b' : '#10b981');
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.type === 'cannon' ? 6 : 4, 0, Math.PI * 2);
      ctx.fill();
    }

    // Global Turret Jammed Overlay Banner
    if (this.globalTurretJamUntil > now) {
      ctx.fillStyle = 'rgba(239, 68, 68, 0.75)';
      ctx.fillRect(0, 0, this.logicalWidth, 28);
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 12px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('⚠ TURRETS JAMMED! (Incorrect Answer Cooldown) ⚠', this.logicalWidth / 2, 18);
    }

    // Top HUD
    ctx.fillStyle = '#0f172a';
    ctx.font = 'bold 12px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(`Wave: ${this.wave} / ${this.maxWaves} | Energy: ⚡ ${this.energy} | Score: 🏆 ${Math.round(this.score)}`, 16, 20);
  }

  _renderTowerSprite(ctx, tower, now) {
    ctx.save();
    ctx.translate(tower.x, tower.y);

    if (tower.type === 'archer') {
      ctx.fillStyle = '#10b981'; // Emerald
      ctx.beginPath();
      ctx.arc(0, 0, 14, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#047857';
      ctx.fillRect(-3, -12, 6, 12);
    } else if (tower.type === 'freeze') {
      ctx.fillStyle = '#06b6d4'; // Cyan
      const pulse = Math.sin(now * 0.005) * 2;
      ctx.beginPath();
      for (let i = 0; i < 6; i++) {
        const angle = (i * Math.PI) / 3;
        const r = 14 + pulse;
        const x = r * Math.cos(angle);
        const y = r * Math.sin(angle);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.fill();
    } else {
      ctx.fillStyle = '#f59e0b'; // Amber
      ctx.beginPath();
      ctx.arc(0, 0, 16, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#b45309';
      ctx.fillRect(-5, -16, 10, 16);
    }

    ctx.restore();
  }

  _renderMonsterSprite(ctx, m, now) {
    ctx.save();
    ctx.translate(m.x, m.y);

    const isSlow = m.slowUntil > now;
    ctx.fillStyle = isSlow ? '#38bdf8' : '#e11d48';

    // Animated bounce
    const bounce = Math.sin(now * 0.01 + m.x) * 3;
    ctx.beginPath();
    ctx.arc(0, bounce, m.radius, 0, Math.PI * 2);
    ctx.fill();

    // Health bar overhead
    const barW = 24;
    const hpPct = Math.max(0, m.hp / m.maxHp);
    ctx.fillStyle = '#ef4444';
    ctx.fillRect(-barW / 2, bounce - m.radius - 8, barW, 4);
    ctx.fillStyle = '#22c55e';
    ctx.fillRect(-barW / 2, bounce - m.radius - 8, barW * hpPct, 4);

    ctx.restore();
  }

  async endGame(isVictory) {
    this.isGameOver = true;
    this.isVictory = isVictory;
    this.stop();

    const accuracy = this.totalQuestions > 0 ? Math.round((this.correctAnswers / this.totalQuestions) * 100) : 0;

    // Update stats in deck
    const currentStats = this.deck.gamification_stats || { high_score: 0, longest_streak: 0, accuracy: 0 };
    const updatedStats = {
      high_score: Math.max(currentStats.high_score, Math.round(this.score)),
      longest_streak: Math.max(currentStats.longest_streak, this.longestStreak),
      accuracy: Math.max(currentStats.accuracy, accuracy)
    };

    this.deck.gamification_stats = updatedStats;
    await storage.table('flashcards').put(this.deck);

    if (typeof this.onEndGame === 'function') {
      this.onEndGame({
        isVictory,
        score: Math.round(this.score),
        longestStreak: this.longestStreak,
        accuracy,
        wave: this.wave
      });
    }
  }
}

export default TowerDefenseEngine;
