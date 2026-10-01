// Cleans one sentence of model output for the balloon and for TTS:
// markdown, links, URLs and emoji become plain readable text.

const PICTOGRAPHS = /[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u{1F3FB}-\u{1F3FF}︎️‍⃣]/gu;

function domainOf(url: string): string {
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `https://${url}`;
  try {
    return new URL(withScheme).hostname.replace(/^www\./i, '');
  } catch {
    return url;
  }
}

export function cleanSpeechText(input: string): string {
  let s = input;

  // Code fences: drop the fence markers (and language ids), keep inner text.
  s = s.replace(/```[^\n`]*/g, ' ');
  s = s.replace(/`([^`]*)`/g, '$1');
  s = s.replace(/`/g, '');

  // Images and links.
  s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
  s = s.replace(/\[([^\]]+)\]\((?:[^()\s]|\([^)]*\))+(?:\s+"[^"]*")?\)/g, '$1');

  // Bare URLs become their domain.
  s = s.replace(/\b(?:https?:\/\/|www\.)[^\s<>()\[\]]+/gi, (m) => {
    const trail = /[.,;:!?'"]+$/.exec(m)?.[0] ?? '';
    return domainOf(m.slice(0, m.length - trail.length)) + trail;
  });

  // Simple HTML tags (e.g. <br>, <b>).
  s = s.replace(/<\/?[a-z][a-z0-9]*(?:\s[^<>]*)?\/?>/gi, ' ');

  // Line-level markdown: headings, quotes, bullets, rules. A leading number is
  // kept: in "4. Easy!" it is usually the answer, and reading a rare list
  // number aloud loses nothing.
  s = s.replace(/^[ \t]*#{1,6}[ \t]+/gm, '');
  s = s.replace(/^[ \t]*>[ \t]?/gm, '');
  s = s.replace(/^[ \t]*[-*+•][ \t]+/gm, '');
  s = s.replace(/^[ \t]*(?:[-*_][ \t]*){3,}$/gm, ' ');

  // Emphasis and strikethrough.
  s = s.replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, '$2');
  s = s.replace(/(^|[^\p{L}\p{N}*])\*(?=\S)([^*\n]*?\S)\*(?![\p{L}\p{N}])/gu, '$1$2');
  s = s.replace(/(^|[^\p{L}\p{N}_])_(?=\S)([^_\n]*?\S)_(?![\p{L}\p{N}])/gu, '$1$2');
  s = s.replace(/~~(?=\S)([\s\S]*?\S)~~/g, '$1');
  s = s.replace(/\*{2,}|_{2,}|~{2,}/g, '');

  // Emoji and other pictographs.
  s = s.replace(PICTOGRAPHS, '');

  // Whitespace and spacing around punctuation left behind by removals.
  s = s.replace(/\s+/g, ' ');
  s = s.replace(/\s+([.,!?;:])/g, '$1');
  s = s.replace(/\(\s*\)/g, '');
  return s.trim();
}
