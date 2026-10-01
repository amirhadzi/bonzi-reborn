// Native right-click menu for the character (opened via win:context-menu).

import { Menu } from 'electron';
import type { MenuItemConstructorOptions } from 'electron';
import { availableGestures, resolveGesture } from '../shared/gestures.ts';
import type { QuickAction } from '../shared/ipc.ts';
import type { AppController } from './controller.ts';

/** "PointUp" -> "Point Up", "BlowKiss" -> "Blow Kiss". */
export function gestureLabel(tag: string): string {
  return tag.replace(/([a-z])([A-Z])/g, '$1 $2');
}

/** Animation submenu entries: label plus the ACS animation name to play. */
export function animationMenuEntries(animationNames: readonly string[]): { label: string; animation: string }[] {
  const names = new Set(animationNames.map((n) => n.toUpperCase()));
  const has = (n: string): boolean => names.has(n.toUpperCase());
  const out: { label: string; animation: string }[] = [];
  for (const g of availableGestures(animationNames)) {
    const animation = resolveGesture(g.tag, has);
    if (animation) out.push({ label: gestureLabel(g.tag), animation });
  }
  return out;
}

export function showAgentContextMenu(controller: AppController): void {
  const win = controller.agent.window;
  if (!win) return;
  const name = controller.character.name || 'Bonzi';
  const quick = (action: QuickAction) => (): void => controller.sendCommand({ type: 'quick-action', action });

  const animations: MenuItemConstructorOptions[] = animationMenuEntries(controller.character.animations).map((e) => ({
    label: e.label,
    click: () => controller.sendCommand({ type: 'play-animation', name: e.animation }),
  }));

  const template: MenuItemConstructorOptions[] = [
    { label: `Talk to ${name}...`, click: () => controller.talk() },
    { label: 'Tell me a joke', click: quick('joke') },
    { label: 'Fun fact', click: quick('fact') },
    { label: 'What time is it?', click: quick('time') },
    { label: 'Compliment me', click: quick('compliment') },
    { label: 'Animations', submenu: animations.length > 0 ? animations : [{ label: '(none)', enabled: false }] },
    { label: 'Stop talking', click: () => controller.sendCommand({ type: 'stop' }) },
    { label: 'Reset conversation', click: () => controller.sendCommand({ type: 'reset-conversation' }) },
    { type: 'separator' },
    { label: 'Settings...', click: () => controller.openSettings() },
    { label: `Hide ${name}`, click: () => controller.hideBonzi() },
    { label: 'Exit', click: () => controller.quit() },
  ];
  Menu.buildFromTemplate(template).popup({ window: win });
}
