/**
 * Lists the Gemini models this GEMINI_API_KEY can call with generateContent, so a less
 * loaded model can be picked with GEMINI_MODEL when the default one returns 503/504:
 *   npm run models -w agent
 */
import type { GoogleGenAI as GoogleGenAIType } from '@google/genai' with { 'resolution-mode': 'import' };

const { GoogleGenAI } = require('@google/genai') as { GoogleGenAI: typeof GoogleGenAIType };

async function main() {
  const ai = new GoogleGenAI({});
  const names: string[] = [];
  for await (const m of await ai.models.list()) {
    const actions = m.supportedActions ?? [];
    if (m.name?.includes('gemini') && actions.includes('generateContent')) {
      names.push(m.name.replace(/^models\//, ''));
    }
  }
  console.log(names.sort().join('\n'));
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
