/**
 * Loads the billing guide, chunks it and builds the search index ONCE.
 * The tool handler only queries the prebuilt index.
 */
import fs from 'node:fs';
import path from 'node:path';
import { chunkMarkdown, type Chunk } from './chunker';
import { SearchIndex } from './searchIndex';

export const DOCUMENT_NAME = 'Mobile_Provider_Billing_Guide.md';
export const DEFAULT_DOC_PATH = path.join(__dirname, '..', 'data', DOCUMENT_NAME);

export interface Match {
  section: string;
  heading: string;
  text: string;
  score: number;
}

export interface SearchResult {
  document: string;
  documentId: string;
  query: string;
  matches: Match[];
}

export class BillingDocs {
  readonly documentId: string;
  readonly chunks: Chunk[];
  private readonly index: SearchIndex;

  constructor(markdown: string) {
    this.chunks = chunkMarkdown(markdown);
    this.index = new SearchIndex(this.chunks);
    this.documentId = /Document ID:\**\s*([A-Z0-9-]+)/i.exec(markdown)?.[1] ?? 'unknown';
  }

  static fromFile(file = DEFAULT_DOC_PATH): BillingDocs {
    return new BillingDocs(fs.readFileSync(file, 'utf8'));
  }

  search(query: string, maxResults = 3): SearchResult {
    return {
      document: DOCUMENT_NAME,
      documentId: this.documentId,
      query,
      matches: this.index.search(query, maxResults).map(({ chunk, score }) => ({
        section: chunk.section,
        heading: chunk.heading,
        text: chunk.text,
        score: Math.round(score * 100) / 100,
      })),
    };
  }
}
