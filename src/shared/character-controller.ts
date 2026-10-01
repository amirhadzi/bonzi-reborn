// Contract between the animation engine (src/renderer/agent/character/)
// and the rest of the agent renderer (conversation, speech, input).
// The engine implements MS Agent playback semantics on top of the parsed
// ACS data; callers only express intent.

/** ACS mouth overlay types. */
export const MOUTH = {
  closed: 0,
  wide1: 1,
  wide2: 2,
  wide3: 3,
  wide4: 4,
  medium: 5,
  narrow: 6,
} as const;
export type MouthShape = (typeof MOUTH)[keyof typeof MOUTH];

/** Looping activities that run until stopActivity() is called. */
export type Activity =
  | 'thinking' // waiting for the AI to respond
  | 'listening' // microphone is recording
  | 'processing' // transcribing audio, loading
  | 'searching'
  | 'reading'
  | 'writing'
  | 'dragging'; // user is dragging the window (Bonzi hangs from his vine: MOVEUP held, MOVEUPRETURN on drop)

export type PlayOutcome = 'completed' | 'interrupted' | 'missing';

export type LookDirection = 'left' | 'right' | 'up' | 'down' | 'up-left' | 'up-right' | 'down-left' | 'down-right';

export interface CharacterController {
  /** Character display name from the ACS file. */
  readonly name: string;
  /** ACS character size in pixels (unscaled). */
  readonly width: number;
  readonly height: number;
  /** The canvas the engine draws into. The caller places it in the DOM. */
  readonly canvas: HTMLCanvasElement;

  hasAnimation(name: string): boolean;
  animationNames(): string[];

  /** Plays the Showing state animation (appear). */
  show(): Promise<void>;
  /** Plays the Hiding state animation (disappear). Resolves when it has finished. */
  hide(): Promise<void>;

  /**
   * Plays a named animation after anything already queued (MS Agent semantics):
   * the animation runs to its natural end and its final visible frame is HELD.
   * Before the next animation (or idle) starts, the held animation is wound
   * back to rest automatically: transition type 0 plays its return animation,
   * type 1 follows exit branches, type 2 needs nothing.
   * Endless animations (e.g. SEARCHING, LOOKLEFT) keep looping until the next
   * request arrives, then exit gracefully; their promise resolves when they start
   * exiting. Name lookup is case-insensitive. Unknown names resolve to 'missing'.
   */
  play(name: string): Promise<PlayOutcome>;
  /** Like play(), but clears the queue and gracefully exits the current animation first. */
  playNow(name: string): Promise<PlayOutcome>;

  /** Starts a looping activity (replacing any current one). */
  startActivity(activity: Activity): void;
  /** Ends the current activity gracefully. Resolves once back at rest. */
  stopActivity(): Promise<void>;

  /** Briefly looks toward a direction (LookLeft etc.) and returns. */
  look(direction: LookDirection): Promise<PlayOutcome>;

  /**
   * Gets ready to talk and resolves when setMouth() will have a visible effect.
   * MS Agent rule: if the currently held frame has mouth overlays (for example
   * after play('Explain') or play('Wave') finished), speak right there; otherwise
   * wind the held animation back to rest and hold the Speaking state animation
   * (RESTPOSE frame 0 for Bonzi). Waits for queued animations first.
   */
  beginSpeaking(): Promise<void>;
  /** Changes the mouth overlay while speaking. null = no overlay (base frame). */
  setMouth(shape: MouthShape | null): void;
  /**
   * Stops lip-sync and closes the mouth. The pose stays held; the next
   * animation or idle winds it back to rest.
   */
  endSpeaking(): Promise<void>;
  /** True when the given animation ends on a frame with mouth overlays, so speech can follow it without returning to rest first. */
  canSpeakDuring(name: string): boolean;

  /** Interrupts everything immediately and returns to rest. */
  stopAll(): void;

  /** Idle behaviour (IdlingLevel1/2/3 escalation). */
  setIdleEnabled(enabled: boolean): void;
  /** Resets the idle timer and idle level (call on any user interaction). */
  notifyUserActivity(): void;

  setScale(scale: number): void;
  setSoundEnabled(enabled: boolean): void;
  /** 0..1 */
  setVolume(volume: number): void;

  /**
   * Hit test against the currently displayed frame. x/y are CSS pixels
   * relative to the canvas top-left. True when the pixel is opaque.
   */
  hitTest(x: number, y: number): boolean;

  /** Fires whenever a new frame is drawn (used for debugging / tests). */
  onFrame(cb: (info: { animation: string | null; frame: number }) => void): () => void;

  dispose(): void;
}
