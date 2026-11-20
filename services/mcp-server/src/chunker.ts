/**
 * Splits the billing guide into section-level chunks.
 *
 * Every numbered heading becomes a citable unit:
 *   "## 3. Internet pricing"         -> section "3"
 *   "### 3.2 Additional internet..." -> section "3.2"
 * A "##" section only becomes a chunk when it has body text of its own (e.g. §1),
 * so §3 does not duplicate §3.1–§3.3. Text before the first numbered heading
 * (title, metadata, disclaimer) becomes section "0" ("Document overview").
 */
export interface Chunk {
  /** Section ID as printed in the guide, e.g. "3.2". */
  section: string;
  /** Heading without its number, e.g. "Additional internet blocks". */
  heading: string;
  /** Heading of the enclosing "##" section, e.g. "Internet pricing". */
  parentHeading: string;
  /** Section body with markdown emphasis removed. */
  text: string;
}

const HEADING = /^(#{2,3})\s+(\d+(?:\.\d+)*)\.?\s+(.+?)\s*$/;

export function cleanMarkdown(s: string): string {
  return s
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/^>\s?/gm, '')
    .replace(/^#\s+/gm, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function chunkMarkdown(markdown: string): Chunk[] {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const chunks: Chunk[] = [];

  let current: { section: string; heading: string; parentHeading: string; body: string[] } = {
    section: '0',
    heading: 'Document overview',
    parentHeading: '',
    body: [],
  };
  let parentHeading = '';
  let inCodeBlock = false;

  const flush = () => {
    const text = cleanMarkdown(current.body.join('\n'));
    if (text) {
      chunks.push({
        section: current.section,
        heading: current.heading,
        parentHeading: current.parentHeading,
        text,
      });
    }
  };

  for (const line of lines) {
    if (line.trimStart().startsWith('```')) inCodeBlock = !inCodeBlock;
    const m = inCodeBlock ? null : HEADING.exec(line);
    if (!m) {
      current.body.push(line);
      continue;
    }
    flush();
    const [, hashes, section, heading] = m;
    if (hashes.length === 2) parentHeading = heading;
    current = {
      section,
      heading,
      parentHeading: hashes.length === 2 ? '' : parentHeading,
      body: [],
    };
  }
  flush();
  return chunks;
}
