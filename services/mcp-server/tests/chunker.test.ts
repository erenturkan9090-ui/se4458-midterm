import fs from 'node:fs';
import { chunkMarkdown, cleanMarkdown } from '../src/chunker';
import { DEFAULT_DOC_PATH } from '../src/billingDocs';

const guide = fs.readFileSync(DEFAULT_DOC_PATH, 'utf8');

describe('chunkMarkdown', () => {
  it('creates one chunk per numbered section of the billing guide', () => {
    const sections = chunkMarkdown(guide).map((c) => c.section);
    expect(sections).toEqual([
      '0', '1', '2.1', '2.2', '2.3', '3.1', '3.2', '3.3', '4.1', '4.2', '4.3', '4.4',
      '5.1', '5.2', '5.3', '6.1', '6.2', '6.3', '7.1', '7.2', '7.3',
      '8.1', '8.2', '8.3', '8.4', '9',
    ]);
  });

  it('keeps heading, parent heading and cleaned text for a subsection', () => {
    const c = chunkMarkdown(guide).find((x) => x.section === '3.2')!;
    expect(c.heading).toBe('Additional internet blocks');
    expect(c.parentHeading).toBe('Internet pricing');
    expect(c.text).toContain('Each additional 10 GB block costs $10.');
    expect(c.text).not.toContain('**');
  });

  it('does not split on "#" lines inside fenced code blocks', () => {
    const md = '## 1. A\n\nintro\n\n```\n## 2. not a heading\n```\n\n## 2. B\n\nbody';
    const chunks = chunkMarkdown(md);
    expect(chunks.map((c) => c.section)).toEqual(['1', '2']);
    expect(chunks[0].text).toContain('## 2. not a heading');
  });

  it('returns no chunks for an empty document (failure case)', () => {
    expect(chunkMarkdown('')).toEqual([]);
    expect(chunkMarkdown('   \n\n')).toEqual([]);
  });

  it('cleanMarkdown strips emphasis and inline code', () => {
    expect(cleanMarkdown('**$50** for `20 GB`')).toBe('$50 for 20 GB');
  });
});
