// Bonzi's local, canned lines (no API call): greetings, errors, quick
// answers and the prompts used for quick actions and idle chatter.

import type { AiError, QuickAction } from '../../shared/ipc.ts';

export interface LocalLine {
  text: string;
  /** Gesture tag (from shared/gestures.ts) to play before the line. */
  gesture?: string;
  /** The line announces the settings window: open it when the line starts playing. */
  openSettings?: boolean;
}

function pick<T>(items: readonly T[], random: () => number): T {
  return items[Math.min(items.length - 1, Math.floor(random() * items.length))]!;
}

export function introLines(hasApiKey: boolean): LocalLine[] {
  const lines: LocalLine[] = [
    { text: "Well hello there! I'm Bonzi, your purple pal, and I'm back!", gesture: 'Wave' },
    { text: "I've been rebuilt from scratch, nice and clean this time: no ads, no tracking and no spyware.", gesture: 'Greet' },
    { text: 'Click me to chat, right-click me for more, and drag me anywhere you like.', gesture: 'Explain' },
  ];
  if (!hasApiKey) {
    lines.push({
      text: "One thing first: to think and talk I need an OpenAI API key. I'm opening my settings window so you can add yours.",
      gesture: 'Idea',
      openSettings: true,
    });
  }
  return lines;
}

export function greetingLine(userName: string, random: () => number = Math.random): LocalLine {
  const name = userName.trim();
  const named = name
    ? [`Hi again, ${name}!`, `Hey ${name}, good to see you!`, `${name}! I missed you.`]
    : [];
  const plain = [
    'Hi again!',
    "Hey there, I'm back!",
    'Hello again, friend!',
    'Did you miss me? I missed you!',
    'Bonzi is back in business!',
  ];
  const text = pick([...named, ...named, ...plain], random);
  return { text, gesture: random() < 0.5 ? 'Wave' : 'Greet' };
}

export function goodbyeLine(random: () => number = Math.random): LocalLine {
  return {
    text: pick(['Bye for now!', 'See you later!', 'Catch you next time!', 'Goodbye, friend!'], random),
    gesture: 'Wave',
  };
}

export function noKeyLine(): LocalLine {
  return {
    text: "I'd love to chat, but I need an OpenAI API key first. I'm opening my settings so you can add one.",
    gesture: 'Explain',
  };
}

/** Friendly reaction to an AI error, or null when Bonzi should say nothing. */
export function errorLine(error: AiError): LocalLine | null {
  switch (error.kind) {
    case 'cancelled':
      return null;
    case 'no-key':
      return noKeyLine();
    case 'auth':
      return { text: 'Hmm, my API key looks wrong or has been revoked. Could you check it in my settings?', gesture: 'Confused' };
    case 'quota':
      return { text: "Uh oh, the OpenAI account is out of credits, so my brain is on a break. Check your billing and I'll be right back.", gesture: 'Sad' };
    case 'rate-limit': {
      const s = error.retryAfterSec;
      const when = s && s > 0 ? `in about ${Math.ceil(s)} second${Math.ceil(s) === 1 ? '' : 's'}` : 'in a moment';
      return { text: `Whoa, too many requests at once! Let's try again ${when}.`, gesture: 'Uncertain' };
    }
    case 'model':
      return { text: "That AI model isn't available for this key. Pick another one in my settings and we're good to go.", gesture: 'Confused' };
    case 'network':
      return { text: "I can't reach the server right now. Are we connected to the internet?", gesture: 'Uncertain' };
    case 'timeout':
      return { text: 'That took way too long, so I gave up waiting. Want to try again?', gesture: 'Uncertain' };
    case 'server':
      return { text: 'The AI server is having a bad day. Give it a moment and try again.', gesture: 'Sad' };
    case 'bad-request':
      return { text: "Hmm, the server didn't like that request. Maybe try saying it a bit differently?", gesture: 'Confused' };
    default:
      return { text: 'Oops, something went wrong on my end. Mind trying that again?', gesture: 'Confused' };
  }
}

/**
 * What Bonzi says when a reply finished without any words, by finish_reason:
 * 'length' (the reply token limit ran out, typical for reasoning models),
 * 'content_filter', or anything else.
 */
export function emptyReplyLine(finishReason: string | null): LocalLine {
  if (finishReason === 'length') {
    return { text: 'I ran out of room before I could answer. Try raising Max reply tokens in my settings.', gesture: 'Uncertain' };
  }
  if (finishReason === 'content_filter') {
    return { text: "Hmm, I can't answer that one. Let's try something else.", gesture: 'Confused' };
  }
  return { text: 'Huh, I drew a blank on that one. Could you ask me again?', gesture: 'Confused' };
}

/** Note shown once when OpenAI TTS fails; fellBack: the Windows voice is speaking instead. */
export function ttsNote(kind: AiError['kind'], fellBack = false): string | null {
  const then = fellBack ? "I'm using my Windows voice for now" : "I'll just type for now";
  if (kind === 'auth') return `(My OpenAI voice isn't working because the API key was rejected for speech, so ${then}.)`;
  if (kind === 'quota') return `(My OpenAI voice is out of credits, so ${then}.)`;
  return null;
}

export function timeLine(now: Date, locale?: string): LocalLine {
  const time = new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit' }).format(now);
  const day = new Intl.DateTimeFormat(locale, { weekday: 'long' }).format(now);
  return { text: `It's ${time} on ${day}.`, gesture: 'Explain' };
}

export const QUICK_PROMPTS: Record<Exclude<QuickAction, 'time'>, string> = {
  joke: 'Tell me a short, clean joke.',
  fact: 'Tell me one surprising fun fact in two sentences or less.',
  compliment: 'Give me a short, genuine, cheerful compliment.',
  about: 'Briefly introduce yourself: who you are and what you can help me with.',
};

export const IDLE_CHATTER_PROMPT =
  'The user has been quiet for a while. Say one short, fun, unprompted remark, tip or joke.';

/** Gesture tags for a double click. */
export const FUN_GESTURES: readonly string[] = ['Banana', 'Juggle', 'Backflip', 'Laugh', 'Wink', 'BlowKiss', 'Butterfly', 'Excited'];

export const MIC_LINES = {
  denied: "I can't hear you: microphone access is blocked. You can allow it in Windows privacy settings.",
  noDevice: "I can't find a microphone. Plug one in and try again!",
  failed: "Hmm, my ears aren't working right now. Try typing instead?",
  disabled: 'Voice input is switched off. You can turn it on in my settings.',
  nothingHeard: "I didn't catch that. Could you say it again?",
} as const;

export const RESET_LINE: LocalLine = { text: 'Fresh start! What should we talk about?', gesture: 'Pleased' };

export const CHARACTER_ERROR_LINE = "I couldn't load my character file. Try picking another one in settings, or reset to the default Bonzi.";
