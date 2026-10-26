/**
 * BM25 Inverted Full-Text Search Web Worker (KB-SEARCH-001)
 * Zero external dependencies: works in any standard Web Worker without import maps.
 */

const K1 = 1.2;
const B = 0.75;

const STOP_WORDS = new Set([
  'a', 'about', 'above', 'after', 'again', 'against', 'all', 'am', 'an', 'and', 'any', 'are', 'as',
  'at', 'be', 'because', 'been', 'before', 'being', 'below', 'between', 'both', 'but', 'by', 'can',
  'could', 'did', 'do', 'does', 'doing', 'down', 'during', 'each', 'few', 'for', 'from', 'further',
  'had', 'has', 'have', 'having', 'he', 'her', 'here', 'hers', 'herself', 'him', 'himself', 'his',
  'how', 'i', 'if', 'in', 'into', 'is', 'it', 'its', 'itself', 'just', 'me', 'more', 'most', 'my',
  'myself', 'no', 'nor', 'not', 'of', 'off', 'on', 'once', 'only', 'or', 'other', 'ought', 'our',
  'ours', 'ourselves', 'out', 'over', 'own', 'same', 'she', 'should', 'so', 'some', 'such', 'than',
  'that', 'the', 'their', 'theirs', 'them', 'themselves', 'then', 'there', 'these', 'they', 'this',
  'those', 'through', 'to', 'too', 'under', 'until', 'up', 'very', 'was', 'we', 'were', 'what',
  'when', 'where', 'which', 'while', 'who', 'whom', 'why', 'with', 'would', 'you', 'your', 'yours'
]);

function tokenize(text) {
  if (!text) return [];
  const normalized = String(text).toLowerCase();
  const rawTokens = normalized.match(/[\p{L}\p{N}]+/gu) || [];
  return rawTokens.filter(t => t.length > 1 && !STOP_WORDS.has(t));
}

class SearchIndex {
  constructor() {
    this.docs = new Map(); // id -> doc
    this.postings = new Map(); // term -> Map<docId, termFrequency>
    this.docLengths = new Map(); // docId -> totalTokens
    this.totalLength = 0;
  }

  addDocument(doc) {
    if (!doc || !doc.id) return;
    if (this.docs.has(doc.id)) {
      this.removeDocument(doc.id);
    }

    const titleTokens = tokenize(doc.title || '');
    const categoryTokens = tokenize(doc.category || '');
    const bodyTokens = tokenize(doc.body || '');

    const tfMap = new Map();

    // Weight title 3.0x, category 2.0x, body 1.0x
    for (const t of titleTokens) {
      tfMap.set(t, (tfMap.get(t) || 0) + 3.0);
    }
    for (const t of categoryTokens) {
      tfMap.set(t, (tfMap.get(t) || 0) + 2.0);
    }
    for (const t of bodyTokens) {
      tfMap.set(t, (tfMap.get(t) || 0) + 1.0);
    }

    const docLen = titleTokens.length * 3 + categoryTokens.length * 2 + bodyTokens.length;
    this.docs.set(doc.id, doc);
    this.docLengths.set(doc.id, docLen);
    this.totalLength += docLen;

    for (const [term, freq] of tfMap.entries()) {
      let post = this.postings.get(term);
      if (!post) {
        post = new Map();
        this.postings.set(term, post);
      }
      post.set(doc.id, freq);
    }
  }

  removeDocument(id) {
    if (!this.docs.has(id)) return;
    const len = this.docLengths.get(id) || 0;
    this.totalLength = Math.max(0, this.totalLength - len);
    this.docLengths.delete(id);
    this.docs.delete(id);

    for (const [term, post] of this.postings.entries()) {
      post.delete(id);
      if (post.size === 0) {
        this.postings.delete(term);
      }
    }
  }

  search(queryStr, limit = 20) {
    const queryTokens = tokenize(queryStr);
    if (!queryTokens.length) return [];

    const N = this.docs.size;
    if (N === 0) return [];
    const avgdl = (this.totalLength / N) || 1;

    const scores = new Map(); // docId -> score

    for (const q of queryTokens) {
      // Exact match or prefix match (prefix if q length >= 3)
      const matchingTerms = [];
      if (this.postings.has(q)) {
        matchingTerms.push({ term: q, weight: 1.0 });
      }
      if (q.length >= 3) {
        for (const term of this.postings.keys()) {
          if (term !== q && term.startsWith(q)) {
            matchingTerms.push({ term, weight: 0.7 });
          }
        }
      }

      for (const { term, weight } of matchingTerms) {
        const post = this.postings.get(term);
        if (!post) continue;

        const df = post.size;
        // Robertson-Spärck Jones IDF
        const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5)) * weight;

        for (const [docId, tf] of post.entries()) {
          const docLen = this.docLengths.get(docId) || avgdl;
          const num = tf * (K1 + 1);
          const denom = tf + K1 * (1 - B + B * (docLen / avgdl));
          const termScore = idf * (num / denom);

          scores.set(docId, (scores.get(docId) || 0) + termScore);
        }
      }
    }

    const sorted = Array.from(scores.entries())
      .filter(([, score]) => score > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit);

    return sorted.map(([id, score]) => {
      const doc = this.docs.get(id);
      return {
        id: doc.id,
        title: doc.title,
        category: doc.category,
        route: doc.route,
        classId: doc.classId || null,
        snippet: this._makeSnippet(doc.body || '', queryTokens),
        score: Math.round(score * 100) / 100
      };
    });
  }

  _makeSnippet(body, queryTokens) {
    if (!body) return '';
    const lower = body.toLowerCase();
    let bestIdx = -1;

    for (const q of queryTokens) {
      const idx = lower.indexOf(q);
      if (idx !== -1) {
        bestIdx = idx;
        break;
      }
    }

    if (bestIdx === -1) {
      return body.slice(0, 100) + (body.length > 100 ? '…' : '');
    }

    const start = Math.max(0, bestIdx - 40);
    const end = Math.min(body.length, bestIdx + 80);
    let snippet = body.slice(start, end).trim();
    if (start > 0) snippet = '…' + snippet;
    if (end < body.length) snippet = snippet + '…';
    return snippet;
  }
}

const index = new SearchIndex();

self.onmessage = (e) => {
  const { type, payload, correlationId } = e.data || {};

  switch (type) {
    case 'INDEX_INIT':
      if (Array.isArray(payload)) {
        for (const doc of payload) {
          index.addDocument(doc);
        }
      }
      self.postMessage({ type: 'INDEX_READY', count: index.docs.size, correlationId });
      break;

    case 'DOC_UPSERT':
      if (payload && payload.id) {
        index.addDocument(payload);
      }
      break;

    case 'DOC_REMOVE':
      if (payload && payload.id) {
        index.removeDocument(payload.id);
      }
      break;

    case 'SEARCH':
      const results = index.search(payload?.query || '', payload?.limit || 20);
      self.postMessage({ type: 'SEARCH_RESULTS', results, correlationId });
      break;
  }
};
