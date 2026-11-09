// Browser stand-in for ml_categorizer.py. Same features as the scikit-learn
// pipeline (TF-IDF over word-bounded character 2-5 grams, sublinear tf, L2
// norm), but a nearest-neighbour vote instead of logistic regression: no
// training step, and a correction counts the moment it is saved.
//
// predict() answers only when the closest training example is similar enough;
// otherwise it returns null and the caller falls back to 'Other'.

const MIN_SIMILARITY = 0.45;

function ngrams(text) {
  const grams = new Map();
  for (const word of text.toLowerCase().split(/\s+/).filter(Boolean)) {
    const w = ` ${word} `;
    for (let n = 2; n <= 5; n++) {
      if (w.length < n) break;
      for (let i = 0; i + n <= w.length; i++) {
        const g = w.slice(i, i + n);
        grams.set(g, (grams.get(g) || 0) + 1);
      }
    }
  }
  return grams;
}

export class Categorizer {
  constructor(corpus) {
    this.cache = new Map();
    const docs = corpus.map(([text, cat]) => ({ grams: ngrams(text), cat }));
    const df = new Map();
    for (const d of docs) for (const g of d.grams.keys()) df.set(g, (df.get(g) || 0) + 1);
    const n = docs.length;
    this.idf = new Map();
    for (const [g, c] of df) this.idf.set(g, Math.log((1 + n) / (1 + c)) + 1);
    this.docs = docs.map(d => ({ vec: this.vectorize(d.grams), cat: d.cat }));
    this.enabled = new Set(docs.map(d => d.cat)).size >= 2;
  }

  vectorize(grams) {
    const v = new Map();
    let norm = 0;
    for (const [g, tf] of grams) {
      const idf = this.idf.get(g);
      if (!idf) continue;
      const w = (1 + Math.log(tf)) * idf;
      v.set(g, w);
      norm += w * w;
    }
    norm = Math.sqrt(norm) || 1;
    for (const [g, w] of v) v.set(g, w / norm);
    return v;
  }

  predict(text) {
    if (!this.enabled) return null;
    if (this.cache.has(text)) return this.cache.get(text);
    const q = this.vectorize(ngrams(text));
    let best = null, bestSim = 0;
    for (const d of this.docs) {
      let sim = 0;
      const [small, big] = q.size < d.vec.size ? [q, d.vec] : [d.vec, q];
      for (const [g, w] of small) {
        const o = big.get(g);
        if (o) sim += w * o;
      }
      if (sim > bestSim) { bestSim = sim; best = d.cat; }
    }
    const answer = bestSim >= MIN_SIMILARITY ? best : null;
    this.cache.set(text, answer);
    return answer;
  }
}
