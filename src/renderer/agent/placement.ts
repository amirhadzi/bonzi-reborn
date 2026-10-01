// Pure placement math for the speech balloon and the chat bar inside the
// agent window. All coordinates are window-relative CSS pixels (DIP) unless
// noted. The window may hang off the screen edge, so everything is clamped to
// the part of the window that is actually on screen.

import type { Point, Rect } from '../../shared/layout.ts';

export type Side = 'above' | 'below';

export interface Size {
  width: number;
  height: number;
}

/** Where the visible character is, in window coordinates. */
export interface CharacterAnchor {
  /** Horizontal centre of the head. */
  headX: number;
  /** Top of the visible sprite (rest pose); the balloon tail points here. */
  top: number;
  /**
   * Highest point gestures reach (e.g. a raised arm). The chat bar keeps clear
   * of it when placed above. Defaults to top.
   */
  reachTop?: number;
  /** Bottom of the visible sprite. */
  bottom: number;
}

export interface PlacementInput {
  window: Size;
  /** Window top-left in screen coordinates (window.screenX / screenY). */
  windowScreen: Point;
  /** Available screen area in screen coordinates (screen.availLeft ...). */
  screen: Rect;
  anchor: CharacterAnchor;
  /** Natural size of the balloon, or null when hidden. */
  balloon: Size | null;
  /** Size of the chat bar, or null when closed. */
  chat: Size | null;
  /** Gap between the character and the nearest element, and between stacked elements. */
  gap?: number;
  /** Distance kept from the screen edges. */
  margin?: number;
  /** Upper bound for the balloon height (longer text scrolls inside). */
  balloonMaxHeight?: number;
  /** Smallest useful balloon height when room is short. */
  balloonMinHeight?: number;
  /** Closest the tail may get to the balloon's left or right edge. */
  tailInset?: number;
  /** How far the tail sticks out of the balloon; added to the balloon's gap. */
  tailSize?: number;
}

export interface BalloonPlacement {
  x: number;
  y: number;
  /** Height the balloon will have (natural height capped by maxHeight). */
  height: number;
  /** Apply as CSS max-height so long text scrolls. */
  maxHeight: number;
  side: Side;
  /** Tail position relative to the balloon's left edge. */
  tailX: number;
}

export interface ChatPlacement {
  x: number;
  y: number;
  side: Side;
}

export interface PlacementResult {
  balloon: BalloonPlacement | null;
  chat: ChatPlacement | null;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi);
}

/** Part of the window that is on screen, inset by a margin, in window coordinates. */
export interface VisibleArea {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/**
 * The on-screen part of the window, inset by margin. When the character sits
 * at a screen edge the window hangs off screen, so the balloon and chat bar
 * must be no wider than right - left (the caller caps their CSS max-width).
 */
export function visibleArea(win: Size, windowScreen: Point, screen: Rect, margin = 8): VisibleArea {
  return {
    top: clamp(screen.y - windowScreen.y + margin, 0, win.height),
    bottom: clamp(screen.y + screen.height - windowScreen.y - margin, 0, win.height),
    left: clamp(screen.x - windowScreen.x + margin, 0, win.width),
    right: clamp(screen.x + screen.width - windowScreen.x - margin, 0, win.width),
  };
}

interface Candidate {
  balloon: Side;
  chat: Side;
}

// Preference order: balloon above, chat bar below.
const CANDIDATES: readonly Candidate[] = [
  { balloon: 'above', chat: 'below' },
  { balloon: 'above', chat: 'above' },
  { balloon: 'below', chat: 'below' },
  { balloon: 'below', chat: 'above' },
];

export function computePlacement(input: PlacementInput): PlacementResult {
  const gap = input.gap ?? 6;
  const margin = input.margin ?? 8;
  const maxB = input.balloonMaxHeight ?? 260;
  const minB = input.balloonMinHeight ?? 64;
  const tailInset = input.tailInset ?? 24;
  const tail = input.tailSize ?? 0;
  const W = input.window.width;
  const H = input.window.height;
  const { anchor } = input;

  // Visible part of the window, in window coordinates.
  const { top, bottom, left, right } = visibleArea(input.window, input.windowScreen, input.screen, margin);

  const reachTop = Math.min(anchor.top, anchor.reachTop ?? anchor.top);
  const roomAbove = Math.max(0, anchor.top - gap - top);
  const roomBelow = Math.max(0, bottom - anchor.bottom - gap);
  const chatRoomAbove = Math.max(0, reachTop - gap - top);
  const room = (side: Side): number => (side === 'above' ? roomAbove : roomBelow);

  const chatH = input.chat?.height ?? 0;
  const wantB = input.balloon ? Math.min(input.balloon.height, maxB) : 0;

  const chatFits = (c: Candidate): boolean => !input.chat || chatH <= (c.chat === 'above' ? chatRoomAbove : roomBelow);
  const balloonRoom = (c: Candidate): number => {
    const stacked = input.chat && c.chat === c.balloon;
    if (!stacked) return room(c.balloon) - tail;
    return (c.balloon === 'above' ? chatRoomAbove : roomBelow) - chatH - gap - tail;
  };

  let pick: Candidate | undefined;
  if (!input.balloon) {
    pick = CANDIDATES.find((c) => chatFits(c)) ?? (roomBelow >= roomAbove ? CANDIDATES[0] : CANDIDATES[3]);
  } else if (!input.chat) {
    if (wantB + tail <= roomAbove) pick = CANDIDATES[0];
    else if (wantB + tail <= roomBelow) pick = CANDIDATES[2];
    else pick = roomAbove >= roomBelow ? CANDIDATES[0] : CANDIDATES[2];
  } else {
    pick = CANDIDATES.find((c) => chatFits(c) && balloonRoom(c) >= wantB);
    if (!pick) {
      let best = -Infinity;
      for (const c of CANDIDATES) {
        if (!chatFits(c)) continue;
        const r = balloonRoom(c);
        if (r > best) {
          best = r;
          pick = c;
        }
      }
    }
  }
  const choice = pick ?? CANDIDATES[0]!;

  const centered = (width: number): number => {
    let x = anchor.headX - width / 2;
    if (right - left >= width) x = clamp(x, left, right - width);
    // Wider than the visible span (callers cap widths, so this is defensive):
    // keep the start of the text on screen.
    else x = left > 0 ? left : right - width;
    return Math.round(clamp(x, 0, Math.max(0, W - width)));
  };

  let chat: ChatPlacement | null = null;
  if (input.chat) {
    const y = choice.chat === 'above' ? reachTop - gap - chatH : anchor.bottom + gap;
    chat = { x: centered(input.chat.width), y: Math.round(clamp(y, 0, Math.max(0, H - chatH))), side: choice.chat };
  }

  let balloon: BalloonPlacement | null = null;
  if (input.balloon) {
    const available = Math.floor(balloonRoom(choice));
    const maxHeight = Math.max(Math.min(maxB, available), Math.min(minB, maxB));
    const height = Math.min(input.balloon.height, maxHeight);
    const stacked = input.chat !== null && choice.chat === choice.balloon;
    let y: number;
    if (choice.balloon === 'above') {
      const base = stacked && chat ? chat.y - gap : anchor.top - gap;
      y = base - tail - height;
    } else {
      const base = stacked && chat ? chat.y + chatH + gap : anchor.bottom + gap;
      y = base + tail;
    }
    const x = centered(input.balloon.width);
    const w = input.balloon.width;
    const tailX = Math.round(clamp(anchor.headX - x, Math.min(tailInset, w / 2), Math.max(w - tailInset, w / 2)));
    balloon = {
      x,
      y: Math.round(clamp(y, 0, Math.max(0, H - height))),
      height,
      maxHeight,
      side: choice.balloon,
      tailX,
    };
  }

  return { balloon, chat };
}
