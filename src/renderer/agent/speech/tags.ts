// Streaming parser for inline [[Tag]] markers in model output.
// Deltas may split a tag anywhere ('[', '[Wa', 've]] Hi'). Text that only
// looks like a bracket passes through unchanged. Well-formed tags are always
// removed from the text, whether or not they name a known gesture.

export type TagToken =
  /** pos: offset of this text in the tag-free output stream. */
  | { type: 'text'; text: string; pos: number }
  /** pos: offset in the tag-free output stream where the tag appeared. */
  | { type: 'tag'; name: string; pos: number };

export const MAX_TAG_LENGTH = 40;

const NAME_CHAR = /^[A-Za-z0-9 _-]$/;

function isValidName(raw: string): boolean {
  if (raw.length > MAX_TAG_LENGTH) return false;
  const name = raw.trim();
  if (!name || !/^[A-Za-z]/.test(name)) return false;
  for (const ch of raw) if (!NAME_CHAR.test(ch)) return false;
  return true;
}

export class TagParser {
  private pending = '';
  private emitted = 0;

  push(chunk: string): TagToken[] {
    this.pending += chunk;
    return this.drain(false);
  }

  /** Ends the stream: any half-open tag is returned as text. */
  flush(): TagToken[] {
    return this.drain(true);
  }

  reset(): void {
    this.pending = '';
    this.emitted = 0;
  }

  private drain(final: boolean): TagToken[] {
    const out: TagToken[] = [];
    let text = '';
    const buf = this.pending;
    let i = 0;
    let keepFrom = buf.length;

    while (i < buf.length) {
      const open = buf.indexOf('[', i);
      if (open < 0) {
        text += buf.slice(i);
        i = buf.length;
        break;
      }
      text += buf.slice(i, open);
      if (open + 1 >= buf.length) {
        // A lone '[' at the end may become '[['.
        if (final) {
          text += '[';
          i = buf.length;
        } else {
          keepFrom = open;
          i = buf.length;
        }
        break;
      }
      if (buf[open + 1] !== '[') {
        text += '[';
        i = open + 1;
        continue;
      }
      const close = buf.indexOf(']]', open + 2);
      if (close >= 0) {
        const raw = buf.slice(open + 2, close);
        if (isValidName(raw)) {
          if (text) {
            out.push({ type: 'text', text, pos: this.emitted });
            this.emitted += text.length;
            text = '';
          }
          out.push({ type: 'tag', name: raw.trim(), pos: this.emitted });
          i = close + 2;
          continue;
        }
        text += '[';
        i = open + 1;
        continue;
      }
      // No closing yet: keep waiting only while it can still become a tag.
      const partial = buf.slice(open + 2);
      const body = partial.endsWith(']') ? partial.slice(0, -1) : partial;
      let plausible = !final && body.length <= MAX_TAG_LENGTH;
      if (plausible) for (const ch of body) if (!NAME_CHAR.test(ch)) plausible = false;
      if (plausible) {
        keepFrom = open;
        i = buf.length;
        break;
      }
      text += '[';
      i = open + 1;
    }

    if (text) {
      out.push({ type: 'text', text, pos: this.emitted });
      this.emitted += text.length;
    }
    this.pending = keepFrom < buf.length ? buf.slice(keepFrom) : '';
    return out;
  }
}

/** Convenience for whole strings: returns the tag-free text and the tag names. */
export function extractTags(input: string): { text: string; tags: string[] } {
  const p = new TagParser();
  const tokens = [...p.push(input), ...p.flush()];
  let text = '';
  const tags: string[] = [];
  for (const t of tokens) {
    if (t.type === 'text') text += t.text;
    else tags.push(t.name);
  }
  return { text, tags };
}
