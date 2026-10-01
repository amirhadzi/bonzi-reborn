// Gestures the AI may trigger with inline [[Tag]] markers.
// Used by the main process (to describe the available gestures in the system
// prompt) and by the agent renderer (to resolve tags to ACS animations).
//
// Each gesture lists candidate ACS animation names in preference order; the
// first one present in the loaded character file is used, so other Microsoft
// Agent characters (Clippy, Merlin, Genie, Peedy...) work with the same tags.
// Bonzi placeholders (single rest-pose frames such as SUGGEST, THINKING,
// DOMAGIC1) are listed after real animations so they are only used as a last
// resort for characters that genuinely animate them.

export interface GestureDef {
  /** Tag the model writes, e.g. [[Wave]]. Matched case-insensitively. */
  tag: string;
  /** Candidate ACS animation names, upper case, in preference order. */
  animations: readonly string[];
  /** Short description shown to the model. */
  description: string;
}

export const GESTURES: readonly GestureDef[] = [
  { tag: 'Wave', animations: ['WAVE'], description: 'big wave hello or goodbye' },
  { tag: 'Greet', animations: ['GREET'], description: 'polite bow with an arm sweep' },
  { tag: 'Pleased', animations: ['PLEASED', 'PLEASEDSOFT'], description: 'happy grin' },
  { tag: 'Excited', animations: ['PLEASEDHARD', 'PLEASED'], description: 'huge delighted grin' },
  { tag: 'Laugh', animations: ['GIGGLE', 'PLEASED'], description: 'giggles at something funny' },
  { tag: 'Congratulate', animations: ['CONGRATULATE', 'CONGRATULATE_2'], description: 'cheers and celebrates the user' },
  { tag: 'Sad', animations: ['SAD'], description: 'sad or sympathetic' },
  { tag: 'Surprised', animations: ['SURPRISED'], description: 'jaw-drop surprise' },
  { tag: 'Impressed', animations: ['UNBELIEVABLE', 'SURPRISED'], description: 'impressed "ooh" face' },
  { tag: 'Confused', animations: ['CONFUSED'], description: 'scratches head, puzzled' },
  { tag: 'Uncertain', animations: ['UNCERTAIN'], description: 'unsure head tilt' },
  { tag: 'No', animations: ['DECLINE'], description: 'shakes head no' },
  { tag: 'Yes', animations: ['ACKNOWLEDGE'], description: 'nods yes or understood' },
  { tag: 'Explain', animations: ['EXPLAIN', 'EXPLAIN2', 'EXPLAIN4'], description: 'open arms while explaining something' },
  { tag: 'Idea', animations: ['EXPLAIN3', 'SUGGEST'], description: 'raises a finger with an idea or tip' },
  { tag: 'Think', animations: ['THINK'], description: 'hand on chin, pondering' },
  { tag: 'PointUp', animations: ['GESTUREUP'], description: 'points upward' },
  { tag: 'Attention', animations: ['GETATTENTION'], description: 'fist pump, "hey, listen!"' },
  { tag: 'Backflip', animations: ['GETATTENTION2'], description: 'jumps and does a backflip (big excitement)' },
  { tag: 'Shush', animations: ['SHOOSH'], description: 'finger to lips, a secret' },
  { tag: 'Wink', animations: ['WINK'], description: 'playful wink' },
  { tag: 'BlowKiss', animations: ['BLOWKISS'], description: 'blows a kiss' },
  { tag: 'Hug', animations: ['HUG'], description: 'warm hug, comfort' },
  { tag: 'Banana', animations: ['BANANA'], description: 'eats a banana (food, snacks, hunger)' },
  { tag: 'Juggle', animations: ['JUGGLE'], description: 'juggles coconuts (showing off, fun)' },
  { tag: 'Butterfly', animations: ['BUTTERNUT'], description: 'a butterfly lands on his finger (calm, nature)' },
  { tag: 'Write', animations: ['WRITE', 'WRITEONCE'], description: 'jots a note in a notebook' },
  { tag: 'Search', animations: ['SEARCH'], description: 'spins a globe (world facts, travel, looking things up)' },
  { tag: 'Scout', animations: ['SCOUT'], description: 'shades his eyes and looks into the distance' },
];

const TAG_INDEX = new Map(GESTURES.map((g) => [g.tag.toLowerCase(), g]));

/** Finds a gesture by tag, case-insensitively. */
export function findGesture(tag: string): GestureDef | undefined {
  return TAG_INDEX.get(tag.trim().toLowerCase());
}

/**
 * Resolves a tag to the ACS animation to play for a character, or null when
 * the tag is unknown or the character has none of the candidates.
 * `hasAnimation` must be case-insensitive (e.g. CharacterController.hasAnimation).
 */
export function resolveGesture(tag: string, hasAnimation: (name: string) => boolean): string | null {
  const g = findGesture(tag);
  if (!g) return null;
  for (const name of g.animations) if (hasAnimation(name)) return name;
  return null;
}

/** Gestures the given character can actually perform (for the system prompt and menus). */
export function availableGestures(animationNames: readonly string[]): GestureDef[] {
  const names = new Set(animationNames.map((n) => n.toUpperCase()));
  return GESTURES.filter((g) => g.animations.some((a) => names.has(a)));
}
