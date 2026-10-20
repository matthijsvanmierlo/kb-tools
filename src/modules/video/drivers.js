/**
 * Unified Multi-Provider Video Driver Abstraction (KB-VID-001)
 * Supports HTML5 <video> and YouTube/Vimeo embeds controlled over postMessage (no third-party scripts).
 */

/**
 * Replace the player area with an accessible, readable error panel.
 */
export function renderVideoError(containerEl, title, detail) {
  if (!containerEl) return;
  const esc = (t) => String(t ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  containerEl.innerHTML = `
    <div class="w-full h-full flex flex-col items-center justify-center gap-3 p-6 text-center bg-slate-900" role="alert">
      <span class="w-12 h-12 rounded-full bg-white/10 flex items-center justify-center text-2xl" style="color:#fda4af">
        <sl-icon name="camera-video-off"></sl-icon>
      </span>
      <div class="space-y-1 max-w-sm">
        <p class="text-sm font-semibold" style="color:#f8fafc">${esc(title)}</p>
        <p class="text-xs leading-relaxed" style="color:#94a3b8">${esc(detail)}</p>
      </div>
    </div>
  `;
}

export class VideoProviderDriver {
  constructor() {
    this.container = null;
    this.source = '';
  }

  async mount(containerEl, videoSource) {
    throw new Error('Not implemented');
  }

  async play() {
    throw new Error('Not implemented');
  }

  async pause() {
    throw new Error('Not implemented');
  }

  async seekTo(seconds) {
    throw new Error('Not implemented');
  }

  async getCurrentTime() {
    throw new Error('Not implemented');
  }

  async getDuration() {
    throw new Error('Not implemented');
  }

  destroy() {}
}

/**
 * Native HTML5 Video Driver
 */
export class HTML5VideoDriver extends VideoProviderDriver {
  constructor() {
    super();
    this.videoEl = null;
  }

  async mount(containerEl, videoSource) {
    this.container = containerEl;
    this.source = videoSource;

    let resolvedSource = videoSource;
    if (String(videoSource || '').startsWith('opfs://') || String(videoSource || '').startsWith('idb-blob://') || String(videoSource || '').startsWith('sha256-')) {
      try {
        const { storage } = await import('../../core/storage.js');
        resolvedSource = await storage.loadBinaryAsset(videoSource);
      } catch (err) {
        console.warn('Failed to resolve local video asset:', err);
      }
    }

    this.videoEl = document.createElement('video');
    // Only web, blob and inline media URLs; never javascript: or file:
    if (!/^(https?:|blob:|data:video\/)/i.test(String(resolvedSource || '').trim())) {
      this.failed = true;
      renderVideoError(containerEl, 'This video link is not supported', 'Use a direct https:// link or local asset to an .mp4 or .webm file.');
      return;
    }
    this.videoEl.src = resolvedSource;
    this.videoEl.playsInline = true;
    this.videoEl.preload = 'metadata';
    this.videoEl.className = 'w-full h-full object-contain bg-black';
    // Native controls omitted so custom KennisBoost accessible scrubber bar governs playback
    this.videoEl.controls = false;

    this.container.innerHTML = '';
    this.container.appendChild(this.videoEl);

    return new Promise((resolve) => {
      this.videoEl.onloadedmetadata = () => resolve();
      this.videoEl.onerror = () => {
        this.failed = true;
        renderVideoError(
          this.container,
          'This video could not be loaded',
          'Check that the link points directly to an .mp4 or .webm file and that it is publicly accessible. Try one of the sample videos to confirm playback works.'
        );
        resolve();
      };
      // Fallback timeout in case event doesn't fire immediately
      setTimeout(resolve, 800);
    });
  }

  async play() {
    if (this.videoEl) {
      try {
        await this.videoEl.play();
      } catch (e) {
        console.debug('Autoplay prevented or interrupted:', e);
      }
    }
  }

  async pause() {
    if (this.videoEl) {
      this.videoEl.pause();
    }
  }

  async seekTo(seconds) {
    if (this.videoEl) {
      this.videoEl.currentTime = Math.max(0, seconds);
    }
  }

  async getCurrentTime() {
    return this.videoEl ? this.videoEl.currentTime : 0;
  }

  async getDuration() {
    return this.videoEl ? this.videoEl.duration || 0 : 0;
  }

  destroy() {
    if (this.videoEl) {
      this.videoEl.pause();
      this.videoEl.remove();
      this.videoEl = null;
    }
  }
}

/**
 * Shared base for third-party players driven over window.postMessage.
 *
 * The YouTube IFrame API and Vimeo SDK would require loading third-party scripts into the app's
 * origin, which the Content Security Policy forbids (script-src 'self'). Both players expose the
 * same control channel over postMessage, so the embed runs isolated in its own cross-origin
 * frame and this page only exchanges JSON messages with it (origin- and source-checked).
 */
class PostMessageDriver extends VideoProviderDriver {
  constructor(playerOrigin) {
    super();
    this.playerOrigin = playerOrigin;
    this.iframe = null;
    this.ready = false;
    this.duration = 0;
    this.time = 0;
    this.timeStamp = 0;
    this.playing = false;
    this._onMessage = (event) => {
      if (event.origin !== this.playerOrigin || !this.iframe || event.source !== this.iframe.contentWindow) return;
      let data = event.data;
      if (typeof data === 'string') {
        try { data = JSON.parse(data); } catch (_) { return; }
      }
      if (data && typeof data === 'object') this.handleMessage(data);
    };
  }

  /** Subclasses return the embed URL for a validated video id */
  embedUrl() { throw new Error('Not implemented'); }
  handleMessage() {}

  post(message) {
    this.iframe?.contentWindow?.postMessage(JSON.stringify(message), this.playerOrigin);
  }

  _setTime(seconds) {
    if (Number.isFinite(seconds)) {
      this.time = seconds;
      this.timeStamp = Date.now();
    }
  }

  /**
   * @param {HTMLElement} containerEl
   * @param {string} videoId - already validated
   * @param {{ title: string, unavailableTitle: string, unavailableDetail: string }} labels
   */
  _mountFrame(containerEl, videoId, labels) {
    this.iframe = document.createElement('iframe');
    this.iframe.src = this.embedUrl(videoId);
    this.iframe.title = labels.title;
    this.iframe.className = 'w-full h-full border-0';
    this.iframe.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen';
    // The document sends no Referer at all; both players refuse to embed without one. This
    // frame alone sends just the origin (never the path or the #fragment).
    this.iframe.referrerPolicy = 'strict-origin-when-cross-origin';
    containerEl.innerHTML = '';
    containerEl.appendChild(this.iframe);
    window.addEventListener('message', this._onMessage);

    return new Promise((resolve) => {
      this._resolveReady = () => {
        this.ready = true;
        clearInterval(this._handshake);
        clearTimeout(this._readyTimeout);
        resolve();
      };
      this.iframe.addEventListener('load', () => this.onFrameLoad?.());
      this._readyTimeout = setTimeout(() => {
        clearInterval(this._handshake);
        if (!this.ready) {
          renderVideoError(this.container, labels.unavailableTitle, labels.unavailableDetail);
          this.failed = true;
        }
        resolve();
      }, 15000);
    });
  }

  async getCurrentTime() {
    // Players report time a few times per second; extrapolate between reports while playing
    if (this.playing && this.timeStamp) return this.time + (Date.now() - this.timeStamp) / 1000;
    return this.time;
  }

  async getDuration() {
    return this.duration;
  }

  destroy() {
    clearInterval(this._handshake);
    clearTimeout(this._readyTimeout);
    window.removeEventListener('message', this._onMessage);
    this.iframe?.remove();
    this.iframe = null;
  }
}

/**
 * YouTube embed driver (privacy-enhanced youtube-nocookie.com host)
 */
export class YouTubeDriver extends PostMessageDriver {
  constructor() {
    super('https://www.youtube-nocookie.com');
    this.frameId = `yt-player-${Math.random().toString(36).slice(2, 9)}`;
  }

  static extractYouTubeId(url) {
    if (!url) return '';
    const regExp = /^.*(youtu.be\/|v\/|u\/\w\/|embed\/|shorts\/|watch\?v=|&v=)([^#&?]*).*/;
    const match = url.match(regExp);
    return match && match[2].length === 11 ? match[2] : url;
  }

  static isValidId(id) {
    return /^[A-Za-z0-9_-]{11}$/.test(String(id || ''));
  }

  embedUrl(videoId) {
    const params = new URLSearchParams({
      enablejsapi: '1',
      controls: '0',
      disablekb: '1',
      modestbranding: '1',
      rel: '0',
      playsinline: '1',
      origin: window.location.origin
    });
    return `${this.playerOrigin}/embed/${encodeURIComponent(videoId)}?${params}`;
  }

  onFrameLoad() {
    // Subscribe to player events; repeat until the player answers (it may still be booting)
    const listen = () => this.post({ event: 'listening', id: this.frameId, channel: 'widget' });
    listen();
    clearInterval(this._handshake);
    this._handshake = setInterval(listen, 250);
  }

  handleMessage(msg) {
    if (msg.event === 'onReady' || (msg.event === 'initialDelivery' && !this.ready)) {
      this.post({ event: 'command', func: 'addEventListener', args: ['onStateChange'], id: this.frameId, channel: 'widget' });
      this._resolveReady?.();
    }
    const info = msg.info;
    if ((msg.event === 'infoDelivery' || msg.event === 'initialDelivery') && info && typeof info === 'object') {
      if (Number.isFinite(info.duration) && info.duration > 0) this.duration = info.duration;
      if (Number.isFinite(info.currentTime)) this._setTime(info.currentTime);
      if (Number.isFinite(info.playerState)) this.playing = info.playerState === 1;
    }
    if (msg.event === 'onStateChange' && Number.isFinite(msg.info)) {
      this.playing = msg.info === 1;
    }
    if (msg.event === 'onError') {
      const notEmbeddable = msg.info === 101 || msg.info === 150;
      renderVideoError(
        this.container,
        notEmbeddable ? 'The owner of this YouTube video does not allow embedding' : 'This YouTube video is unavailable',
        notEmbeddable
          ? 'Choose a different video, or ask the creator to enable embedding.'
          : 'Double-check the link or video ID. Private and removed videos cannot be played.'
      );
      this.failed = true;
      this._resolveReady?.();
    }
  }

  async mount(containerEl, videoSource) {
    this.container = containerEl;
    this.source = videoSource;
    const videoId = YouTubeDriver.extractYouTubeId(videoSource);
    if (!YouTubeDriver.isValidId(videoId)) {
      this.failed = true;
      renderVideoError(containerEl, 'This is not a valid YouTube link', 'Paste a link like https://www.youtube.com/watch?v=… or https://youtu.be/…');
      return;
    }
    await this._mountFrame(containerEl, videoId, {
      title: 'YouTube video player',
      unavailableTitle: 'The YouTube player did not respond',
      unavailableDetail: 'Check your internet connection and try reloading. Some school networks block YouTube.'
    });
  }

  _command(func, args = []) {
    this.post({ event: 'command', func, args, id: this.frameId, channel: 'widget' });
  }

  async play() {
    this._command('playVideo');
  }

  async pause() {
    this._command('pauseVideo');
  }

  async seekTo(seconds) {
    const s = Math.max(0, Number(seconds) || 0);
    this._command('seekTo', [s, true]);
    this._setTime(s);
  }
}

/**
 * Vimeo embed driver
 */
export class VimeoDriver extends PostMessageDriver {
  constructor() {
    super('https://player.vimeo.com');
  }

  static extractVimeoId(url) {
    if (!url) return '';
    const match = url.match(/(?:vimeo\.com\/)(?:.*\/)?([0-9]+)/);
    return match ? match[1] : url;
  }

  static isValidId(id) {
    return /^[0-9]{1,15}$/.test(String(id || ''));
  }

  embedUrl(videoId) {
    const params = new URLSearchParams({ controls: '0', keyboard: '0', dnt: '1', api: '1' });
    return `${this.playerOrigin}/video/${encodeURIComponent(videoId)}?${params}`;
  }

  handleMessage(msg) {
    const data = msg.data && typeof msg.data === 'object' ? msg.data : {};
    switch (msg.event) {
      case 'ready':
        for (const ev of ['timeupdate', 'play', 'pause', 'ended', 'error', 'loaded']) {
          this.post({ method: 'addEventListener', value: ev });
        }
        this.post({ method: 'getDuration' });
        this._resolveReady?.();
        break;
      case 'timeupdate':
      case 'playProgress':
        if (Number.isFinite(data.duration) && data.duration > 0) this.duration = data.duration;
        this._setTime(data.seconds);
        break;
      case 'play':
        this.playing = true;
        break;
      case 'pause':
      case 'ended':
        this.playing = false;
        this._setTime(data.seconds);
        break;
      case 'error':
        this.failed = true;
        renderVideoError(this.container, 'This Vimeo video is unavailable', 'Double-check the link. Private videos and videos with embedding disabled cannot be played.');
        this._resolveReady?.();
        break;
      default:
        break;
    }
    if (msg.method === 'getDuration' && Number.isFinite(msg.value)) this.duration = msg.value;
  }

  async mount(containerEl, videoSource) {
    this.container = containerEl;
    this.source = videoSource;
    const videoId = VimeoDriver.extractVimeoId(videoSource);
    if (!VimeoDriver.isValidId(videoId)) {
      this.failed = true;
      renderVideoError(containerEl, 'This is not a valid Vimeo link', 'Paste a link like https://vimeo.com/123456789');
      return;
    }
    await this._mountFrame(containerEl, videoId, {
      title: 'Vimeo video player',
      unavailableTitle: 'Vimeo player could not be loaded',
      unavailableDetail: 'Check your internet connection and try reloading the preview.'
    });
  }

  async play() {
    this.post({ method: 'play' });
  }

  async pause() {
    this.post({ method: 'pause' });
  }

  async seekTo(seconds) {
    const s = Math.max(0, Number(seconds) || 0);
    this.post({ method: 'setCurrentTime', value: s });
    this._setTime(s);
  }
}

/**
 * Driver Factory
 */
export function createVideoDriver(provider) {
  if (provider === 'youtube') return new YouTubeDriver();
  if (provider === 'vimeo') return new VimeoDriver();
  return new HTML5VideoDriver();
}

export default createVideoDriver;
