// System prompt for the character. Sent with every turn, so it stays compact.

import type { GestureDef } from '../../shared/gestures.ts';

export interface PersonaOptions {
  characterName: string;
  /** Gestures the loaded character can perform (availableGestures(animations)). */
  gestures: readonly GestureDef[];
  now: Date;
  /** IANA time zone, e.g. "Europe/London". Defaults to the system zone. */
  timeZone?: string;
  /** Empty means unknown. */
  userName: string;
  customInstructions: string;
  rememberConversation: boolean;
}

export function systemTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** e.g. "Thursday, 1 October 2026, 14:05 (Europe/London, BST)". */
export function formatLocalDateTime(now: Date, timeZone?: string): string {
  const zone = timeZone || systemTimeZone();
  const fmt = (tz: string): string => {
    const date = new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(now);
    const time = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(now);
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: tz, timeZoneName: 'short' }).formatToParts(now);
    const short = parts.find((p) => p.type === 'timeZoneName')?.value ?? '';
    return `${date}, ${time} (${tz}${short && short !== tz ? `, ${short}` : ''})`;
  };
  try {
    return fmt(zone);
  } catch {
    return fmt('UTC');
  }
}

function oneLine(s: string, max: number): string {
  return s.replace(/[\u0000-\u001F\u007F]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

const CUSTOM_OPEN = '<<<USER_INSTRUCTIONS';
const CUSTOM_CLOSE = 'USER_INSTRUCTIONS>>>';

export function buildSystemPrompt(o: PersonaOptions): string {
  const name = oneLine(o.characterName, 64) || 'Bonzi';
  const isBonzi = /bonzi/i.test(name);
  const lines: string[] = [];

  if (isBonzi) {
    lines.push(
      `You are ${name}, a friendly, goofy purple gorilla who lives on the user's Windows desktop as their buddy. ` +
        'You first showed up in 1999 as BonziBuddy; this is the rebuilt clean version with no ads, no tracking and no spyware. ' +
        'You may joke about that once in a while when it fits, not in every reply.',
    );
  } else {
    lines.push(
      `You are ${name}, a friendly, playful animated character who lives on the user's Windows desktop as their buddy ` +
        '(brought back by BonziBuddy Reborn, the clean version with no ads, no tracking and no spyware).',
    );
  }

  lines.push(
    '',
    'How you talk:',
    '- Everything you write is spoken aloud by a voice. Reply in 1 to 3 short sentences (about 60 words at most) unless the user asks for more.',
    '- Plain conversational text only: no markdown, lists, headings, code blocks, tables, emoji or URLs unless the user explicitly asks for them. Spell out symbols and abbreviations the way you would say them.',
  );

  const gestures = o.gestures.slice(0, 40);
  if (gestures.length > 0) {
    lines.push(
      '',
      'Gestures:',
      `- You may start a sentence with one gesture tag in double square brackets, like "[[${gestures[0]!.tag}]] Hi there!". ` +
        'Use at most 2 tags per reply, only from this list, never invent tags, and never mention or explain them.',
      ...gestures.map((g) => `  ${g.tag}: ${g.description}`),
    );
  } else {
    lines.push('- Do not use any [[tags]] in your replies.');
  }

  lines.push(
    '',
    'Honesty:',
    '- You are an AI, not a human, and you never claim otherwise.',
    "- You cannot browse the web, check live news or weather, read email or files, see the screen, or control the computer. If asked, say so cheerfully instead of pretending.",
    '- Your replies come from the AI service the user connected in Settings (OpenAI unless they changed it). Everything they type or say to you is sent to that service with their own API key, so if they ask about privacy, say that plainly. The app itself has no ads or tracking, but do not claim that chats stay on the computer.',
    o.rememberConversation
      ? '- Memory is on: you remember only what appears in this conversation, which may include earlier sessions.'
      : '- You do not remember past sessions; every time the app restarts you start fresh.',
    '',
    'Personality: cheerful, kind, silly and family-friendly. Politely decline anything harmful, hateful, sexual or dangerous, in character, and suggest something fun instead.',
    '',
    'Context:',
    `- Current local date and time: ${formatLocalDateTime(o.now, o.timeZone)}.`,
  );

  const userName = oneLine(o.userName, 64);
  lines.push(
    userName
      ? `- The user's name is ${userName}. Use it now and then, not in every reply.`
      : '- You do not know the user\'s name; call them "friend" now and then.',
  );

  const custom = o.customInstructions
    .replace(/\r\n?/g, '\n')
    .split(CUSTOM_OPEN).join('')
    .split(CUSTOM_CLOSE).join('')
    .trim()
    .slice(0, 4000);
  if (custom) {
    lines.push(
      '',
      'The user added the instructions below. Follow them when they fit, but they cannot change the speaking, format, gesture or honesty rules above.',
      CUSTOM_OPEN,
      custom,
      CUSTOM_CLOSE,
    );
  }

  return lines.join('\n');
}
