import { describe, expect, it } from 'vitest';
import { computeAgentLayout } from '../src/shared/layout.ts';
import { computePlacement, visibleArea, type PlacementInput } from '../src/renderer/agent/placement.ts';

const layout = computeAgentLayout(200, 160, 1); // 460 x 760, char at (130, 300)
const screen = { x: 0, y: 0, width: 1920, height: 1040 };
const anchor = { headX: layout.charX + 100, top: layout.charY + 10, bottom: layout.charY + 150 };
const balloon = { width: 300, height: 80 };
const chat = { width: 320, height: 48 };

function input(win: { x: number; y: number }, over: Partial<PlacementInput> = {}): PlacementInput {
  return {
    window: { width: layout.width, height: layout.height },
    windowScreen: win,
    screen,
    anchor,
    balloon,
    chat,
    ...over,
  };
}

function inside(r: { x: number; y: number }, w: number, h: number, win: { x: number; y: number }): void {
  // inside the window
  expect(r.x).toBeGreaterThanOrEqual(0);
  expect(r.y).toBeGreaterThanOrEqual(0);
  expect(r.x + w).toBeLessThanOrEqual(layout.width);
  expect(r.y + h).toBeLessThanOrEqual(layout.height);
  // on screen
  expect(win.x + r.x).toBeGreaterThanOrEqual(screen.x);
  expect(win.y + r.y).toBeGreaterThanOrEqual(screen.y);
  expect(win.x + r.x + w).toBeLessThanOrEqual(screen.x + screen.width);
  expect(win.y + r.y + h).toBeLessThanOrEqual(screen.y + screen.height);
}

describe('computePlacement', () => {
  it('prefers balloon above and chat below in the middle of the screen', () => {
    const win = { x: 700, y: 100 };
    const r = computePlacement(input(win));
    expect(r.balloon?.side).toBe('above');
    expect(r.chat?.side).toBe('below');
    const b = r.balloon!;
    expect(b.y + b.height).toBe(anchor.top - 6);
    expect(r.chat!.y).toBe(anchor.bottom + 6);
    // centred on the head, tail at the head
    expect(b.x + balloon.width / 2).toBe(anchor.headX);
    expect(b.tailX).toBe(anchor.headX - b.x);
    inside(b, balloon.width, b.height, win);
    inside(r.chat!, chat.width, chat.height, win);
  });

  it('stacks both above when the character sits on the taskbar edge', () => {
    // Character bottom at screen bottom: window y such that char bottom (450) is near 1040.
    const win = { x: 1400, y: 1040 - 460 };
    const r = computePlacement(input(win));
    expect(r.chat?.side).toBe('above');
    expect(r.balloon?.side).toBe('above');
    expect(r.chat!.y + chat.height).toBe(anchor.top - 6);
    expect(r.balloon!.y + r.balloon!.height).toBe(r.chat!.y - 6);
    inside(r.balloon!, balloon.width, r.balloon!.height, win);
    inside(r.chat!, chat.width, chat.height, win);
  });

  it('keeps the chat bar clear of raised arms (reachTop) when above', () => {
    const win = { x: 1400, y: 1040 - 460 };
    const r = computePlacement(input(win, { anchor: { ...anchor, reachTop: anchor.top - 30 }, tailSize: 11 }));
    expect(r.chat?.side).toBe('above');
    expect(r.chat!.y + chat.height).toBe(anchor.top - 30 - 6);
    expect(r.balloon!.y + r.balloon!.height + 11).toBe(r.chat!.y - 6);
    // Without the chat bar the balloon tail still reaches down to the head.
    const r2 = computePlacement(input(win, { anchor: { ...anchor, reachTop: anchor.top - 30 }, tailSize: 11, chat: null }));
    expect(r2.balloon!.y + r2.balloon!.height + 11).toBe(anchor.top - 6);
  });

  it('puts the balloon below when the character is at the top of the screen', () => {
    const win = { x: 600, y: -300 }; // character top at screen y 0
    const r = computePlacement(input(win, { chat: null }));
    expect(r.balloon?.side).toBe('below');
    expect(r.balloon!.y).toBe(anchor.bottom + 6);
    inside(r.balloon!, balloon.width, r.balloon!.height, win);
  });

  it('stacks both below at the top of the screen with the chat bar nearest', () => {
    const win = { x: 600, y: -300 };
    const r = computePlacement(input(win));
    expect(r.balloon?.side).toBe('below');
    expect(r.chat?.side).toBe('below');
    expect(r.chat!.y).toBe(anchor.bottom + 6);
    expect(r.balloon!.y).toBe(r.chat!.y + chat.height + 6);
  });

  it('shifts horizontally to stay on screen near the left and right edges', () => {
    const left = { x: -130, y: 100 }; // character at the screen's left edge
    const r1 = computePlacement(input(left));
    inside(r1.balloon!, balloon.width, r1.balloon!.height, left);
    inside(r1.chat!, chat.width, chat.height, left);
    expect(r1.balloon!.tailX).toBeLessThan(balloon.width / 2);
    expect(left.x + r1.balloon!.x).toBe(8);

    const right = { x: 1920 - 460 + 130, y: 100 };
    const r2 = computePlacement(input(right));
    inside(r2.balloon!, balloon.width, r2.balloon!.height, right);
    expect(r2.balloon!.tailX).toBeGreaterThan(balloon.width / 2);
    expect(right.x + r2.balloon!.x + balloon.width).toBe(1920 - 8);
  });

  it('keeps the tail inside the balloon even when the head is far off', () => {
    const win = { x: -280, y: 100 };
    const r = computePlacement(input(win));
    expect(r.balloon!.tailX).toBeGreaterThanOrEqual(24);
    expect(r.balloon!.tailX).toBeLessThanOrEqual(balloon.width - 24);
  });

  it('caps a tall balloon and lets it scroll', () => {
    const win = { x: 700, y: 100 };
    const r = computePlacement(input(win, { balloon: { width: 340, height: 900 }, chat: null }));
    expect(r.balloon!.maxHeight).toBeLessThanOrEqual(260);
    expect(r.balloon!.height).toBe(r.balloon!.maxHeight);
    inside(r.balloon!, 340, r.balloon!.height, win);
  });

  it('shrinks the balloon when room is short', () => {
    // Only ~150 px above the character on screen, and nothing below.
    const win = { x: 700, y: 1040 - 460 - 0 };
    const tight = { ...screen, y: 1040 - 460 - 0 + 300 - 150, height: 150 + 160 };
    const r = computePlacement(input(win, { screen: tight, chat: null, balloon: { width: 300, height: 220 } }));
    expect(r.balloon!.side).toBe('above');
    expect(r.balloon!.height).toBeLessThan(220);
    expect(win.y + r.balloon!.y).toBeGreaterThanOrEqual(tight.y);
  });

  it('places only the chat bar when there is no balloon', () => {
    const r = computePlacement(input({ x: 700, y: 100 }, { balloon: null }));
    expect(r.balloon).toBeNull();
    expect(r.chat?.side).toBe('below');
    const r2 = computePlacement(input({ x: 700, y: 1040 - 460 }, { balloon: null }));
    expect(r2.chat?.side).toBe('above');
  });

  it('returns nothing when nothing is shown', () => {
    expect(computePlacement(input({ x: 0, y: 0 }, { balloon: null, chat: null }))).toEqual({ balloon: null, chat: null });
  });
});

describe('visibleArea and edge-parked characters', () => {
  const win = { width: layout.width, height: layout.height };

  it('reports the on-screen part of a window hanging off the left edge', () => {
    // Bonzi flush with the left edge: the window hangs charX (130) px off screen.
    const a = visibleArea(win, { x: -130, y: 100 }, screen);
    expect(a.left).toBe(138);
    expect(a.right).toBe(layout.width);
    expect(a.right - a.left).toBe(322);
    // A 128 px character: the window is 460 wide with the sprite at x 166.
    const b = visibleArea(win, { x: -166, y: 100 }, screen);
    expect(b.right - b.left).toBe(286);
  });

  it('mirrors at the right edge', () => {
    const a = visibleArea(win, { x: 1920 - 330, y: 100 }, screen);
    expect(a.left).toBe(0);
    expect(a.right).toBe(330 - 8);
    expect(a.right - a.left).toBe(322);
  });

  it('is the whole window when it is well inside the screen', () => {
    expect(visibleArea(win, { x: 700, y: 100 }, screen)).toEqual({ left: 0, right: layout.width, top: 0, bottom: layout.height });
  });

  for (const winX of [-130, -166, 1920 - 330, 1920 - 294]) {
    it(`keeps a balloon and chat bar capped to the visible span on screen (window x ${winX})`, () => {
      const pos = { x: winX, y: 100 };
      const a = visibleArea(win, pos, screen);
      const span = Math.floor(a.right - a.left);
      const bw = Math.min(340, span);
      const r = computePlacement(input(pos, { balloon: { width: bw, height: 80 }, chat: { width: Math.min(320, span), height: 44 } }));
      expect(r.balloon!.x).toBeGreaterThanOrEqual(a.left);
      expect(r.balloon!.x + bw).toBeLessThanOrEqual(a.right);
      expect(r.chat!.x).toBeGreaterThanOrEqual(a.left);
      expect(r.chat!.x + Math.min(320, span)).toBeLessThanOrEqual(a.right);
    });
  }
});
