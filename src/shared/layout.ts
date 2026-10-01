// Geometry of the transparent agent window, shared by the main process
// (window sizing, drag clamping, position persistence) and the agent
// renderer (where to draw the character, balloon and chat box).
//
// The window is larger than the character so the speech balloon and chat box
// can be drawn inside it on either side of the character. Transparent pixels
// are click-through, so the extra area does not get in the user's way. The
// window may extend past the screen edges; the renderer flips the balloon and
// chat box to whichever side of the character has room on screen.

export const LAYOUT = {
  /** Room reserved above and below the character for balloon + chat box (DIP). */
  verticalPad: 300,
  /** Room reserved left and right of the character (DIP). */
  horizontalPad: 130,
  /** Minimum window width (DIP) so a full-width balloon always fits. */
  minWidth: 460,
  /** Maximum balloon width (DIP). */
  balloonMaxWidth: 340,
  /** Height of the chat input bar (DIP). */
  chatBarHeight: 48,
  /** Gap between the character and the balloon / chat bar (DIP). */
  gap: 6,
} as const;

export interface AgentLayout {
  /** Window size in DIP. */
  width: number;
  height: number;
  /** Character sprite box inside the window, in DIP (already scaled). */
  charX: number;
  charY: number;
  charWidth: number;
  charHeight: number;
  scale: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** charWidth/charHeight are the ACS character dimensions in pixels. */
export function computeAgentLayout(charWidth: number, charHeight: number, scale: number): AgentLayout {
  const cw = Math.round(charWidth * scale);
  const ch = Math.round(charHeight * scale);
  const width = Math.max(LAYOUT.minWidth, cw + 2 * LAYOUT.horizontalPad);
  const height = ch + 2 * LAYOUT.verticalPad;
  return {
    width,
    height,
    charX: Math.round((width - cw) / 2),
    charY: LAYOUT.verticalPad,
    charWidth: cw,
    charHeight: ch,
    scale,
  };
}

/** Screen position of the window's top-left for a given character box top-left. */
export function windowPositionForCharacter(layout: AgentLayout, charScreen: Point): Point {
  return { x: Math.round(charScreen.x - layout.charX), y: Math.round(charScreen.y - layout.charY) };
}

/** Screen position of the character box top-left for a given window top-left. */
export function characterPositionForWindow(layout: AgentLayout, windowScreen: Point): Point {
  return { x: windowScreen.x + layout.charX, y: windowScreen.y + layout.charY };
}

/**
 * Clamps a character box so it stays fully inside one of the given work areas
 * (the one it overlaps most, or the first one when it overlaps none).
 */
export function clampCharacterToWorkAreas(layout: AgentLayout, charScreen: Point, workAreas: readonly Rect[]): Point {
  if (workAreas.length === 0) return charScreen;
  const box: Rect = { x: charScreen.x, y: charScreen.y, width: layout.charWidth, height: layout.charHeight };
  let best = workAreas[0]!;
  let bestOverlap = -1;
  for (const wa of workAreas) {
    const ox = Math.max(0, Math.min(box.x + box.width, wa.x + wa.width) - Math.max(box.x, wa.x));
    const oy = Math.max(0, Math.min(box.y + box.height, wa.y + wa.height) - Math.max(box.y, wa.y));
    if (ox * oy > bestOverlap) {
      bestOverlap = ox * oy;
      best = wa;
    }
  }
  const x = Math.min(Math.max(box.x, best.x), best.x + best.width - box.width);
  const y = Math.min(Math.max(box.y, best.y), best.y + best.height - box.height);
  return { x: Math.round(x), y: Math.round(y) };
}

/** Default spot: bottom-right corner of the given work area, with a margin. */
export function defaultCharacterPosition(layout: AgentLayout, workArea: Rect): Point {
  const margin = 24;
  return {
    x: Math.round(workArea.x + workArea.width - layout.charWidth - margin),
    y: Math.round(workArea.y + workArea.height - layout.charHeight - margin),
  };
}
