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
  step: Step;
  alter: number;
  stepIndex: number;
  degreeAbs: number;
  keyFifths: number;
  measure: number;
  beat: number;
};

type FigureAccidental = "double-flat" | "flat" | "natural" | "sharp" | "double-sharp";

type FigureSlot = {
  number?: number;        // omitted for a bare accidental (refers to the 3rd by convention)
  prefix?: FigureAccidental;
};

type FigureEvent = {
  anchorDiv: number;  // bass note start — used as insertion key
  measure: number;
  beat: number;
  startDiv: number;   // actual segment start (may differ from anchorDiv mid-note)
  durationDiv: number;
  bassMidi: number;
  slots: FigureSlot[];   // structured figure data for MusicXML output
  figures: string;       // human-readable string for console/debug
  rawIntervals: string;
};

type ExistingFigureEvent = {
  anchorDiv: number;
  measure: number;
  slots: FigureSlot[];
  durationDiv: number;
  figures: string;
};

type FigureChange = {
  measure: number;
  reason: string;
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

const STEPS_IN_ORDER: Step[] = ["C", "D", "E", "F", "G", "A", "B"];
const SHARPS_ORDER: Step[] = ["F", "C", "G", "D", "A", "E", "B"];
const FLATS_ORDER: Step[] = ["B", "E", "A", "D", "G", "C", "F"];

/** Chromatic alteration the key signature expects for a given step letter. */
function expectedAlterForStep(step: Step, fifths: number): number {
  if (fifths > 0) return SHARPS_ORDER.slice(0, fifths).includes(step) ? 1 : 0;
  if (fifths < 0) return FLATS_ORDER.slice(0, -fifths).includes(step) ? -1 : 0;
  return 0;
}

/** The step letter that is N diatonic steps above a given bass step (N=1 is the unison). */
function diatonicStepAbove(bassStep: Step, n: number): Step {
  const idx = STEPS_IN_ORDER.indexOf(bassStep);
  return STEPS_IN_ORDER[(idx + n - 1) % 7];
}

/** Map a chromatic deviation from the key to a MusicXML figured-bass accidental name. */
function toFigAccidental(
  acc: number,
  expectedAlt: number,
): FigureAccidental | undefined {
  if (acc === 0) return undefined; // in key
  if (acc > 0 && expectedAlt < 0) return "natural"; // cancelling a flat
  if (acc < 0 && expectedAlt > 0) return "natural"; // cancelling a sharp
  if (acc === 1) return "sharp";
  if (acc === -1) return "flat";
  if (acc === 2) return "double-sharp";
  if (acc === -2) return "double-flat";
  return undefined;
}

type IntervalData = { n: number; acc: number; expectedAlt: number };

function toIntervalData(bass: NoteEvent, upper: NoteEvent): IntervalData {
  let n = upper.degreeAbs - bass.degreeAbs + 1;
  while (n > 9) n -= 7;
  while (n < 2) n += 7;
  const expectedStep = diatonicStepAbove(bass.step, n);
  const expectedAlt = expectedAlterForStep(expectedStep, upper.keyFifths);
  const acc = upper.alter - expectedAlt;
  return { n, acc, expectedAlt };
}

function slotsToString(slots: FigureSlot[]): string {
  return slots
    .map((s) => {
      const acc = s.prefix
        ? { sharp: "#", flat: "b", natural: "n", "double-sharp": "##", "double-flat": "bb" }[s.prefix]
        : "";
      return s.number !== undefined ? `${acc}${s.number}` : acc;
    })
    .join("/");
}

// forceShowThird: when true, show "3" (with any accidental) for root-position chords
// rather than leaving them unfigured. Used for 4→3 suspension resolutions.
function simplifyFigures(
  intervals: IntervalData[],
  forceShowThird = false,
): FigureSlot[] {
  // De-duplicate by interval number (keep first occurrence), drop octave/unison
  const seen = new Set<number>();
  const nums: IntervalData[] = [];
  for (const iv of intervals) {
    if (iv.n === 8 || iv.n === 1) continue;
    if (!seen.has(iv.n)) { seen.add(iv.n); nums.push(iv); }
  }
  nums.sort((a, b) => a.n - b.n);

  if (nums.length === 0) return [];

  const get = (n: number) => nums.find((i) => i.n === n);
  const has = (n: number) => !!get(n);

  const slot = (n: number): FigureSlot => {
    const item = get(n)!;
    const prefix = toFigAccidental(item.acc, item.expectedAlt);
    return prefix ? { number: n, prefix } : { number: n };
  };

  // Returns a slot only if the interval is chromatically altered from the key.
  // Used to surface altered implied intervals.
  const alteredSlot = (n: number): FigureSlot | null => {
    const item = get(n);
    if (!item) return null;
    const prefix = toFigAccidental(item.acc, item.expectedAlt);
    return prefix ? { number: n, prefix } : null;
  };

  // --- Root-position triad (only 3 and/or 5 present) ---
  if (nums.every((i) => i.n === 3 || i.n === 5)) {
    if (forceShowThird && has(3)) {
      const s = slot(3);
      const alt5 = alteredSlot(5);
      return alt5 ? [alt5, s] : [s];
    }
    // Blank — but surface any chromatic alterations
    const result: FigureSlot[] = [];
    const alt5 = alteredSlot(5);
    const alt3 = alteredSlot(3);
    if (alt5) result.push(alt5);
    if (alt3) result.push(alt3);
    return result;
  }

  // --- Seventh chords (root position: 3+5+7 → "7") ---
  if (has(7)) {
    const s7 = slot(7);
    const alt3 = alteredSlot(3);
    const alt5 = alteredSlot(5);
    if (has(3) && has(5)) {
      // Full 7th chord → "7" (surface altered 3rd/5th)
      const r: FigureSlot[] = [s7];
      if (alt5) r.push(alt5);
      if (alt3) r.push(alt3);
      return r;
    }
    if (has(3) && !has(5)) return alt3 ? [s7, alt3] : [s7, { number: 3 }];
    if (has(5) && !has(3)) return alt5 ? [s7, alt5] : [s7, { number: 5 }];
    return [s7];
  }

  // --- 9th / 9-8 suspension (9 sounding without a 3rd → suspended) ---
  if (has(9)) {
    const s9 = slot(9);
    if (!has(3) && has(5)) return [s9, slot(5)];
    return [s9];
  }

  // --- First inversion triad (3+6, no 4/5/2) ---
  if (has(6) && has(3) && !has(4) && !has(5) && !has(2)) {
    const s6 = slot(6);
    const alt3 = alteredSlot(3);
    return alt3 ? [s6, alt3] : [s6];
  }

  // --- Second inversion triad (4+6, no 3/5/2) — always write both ---
  if (has(6) && has(4) && !has(3) && !has(5) && !has(2)) {
    return [slot(6), slot(4)];
  }

  // --- 4-3 suspension (4th without 6th) ---
  if (has(4) && !has(6) && !has(3)) return [slot(4)];

  // --- First inversion seventh: 6/5/3 → "6/5" (3 implied) ---
  if (has(6) && has(5)) {
    const r = [slot(6), slot(5)];
    const alt3 = alteredSlot(3);
    if (alt3) r.push(alt3);
    return r;
  }

  // --- Second inversion seventh: 6/4/3 → "4/3" (6 implied) ---
  if (has(4) && has(3)) {
    const r = [slot(4), slot(3)];
    const alt6 = alteredSlot(6);
    if (alt6) r.unshift(alt6);
    return r;
  }

  // --- Third inversion seventh: 6/4/2 → "4/2" or "2" ---
  if (has(2) && has(4)) return [slot(4), slot(2)];
  if (has(2)) return [slot(2)];

  // --- Fallback: write all non-implied intervals highest first ---
  const toWrite = nums.filter((i) => i.n !== 3 && i.n !== 5);
  const source = toWrite.length > 0 ? toWrite : nums;
  return source.sort((a, b) => b.n - a.n).map((i) => slot(i.n));
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
  let keyFifths = 0;

  for (let m = 0; m < measures.length; m += 1) {
    const measure = measures[m];
    divisions = readDivisions(measure, divisions);

    // Track key signature changes
    const fifthsVal = measure.attributes?.key?.fifths;
    if (typeof fifthsVal === "number") {
      keyFifths = fifthsVal;
    }

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
            step,
            alter,
            stepIndex,
            degreeAbs,
            keyFifths,
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
    const changePoints = new Set<number>([bass.start]);
    for (const part of upperParts) {
      for (const n of part) {
        if (n.start > bass.start && n.start < bass.end) {
          changePoints.add(n.start);
        }
      }
    }

    const allPoints = [...changePoints].sort((a, b) => a - b);
    const sortedPoints: number[] = [allPoints[0]];
    for (let i = 1; i < allPoints.length; i++) {
      if (allPoints[i] - sortedPoints[sortedPoints.length - 1] >= minDurationDiv) {
        sortedPoints.push(allPoints[i]);
      }
    }

    type Seg = { startDiv: number; durationDiv: number; slots: FigureSlot[]; figures: string; rawIntervals: string };
    const segs: Seg[] = [];
    let prevFigures: string | null = null;

    for (let i = 0; i < sortedPoints.length; i++) {
      const segStart = sortedPoints[i];
      const segEnd = i + 1 < sortedPoints.length ? sortedPoints[i + 1] : bass.end;
      const segDuration = segEnd - segStart;
      const isAtAttack = segStart === bass.start;

      const intervals: IntervalData[] = [];
      for (const part of upperParts) {
        for (const n of part) {
          if (n.start <= segStart && n.end > segStart && n.midi > bass.midi) {
            intervals.push(toIntervalData(bass, n));
          }
        }
      }

      const rawIntervals = [...new Set(intervals.map((i) => i.n))].sort((a, b) => a - b).join("/");
      const prevHadFourth = prevFigures !== null && /\b4\b/.test(prevFigures);
      const isResolution = !isAtAttack && prevHadFourth;
      const slots = simplifyFigures(intervals, isResolution);
      const figures = slotsToString(slots);

      if (figures === prevFigures) {
        if (segs.length > 0) segs[segs.length - 1].durationDiv += segDuration;
      } else {
        segs.push({ startDiv: segStart, durationDiv: segDuration, slots, figures, rawIntervals });
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
        slots: seg.slots,
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

function buildFiguredBassXml(slots: FigureSlot[], durationDiv: number, indent: string): string {
  const figureLines = slots
    .map((slot) => {
      const lines: string[] = [`${indent}  <figure>`];
      if (slot.prefix) lines.push(`${indent}    <prefix>${slot.prefix}</prefix>`);
      if (slot.number !== undefined)
        lines.push(`${indent}    <figure-number>${slot.number}</figure-number>`);
      lines.push(`${indent}  </figure>`);
      return lines.join("\n");
    })
    .join("\n");

  return `${indent}<figured-bass>\n${figureLines}\n${indent}  <duration>${durationDiv}</duration>\n${indent}</figured-bass>\n`;
}

function parseFigureSlots(figuredBassXml: string): { slots: FigureSlot[]; durationDiv: number } {
  const slots: FigureSlot[] = [];
  const figureRe = /<figure\b[^>]*>([\s\S]*?)<\/figure>/g;
  let m: RegExpExecArray | null;
  while ((m = figureRe.exec(figuredBassXml)) !== null) {
    const body = m[1];
    const prefixMatch = body.match(/<prefix>([^<]+)<\/prefix>/);
    const numberMatch = body.match(/<figure-number>([^<]+)<\/figure-number>/);
    const prefixText = (prefixMatch?.[1] ?? "").trim();
    const numberText = (numberMatch?.[1] ?? "").trim();

    const slot: FigureSlot = {};
    if (
      prefixText === "double-flat" ||
      prefixText === "flat" ||
      prefixText === "natural" ||
      prefixText === "sharp" ||
      prefixText === "double-sharp"
    ) {
      slot.prefix = prefixText;
    }
    if (numberText.length > 0) {
      const n = Number(numberText);
      if (Number.isFinite(n) && n > 0) slot.number = n;
    }
    slots.push(slot);
  }

  const durationMatch = figuredBassXml.match(/<duration>([^<]+)<\/duration>/);
  const durationDiv = Number((durationMatch?.[1] ?? "").trim());
  return { slots, durationDiv: Number.isFinite(durationDiv) && durationDiv > 0 ? durationDiv : 0 };
}

/**
 * Extracts existing figured-bass blocks in the bass part, maps them to bass-note anchors,
 * and returns XML with those blocks removed.
 */
function collectAndStripExistingFiguredBass(
  xmlText: string,
  bassPartIndex: number,
): { existing: ExistingFigureEvent[]; strippedXml: string } {
  const bassPartId = getBassPartId(xmlText, bassPartIndex);
  const partOpenRegex = new RegExp(`<part\\s[^>]*id="${bassPartId}"[^>]*>`);
  const partMatch = partOpenRegex.exec(xmlText);
  if (!partMatch) throw new Error(`<part id="${bassPartId}"> not found.`);

  const partContentStart = partMatch.index + partMatch[0].length;
  const partContentEnd = xmlText.indexOf("</part>", partContentStart);
  if (partContentEnd === -1) throw new Error("Closing </part> not found.");

  const segment = xmlText.slice(partContentStart, partContentEnd);
  const tagRe = /<(\/?)(\w[\w.-]*)([^>]*)>/g;

  type PendingExisting = {
    measure: number;
    slots: FigureSlot[];
    durationDiv: number;
    figures: string;
  };

  const existing: ExistingFigureEvent[] = [];
  const removalRanges: Array<{ start: number; end: number }> = [];
  const pendingFigureBlocks: PendingExisting[] = [];

  let absoluteDiv = 0;
  let cursor = 0;
  let chordAnchor = 0;
  let measureNumber = 0;

  let inMeasure = false;
  let inNote = false;
  let inAttributes = false;
  let inBackupForward = false;
  let noteIsChord = false;
  let noteIsRest = false;
  let noteDuration = 0;

  let pendingTextConsumer: "duration" | "divisions" | null = null;
  let lastTagEnd = 0;

  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(segment)) !== null) {
    const isClose = m[1] === "/";
    const tagName = m[2].toLowerCase();
    const attrs = m[3];
    const tagPos = m.index;
    const tagEnd = m.index + m[0].length;
    const isSelfClose = attrs.trimEnd().endsWith("/");

    if (pendingTextConsumer !== null && isClose) {
      const text = segment.slice(lastTagEnd, tagPos).trim();
      const val = Number(text);
      if (pendingTextConsumer === "duration") {
        if (inNote || inBackupForward) noteDuration = val;
      }
      pendingTextConsumer = null;
    }
    lastTagEnd = tagEnd;

    if (isClose) {
      if (tagName === "measure") {
        inMeasure = false;
        absoluteDiv += cursor;
        cursor = 0;
        chordAnchor = 0;
        pendingFigureBlocks.length = 0;
      } else if (tagName === "note") {
        if (!noteIsChord && !noteIsRest) {
          const anchorDiv = absoluteDiv + cursor;
          for (const fb of pendingFigureBlocks) {
            existing.push({
              anchorDiv,
              measure: fb.measure,
              slots: fb.slots,
              durationDiv: fb.durationDiv,
              figures: fb.figures,
            });
          }
          pendingFigureBlocks.length = 0;
        }

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
      const nMatch = attrs.match(/\bnumber="([^"]+)"/);
      const n = Number(nMatch?.[1] ?? "");
      measureNumber = Number.isFinite(n) ? n : measureNumber + 1;
      continue;
    }

    if (inMeasure && !inNote && !inAttributes && !inBackupForward && tagName === "figured-bass") {
      const closeIdx = segment.indexOf("</figured-bass>", tagEnd);
      if (closeIdx !== -1) {
        const end = closeIdx + "</figured-bass>".length;
        const raw = segment.slice(tagPos, end);
        const parsed = parseFigureSlots(raw);
        pendingFigureBlocks.push({
          measure: measureNumber,
          slots: parsed.slots,
          durationDiv: parsed.durationDiv,
          figures: slotsToString(parsed.slots),
        });
        removalRanges.push({
          start: partContentStart + tagPos,
          end: partContentStart + end,
        });
        tagRe.lastIndex = end;
        lastTagEnd = end;
      }
      continue;
    }

    if (inMeasure && !inNote && !inAttributes && !inBackupForward) {
      if (tagName === "note") {
        inNote = true;
        noteIsChord = false;
        noteIsRest = false;
        noteDuration = 0;
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
      if (tagName === "duration" && !isSelfClose) pendingTextConsumer = "duration";
      if (tagName === "chord" && noteIsChord) {
        // Keep anchor at chordAnchor for chord tones
        void chordAnchor;
      }
    }

    if (inBackupForward && tagName === "duration" && !isSelfClose) {
      pendingTextConsumer = "duration";
    }
  }

  // Remove existing figured-bass blocks back-to-front
  removalRanges.sort((a, b) => b.start - a.start);
  let strippedXml = xmlText;
  for (const r of removalRanges) {
    strippedXml = strippedXml.slice(0, r.start) + strippedXml.slice(r.end);
  }

  return { existing, strippedXml };
}

function slotSig(slot: FigureSlot): string {
  const p = slot.prefix ?? "";
  const n = slot.number !== undefined ? String(slot.number) : "";
  return `${p}:${n}`;
}

function eventSig(slots: FigureSlot[], durationDiv: number): string {
  return `${slots.map(slotSig).join("|")}@${durationDiv}`;
}

function buildFigureChangeReport(
  inferred: FigureEvent[],
  existing: ExistingFigureEvent[],
): FigureChange[] {
  const inferredMap = new Map<number, FigureEvent[]>();
  const existingMap = new Map<number, ExistingFigureEvent[]>();

  for (const fe of inferred) {
    if (fe.slots.length === 0) continue;
    if (!inferredMap.has(fe.anchorDiv)) inferredMap.set(fe.anchorDiv, []);
    inferredMap.get(fe.anchorDiv)!.push(fe);
  }
  for (const ex of existing) {
    if (ex.slots.length === 0) continue;
    if (!existingMap.has(ex.anchorDiv)) existingMap.set(ex.anchorDiv, []);
    existingMap.get(ex.anchorDiv)!.push(ex);
  }

  const allAnchors = new Set<number>([
    ...inferredMap.keys(),
    ...existingMap.keys(),
  ]);

  const changes: FigureChange[] = [];

  for (const anchor of [...allAnchors].sort((a, b) => a - b)) {
    const inf = inferredMap.get(anchor) ?? [];
    const ex = existingMap.get(anchor) ?? [];

    const measure = inf[0]?.measure ?? ex[0]?.measure ?? 0;
    const infSig = inf.map((f) => eventSig(f.slots, f.durationDiv));
    const exSig = ex.map((f) => eventSig(f.slots, f.durationDiv));

    if (infSig.length === 0 && exSig.length > 0) {
      changes.push({ measure, reason: `removed outdated figures (${ex.map((f) => f.figures).join(", ")})` });
      continue;
    }
    if (infSig.length > 0 && exSig.length === 0) {
      changes.push({ measure, reason: `added missing figures (${inf.map((f) => f.figures).join(", ")})` });
      continue;
    }
    if (infSig.join(";") !== exSig.join(";")) {
      changes.push({
        measure,
        reason: `updated figures from [${ex.map((f) => f.figures).join(", ")}] to [${inf.map((f) => f.figures).join(", ")}]`,
      });
    }
  }

  return changes;
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
  allowExisting = false,
): string {
  // Build lookup: bass note anchorDiv -> ordered list of FigureEvents for that note
  const figureMap = new Map<number, FigureEvent[]>();
  for (const fe of figures) {
    if (!figureMap.has(fe.anchorDiv)) figureMap.set(fe.anchorDiv, []);
    figureMap.get(fe.anchorDiv)!.push(fe);
  }

  if (!allowExisting && xmlText.includes("<figured-bass>")) {
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
                .filter(fe => fe.slots.length > 0)
                .forEach((fe, idx) => {
                  insertions.push({
                    offset: partContentStart + lineStart,
                    xml: buildFiguredBassXml(fe.slots, fe.durationDiv, indent),
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

  const hasExistingFiguredBass = xmlText.includes("<figured-bass>");
  let existing: ExistingFigureEvent[] = [];
  let sourceXmlForInsert = xmlText;
  let changes: FigureChange[] = [];

  if (hasExistingFiguredBass) {
    const reviewed = collectAndStripExistingFiguredBass(xmlText, bassPartIndex);
    existing = reviewed.existing;
    sourceXmlForInsert = reviewed.strippedXml;
    changes = buildFigureChangeReport(figures, existing);
  }

  const outputXml = insertFiguredBass(sourceXmlForInsert, figures, bassPartIndex, true);
  fs.writeFileSync(out, outputXml, "utf8");

  console.log(`Input:  ${input}`);
  console.log(`Output: ${out}`);
  console.log(`Figure events:    ${figures.length}`);
  console.log(`Non-trivial figures: ${figures.filter((f) => f.slots.length > 0).length}`);
  if (hasExistingFiguredBass) {
    console.log(`Existing figured-bass entries reviewed: ${existing.length}`);
    if (changes.length === 0) {
      console.log("Verification: existing figured bass matched inferred analysis (no updates needed).");
    } else {
      console.log("Verification: updated figured bass at:");
      for (const change of changes) {
        console.log(`  Measure ${change.measure}: ${change.reason}`);
      }
    }
  }
}

main();
