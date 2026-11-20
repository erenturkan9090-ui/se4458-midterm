import fs from 'node:fs';
import path from 'node:path';

export interface TraceEntry {
  ts: string;
  turn: number;
  tool: string;
  source: 'MCP' | 'REST' | 'AGENT';
  input: unknown;
  ok: boolean;
  /** For REST tools: the gateway call(s) made, e.g. "GET /bills/5551000001?... -> 200". */
  http?: string[];
  output: unknown;
  ms: number;
}

/** Collects one entry per tool call; optionally echoes to the console and appends to a JSONL file. */
export class TraceRecorder {
  readonly entries: TraceEntry[] = [];
  readonly file?: string;

  constructor(opts: { dir?: string; sessionId?: string; echo?: (e: TraceEntry) => void } = {}) {
    if (opts.dir) {
      fs.mkdirSync(opts.dir, { recursive: true });
      this.file = path.join(opts.dir, `trace-${opts.sessionId ?? Date.now()}.jsonl`);
    }
    this.echo = opts.echo;
  }

  private readonly echo?: (e: TraceEntry) => void;

  record(entry: Omit<TraceEntry, 'ts'>): void {
    const e: TraceEntry = { ts: new Date().toISOString(), ...entry };
    this.entries.push(e);
    if (this.file) fs.appendFileSync(this.file, JSON.stringify(e) + '\n');
    this.echo?.(e);
  }
}

export function formatTrace(e: TraceEntry): string {
  const input = JSON.stringify(e.input);
  const http = e.http?.length ? `  ${e.http.join(', ')}` : '';
  let summary: string;
  const out = e.output as any;
  if (e.source === 'MCP' && out?.matches) {
    summary = `sections [${out.matches.map((m: any) => m.section).join(', ')}]`;
  } else {
    summary = JSON.stringify(out).slice(0, 160);
  }
  return `  [tool] ${e.source} ${e.tool}(${input})${http}  ${e.ok ? 'OK' : 'ERROR'} ${e.ms}ms\n         -> ${summary}`;
}
