/**
 * In-memory BM25 full-text index over guide chunks.
 *
 * Built once (at server start-up) from the chunk list; queries only read it.
 * - Tokens: lower-case words and numbers; a few English stop words are dropped
 *   and a light suffix stemmer folds plurals/verb forms ("blocks" -> "block").
 * - Heading words count twice, so a query that names a topic ranks the section
 *   about it above sections that only mention it.
 * - A small synonym table expands the query with the guide's own vocabulary
 *   ("extra" -> "additional", "overdue" -> "late", "complaint" -> "dispute").
 */
import type { Chunk } from './chunker';

const STOP_WORDS = new Set(
  (
    'a an and are as at be by can do does for from how i if in is it its me my of on or ' +
    'so that the their them then there this to was what when which who will with you your'
  ).split(' '),
);

/** Each group maps user wording onto words that appear in the guide. */
const SYNONYMS: string[][] = [
  ['additional', 'extra', 'more', 'over', 'exceed', 'beyond'],
  ['cost', 'price', 'pricing', 'fee', 'charge', 'expensive', 'much'],
  ['pay', 'payment', 'paid', 'settle'],
  ['internet', 'data', 'mobile data', 'gb', 'mb', 'gigabyte', 'megabyte'],
  ['phone', 'call', 'minute', 'voice'],
  ['partial', 'part', 'portion', 'some', 'installment'],
  ['late', 'overdue', 'missed', 'unpaid', 'after due'],
  ['restriction', 'restrict', 'suspend', 'suspension', 'cut', 'block service', 'disconnect'],
  ['dispute', 'complaint', 'contest', 'challenge', 'wrong', 'incorrect', 'object'],
  ['refund', 'adjustment', 'money back', 'reimburse'],
  ['confirmation', 'confirm', 'consent', 'approve', 'agree'],
  ['due', 'deadline', 'due date'],
  ['bill', 'invoice', 'statement'],
  ['higher', 'increase', 'bigger', 'went up'],
  ['included', 'free', 'allowance'],
];

export function stem(word: string): string {
  if (word.length <= 3 || /^\d/.test(word)) return word;
  for (const [suffix, minLen] of [
    ['ies', 5],
    ['ing', 6],
    ['ed', 5],
    ['es', 5],
    ['s', 4],
  ] as const) {
    if (word.endsWith(suffix) && word.length >= minLen) {
      const base = word.slice(0, -suffix.length);
      if (suffix === 'ies') return base + 'y';
      if (suffix === 'es' && !/(ch|sh|x|ss|z)$/.test(base)) return base + 'e';
      if (suffix === 's' && word.endsWith('ss')) return word;
      return base;
    }
  }
  return word;
}

export function tokenize(text: string): string[] {
  const words = text.toLowerCase().match(/[a-z]+|\d+(?:\.\d+)?/g) ?? [];
  return words.filter((w) => !STOP_WORDS.has(w)).map(stem);
}

/** Stemmed synonym table: token -> other tokens of the same group. */
const SYNONYM_INDEX: Map<string, Set<string>> = (() => {
  const map = new Map<string, Set<string>>();
  for (const group of SYNONYMS) {
    const tokens = new Set(group.flatMap((phrase) => tokenize(phrase)));
    for (const t of tokens) {
      const set = map.get(t) ?? new Set<string>();
      tokens.forEach((o) => o !== t && set.add(o));
      map.set(t, set);
    }
  }
  return map;
})();

export interface SearchHit {
  chunk: Chunk;
  score: number;
}

const K1 = 1.2;
const B = 0.75;
const HEADING_WEIGHT = 2;
/** Expanded (synonym) terms count less than the words the user actually typed. */
const SYNONYM_WEIGHT = 0.5;

export class SearchIndex {
  private readonly docs: { chunk: Chunk; tf: Map<string, number>; length: number }[];
  private readonly df = new Map<string, number>();
  private readonly avgLength: number;

  constructor(chunks: Chunk[]) {
    this.docs = chunks.map((chunk) => {
      const tokens = [
        ...Array(HEADING_WEIGHT).fill(tokenize(chunk.heading)).flat(),
        ...tokenize(chunk.parentHeading),
        ...tokenize(chunk.text),
      ] as string[];
      const tf = new Map<string, number>();
      for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
      return { chunk, tf, length: tokens.length };
    });
    for (const d of this.docs) for (const t of d.tf.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1);
    this.avgLength = this.docs.reduce((s, d) => s + d.length, 0) / Math.max(1, this.docs.length);
  }

  get size(): number {
    return this.docs.length;
  }

  /** Query terms with weights: typed words 1.0, synonym expansions 0.5. */
  private queryTerms(query: string): Map<string, number> {
    const terms = new Map<string, number>();
    for (const t of tokenize(query)) terms.set(t, 1);
    for (const t of [...terms.keys()]) {
      for (const s of SYNONYM_INDEX.get(t) ?? []) {
        if (!terms.has(s)) terms.set(s, SYNONYM_WEIGHT);
      }
    }
    return terms;
  }

  private idf(term: string): number {
    const n = this.docs.length;
    const df = this.df.get(term) ?? 0;
    return Math.log(1 + (n - df + 0.5) / (df + 0.5));
  }

  search(query: string, limit = 3): SearchHit[] {
    const terms = this.queryTerms(query);
    const hits: SearchHit[] = [];
    for (const d of this.docs) {
      let score = 0;
      for (const [term, weight] of terms) {
        const f = d.tf.get(term);
        if (!f) continue;
        const norm = f + K1 * (1 - B + (B * d.length) / this.avgLength);
        score += weight * this.idf(term) * ((f * (K1 + 1)) / norm);
      }
      if (score > 0) hits.push({ chunk: d.chunk, score });
    }
    hits.sort((a, b) => b.score - a.score || a.chunk.section.localeCompare(b.chunk.section));
    if (hits.length === 0) return [];
    // Drop weak tail matches: keep hits scoring at least 35% of the best one.
    const cutoff = hits[0].score * 0.35;
    return hits.filter((h) => h.score >= cutoff).slice(0, limit);
  }
}
