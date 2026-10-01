// Builds Electron accelerator strings (e.g. "CommandOrControl+Shift+B") from
// keyboard events. Pure, so it can be unit tested without a DOM.

export interface KeyLike {
  code: string;
  key: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}

export type AcceleratorResult =
  | { kind: 'complete'; accelerator: string }
  /** Only modifiers held so far; `preview` is a display string such as "Ctrl + Shift + ...". */
  | { kind: 'partial'; preview: string }
  | { kind: 'invalid'; message: string };

const MODIFIER_CODES = new Set([
  'ControlLeft',
  'ControlRight',
  'ShiftLeft',
  'ShiftRight',
  'AltLeft',
  'AltRight',
  'MetaLeft',
  'MetaRight',
  'OSLeft',
  'OSRight',
]);

const NAMED_CODES: Readonly<Record<string, string>> = {
  Space: 'Space',
  Enter: 'Enter',
  NumpadEnter: 'Enter',
  Tab: 'Tab',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Insert: 'Insert',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Escape: 'Esc',
  PrintScreen: 'PrintScreen',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
  Backquote: '`',
  NumpadAdd: 'numadd',
  NumpadSubtract: 'numsub',
  NumpadMultiply: 'nummult',
  NumpadDivide: 'numdiv',
  NumpadDecimal: 'numdec',
};

/** Maps a KeyboardEvent.code (layout independent) to an Electron accelerator key, or null. */
export function acceleratorKeyFromCode(code: string): string | null {
  let m = /^Key([A-Z])$/.exec(code);
  if (m?.[1]) return m[1];
  m = /^Digit([0-9])$/.exec(code);
  if (m?.[1]) return m[1];
  m = /^Numpad([0-9])$/.exec(code);
  if (m?.[1]) return `num${m[1]}`;
  m = /^F([1-9]|1[0-9]|2[0-4])$/.exec(code);
  if (m?.[1]) return `F${m[1]}`;
  return NAMED_CODES[code] ?? null;
}

function isFunctionKey(key: string): boolean {
  return /^F([1-9]|1[0-9]|2[0-4])$/.test(key);
}

function modifierParts(e: KeyLike): string[] {
  const parts: string[] = [];
  if (e.ctrlKey) parts.push('CommandOrControl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  if (e.metaKey) parts.push('Super');
  return parts;
}

export function isModifierOnly(e: KeyLike): boolean {
  return MODIFIER_CODES.has(e.code) || ['Control', 'Shift', 'Alt', 'Meta', 'OS'].includes(e.key);
}

/**
 * Interprets one keydown in the hotkey capture field. A shortcut needs Ctrl, Alt
 * or Win (Shift alone would swallow normal typing), except for F1 to F24.
 */
export function acceleratorFromKeyEvent(e: KeyLike): AcceleratorResult {
  const mods = modifierParts(e);
  if (isModifierOnly(e)) {
    const preview = mods.length > 0 ? `${formatAccelerator(mods.join('+'))} + ...` : '';
    return { kind: 'partial', preview };
  }
  const key = acceleratorKeyFromCode(e.code);
  if (!key) return { kind: 'invalid', message: 'That key cannot be used in a shortcut.' };
  const strong = e.ctrlKey || e.altKey || e.metaKey;
  if (!strong && !isFunctionKey(key)) {
    return { kind: 'invalid', message: 'Add Ctrl, Alt or Win to the shortcut (F1 to F24 also work on their own).' };
  }
  return { kind: 'complete', accelerator: [...mods, key].join('+') };
}

const DISPLAY_NAMES: Readonly<Record<string, string>> = {
  commandorcontrol: 'Ctrl',
  cmdorctrl: 'Ctrl',
  control: 'Ctrl',
  ctrl: 'Ctrl',
  command: 'Ctrl',
  cmd: 'Ctrl',
  super: 'Win',
  meta: 'Win',
  alt: 'Alt',
  option: 'Alt',
  altgr: 'AltGr',
  shift: 'Shift',
  esc: 'Esc',
  escape: 'Esc',
  return: 'Enter',
  enter: 'Enter',
  up: 'Up',
  down: 'Down',
  left: 'Left',
  right: 'Right',
  space: 'Space',
  plus: '+',
  numadd: 'Num +',
  numsub: 'Num -',
  nummult: 'Num *',
  numdiv: 'Num /',
  numdec: 'Num .',
};

/** Human readable form for Windows: "CommandOrControl+Shift+B" becomes "Ctrl + Shift + B". */
export function formatAccelerator(accelerator: string): string {
  if (!accelerator) return '';
  // "Ctrl++" style accelerators are not produced by us; split on "+" between tokens.
  const tokens = accelerator.split('+').filter((t) => t.length > 0);
  return tokens
    .map((t) => {
      const lower = t.toLowerCase();
      const named = DISPLAY_NAMES[lower];
      if (named) return named;
      const num = /^num([0-9])$/.exec(lower);
      if (num?.[1]) return `Num ${num[1]}`;
      return t.length === 1 ? t.toUpperCase() : t;
    })
    .join(' + ');
}
