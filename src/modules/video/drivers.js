/**
 * Unified Multi-Provider Video Driver Abstraction (KB-VID-001)
 * Supports HTML5 <video>, YouTube IFrame API, and Vimeo Player SDK.
 */

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

    this.videoEl = document.createElement('video');
    this.videoEl.src = videoSource;
    this.videoEl.playsInline = true;
    this.videoEl.preload = 'metadata';
    this.videoEl.className = 'w-full h-full object-contain bg-black';
    // Native controls omitted so custom KennisBoost accessible scrubber bar governs playback
    this.videoEl.controls = false;

    this.container.innerHTML = '';
    this.container.appendChild(this.videoEl);

    return new Promise((resolve) => {
      this.videoEl.onloadedmetadata = () => resolve();
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
 * YouTube IFrame API Driver
 */
export class YouTubeDriver extends VideoProviderDriver {
  constructor() {
    super();
    this.player = null;
    this.elementId = `yt-player-${Math.random().toString(36).slice(2, 9)}`;
  }

  static extractYouTubeId(url) {
    if (!url) return '';
    const regExp = /^.*(youtu.be\/|v\/|u\/\w\/|embed\/|watch\?v=|&v=)([^#&?]*).*/;
    const match = url.match(regExp);
    return match && match[2].length === 11 ? match[2] : url;
  }

  static async loadAPI() {
    if (typeof window === 'undefined') return;
    if (window.YT && window.YT.Player) return;

    return new Promise((resolve) => {
      const existing = document.getElementById('youtube-iframe-api');
      if (existing) {
        const check = setInterval(() => {
          if (window.YT && window.YT.Player) {
            clearInterval(check);
            resolve();
          }
        }, 50);
        return;
      }

      const tag = document.createElement('script');
      tag.id = 'youtube-iframe-api';
      tag.src = 'https://www.youtube.com/iframe_api';
      window.onYouTubeIframeAPIReady = () => resolve();
      document.head.appendChild(tag);
    });
  }

  async mount(containerEl, videoSource) {
    this.container = containerEl;
    this.source = videoSource;
    const videoId = YouTubeDriver.extractYouTubeId(videoSource);

    await YouTubeDriver.loadAPI();

    const targetDiv = document.createElement('div');
    targetDiv.id = this.elementId;
    this.container.innerHTML = '';
    this.container.appendChild(targetDiv);

    return new Promise((resolve) => {
      if (!window.YT || !window.YT.Player) {
        resolve();
        return;
      }

      this.player = new window.YT.Player(this.elementId, {
        videoId,
        width: '100%',
        height: '100%',
        playerVars: {
          controls: 0,
          disablekb: 1,
          modestbranding: 1,
          rel: 0,
          playsinline: 1
        },
        events: {
          onReady: () => resolve(),
          onError: () => resolve()
        }
      });
    });
  }

  async play() {
    if (this.player && typeof this.player.playVideo === 'function') {
      this.player.playVideo();
    }
  }

  async pause() {
    if (this.player && typeof this.player.pauseVideo === 'function') {
      this.player.pauseVideo();
    }
  }

  async seekTo(seconds) {
    if (this.player && typeof this.player.seekTo === 'function') {
      this.player.seekTo(Math.max(0, seconds), true);
    }
  }

  async getCurrentTime() {
    if (this.player && typeof this.player.getCurrentTime === 'function') {
      return this.player.getCurrentTime() || 0;
    }
    return 0;
  }

  async getDuration() {
    if (this.player && typeof this.player.getDuration === 'function') {
      return this.player.getDuration() || 0;
    }
    return 0;
  }

  destroy() {
    if (this.player && typeof this.player.destroy === 'function') {
      this.player.destroy();
      this.player = null;
    }
  }
}

/**
 * Vimeo Player SDK Driver
 */
export class VimeoDriver extends VideoProviderDriver {
  constructor() {
    super();
    this.player = null;
    this.elementId = `vimeo-player-${Math.random().toString(36).slice(2, 9)}`;
  }

  static extractVimeoId(url) {
    if (!url) return '';
    const match = url.match(/(?:vimeo\.com\/)(?:.*\/)?([0-9]+)/);
    return match ? match[1] : url;
  }

  static async loadAPI() {
    if (typeof window === 'undefined') return;
    if (window.Vimeo && window.Vimeo.Player) return;

    return new Promise((resolve) => {
      const existing = document.getElementById('vimeo-sdk-api');
      if (existing) {
        resolve();
        return;
      }
      const tag = document.createElement('script');
      tag.id = 'vimeo-sdk-api';
      tag.src = 'https://player.vimeo.com/api/player.js';
      tag.onload = () => resolve();
      document.head.appendChild(tag);
    });
  }

  async mount(containerEl, videoSource) {
    this.container = containerEl;
    this.source = videoSource;
    const videoId = VimeoDriver.extractVimeoId(videoSource);

    await VimeoDriver.loadAPI();

    const targetDiv = document.createElement('div');
    targetDiv.id = this.elementId;
    this.container.innerHTML = '';
    this.container.appendChild(targetDiv);

    if (window.Vimeo && window.Vimeo.Player) {
      this.player = new window.Vimeo.Player(this.elementId, {
        id: videoId,
        controls: false,
        keyboard: false,
        responsive: true
      });
      await this.player.ready();
    }
  }

  async play() {
    if (this.player) await this.player.play();
  }

  async pause() {
    if (this.player) await this.player.pause();
  }

  async seekTo(seconds) {
    if (this.player) await this.player.setCurrentTime(seconds);
  }

  async getCurrentTime() {
    if (this.player) return await this.player.getCurrentTime();
    return 0;
  }

  async getDuration() {
    if (this.player) return await this.player.getDuration();
    return 0;
  }

  destroy() {
    if (this.player) {
      this.player.destroy().catch(() => {});
      this.player = null;
    }
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
