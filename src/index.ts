import fs from "node:fs";
import path from "node:path";
import { XMLParser } from "fast-xml-parser";

type Step = "C" | "D" | "E" | "F" | "G" | "A" | "B";

type Pitch = {
  step: Step;
  alter: number;
  octave: number;
};

type NoteEvent = {
  start: number;
  end: number;
  midi: number;
  stepIndex: number;
  degreeAbs: number;
  measure: number;
  beat: number;
};

type FigureEvent = {
  anchorDiv: number;  // bass note start — used as insertion key
  measure: number;
  beat: number;
  startDiv: number;   // actual segment start (may differ from anchorDiv mid-note)
  durationDiv: number;
  bassMidi: number;
  figures: string;
  rawIntervals: string;
};

const STEP_TO_SEMITONE: Record<Step, number> = {
  C: 0,
  D: 2,
  E: 4,
  F: 5,
  G: 7,
  A: 9,
  B: 11,
};

const STEP_TO_INDEX: Record<Step, number> = {
  C: 0,
  D: 1,
  E: 2,
  F: 3,
  G: 4,
  A: 5,
  B: 6,
};

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function parseArgs(argv: string[]) {
  const args = argv.slice(2);
  if (args.length === 0) {
    throw new Error("Usage: npm run start -- <input.musicxml> [--out output.musicxml]");
  }

  let input = "";
  let out = "";

  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (token === "--out") {
      out = args[i + 1] ?? "";
      i += 1;
      continue;
    }
    if (!input) {
      input = token;
    }
  }

  if (!input) {
    throw new Error("Missing input MusicXML path.");
  }

  if (!out) {
    const parsed = path.parse(input);
    out = path.join(parsed.dir, `${parsed.name}-figured-bass.musicxml`);
  }

  return { input, out };
}

function pitchToMidi(pitch: Pitch): number {
  const semitone = STEP_TO_SEMITONE[pitch.step] + pitch.alter;
  return (pitch.octave + 1) * 12 + semitone;
}

// forceShowThird: when true, show "3" for root-position chords rather than suppressing
// them as implied. Used for resolution segments (e.g. 4→3, 7→3) within a held bass note.
function simplifyIntervals(intervals: number[], forceShowThird = false): string {
  // Remove octave (8) and unison (1) — always implied, never written in figured bass
  const nums = [...new Set(intervals)]
    .filter(n => n !== 8 && n !== 1)
    .sort((a, b) => a - b);

  if (nums.length === 0) return "";

  const has = (n: number) => nums.includes(n);

  // Root position triad: 3 and/or 5 only → blank normally, but show "3" when resolving
  if (nums.every(n => n === 3 || n === 5)) {
    return (forceShowThird && has(3)) ? "3" : "";
  }

  // Root position seventh chords (3+5+7 → "7"; variants without full complement)
  if (has(7)) {
    if (has(3) && has(5)) return "7";          // full 7th chord
    if (has(3) && !has(5)) return "7/3";       // missing 5th (rare)
    if (has(5) && !has(3)) return "7/5";       // missing 3rd (rare)
    return "7";
  }

  // Suspension figures (no 3rd present with the 4th or 9th)
  if (has(9) && !has(3)) return has(5) ? "9/5" : "9";
  if (has(9) && has(3) && has(5)) return "9";
  if (has(9)) return "9";

  // First inversion triad: 3+6 → "6" (3 implied)
  if (has(6) && has(3) && !has(4) && !has(5) && !has(2)) return "6";

  // Second inversion triad: 4+6 → "6/4"
  if (has(6) && has(4) && !has(3) && !has(5) && !has(2)) return "6/4";

  // 4-3 suspension (4th without 6th)
  if (has(4) && !has(6) && !has(3)) return has(5) ? "4" : "4";

  // First inversion seventh: 3+5+6 → "6/5" (3 implied)
  if (has(6) && has(5)) return "6/5";

  // Second inversion seventh: 3+4+6 → "4/3" (6 implied)
  if (has(4) && has(3) && has(6)) return "4/3";
  if (has(4) && has(3)) return "4/3";

  // Third inversion seventh: 2+4+6 → "4/2" (6 implied)
  if (has(2) && has(4)) return "4/2";
  if (has(2)) return "2";

  // Fallback: strip implied intervals (8 already gone; also strip 3 and 5 since
  // they're implied in most contexts), write remaining highest-first
  const toWrite = nums.filter(n => n !== 3 && n !== 5);
  if (toWrite.length === 0) return nums.sort((a, b) => b - a).join("/");
  return toWrite.sort((a, b) => b - a).join("/");
}

function toIntervalNumber(bassDegreeAbs: number, upperDegreeAbs: number): number {
  let interval = upperDegreeAbs - bassDegreeAbs + 1;
  while (interval > 9) {
    interval -= 7;
  }
  while (interval < 2) {
    interval += 7;
  }
  return interval;
}

function parseScore(xmlText: string): any {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    parseTagValue: true,
    trimValues: true,
  });

  const parsed = parser.parse(xmlText);
  const score = parsed["score-partwise"];
  if (!score) {
    throw new Error("Only score-partwise MusicXML is supported.");
  }
  return score;
}

function readDivisions(measure: any, fallback: number): number {
  const attributes = measure.attributes;
  const divisions = attributes?.divisions;
  if (typeof divisions === "number" && divisions > 0) {
    return divisions;
  }
  return fallback;
}

/** Returns the first divisions-per-quarter-note value found in any part. */
function extractDivisions(score: any): number {
  for (const part of asArray(score.part)) {
    for (const measure of asArray(part.measure)) {
      const d = measure.attributes?.divisions;
      if (typeof d === "number" && d > 0) return d;
    }
  }
  return 1;
}

function extractPartEvents(part: any): NoteEvent[] {
  const measures = asArray(part.measure);
  const events: NoteEvent[] = [];

  let absoluteDiv = 0;
  let divisions = 1;

  for (let m = 0; m < measures.length; m += 1) {
    const measure = measures[m];
    divisions = readDivisions(measure, divisions);
    const notes = asArray(measure.note);

    let cursor = 0;
    let chordAnchor = 0;

    for (const note of notes) {
      const isRest = Boolean(note.rest);
      const isChord = Boolean(note.chord);
      const duration = Number(note.duration ?? 0);

      const localStart = isChord ? chordAnchor : cursor;
      if (!isChord) {
        chordAnchor = localStart;
      }

      if (!isRest && note.pitch) {
        const p = note.pitch;
        const step = String(p.step) as Step;
        const alter = Number(p.alter ?? 0);
        const octave = Number(p.octave);

        if (Number.isFinite(octave) && STEP_TO_INDEX[step] !== undefined) {
          const pitch: Pitch = { step, alter, octave };
          const midi = pitchToMidi(pitch);
          const stepIndex = STEP_TO_INDEX[step];
          const degreeAbs = octave * 7 + stepIndex;

          events.push({
            start: absoluteDiv + localStart,
            end: absoluteDiv + localStart + duration,
            midi,
            stepIndex,
            degreeAbs,
            measure: Number(measure["@_number"] ?? m + 1),
            beat: localStart / divisions + 1,
          });
        }
      }

      if (!isChord) {
        cursor += duration;
      }
    }

    absoluteDiv += cursor;
  }

  return events;
}

function averageMidi(events: NoteEvent[]): number {
  if (events.length === 0) {
    return Number.POSITIVE_INFINITY;
  }
  const total = events.reduce((sum, e) => sum + e.midi, 0);
  return total / events.length;
}

function findBassPartIndex(allPartEvents: NoteEvent[][]): number {
  return (
    allPartEvents
      .map((events, index) => ({ index, avg: averageMidi(events) }))
      .sort((a, b) => a.avg - b.avg)[0]?.index ?? 0
  );
}

function inferFigures(allPartEvents: NoteEvent[][], minDurationDiv: number): FigureEvent[] {
  const bassIndex = findBassPartIndex(allPartEvents);
  const bassEvents = allPartEvents[bassIndex];
  const upperParts = allPartEvents.filter((_, i) => i !== bassIndex);
  const results: FigureEvent[] = [];

  for (const bass of bassEvents) {
    // Collect all time points within this bass note where an upper voice changes.
    // Each point becomes a new harmonic segment to figure separately.
    const changePoints = new Set<number>([bass.start]);
    for (const part of upperParts) {
      for (const n of part) {
        if (n.start > bass.start && n.start < bass.end) {
          changePoints.add(n.start);
        }
      }
    }

    // Filter: keep only change points that are at least minDurationDiv after the
    // previous kept point (suppresses passing-tone splits shorter than a quarter note).
    const allPoints = [...changePoints].sort((a, b) => a - b);
    const sortedPoints: number[] = [allPoints[0]];
    for (let i = 1; i < allPoints.length; i++) {
      if (allPoints[i] - sortedPoints[sortedPoints.length - 1] >= minDurationDiv) {
        sortedPoints.push(allPoints[i]);
      }
    }

    // Accumulate segments before emitting, so we can merge identical consecutive figures
    type Seg = { startDiv: number; durationDiv: number; figures: string; rawIntervals: string };
    const segs: Seg[] = [];
    let prevFigures: string | null = null;

    for (let i = 0; i < sortedPoints.length; i++) {
      const segStart = sortedPoints[i];
      const segEnd = i + 1 < sortedPoints.length ? sortedPoints[i + 1] : bass.end;
      const segDuration = segEnd - segStart;
      const isAtAttack = segStart === bass.start;

      const intervals: number[] = [];
      for (const part of upperParts) {
        for (const n of part) {
          if (n.start <= segStart && n.end > segStart && n.midi > bass.midi) {
            intervals.push(toIntervalNumber(bass.degreeAbs, n.degreeAbs));
          }
        }
      }

      const uniqueIntervals = [...new Set(intervals)].sort((a, b) => a - b);
      // Force-show the resolution "3" only when we're mid-note following a non-trivial figure
      const isResolution = !isAtAttack && prevFigures !== null && prevFigures !== "";
      const figures = simplifyIntervals(uniqueIntervals, isResolution);

      if (figures === prevFigures) {
        // No harmonic change — extend the previous segment's duration
        if (segs.length > 0) segs[segs.length - 1].durationDiv += segDuration;
      } else {
        segs.push({ startDiv: segStart, durationDiv: segDuration, figures, rawIntervals: uniqueIntervals.join("/") });
        prevFigures = figures;
      }
    }

    for (const seg of segs) {
      results.push({
        anchorDiv: bass.start,
        measure: bass.measure,
        beat: Number(bass.beat.toFixed(3)),
        startDiv: seg.startDiv,
        durationDiv: seg.durationDiv,
        bassMidi: bass.midi,
        figures: seg.figures,
        rawIntervals: seg.rawIntervals,
      });
    }
  }

  return results;
}

function toCsv(rows: FigureEvent[]): string {
  const header = [
    "measure",
    "beat",
    "startDiv",
    "durationDiv",
    "bassMidi",
    "figures",
    "rawIntervals",
  ];

  const lines = [header.join(",")];
  for (const row of rows) {
    lines.push(
      [
        row.measure,
        row.beat,
        row.startDiv,
        row.durationDiv,
        row.bassMidi,
        row.figures,
        row.rawIntervals,
      ]
        .map((v) => `"${String(v).replaceAll('"', '""')}"`)
        .join(","),
    );
  }
  return `${lines.join("\n")}\n`;
}

function buildFiguredBassXml(figuresStr: string, durationDiv: number, indent: string): string {
  const numbers = figuresStr
    .split("/")
    .map(Number)
    .filter((n) => Number.isFinite(n) && n > 0)
    .reverse(); // MusicXML lists figures top-to-bottom (highest first)

  const figureLines = numbers
    .map((n) => `${indent}  <figure>\n${indent}    <figure-number>${n}</figure-number>\n${indent}  </figure>`)
    .join("\n");

  return `${indent}<figured-bass>\n${figureLines}\n${indent}  <duration>${durationDiv}</duration>\n${indent}</figured-bass>\n`;
}

/**
 * Returns the ID of the bass part (the one at bassPartIndex among all <part> elements).
 */
function getBassPartId(xmlText: string, bassPartIndex: number): string {
  const partIdRegex = /<part\s[^>]*id="([^"]+)"/g;
  let match: RegExpExecArray | null;
  let i = 0;
  while ((match = partIdRegex.exec(xmlText)) !== null) {
    if (i === bassPartIndex) {
      return match[1];
    }
    i += 1;
  }
  throw new Error(`Bass part index ${bassPartIndex} not found in XML.`);
}

/**
 * Inserts <figured-bass> elements into the original XML string without round-tripping
 * through an XML builder (preserving every byte of the original except for the insertions).
 */
function insertFiguredBass(
  xmlText: string,
  figures: FigureEvent[],
  bassPartIndex: number,
): string {
  // Build lookup: bass note anchorDiv -> ordered list of FigureEvents for that note
  const figureMap = new Map<number, FigureEvent[]>();
  for (const fe of figures) {
    if (!figureMap.has(fe.anchorDiv)) figureMap.set(fe.anchorDiv, []);
    figureMap.get(fe.anchorDiv)!.push(fe);
  }

  if (xmlText.includes("<figured-bass>")) {
    throw new Error(
      "Input file already contains <figured-bass> elements. " +
      "Please provide a clean MusicXML file without existing figured bass."
    );
  }

  const bassPartId = getBassPartId(xmlText, bassPartIndex);

  // Find the start of the bass <part> element's content
  const partOpenRegex = new RegExp(`<part\\s[^>]*id="${bassPartId}"[^>]*>`);
  const partMatch = partOpenRegex.exec(xmlText);
  if (!partMatch) throw new Error(`<part id="${bassPartId}"> not found.`);

  const partContentStart = partMatch.index + partMatch[0].length;
  const partContentEnd = xmlText.indexOf("</part>", partContentStart);
  if (partContentEnd === -1) throw new Error("Closing </part> not found.");

  // We'll collect (insertionOffset, xml_snippet, order) pairs, then apply back-to-front.
  // 'order' breaks ties at the same offset: higher order = inserted first (back-to-front
  // within the group), so order 0 ends up first in the file.
  const insertions: Array<{ offset: number; xml: string; order: number }> = [];

  // State machine: walk through the bass part content tracking cursor position
  let absoluteDiv = 0;
  let divisions = 1;
  let cursor = 0;
  let chordAnchor = 0;

  // We scan for <measure>, <attributes><divisions>, <note>, <chord/>, <rest/>,
  // <duration>, and <backup>/<forward> within the bass part's XML slice.
  const segment = xmlText.slice(partContentStart, partContentEnd);

  // Tokeniser: pull out top-level elements in sequence using a simple tag scanner
  const tagRe = /<(\/?)(\w[\w.-]*)([^>]*)>/g;
  let m: RegExpExecArray | null;

  // Track element nesting depth relative to the bass part root (depth 0 = direct children)
  // We care about: measure (depth 0), and within each measure the elements at depth 1
  let depth = 0;
  let inMeasure = false;
  let inNote = false;
  let inAttributes = false;
  let inDivisions = false;
  let inDuration = false;
  let inBackupForward = false; // inside <backup> or <forward>
  let currentNoteStart = 0; // position in `segment` of the opening <note> tag
  let noteIsChord = false;
  let noteIsRest = false;
  let noteDuration = 0;

  while ((m = tagRe.exec(segment)) !== null) {
    const isClose = m[1] === "/";
    const tagName = m[2].toLowerCase();
    const attrs = m[3];
    const tagEnd = m.index + m[0].length; // position after this tag

    if (isClose) {
      if (tagName === "measure") {
        inMeasure = false;
        absoluteDiv += cursor;
        cursor = 0;
        chordAnchor = 0;
        depth -= 1;
      } else if (tagName === "note") {
        inNote = false;
        // Advance cursor
        if (!noteIsChord) {
          chordAnchor = cursor;
        }
        if (!noteIsChord) {
          cursor += noteDuration;
        }
        inDuration = false;
      } else if (tagName === "attributes") {
        inAttributes = false;
        inDivisions = false;
      } else if (tagName === "backup" || tagName === "forward") {
        inBackupForward = false;
        inDuration = false;
      } else if (tagName === "duration") {
        inDuration = false;
      }
      continue;
    }

    // Self-closing tag: ends with "/>" - attrs includes the trailing /
    const isSelfClose = attrs.trimEnd().endsWith("/");

    if (!inMeasure && tagName === "measure") {
      inMeasure = true;
      depth += 1;
      continue;
    }

    if (inMeasure && !inNote && !inAttributes && !inBackupForward) {
      if (tagName === "note") {
        inNote = true;
        noteIsChord = false;
        noteIsRest = false;
        noteDuration = 0;
        currentNoteStart = m.index; // offset in segment
        continue;
      }
      if (tagName === "attributes") {
        inAttributes = true;
        continue;
      }
      if (tagName === "backup" || tagName === "forward") {
        inBackupForward = true;
        continue;
      }
    }

    if (inNote) {
      if (tagName === "chord" && (isSelfClose || attrs.includes("/"))) {
        noteIsChord = true;
      }
      if (tagName === "rest" && (isSelfClose || attrs.includes("/"))) {
        noteIsRest = true;
      }
      if (tagName === "duration") {
        inDuration = true;
      }
      if (tagName === "chord") noteIsChord = true;
      if (tagName === "rest") noteIsRest = true;
    }

    if (inAttributes && tagName === "divisions") {
      inDivisions = true;
    }
  }

  // Second pass: actually record insertion points for figured-bass
  // Reset state
  absoluteDiv = 0;
  divisions = 1;
  cursor = 0;
  chordAnchor = 0;
  inMeasure = false;
  inNote = false;
  inAttributes = false;
  inDivisions = false;
  inDuration = false;
  inBackupForward = false;
  noteIsChord = false;
  noteIsRest = false;
  noteDuration = 0;
  currentNoteStart = 0;
  tagRe.lastIndex = 0;

  // We also need to capture text content of <duration> and <divisions>
  // Strategy: scan through segment character by character between tags
  let lastTagEnd = 0;
  let pendingTextConsumer: "duration" | "divisions" | null = null;

  const re2 = /<(\/?)(\w[\w.-]*)([^>]*)>/g;
  let m2: RegExpExecArray | null;

  while ((m2 = re2.exec(segment)) !== null) {
    const isClose = m2[1] === "/";
    const tagName = m2[2].toLowerCase();
    const attrs = m2[3];
    const tagPos = m2.index;
    const tagEnd2 = m2.index + m2[0].length;
    const isSelfClose = attrs.trimEnd().endsWith("/");

    // If we were waiting for text content, grab it from between last tag end and this tag
    if (pendingTextConsumer !== null && isClose) {
      const text = segment.slice(lastTagEnd, tagPos).trim();
      const val = Number(text);
      if (pendingTextConsumer === "divisions" && val > 0) {
        divisions = val;
      }
      if (pendingTextConsumer === "duration") {
        if (inNote) {
          noteDuration = val;
        }
        // backup/forward: adjust cursor
        if (inBackupForward) {
          if (tagName === "duration") {
            // We'll handle backup/forward cursor adjustment at </backup> or </forward>
            noteDuration = val; // reuse for backup amount
          }
        }
      }
      pendingTextConsumer = null;
    }

    lastTagEnd = tagEnd2;

    if (isClose) {
      if (tagName === "measure") {
        inMeasure = false;
        absoluteDiv += cursor;
        cursor = 0;
        chordAnchor = 0;
      } else if (tagName === "note") {
        // Before closing note, we already captured duration etc.
        // Advance cursor
        if (!noteIsChord) {
          chordAnchor = cursor;
          cursor += noteDuration;
        }
        inNote = false;
        noteIsChord = false;
        noteIsRest = false;
        noteDuration = 0;
      } else if (tagName === "attributes") {
        inAttributes = false;
      } else if (tagName === "backup") {
        cursor -= noteDuration;
        inBackupForward = false;
        noteDuration = 0;
      } else if (tagName === "forward") {
        cursor += noteDuration;
        inBackupForward = false;
        noteDuration = 0;
      }
      continue;
    }

    if (!inMeasure && tagName === "measure") {
      inMeasure = true;
      continue;
    }

    if (inMeasure && !inNote && !inAttributes && !inBackupForward) {
      if (tagName === "note") {
        inNote = true;
        noteIsChord = false;
        noteIsRest = false;
        noteDuration = 0;
        currentNoteStart = tagPos;
        continue;
      }
      if (tagName === "attributes") {
        inAttributes = true;
        continue;
      }
      if (tagName === "backup" || tagName === "forward") {
        inBackupForward = true;
        noteDuration = 0;
        continue;
      }
    }

    if (inNote) {
      if (tagName === "chord") noteIsChord = true;
      if (tagName === "rest") noteIsRest = true;
      if (tagName === "duration" && !isSelfClose) {
        pendingTextConsumer = "duration";
      }
    }

    if (inAttributes && tagName === "divisions" && !isSelfClose) {
      pendingTextConsumer = "divisions";
    }

    if (inBackupForward && tagName === "duration" && !isSelfClose) {
      pendingTextConsumer = "duration";
    }

    // When we finish reading a note's opening tag (the <note> itself is where we
    // decide to insert), we do the insertion check when the note fully starts.
    // We check at the START of <note> for non-chord, non-rest notes.
    if (inNote && tagName === "note") {
      // Already recorded currentNoteStart above; will check after we know chord/rest
      // Actually let's defer: after inNote is set, check on the NEXT non-chord note open.
      // We handle this below after we know all attributes of the note.
    }
  }

  // Third pass: record actual insertion offsets
  // Reset everything again — this time we emit insertion records
  absoluteDiv = 0;
  divisions = 1;
  cursor = 0;
  chordAnchor = 0;
  inMeasure = false;
  inNote = false;
  inAttributes = false;
  inBackupForward = false;
  noteIsChord = false;
  noteIsRest = false;
  noteDuration = 0;
  currentNoteStart = 0;
  lastTagEnd = 0;
  pendingTextConsumer = null;

  const re3 = /<(\/?)(\w[\w.-]*)([^>]*)>/g;
  let m3: RegExpExecArray | null;

  // Collect completed note info: {insertOffset, absoluteStart, isChord, isRest, duration}
  type PendingNote = {
    insertOffset: number; // in `segment`
    absoluteStart: number;
    isChord: boolean;
    isRest: boolean;
  };
  let pendingNote: PendingNote | null = null;

  while ((m3 = re3.exec(segment)) !== null) {
    const isClose = m3[1] === "/";
    const tagName = m3[2].toLowerCase();
    const attrs = m3[3];
    const tagPos = m3.index;
    const tagEnd3 = m3.index + m3[0].length;
    const isSelfClose = attrs.trimEnd().endsWith("/");

    // Capture text between tags for duration/divisions
    if (pendingTextConsumer !== null && isClose) {
      const text = segment.slice(lastTagEnd, tagPos).trim();
      const val = Number(text);
      if (pendingTextConsumer === "divisions" && val > 0) {
        divisions = val;
      }
      if (pendingTextConsumer === "duration") {
        if (inNote) noteDuration = val;
        if (inBackupForward) noteDuration = val;
      }
      pendingTextConsumer = null;
    }

    lastTagEnd = tagEnd3;

    if (isClose) {
      if (tagName === "measure") {
        inMeasure = false;
        absoluteDiv += cursor;
        cursor = 0;
        chordAnchor = 0;
      } else if (tagName === "note") {
        if (pendingNote) {
          pendingNote.isChord = noteIsChord;
          pendingNote.isRest = noteIsRest;

          if (!noteIsChord && !noteIsRest) {
            const feList = figureMap.get(pendingNote.absoluteStart);
            if (feList) {
              const lineStart = segment.lastIndexOf("\n", pendingNote.insertOffset) + 1;
              const indent = segment.slice(lineStart, pendingNote.insertOffset).match(/^(\s*)/)?.[1] ?? "      ";
              feList
                .filter(fe => fe.figures !== "")
                .forEach((fe, idx) => {
                  insertions.push({
                    offset: partContentStart + lineStart,
                    xml: buildFiguredBassXml(fe.figures, fe.durationDiv, indent),
                    order: idx,
                  });
                });
              figureMap.delete(pendingNote.absoluteStart);
            }
          }

          if (!noteIsChord) {
            chordAnchor = cursor;
            cursor += noteDuration;
          }
          pendingNote = null;
        }
        inNote = false;
        noteIsChord = false;
        noteIsRest = false;
        noteDuration = 0;
      } else if (tagName === "attributes") {
        inAttributes = false;
      } else if (tagName === "backup") {
        cursor -= noteDuration;
        inBackupForward = false;
        noteDuration = 0;
      } else if (tagName === "forward") {
        cursor += noteDuration;
        inBackupForward = false;
        noteDuration = 0;
      }
      continue;
    }

    if (!inMeasure && tagName === "measure") {
      inMeasure = true;
      continue;
    }

    if (inMeasure && !inNote && !inAttributes && !inBackupForward) {
      if (tagName === "note") {
        inNote = true;
        noteIsChord = false;
        noteIsRest = false;
        noteDuration = 0;
        const localStart = cursor; // tentative; chord adjusts later
        pendingNote = {
          insertOffset: tagPos,
          absoluteStart: absoluteDiv + localStart,
          isChord: false,
          isRest: false,
        };
        continue;
      }
      if (tagName === "attributes") { inAttributes = true; continue; }
      if (tagName === "backup" || tagName === "forward") { inBackupForward = true; noteDuration = 0; continue; }
    }

    if (inNote) {
      if (tagName === "chord") {
        noteIsChord = true;
        if (pendingNote) {
          pendingNote.absoluteStart = absoluteDiv + chordAnchor;
        }
      }
      if (tagName === "rest") noteIsRest = true;
      if (tagName === "duration" && !isSelfClose) pendingTextConsumer = "duration";
    }

    if (inAttributes && tagName === "divisions" && !isSelfClose) pendingTextConsumer = "divisions";
    if (inBackupForward && tagName === "duration" && !isSelfClose) pendingTextConsumer = "duration";
  }

  // Apply insertions back-to-front so offsets stay valid.
  // Ties at same offset: sort by order descending so order=0 is inserted last
  // (and therefore ends up first in the output).
  insertions.sort((a, b) => b.offset - a.offset || b.order - a.order);
  let result = xmlText;
  for (const ins of insertions) {
    result = result.slice(0, ins.offset) + ins.xml + result.slice(ins.offset);
  }
  return result;
}

function main() {
  const { input, out } = parseArgs(process.argv);

  const xmlText = fs.readFileSync(input, "utf8");
  const score = parseScore(xmlText);
  const parts = asArray(score.part);

  if (parts.length < 2) {
    throw new Error("Need at least two parts (bass + harmony) to infer figures.");
  }

  const allEvents = parts.map((part) => extractPartEvents(part));
  const bassPartIndex = findBassPartIndex(allEvents);
  const divisions = extractDivisions(score); // ticks per quarter note
  const figures = inferFigures(allEvents, divisions); // minimum segment = 1 quarter note

  const outputXml = insertFiguredBass(xmlText, figures, bassPartIndex);
  fs.writeFileSync(out, outputXml, "utf8");

  console.log(`Input:  ${input}`);
  console.log(`Output: ${out}`);
  console.log(`Figure events:    ${figures.length}`);
  console.log(`Non-trivial figures: ${figures.filter((f) => f.figures !== "").length}`);
}

main();
