// The speech balloon: progressive text reveal, paging, error / listening
// variants, modern and classic (MS Agent) styles, fade in / out.

import type { AcsBalloonInfo, AcsColor } from '../../shared/acs/index.ts';
import type { BalloonStyle } from '../../shared/settings.ts';
import { LAYOUT } from '../../shared/layout.ts';
import type { BalloonPlacement, Size } from './placement.ts';

export type BalloonVariant = 'normal' | 'error';

export interface RevealHandle {
  /** 0..1 of the item spoken so far; reveals whole words. */
  setProgress(fraction: number): void;
  /** Shows the whole item. */
  complete(): void;
}

/** Characters on one balloon "page" before the next sentence starts a new page. */
const PAGE_CHARS = 280;
/** Default cap for the balloon height (longer text scrolls). */
export const BALLOON_MAX_HEIGHT = 260;
const FADE_MS = 170;

/** True when a following sentence of nextChars would land on the current page (same rule as startItem's paging). */
export function nextSharesPage(pageChars: number, nextChars: number): boolean {
  return nextChars > 0 && pageChars + 1 + nextChars <= PAGE_CHARS;
}

function css(c: AcsColor): string {
  return `rgb(${c.r}, ${c.g}, ${c.b})`;
}

export class Balloon {
  /** Called when the balloon appears, disappears or changes size. */
  onChange: () => void = () => {};

  readonly el: HTMLElement;
  readonly textEl: HTMLElement;
  private readonly sr: HTMLElement;
  private styleName: BalloonStyle = 'modern';
  private hideTimer: ReturnType<typeof setTimeout> | null = null;
  private fadeTimer: ReturnType<typeof setTimeout> | null = null;
  private pageChars = 0;
  private freshPage = true;
  private shown = false;

  constructor(el: HTMLElement, textEl: HTMLElement) {
    this.el = el;
    this.textEl = textEl;
    this.textEl.setAttribute('aria-hidden', 'true');
    this.sr = document.createElement('div');
    this.sr.className = 'sr-only';
    this.el.appendChild(this.sr);
  }

  get visible(): boolean {
    return this.shown;
  }

  get style(): BalloonStyle {
    return this.styleName;
  }

  /** Height of the tail outside the balloon box, for placement. */
  get tailSize(): number {
    return this.styleName === 'classic' ? 15 : 11;
  }

  setStyle(style: BalloonStyle, info: AcsBalloonInfo | null): void {
    this.styleName = style;
    this.el.classList.toggle('modern', style === 'modern');
    this.el.classList.toggle('classic', style === 'classic');
    const s = this.el.style;
    if (info) {
      const font = info.fontName.replace(/["'\\;{}]/g, '').trim();
      s.setProperty('--c-bg', css(info.background));
      s.setProperty('--c-fg', css(info.foreground));
      s.setProperty('--c-border', css(info.border));
      s.setProperty('--c-font', `${font ? `"${font}", ` : ''}"Microsoft Sans Serif", Tahoma, sans-serif`);
      const px = Math.abs(info.fontHeight);
      s.setProperty('--c-size', `${px >= 8 && px <= 32 ? px : 13}px`);
      s.setProperty('--c-weight', String(info.fontWeight || 400));
    } else {
      for (const p of ['--c-bg', '--c-fg', '--c-border', '--c-font', '--c-size', '--c-weight']) s.removeProperty(p);
    }
    this.onChange();
  }

  /** The next item starts on a clean balloon. */
  newPage(): void {
    this.freshPage = true;
  }

  /**
   * Adds a sentence to the balloon, hidden until revealed with the handle.
   * nextChars: length of the sentence expected next (0: none). When it will
   * land on this page, the balloon takes its full width now instead of
   * jumping wider mid-reply.
   */
  startItem(text: string, variant: BalloonVariant = 'normal', nextChars = 0): RevealHandle {
    this.cancelHide();
    if (this.freshPage || this.pageChars + text.length > PAGE_CHARS || this.textEl.querySelector('.listening-line')) {
      this.clear();
    }
    this.freshPage = false;
    this.el.classList.toggle('error', variant === 'error');

    const seg = document.createElement('span');
    const shownEl = document.createElement('span');
    const pendingEl = document.createElement('span');
    pendingEl.className = 'pending';
    const note = this.textEl.querySelector(':scope > .note');
    const prevSeg = (note ? note.previousElementSibling : this.textEl.lastElementChild) !== null;
    const prefix = prevSeg ? ' ' : '';
    pendingEl.textContent = prefix + text;
    seg.append(shownEl, pendingEl);
    // Notes stay at the bottom of the page.
    this.textEl.insertBefore(seg, note);
    this.pageChars += prefix.length + text.length;
    // Set before open(), so the measure that onChange triggers already sees the final width.
    if (nextSharesPage(this.pageChars, nextChars)) this.el.classList.add('wide');
    this.sr.textContent = text;
    this.open();

    const full = prefix + text;
    let shownLen = 0;
    const show = (n: number): void => {
      if (n <= shownLen) return;
      shownLen = n;
      shownEl.textContent = full.slice(0, n);
      pendingEl.textContent = full.slice(n);
      this.scrollToReveal(shownEl);
    };
    return {
      setProgress: (fraction: number) => {
        const f = Math.min(1, Math.max(0, fraction));
        let n = Math.ceil(prefix.length + f * text.length);
        if (f > 0) while (n < full.length && !/\s/.test(full[n]!)) n++;
        show(Math.min(full.length, n));
      },
      complete: () => show(full.length),
    };
  }

  /** Shows a complete message immediately on a new page. */
  showMessage(text: string, variant: BalloonVariant = 'normal'): void {
    this.newPage();
    this.startItem(text, variant).complete();
  }

  /** Small muted line under the current text (e.g. "my voice is unavailable"). */
  appendNote(text: string): void {
    this.textEl.querySelector(':scope > .note')?.remove();
    const note = document.createElement('span');
    note.className = 'note';
    note.textContent = text;
    this.textEl.appendChild(note);
    this.pageChars += text.length;
    this.sr.textContent = text;
    this.open();
    this.onChange();
  }

  showListening(label: string, hint: string): void {
    this.cancelHide();
    this.clear();
    this.el.classList.remove('error');
    const line = document.createElement('div');
    line.className = 'listening-line';
    const dots = document.createElement('span');
    dots.className = 'dots';
    dots.append(document.createElement('i'), document.createElement('i'), document.createElement('i'));
    const words = document.createElement('span');
    const strong = document.createElement('span');
    strong.textContent = label;
    words.appendChild(strong);
    if (hint) {
      const small = document.createElement('span');
      small.className = 'listening-hint';
      small.textContent = hint;
      words.appendChild(small);
    }
    line.append(dots, words);
    this.textEl.appendChild(line);
    this.sr.textContent = `${label} ${hint}`.trim();
    this.freshPage = true;
    this.open();
    this.onChange();
  }

  scheduleHide(ms: number): void {
    this.cancelHide();
    this.hideTimer = setTimeout(() => {
      this.hideTimer = null;
      this.hide();
    }, ms);
  }

  cancelHide(): void {
    if (this.hideTimer !== null) clearTimeout(this.hideTimer);
    this.hideTimer = null;
  }

  hide(immediate = false): void {
    this.cancelHide();
    if (!this.shown && this.el.hidden) return;
    this.shown = false;
    this.el.classList.remove('open');
    if (this.fadeTimer !== null) clearTimeout(this.fadeTimer);
    const finish = (): void => {
      this.fadeTimer = null;
      if (this.shown) return;
      this.el.hidden = true;
      this.clear();
      this.freshPage = true;
      this.onChange();
    };
    if (immediate) finish();
    else this.fadeTimer = setTimeout(finish, FADE_MS);
  }

  /** Natural size with the default height cap, for placement. */
  measure(): Size {
    this.el.style.setProperty('--max-h', `${BALLOON_MAX_HEIGHT}px`);
    return { width: Math.min(this.el.offsetWidth, LAYOUT.balloonMaxWidth), height: this.el.offsetHeight };
  }

  place(p: BalloonPlacement): void {
    const s = this.el.style;
    s.left = `${p.x}px`;
    s.top = `${p.y}px`;
    s.setProperty('--max-h', `${p.maxHeight}px`);
    s.setProperty('--tail-x', `${p.tailX}px`);
    this.el.classList.toggle('side-above', p.side === 'above');
    this.el.classList.toggle('side-below', p.side === 'below');
  }

  private clear(): void {
    this.el.classList.remove('wide');
    this.textEl.replaceChildren();
    this.textEl.scrollTop = 0;
    this.pageChars = 0;
  }

  private open(): void {
    if (this.fadeTimer !== null) {
      clearTimeout(this.fadeTimer);
      this.fadeTimer = null;
    }
    const wasShown = this.shown;
    this.shown = true;
    if (this.el.hidden) this.el.hidden = false;
    this.onChange();
    if (!wasShown || !this.el.classList.contains('open')) {
      // Force a style flush so the transition starts from the closed state.
      void this.el.offsetWidth;
      this.el.classList.add('open');
    }
  }

  private scrollToReveal(shownEl: HTMLElement): void {
    const box = this.textEl;
    if (box.scrollHeight <= box.clientHeight) return;
    const rects = shownEl.getClientRects();
    const last = rects[rects.length - 1];
    if (!last) return;
    const bottom = box.getBoundingClientRect().bottom;
    if (last.bottom > bottom) box.scrollTop += Math.ceil(last.bottom - bottom) + 2;
  }
}
