/**
 * Reactive Pub/Sub State Container & Cross-Module Event Bus
 */
export class AppStore {
  constructor(initialState = {}) {
    this._state = {
      currentRoute: '#/flashcards',
      activeDeckId: null,
      activeDeck: null,
      activeTimelineId: null,
      activeTimeline: null,
      activeVideoId: null,
      activeVideo: null,
      activeCourseId: null,
      activeCourse: null,
      ephemeralData: null,
      storageQuota: { usage: 0, quota: 0, percent: 0 },
      isPrivateBrowsing: false,
      autoSyncStatus: 'idle', // 'idle' | 'saving' | 'synced' | 'error' | 'unauthorized'
      ...initialState
    };

    this._stateSubscribers = new Map(); // key -> Set<callback>
    this._eventListeners = new Map(); // eventName -> Set<callback>
  }

  /**
   * Get entire state or specific slice
   * @param {string} [key]
   */
  getState(key) {
    if (key) {
      return this._state[key];
    }
    return { ...this._state };
  }

  /**
   * Update a specific state slice or merge object
   * @param {string|object} keyOrPartialState
   * @param {*} [value]
   */
  setState(keyOrPartialState, value) {
    const changes = {};

    if (typeof keyOrPartialState === 'string') {
      changes[keyOrPartialState] = value;
    } else if (typeof keyOrPartialState === 'object' && keyOrPartialState !== null) {
      Object.assign(changes, keyOrPartialState);
    }

    const modifiedKeys = [];
    for (const [key, val] of Object.entries(changes)) {
      if (this._state[key] !== val) {
        this._state[key] = val;
        modifiedKeys.push(key);
      }
    }

    for (const key of modifiedKeys) {
      this._notifyKey(key, this._state[key]);
    }
  }

  /**
   * Subscribe to changes on a specific state key
   * @param {string} key
   * @param {(value: any, key: string) => void} callback
   * @returns {() => void} unsubscribe function
   */
  subscribe(key, callback) {
    if (!this._stateSubscribers.has(key)) {
      this._stateSubscribers.set(key, new Set());
    }
    this._stateSubscribers.get(key).add(callback);

    // Call immediately with current value
    callback(this._state[key], key);

    return () => {
      const subs = this._stateSubscribers.get(key);
      if (subs) {
        subs.delete(callback);
        if (subs.size === 0) this._stateSubscribers.delete(key);
      }
    };
  }

  _notifyKey(key, value) {
    const subs = this._stateSubscribers.get(key);
    if (subs) {
      for (const cb of subs) {
        try {
          cb(value, key);
        } catch (err) {
          console.error(`Error in state subscriber for ${key}:`, err);
        }
      }
    }
    // Also notify wildcard subscribers
    const wildcardSubs = this._stateSubscribers.get('*');
    if (wildcardSubs) {
      for (const cb of wildcardSubs) {
        try {
          cb(this._state, key);
        } catch (err) {
          console.error('Error in wildcard state subscriber:', err);
        }
      }
    }
  }

  /**
   * Cross-module event bus: publish an event
   * @param {string} eventName
   * @param {*} payload
   */
  publish(eventName, payload) {
    const listeners = this._eventListeners.get(eventName);
    if (listeners) {
      for (const listener of listeners) {
        try {
          listener(payload, eventName);
        } catch (err) {
          console.error(`Error in event listener for ${eventName}:`, err);
        }
      }
    }
  }

  /**
   * Cross-module event bus: subscribe to an event
   * @param {string} eventName
   * @param {(payload: any, eventName: string) => void} listener
   * @returns {() => void} unsubscribe function
   */
  on(eventName, listener) {
    if (!this._eventListeners.has(eventName)) {
      this._eventListeners.set(eventName, new Set());
    }
    this._eventListeners.get(eventName).add(listener);

    return () => {
      const listeners = this._eventListeners.get(eventName);
      if (listeners) {
        listeners.delete(listener);
        if (listeners.size === 0) this._eventListeners.delete(eventName);
      }
    };
  }
}

export const store = new AppStore();
export default store;
