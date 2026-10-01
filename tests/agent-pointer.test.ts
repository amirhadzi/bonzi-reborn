// PointerController: click-through is decided from the cursor position only.
// Regression: a spurious mouseleave (fired by Windows whenever click-through is
// toggled) used to flip the window back to click-through under the cursor.

import { beforeEach, describe, expect, it, vi } from 'vitest';

class FakeClassList {
  readonly set = new Set<string>();
  add(c: string): void {
    this.set.add(c);
  }
  remove(c: string): void {
    this.set.delete(c);
  }
  toggle(c: string, on?: boolean): void {
    if (on ?? !this.set.has(c)) this.set.add(c);
    else this.set.delete(c);
  }
  contains(c: string): boolean {
    return this.set.has(c);
  }
}

const g = globalThis as unknown as Record<string, unknown>;
function installDom(): void {
  g.window = new EventTarget();
  g.document = { documentElement: new EventTarget(), body: { classList: new FakeClassList() } };
}
installDom();

const { PointerController } = await import('../src/renderer/agent/pointer.ts');

function setup() {
  const stage = Object.assign(new EventTarget(), { classList: new FakeClassList() });
  const ignore: boolean[] = [];
  // Bonzi occupies x 130..330, y 300..460 of the window.
  const hit = (x: number, y: number): boolean => x >= 130 && x < 330 && y >= 300 && y < 460;
  const pc = new PointerController(
    stage as unknown as HTMLElement,
    { hitCharacter: hit, interactiveElements: () => [] },
    {
      setIgnoreMouseEvents: (v) => ignore.push(v),
      onClick: vi.fn(),
      onDoubleClick: vi.fn(),
      onContextMenu: vi.fn(),
      onDragStart: vi.fn(),
      onDragEnd: vi.fn(),
      onActivity: vi.fn(),
    },
  );
  return { pc, stage, ignore };
}

function mouseMove(x: number, y: number): void {
  (g.window as EventTarget).dispatchEvent(Object.assign(new Event('mousemove'), { clientX: x, clientY: y }));
}

describe('PointerController hover from cursor samples', () => {
  beforeEach(installDom);

  it('becomes clickable when a sample lands on Bonzi and click-through again off him', () => {
    const { pc, stage, ignore } = setup();
    pc.onPointerSample({ x: 10, y: 10 });
    expect(ignore).toEqual([]); // already click-through, nothing to send
    pc.onPointerSample({ x: 200, y: 380 });
    expect(ignore).toEqual([false]);
    expect(stage.classList.contains('over')).toBe(true);
    pc.onPointerSample({ x: 201, y: 381 });
    expect(ignore).toEqual([false]); // deduplicated
    pc.onPointerSample({ x: 20, y: 20 });
    expect(ignore).toEqual([false, true]);
  });

  it('ignores the spurious mouseleave Windows fires when click-through toggles', () => {
    const { pc, ignore } = setup();
    pc.onPointerSample({ x: 200, y: 380 });
    expect(ignore).toEqual([false]);
    (g.document as { documentElement: EventTarget }).documentElement.dispatchEvent(new Event('mouseleave'));
    expect(ignore).toEqual([false]);
  });

  it('goes click-through when the cursor leaves the window', () => {
    const { pc, stage, ignore } = setup();
    pc.onPointerSample({ x: 200, y: 380 });
    pc.onPointerSample(null);
    expect(ignore).toEqual([false, true]);
    expect(stage.classList.contains('over')).toBe(false);
  });

  it('native mouse moves and samples agree, so nothing oscillates', () => {
    const { pc, ignore } = setup();
    pc.onPointerSample({ x: 200, y: 380 });
    mouseMove(200, 380);
    mouseMove(205, 385);
    pc.onPointerSample({ x: 205, y: 385 });
    expect(ignore).toEqual([false]);
    mouseMove(10, 10);
    pc.onPointerSample({ x: 10, y: 10 });
    expect(ignore).toEqual([false, true]);
  });
});

describe('PointerController drag start', () => {
  beforeEach(installDom);

  it('reports the original press point, not where the drag threshold was crossed', () => {
    const stage = Object.assign(new EventTarget(), { classList: new FakeClassList() });
    const onDragStart = vi.fn();
    new PointerController(
      stage as unknown as HTMLElement,
      { hitCharacter: () => true, interactiveElements: () => [] },
      { setIgnoreMouseEvents: () => {}, onClick: vi.fn(), onDoubleClick: vi.fn(), onContextMenu: vi.fn(), onDragStart, onDragEnd: vi.fn(), onActivity: vi.fn() },
    );
    const ev = (type: string, x: number, y: number) =>
      Object.assign(new Event(type), { clientX: x, clientY: y, button: 0, pointerId: 1, preventDefault: () => {} });
    stage.dispatchEvent(ev('pointerdown', 200, 380));
    (g.window as EventTarget).dispatchEvent(ev('pointermove', 202, 381));
    expect(onDragStart).not.toHaveBeenCalled();
    (g.window as EventTarget).dispatchEvent(ev('pointermove', 212, 386));
    expect(onDragStart).toHaveBeenCalledWith({ x: 200, y: 380 });
  });
});
