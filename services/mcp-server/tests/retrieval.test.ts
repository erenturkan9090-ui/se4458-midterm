/**
 * The three MCP retrieval tests required by the assignment, plus edge cases.
 * Each query is phrased the way a subscriber would ask, not copied from the guide.
 */
import fs from 'node:fs';
import { BillingDocs } from '../src/billingDocs';
import { stem, tokenize } from '../src/searchIndex';

const docs = BillingDocs.fromFile();
const sectionsFor = (q: string, n = 3) => docs.search(q, n).matches.map((m) => m.section);

describe('retrieval test 1: extra internet cost', () => {
  it('returns the additional-internet-block rule (3.2 / FAQ 8.1) first', () => {
    const result = docs.search('How much do I pay if I use more than 20 GB of data?');
    expect(['3.2', '8.1']).toContain(result.matches[0].section);
    expect(result.matches.map((m) => m.section)).toContain('3.2');
    const s32 = result.matches.find((m) => m.section === '3.2')!;
    expect(s32.heading).toBe('Additional internet blocks');
    expect(s32.text).toMatch(/Each additional 10 GB block costs \$10/);
  });
});

describe('retrieval test 2: partial payment', () => {
  it('returns the partial payment policy (5.1 and/or FAQ 8.3)', () => {
    const sections = sectionsFor('Can I pay just a portion of my bill now and the rest later?');
    expect(sections[0]).toBe('8.3');
    expect(sections).toContain('5.1');
  });
});

describe('retrieval test 3: disputes', () => {
  it('returns the dispute process (section 7 / FAQ 8.4)', () => {
    const result = docs.search('I think my bill is wrong, how do I file a complaint?');
    const sections = result.matches.map((m) => m.section);
    expect(sections.some((s) => s.startsWith('7.') || s === '8.4')).toBe(true);
    expect(result.matches.map((m) => m.text).join(' ')).toMatch(/15 (calendar )?days/);
  });
});

describe('other policy questions', () => {
  it.each([
    ['how many free minutes do I get', '2.1'],
    ['when is my October bill due?', '6.1'],
    ['does the assistant need my approval before paying?', '5.2'],
    ['will my line be suspended if I do not pay', '6.3'],
    ['why is my bill higher this month', '8.2'],
  ])('"%s" -> top match %s', (query, expected) => {
    expect(sectionsFor(query)[0]).toBe(expected);
  });
});

describe('result shape (Billing Guide §9)', () => {
  it('returns document, documentId and section/heading/text per match', () => {
    const r = docs.search('extra internet');
    expect(r.document).toBe('Mobile_Provider_Billing_Guide.md');
    expect(r.documentId).toBe('MOB-BILLING-2026-01');
    for (const m of r.matches) {
      expect(m).toEqual({
        section: expect.any(String),
        heading: expect.any(String),
        text: expect.any(String),
        score: expect.any(Number),
      });
    }
  });

  it('respects maxResults', () => {
    expect(docs.search('payment bill due late', 1).matches).toHaveLength(1);
    expect(docs.search('payment bill due late', 5).matches.length).toBeLessThanOrEqual(5);
  });
});

describe('failure / edge cases', () => {
  it('returns no matches for an unrelated query', () => {
    expect(docs.search('zzqx qwerty').matches).toEqual([]);
  });

  it('returns no matches for a query made only of stop words', () => {
    expect(docs.search('what is the').matches).toEqual([]);
  });

  it('indexes once: searching does not read the file again', () => {
    const spy = jest.spyOn(fs, 'readFileSync');
    docs.search('late payment');
    docs.search('dispute');
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('tokenizer', () => {
  it('stems plurals and verb forms', () => {
    expect(stem('blocks')).toBe('block');
    expect(stem('payments')).toBe('payment');
    expect(stem('charged')).toBe('charg');
    expect(stem('charges')).toBe('charge');
  });

  it('drops stop words and keeps numbers', () => {
    expect(tokenize('What is the cost of 20 GB?')).toEqual(['cost', '20', 'gb']);
  });
});
