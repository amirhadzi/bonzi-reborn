/**
 * Type declarations for scripts/lib/e2e-balloon.mjs (balloon visibility checks
 * used by the e2e runner).
 */

export interface BalloonSnapshot {
  exists: boolean;
  hidden: boolean;
  /** Whether #balloon has the 'open' class (removed at the start of the fade-out). */
  open: boolean;
  text: string;
  /** speechLog texts recorded since opts.since, or null when no since was given. */
  spoken: string[] | null;
}

export interface BalloonTextOptions {
  pattern?: string | null;
  /** Date.now() taken before the action; the text must show a line spoken since then. */
  since?: number | null;
}

export declare function readVisibleBalloon(snap: BalloonSnapshot | null | undefined, opts: BalloonTextOptions): string | null;
export declare function balloonTextExpression(opts?: BalloonTextOptions): string;
export declare function balloonTextMessage(opts?: BalloonTextOptions): string;
