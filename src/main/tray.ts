// System tray icon and menu. A module-level reference keeps it alive.

import fs from 'node:fs';
import { Menu, Tray, nativeImage } from 'electron';
import type { NativeImage } from 'electron';
import type { RgbaImage } from '../shared/acs/index.ts';
import type { AppController, TrayHandle } from './controller.ts';
import { errorMessage, log } from './logger.ts';

let tray: Tray | null = null;

/** Converts straight RGBA to the BGRA layout nativeImage.createFromBitmap expects. */
export function rgbaToBgra(img: RgbaImage): Buffer {
  const out = Buffer.alloc(img.width * img.height * 4);
  const d = img.data;
  for (let i = 0; i < out.length; i += 4) {
    out[i] = d[i + 2] ?? 0;
    out[i + 1] = d[i + 1] ?? 0;
    out[i + 2] = d[i] ?? 0;
    out[i + 3] = d[i + 3] ?? 0;
  }
  return out;
}

function loadTrayImage(iconPath: string, fallback: RgbaImage | null): NativeImage {
  if (fs.existsSync(iconPath)) {
    const img = nativeImage.createFromPath(iconPath);
    if (!img.isEmpty()) return img;
  }
  if (fallback && fallback.width > 0 && fallback.height > 0) {
    try {
      return nativeImage.createFromBitmap(rgbaToBgra(fallback), { width: fallback.width, height: fallback.height });
    } catch {
      // fall through
    }
  }
  log.warn('No tray icon available; using an empty image.');
  return nativeImage.createEmpty();
}

export function createTray(controller: AppController): TrayHandle {
  if (tray && !tray.isDestroyed()) tray.destroy();
  const t = new Tray(loadTrayImage(controller.paths.icon, controller.character.trayIcon));
  tray = t;
  t.setToolTip('BonziBuddy Reborn');

  const refresh = (): void => {
    if (t.isDestroyed()) return;
    const name = controller.character.name || 'Bonzi';
    const shown = controller.agent.isShown();
    t.setContextMenu(
      Menu.buildFromTemplate([
        shown
          ? { label: `Hide ${name}`, click: () => controller.hideBonzi() }
          : { label: `Show ${name}`, click: () => controller.showBonzi() },
        { label: `Talk to ${name}`, click: () => controller.talk() },
        { label: 'Settings', click: () => controller.openSettings() },
        { type: 'separator' },
        { label: 'Exit', click: () => controller.quit() },
      ]),
    );
  };

  t.on('click', () => controller.toggleBonzi());
  refresh();

  return {
    refresh,
    showHint: (title: string, content: string) => {
      if (t.isDestroyed()) return false;
      try {
        t.displayBalloon({ title, content, iconType: 'info', noSound: true });
        return true;
      } catch (err) {
        log.warn(`Tray balloon failed: ${errorMessage(err)}`);
        return false;
      }
    },
    destroy: () => {
      if (!t.isDestroyed()) t.destroy();
      if (tray === t) tray = null;
    },
  };
}
