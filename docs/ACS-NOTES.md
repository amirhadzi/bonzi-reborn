# ACS format notes and Bonzi animation guide

This file documents the Microsoft Agent 2.0 `.acs` character format as implemented in
`src/shared/acs/` and verified against `assets/characters/Bonzi.acs`, followed by a
practical guide to the Bonzi animations for the app.

Regenerate the machine-readable summary and the contact sheets with:

```
node scripts/acs-dump.ts            # writes docs/bonzi-acs-summary.json + .scratch/acs-dump/*.png
node scripts/acs-dump.ts --no-png   # JSON only
```

Useful sheets in `.scratch/acs-dump/`: `anim-<NAME>.png` (every frame, labelled with
duration `D`, image count `I`, sound `S`, exit index `X`, branches `B frame:prob`, `M` for
mouth overlays), `_overview-NN.png` (12 animations per sheet, sampled frames),
`_mouth-overlays*.png`, `_layering.png`, `_tray-icon*.png`.

## 1. File format (as implemented)

All integers are little-endian. `STRING` = `u32` character count, then `count + 1` UTF-16LE
code units including a null terminator; when the count is 0 there is no terminator.
`LOCATOR` = `u32 offset, u32 size`. `RGBQUAD` = bytes B, G, R, reserved. `GUID` = 16 bytes,
printed in registry form.

### Header (offset 0)

| field | type |
|---|---|
| signature | u32 `0xABCDABC3` |
| character info | LOCATOR |
| animation list | LOCATOR |
| image list | LOCATOR |
| audio list | LOCATOR |

### Character info

`u16 minor, u16 major, LOCATOR localizedInfo, GUID, u16 width, u16 height, u8 transparentIndex,
u32 flags, u16 animSetMajor, u16 animSetMinor`, then:

* if `flags & 0x20` (voice enabled): `GUID ttsEngine, GUID ttsMode, u32 speed, u16 pitch,
  u8 hasExtra`, and when `hasExtra`: `u16 langId, STRING dialect, u16 gender, u16 age, STRING style`.
* if `flags & 0x200` (balloon enabled): `u8 lines, u8 charsPerLine, RGBQUAD fg, RGBQUAD bg,
  RGBQUAD border, STRING fontName, i32 fontHeight, i32 fontWeight, u8 italic, u8 unknown`.
* palette: `u32 count`, `count x RGBQUAD`.
* tray icon: `u8 present`; when 1: `u32 size, mono (AND mask) DIB bytes, u32 size, colour DIB bytes`.
  Each DIB is a BITMAPINFOHEADER + palette + bottom-up bits. The decoder reads the colour
  DIB (1/4/8/24/32 bpp) and uses the AND mask (bit set = transparent). Icon DIB heights may
  be stored doubled; the decoder uses the row count that fits the data.
* states: `u16 count`, each `STRING stateName, u16 n, n x STRING animationName`.

Other flag bits: `0x10` voice disabled, `0x100` balloon disabled, `0x10000` balloon sizes to
text, `0x20000` balloon does not auto-hide, `0x40000` balloon does not auto-pace,
`0x100000` standard animation set. Bonzi's flags are `0x00010220` (voice, balloon,
size-to-text; the standard-animation-set bit is NOT set).

### Localized info (at `localizedInfo` locator)

`u16 count`, each `u16 langId, STRING name, STRING description, STRING extraData`.

### Animation list

`u32 count`, each `STRING name, LOCATOR`. At the locator: `STRING name, u8 transitionType,
STRING returnAnimation, u16 frameCount`, frames:

* `u16 imageCount`, each `u32 imageIndex, i16 x, i16 y`
* `u16 audioIndex` (`0xFFFF` = none; exposed as `-1`)
* `u16 duration` (1/100 s)
* `i16 exitFrameIndex`
* `u8 branchCount`, each `u16 frameIndex, u16 probability` (percent)
* `u8 overlayCount`, each `u8 type, u8 replace, u16 imageIndex, u8 unknown, u8 hasRegion,
  i16 x, i16 y, u16 width, u16 height`, and when `hasRegion`: `u32 size, RGNDATA bytes`

### Image list

`u32 count`, each `LOCATOR, u32 checksum`. At the locator: `u8 unknown (always 1 in Bonzi),
u16 width, u16 height, u8 compressed, u32 dataSize, data`, then region data:
`u32 compressedSize, u32 uncompressedSize, bytes` (compressed with the same algorithm when
`compressedSize > 0`, raw `uncompressedSize` bytes otherwise). Region data is a Windows
`RGNDATA` (32-byte header with `iType = 1`, then `nCount` RECTs); `parseRegion()` decodes it.

Pixels are 8-bit palette indexes, bottom-up rows, each row padded to a multiple of 4 bytes
(`stride = (width + 3) & ~3`). Decoded size is exactly `stride * height` for all 1253 images.

### Audio list

`u32 count`, each `LOCATOR, u32 checksum`; the located bytes are a complete RIFF WAVE file
(Bonzi: 22 clips, PCM at 11025 or 22050 Hz, 0.24 s to 2 s).

### Compression

The hint matched the real data exactly; no change was needed. Every one of the 1253 images
and all region blocks decode to the expected size:

* byte 0 must be `0x00`; the rest is a bit stream read LSB-first;
* bit `0` = literal byte (next 8 bits);
* bit `1` = back-reference with length 2; the offset prefix is `0` (6 bits + 1), `10`
  (9 bits + 65), `110` (12 bits + 577) or `111` (20 bits + 4673, length + 1). A raw 20-bit
  value of `0xFFFFF` is end of stream;
* length suffix: count 1 bits up to a terminating 0 bit (at most 11 ones; the 0 is always
  read, even after 11 ones); if the count `n > 0`, the length grows by
  `(1 << n) - 1 + next n bits`. An independent decoder that treated 11 ones as
  self-terminating produced short output on Bonzi images, so the terminator is required;
* copy byte by byte from `out - offset` (overlap allowed).

The decoder throws `DecompressError` for a missing `0x00`, truncation, a too-long length
prefix, an offset before the start of the output, or a size mismatch when an expected size
is given. It also rejects an expected size larger than 1100 bytes per compressed byte (the
format's maximum expansion is about 1057), so a corrupt width/height cannot trigger a
multi-GB allocation. `compress()` is a simple encoder used by the round-trip tests.

### Deviations and surprises found in the real file

* **Exit frame index `-2`**: 245 frames use `-2` (62 of them on the trailing empty end-marker
  frames, the other 183 on ordinary frames, for example every frame of SHOW except the last).
  923 frames use `-1`. Treat any negative value as "no exit branch, continue with
  the next frame". Reading `-2` as "stop immediately" would make exits cut off mid-gesture
  (DECLINE frame 15 would end abruptly instead of rewinding 16, 9, 5 ... 0). The raw value is
  kept in `exitFrameIndex`.
* **Exit index equal to `frames.length`** (SEARCHINGRETURN frame 6 -> 7) means "jump to the end".
* **Self-referencing exit index**: SHOW frame 26, LOOKRIGHTRETURN frame 4 and SCOUTRETURN
  frame 5 (each the last frame) point their exit index at themselves. `exitNextFrame()` treats
  this as "ended" to avoid an infinite loop.
* **Branch probabilities can sum to less than 100**; the remainder means "continue to the
  next frame" (IDLE1_1 last frame: 70% back to frame 0, 30% end).
* **End markers**: 55 frames have no images, all with duration 0 and all the last frame of
  their animation. All 53 `transitionType 1` animations end with one (2 others do too). Do not
  draw it: keep the previous frame on screen.
* **Overlay width/height do not match the overlay image**: overlay images are full 200x160
  frames positioned at x = y = 0, while the overlay record says e.g. 100x77. The fields are
  parsed but unused. No overlay in Bonzi has region data.
* **All images are full-frame 200x160** (with transparency). Only 32 frame-image entries use
  non-zero offsets (IDLE3_2, IDLE1_13, READRETURN, READLOOKUPRETURN, SHOW, MOVEDOWNRETURN,
  MOVEUPRETURN, HIDESHOW). Positive y moves the image down.
* Animation names differ in case between the two places they are stored: the animation list
  uses mixed case (`Idle1_9`, `GetAttention`), the animation record itself uses UPPER CASE
  (`IDLE1_9`). The parser keeps the upper-case record name in `anim.name`. Use
  `getAnimation(ch, 'Greet')`, which is case-insensitive. State names and the animation names
  inside states are upper case (`SPEAKING`, `IDLINGLEVEL1` ...).
* The transparent index is 254, whose palette colour is cyan (0, 255, 255).

## 2. Rendering

### Layering order (verified visually)

A frame's image list is ordered **top-most first**. Paint in reverse (last entry first) so
entry 0 ends up on top. In IDLE1_9 frame 1 the list is `[eyelid patch, full body]`: reverse
order shows the blink, forward order hides it under the body. In IDLE3_1 frame 6 the top
entry is the arm across the face and the bottom entry is a body with the arm cut out.
`composeFrame()` uses reverse order by default (`options.order = 'forward'` exists only
for debugging); `_layering.png` shows both orders side by side.

### Transparency

Pixels equal to `transparentIndex` are skipped when painting (they let lower layers show
through) and come out as alpha 0. Every other pixel is opaque. There is no partial alpha.

### Mouth overlays (lip-sync)

Overlay types: 0 closed, 1 wide1, 2 wide2, 3 wide3, 4 wide4, 5 medium, 6 narrow.
`composeFrame(ch, anim, i, { mouth })` draws the overlay of that type, if the frame has one,
after the frame images at the overlay's x/y. A frame without that overlay is rendered unchanged.

`replace` flag: in Bonzi only 24 of 630 overlays set it (some EXPLAIN, GESTURELEFT/RIGHT, SAD,
UNCERTAIN frames). A replace overlay image is a **whole body** rather than just a mouth patch,
so it stands in for the frame's top image (list entry 0). `composeFrame()` skips entry 0 and
draws the overlay in its place. Non-replace overlays are mouth-region patches drawn on top.
Both kinds were checked visually (`_mouth-overlays.png` for RestPose, and
`_mouth-overlays-EXPLAIN-6.png` where "narrow" is a replace overlay); all seven mouths sit
correctly on the mouth.

All 90 frames that have overlays carry all 7 types, and no replace overlay occurs in a multi-image frame. Overlays sit on "talkable" poses: usually the
first frame (the rest pose) and the final held pose of a gesture (the frame just before the
end marker). `docs/bonzi-acs-summary.json` lists them per animation as `overlayFrames`.

## 3. Playback rules (implemented in `playback.ts`)

* **Normal play**: show frame `i` for `duration * 10` ms (a duration of 0 means skip
  immediately), then `pickNextFrame()`: roll `r` in [0, 100); walk branches accumulating
  probability; take the first branch whose running total exceeds `r`; otherwise go to `i + 1`.
  Index `frames.length` means ended.
* **Sound**: when a frame with `audioIndex >= 0` is entered, play that WAV. A `play()` job only
  completes once the sounds it started have ended, capped by `soundTailMaxMs` (3 s), so a queued
  `beginSpeaking` does not talk over a gesture's sound effect. `playNow` and `hide` end the wait
  early and `stopAll` aborts it.
* **Exiting** (the app wants to move on before the animation finishes naturally):
  * `transitionType 1` (exit branches): keep stepping with `exitNextFrame()` (ignores
    branches; goes to `exitFrameIndex` when it is >= 0, else `i + 1`) until the end. This
    rewinds the gesture back to the rest pose, so it looks smooth. `exitPath(anim, i)`
    returns the whole path.
  * `transitionType 0` (return animation): stop, then play `returnAnimation`
    (`getReturnAnimation()`), e.g. READING -> READRETURN, MOVELEFT -> MOVELEFTRETURN.
    Also play it after a natural end.
  * `transitionType 2` (none): stop. The final frame is already at (or near) rest.
* **Endless animations** (`canEndNaturally() === false`) never reach the end on their own and
  must be exited: LOOKDOWN, LOOKLEFT, LOOKRIGHT, LOOKUP, READING, SEARCHING,
  SUNGLASSESCONTINUED, IDLE3_2, WRITECONTINUED, WRITING, HEADPHONESCONTINUED.
* **Looping with a random way out** (`hasLoop()` true but ends naturally): IDLE1_1, IDLE1_3,
  IDLE1_4, IDLE1_5, IDLE1_6, IDLE1_7, IDLE1_8, IDLE1_14, IDLE1_15, IDLE1_21, IDLE1_24,
  IDLE1_26, IDLE1_4 (2), IDLE1_5 (2), IDLE1_1 (2), IDLE1_1 (3), SEARCH.

## 4. Character facts

| | |
|---|---|
| Size | 200 x 160, 256-colour palette, transparent index 254 |
| Name / description | "Bonzi", "Hi, my name is Bonzi! I am your interactive friend and traveling companion on the Internet! ..." (lang 9, extra data `3.0.7`) |
| Voice | TTS engine `{CA141FD0-AC7F-11D1-97A3-0060082730FF}`, mode `{CA141FD0-AC7F-11D1-97A3-006008273001}` (believed to be Lernout & Hauspie TruVoice "Adult Male #2", the classic Bonzi voice), speed 157, pitch 140, en-US (1033), gender 2 (male), age 30, style "Business" |
| Balloon | 2 lines x 28 chars, black text on classic tooltip yellow #FFFFE1 (balloon colors are COLORREF R,G,B,0, unlike the RGBQUAD palette), black border, MS Sans Serif, height -13 (13 px), weight 400 |
| Tray icon | 16x16 banana |
| Counts | 146 animations, 1253 images, 22 sounds |

### States map

| State | Animations |
|---|---|
| SHOWING | SHOW |
| HIDING | HIDE |
| SPEAKING | RESTPOSE |
| LISTENING | ALERT |
| IDLINGLEVEL1 | IDLE1_1, IDLE1_3, IDLE1_5, IDLE1_6, IDLE1_9, IDLE1_11, IDLE1_13, IDLE1_14, IDLE1_15, IDLE1_4, IDLE1_4 (2), IDLE1_5 (2), IDLE1_24, IDLE1_12, IDLE1_25, IDLE1_1 (2), IDLE1_1 (3), IDLE1_9 (2), IDLE1_9 (3) |
| IDLINGLEVEL2 | IDLE1_1, IDLE1_9, IDLE1_3, IDLE1_5, IDLE1_6, IDLE1_4, IDLE1_4 (2), IDLE1_5 (2), IDLE1_13, IDLE1_12, IDLE1_21, IDLE1_24, IDLE1_8, IDLE1_26, IDLE1_14, IDLE1_25, IDLE1_7, IDLE1_1 (2), IDLE1_1 (3), IDLE1_9 (2), IDLE1_9 (3) |
| IDLINGLEVEL3 | IDLE3_1, IDLE3_2 |
| MOVINGLEFT / RIGHT / UP / DOWN | MOVELEFT / MOVERIGHT / MOVEUP / MOVEDOWN |
| GESTURINGLEFT / RIGHT / UP / DOWN | GESTURELEFT / GESTURERIGHT / GESTUREUP / GESTUREDOWN |

There is no HEARING state entry in this file.

### Placeholder animations (do not use for anything visible)

These 28 animations are a single frame of the plain rest pose (identical to RESTPOSE):
DOMAGIC1, DOMAGIC2, GETATTENTIONCONTINUED, GETATTENTIONRETURN, HEARING1, HEARING2, HEARING3,
IDLE3_3, PROCESS, PROCESSING, SUGGEST, THINKING, and all the diagonal or blink look variants
(LOOKDOWNBLINK, LOOKDOWNLEFT, LOOKDOWNLEFTBLINK, LOOKDOWNLEFTRETURN, LOOKDOWNRIGHT,
LOOKDOWNRIGHTBLINK, LOOKDOWNRIGHTRETURN, LOOKLEFTBLINK, LOOKRIGHTBLINK, LOOKUPBLINK,
LOOKUPLEFT, LOOKUPLEFTBLINK, LOOKUPLEFTRETURN, LOOKUPRIGHT, LOOKUPRIGHTBLINK,
LOOKUPRIGHTRETURN). In particular **THINKING, PROCESSING, HEARING1-3 and SUGGEST do nothing
visible for Bonzi**; use the substitutes recommended below.

## 5. Animation guide for the app

Durations are a straight playthrough (ignoring branches). `S` = has sound. `M` = has mouth
overlays (can talk on its overlay frames).

### Recommended mapping

| App behaviour | Use | Notes |
|---|---|---|
| Appear | SHOW (2.7 s, S) | Swings in on a jungle vine, lands with a dust puff, settles to rest. Type 2. |
| Disappear | HIDE (2.6 s, S) | Grabs a vine and is pulled up out of view; last frames are nearly empty, so hide the window after it ends. |
| Re-appear / refresh gag | HIDESHOW (6.3 s, S) | Leaves on the vine and swings straight back. |
| Greet on launch | GREET (1.1 s, M) | Bows forward with an arm sweep. Pair with WAVE for a friendlier hello. |
| Wave hello / goodbye | WAVE (2.9 s, M) | Big overhead wave. |
| Speaking rest pose | RESTPOSE frame 0 (M) | The SPEAKING state. Hold it and swap mouth overlays during TTS. |
| Waiting for the AI (short) | THINK (3.05 s, M) | Hand on chin, eyes rolling up. It does NOT loop: its two branches (frame 3 to 5, frame 5 to 7, both 100%) only skip forward, so it plays once and ends at rest. For a longer wait replay it or switch to SEARCHING. Exit branches rewind it. |
| Waiting for the AI (long) | SEARCHING (endless) then SEARCHINGRETURN | Spins a globe on one finger; the return makes the globe vanish in a puff of smoke. SEARCH is the self-contained version (6 s). |
| Reading a long answer / document | READING (endless) then READRETURN | Sits down and reads a big book. READ / READCONTINUED / READLOOKUP* are the building blocks. |
| Composing / writing | WRITING or WRITE (endless or 4.3 s, S) then WRITINGRETURN / WRITERETURN | Writes in a notebook with a pencil (pencil scratch sound). |
| Listening to the mic | STARTLISTENING (M) on start, ALERT while listening, STOPLISTENING (M) at the end | Start: cups a hand to his ear. Alert: attentive rest pose. Stop: hands over ears. |
| Hearing speech (mid-utterance) | ALERT or DONTRECOGNIZE | HEARING1-3 are placeholders. DONTRECOGNIZE (hand cupped to ear, M) also fits "I didn't catch that". |
| Idle | random pick from the IDLINGLEVEL1/2/3 lists (`animationsForState`) | Level 1 after ~10 s, level 2 after ~1 min, level 3 after several minutes (IDLE3_1 big yawn, IDLE3_2 sits down and dozes; IDLE3_2 is endless). |
| Blink | BLINK, IDLE1_9 | Quick eye blink overlays; good filler between idles. |
| Get attention | GETATTENTION (S) or GETATTENTION2 (S, M) | 1: fist pump "hey!" gesture. 2: jumps, does a flip and lands in a dust cloud. |
| Happy / pleased | PLEASED, PLEASEDSOFT, PLEASEDHARD | Toothy grin, from mild to very big. |
| Laugh | GIGGLE (S, M) | Eyes-closed giggle with a 2 s laugh sound. |
| Congratulate | CONGRATULATE (S, M) | Pats his belly happily with a cheer sound. |
| Sad / sorry | SAD (M) | Slumps, arms hanging, sad face. |
| Surprised | SURPRISED (S, M), UNBELIEVABLE (S, M) | Jaw-drop with an arm thrown up; Unbelievable is a smaller "ooh" face. |
| Confused / uncertain | CONFUSED (S, M), UNCERTAIN (M) | Scratches his head; Uncertain is a subtle head tilt. |
| Decline / no | DECLINE (M) | Small head shake. |
| Acknowledge / yes | ACKNOWLEDGE | Nod. |
| Explaining | EXPLAIN, EXPLAIN2, EXPLAIN3, EXPLAIN4 (all M) | Arms open (shrug-like), one hand presenting to the side, finger raised, both arms out. Good while the answer is spoken. |
| Suggesting | EXPLAIN3 (finger raised) or GESTUREUP | SUGGEST is a placeholder. |
| Point at something | GESTURELEFT / GESTURERIGHT / GESTUREUP / GESTUREDOWN (M) | Directions are the CHARACTER's, so left and right are mirrored on screen: GESTURELEFT points toward the right edge of the screen, GESTURERIGHT toward the left edge (checked on the contact sheets). To point at something to the right of Bonzi on screen, use GESTURELEFT. |
| Look around | LOOKLEFT / LOOKRIGHT / LOOKUP / LOOKDOWN (endless) then the matching *RETURN | Holds the gaze until exited. Left and right are mirrored like the gestures: LOOKLEFT looks toward the right of the screen. |
| Moving across the screen | MOVELEFT / MOVERIGHT / MOVEUP / MOVEDOWN (S) while moving, then *RETURN (S) | Swings on a vine in that direction; the return lands with a dust puff. Move the window during the loop part. |
| Being dragged | MOVEUP frames or GETATTENTION2 middle frames | No dedicated drag animation. A good option is to hold MOVEUP's last frame (hanging, arm raised) while dragging, then play MOVEUPRETURN on drop. |
| Shush / quiet mode | SHOOSH (M) | Finger to lips. |
| Wink / flirt | WINK (S, M), BLOWKISS (S) | Wink; blows a kiss with a kiss sound. |
| Hug / affection | HUG (S) | Hugs himself with eyes closed. |
| Scouting / searching the web | SCOUT then SCOUTLEFT / SCOUTRIGHT, end with SCOUTRETURN; SCOUTALERT | Hand shading the eyes, looking into the distance. |
| Mail / notifications | MAILCHECK (S) then MAILCHECKEMPTY or MAILCHECKFULL (S), MAILREAD / MAILNEXT (S), MAILRETURN | A yellow mailbox pops up beside him; Full pulls out a letter, Read holds up a white letter. |

### Bonzi-specific fun animations

| Animation | What it shows | Sound | Mouth | Ends |
|---|---|---|---|---|
| BANANA | Peels a banana, chomps it down, tosses the peel away and pats his belly | no | yes | natural |
| BANANAMISS | Peels a banana and lunges at it with his mouth wide open, apparently misses, looks down at it, then flicks the peel up into the air | yes | no | natural |
| IDLE1_25 | Long banana-eating idle (18 s) | yes | yes | natural |
| JUGGLE | Juggles three coconuts | no | no | natural |
| IDLE1_14 | Short coconut-juggling idle | no | no | natural |
| SUNGLASSESCONTINUED -> SUNGLASSESRETURN | Puts on black sunglasses and poses (endless), return takes them off | no | no | endless |
| IDLE1_24 | Self-contained sunglasses idle (20 s) | no | no | natural |
| HEADPHONESCONTINUED -> HEADPHONESRETURN | Puts on orange headphones and grooves to music (endless) | no | yes | endless |
| IDLE1_26 | Self-contained headphones idle (14 s) | no | yes | natural |
| BUTTERNUT | A yellow butterfly flutters in and lands on his finger, he admires it, it flies off | no | no | natural |
| IDLE1_12 | Butterfly-on-finger idle (13 s) | no | no | natural |
| IDLE1_13 | Butterfly lands on his head | no | no | natural |
| BLOWKISS | Blows a kiss | yes | no | natural |
| HUG | Hugs himself | yes | no | natural |
| GIGGLE | Giggles | yes | yes | natural |
| WINK | Winks | yes | yes | natural |
| IDLE1_21 | Takes out a notebook and scribbles in it | no | yes | natural |
| IDLE1_7 | Shades his eyes and looks around | no | no | natural |
| IDLE1_8 | Hands on hips, looking around | no | yes | natural |
| IDLE1_11 | Purses his lips (whistling) and looks up | no | no | natural |
| HANDSBEHIND | Arms bent with hands at his hips, half-closed eyes (a smug pose) | no | yes | natural |
| IDLE3_1 | Huge yawn | yes | yes | natural |
| IDLE3_2 | Sits down and dozes off | yes | yes | endless |

### Sounds

22 WAV clips. Animations with sound: CONFUSED (0), CONGRATULATE (1), GETATTENTION2 (2),
IDLE3_1 (3), READING / IDLE3_2 / READ / READLOOKUP (4), READING / READCONTINUED /
READLOOKUPCONTINUED (5), SURPRISED / UNBELIEVABLE (6), GETATTENTION (7), HUG (8),
BLOWKISS (9, 10), WRITE / WRITING / WRITECONTINUED / WRITEONCE / WRITEONCEAGAIN (11),
MAILCHECKEMPTY / MAILCHECKFULL (12), MAILREAD / MAILNEXT (13), MAILCHECK (14), WINK (15),
GIGGLE (16), BANANAMISS / IDLE1_25 (17), SHOW / HIDESHOW (18), HIDE / HIDESHOW (19),
MOVE* (20), MOVE*RETURN (21).

### Lip-sync recipe

1. Play the chosen gesture (e.g. EXPLAIN) normally.
2. When it reaches its last overlay frame (`overlayFrames` in the summary JSON, usually the
   frame before the end marker), hold that frame instead of finishing, or simply switch to
   RESTPOSE frame 0.
3. While audio plays, re-compose the held frame with `{ mouth }` driven by the audio
   amplitude or visemes (closed for silence, narrow/medium for small amplitude, wide1-4 for
   louder), at roughly 10 to 15 updates per second.
4. When speech ends, compose with `mouth: 0` (closed) or no overlay and continue (exit the
   gesture or go idle).
