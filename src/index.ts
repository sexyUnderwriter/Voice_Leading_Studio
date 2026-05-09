import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
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
  tieStart: boolean;
  tieStop: boolean;
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
    throw new Error(
      "Usage: npm run start -- <input.musicxml> [--out output.musicxml] [--bass-part-id P4] [--analyze] [--analyze-only] [--analyze-out report.txt] [--pdf] [--pdf-out output.pdf] [--pdf-cmd command]",
    );
  }

  let input = "";
  let out = "";
  let bassPartId = "";
  let analyze = false;
  let analyzeOnly = false;
  let analyzeOut = "";
  let exportPdf = false;
  let pdfOut = "";
  let pdfCmd = "";

  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (token === "--out") {
      out = args[i + 1] ?? "";
      i += 1;
      continue;
    }
    if (token === "--bass-part-id") {
      bassPartId = args[i + 1] ?? "";
      i += 1;
      continue;
    }
    if (token === "--analyze" || token === "--analyze-only") {
      analyze = true;
      if (token === "--analyze-only") analyzeOnly = true;
      continue;
    }
    if (token === "--analyze-out") {
      analyzeOut = args[i + 1] ?? "";
      analyze = true;
      i += 1;
      continue;
    }
    if (token === "--pdf") {
      exportPdf = true;
      continue;
    }
    if (token === "--pdf-out") {
      pdfOut = args[i + 1] ?? "";
      exportPdf = true;
      i += 1;
      continue;
    }
    if (token === "--pdf-cmd") {
      pdfCmd = args[i + 1] ?? "";
      exportPdf = true;
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

  if (exportPdf && !pdfOut) {
    const parsed = path.parse(out);
    pdfOut = path.join(parsed.dir, `${parsed.name}.pdf`);
  }

  if (analyzeOnly && exportPdf) {
    throw new Error("--pdf cannot be used with --analyze-only because no score output file is written.");
  }

  return { input, out, bassPartId, analyze, analyzeOnly, analyzeOut, exportPdf, pdfOut, pdfCmd };
}

function pickPdfCommand(explicitCmd: string): string {
  const candidates = explicitCmd
    ? [explicitCmd]
    : [
        process.env.PDF_RENDER_CMD ?? "",
      ].filter((s) => s.length > 0);

  for (const cmd of candidates) {
    const test = spawnSync(cmd, ["--version"], { encoding: "utf8" });
    if (!test.error) return cmd;
  }

  throw new Error(
    "No custom PDF renderer command found. Pass --pdf-cmd <command> or set PDF_RENDER_CMD.",
  );
}

function exportMusicXmlToPdf(xmlPath: string, pdfPath: string, explicitCmd: string) {
  if (explicitCmd || process.env.PDF_RENDER_CMD) {
    const cmd = pickPdfCommand(explicitCmd);
    const result = spawnSync(cmd, [xmlPath, "-o", pdfPath], { encoding: "utf8" });
    if (result.error || result.status !== 0) {
      const stderr = (result.stderr ?? "").trim();
      const stdout = (result.stdout ?? "").trim();
      const detail = stderr || stdout || result.error?.message || "unknown error";
      throw new Error(`PDF export failed via '${cmd}': ${detail}`);
    }
    return;
  }

  // Default renderer: headless LilyPond pipeline.
  const outNoExt = pdfPath.replace(/\.pdf$/i, "");
  const lyPath = `${outNoExt}.ly`;

  const musicxml2ly = spawnSync("musicxml2ly", [xmlPath, "-o", lyPath], { encoding: "utf8" });
  if (musicxml2ly.error || musicxml2ly.status !== 0) {
    const stderr = (musicxml2ly.stderr ?? "").trim();
    const stdout = (musicxml2ly.stdout ?? "").trim();
    const detail = stderr || stdout || musicxml2ly.error?.message || "unknown error";
    throw new Error(`PDF export failed at musicxml2ly step: ${detail}`);
  }

  const lilypond = spawnSync("lilypond", ["-o", outNoExt, lyPath], { encoding: "utf8" });
  if (lilypond.error || lilypond.status !== 0) {
    const stderr = (lilypond.stderr ?? "").trim();
    const stdout = (lilypond.stdout ?? "").trim();
    const detail = stderr || stdout || lilypond.error?.message || "unknown error";
    throw new Error(`PDF export failed at lilypond step: ${detail}`);
  }

  if (fs.existsSync(lyPath)) {
    fs.unlinkSync(lyPath);
  }
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

/**
 * Normalizes incoming MusicXML text by stripping BOM and any non-tag bytes
 * that appear before the first '<'. Some exports include stray leading chars.
 */
function normalizeXmlText(xmlText: string): string {
  const withoutBom = xmlText.replace(/^\uFEFF/, "");
  const firstTag = withoutBom.indexOf("<");
  if (firstTag <= 0) return withoutBom;
  return withoutBom.slice(firstTag);
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

function sumDurations(items: any[]): number {
  return items.reduce((sum, item) => {
    const d = Number(item?.duration ?? 0);
    return Number.isFinite(d) ? sum + d : sum;
  }, 0);
}

function extractPartEvents(part: any): NoteEvent[] {
  const measures = asArray(part.measure);
  const events: NoteEvent[] = [];

  let absoluteDiv = 0;
  let divisions = 1;
  let keyFifths = 0;
  let transposeChromatic = 0;
  let transposeDiatonic = 0;
  let transposeOctave = 0;

  for (let m = 0; m < measures.length; m += 1) {
    const measure = measures[m];
    divisions = readDivisions(measure, divisions);

    // Track key signature changes
    const fifthsVal = measure.attributes?.key?.fifths;
    if (typeof fifthsVal === "number") {
      keyFifths = fifthsVal;
    }

    // Track transposition changes so analysis can use sounding pitch.
    const t = measure.attributes?.transpose;
    if (t) {
      transposeChromatic = Number(t.chromatic ?? 0);
      transposeDiatonic = Number(t.diatonic ?? 0);
      transposeOctave = Number(t["octave-change"] ?? 0);
    }

    const notes = asArray(measure.note);
    const forwardTotal = sumDurations(asArray(measure.forward));
    const backupTotal = sumDurations(asArray(measure.backup));

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
        const ties = asArray(note.tie);
        const tieStart = ties.some((t: any) => String(t?.["@_type"] ?? "") === "start");
        const tieStop = ties.some((t: any) => String(t?.["@_type"] ?? "") === "stop");

        if (Number.isFinite(octave) && STEP_TO_INDEX[step] !== undefined) {
          const pitch: Pitch = { step, alter, octave };
          const midi = pitchToMidi(pitch) + transposeChromatic + transposeOctave * 12;
          const stepIndex = STEP_TO_INDEX[step];
          const degreeAbs = octave * 7 + stepIndex + transposeDiatonic + transposeOctave * 7;

          const parsedMeasure = Number(measure["@_number"] ?? "");
          events.push({
            start: absoluteDiv + localStart,
            end: absoluteDiv + localStart + duration,
            midi,
            step,
            alter,
            stepIndex,
            degreeAbs,
            keyFifths,
            measure: Number.isFinite(parsedMeasure) ? parsedMeasure : m + 1,
            beat: localStart / divisions + 1,
            tieStart,
            tieStop,
          });
        }
      }

      if (!isChord) {
        cursor += duration;
      }
    }

    // MusicXML may use forward/backup for timeline placement (including
    // measures with rests encoded as forward-only). Apply net movement so
    // absolute time stays aligned across parts.
    cursor += forwardTotal - backupTotal;
    if (cursor < 0) cursor = 0;

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

function stripAllFiguredBass(xmlText: string): { strippedXml: string; removedCount: number } {
  const pattern = /\s*<figured-bass\b[\s\S]*?<\/figured-bass>\s*/g;
  const matches = xmlText.match(pattern);
  const removedCount = matches ? matches.length : 0;
  const strippedXml = xmlText.replace(pattern, "\n");
  return { strippedXml, removedCount };
}

function buildFigureChangeReport(
  inferred: FigureEvent[],
  existing: ExistingFigureEvent[],
  includeAdditions = true,
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
    if (includeAdditions && infSig.length > 0 && exSig.length === 0) {
      changes.push({ measure, reason: `added missing figures (${inf.map((f) => f.figures).join(", ")})` });
      continue;
    }
    if (!includeAdditions && exSig.length === 0 && infSig.length > 0) {
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

function getPartIdsInOrder(xmlText: string): string[] {
  const ids: string[] = [];
  const partIdRegex = /<part\s[^>]*id="([^"]+)"/g;
  let match: RegExpExecArray | null;
  while ((match = partIdRegex.exec(xmlText)) !== null) {
    ids.push(match[1]);
  }
  return ids;
}

function resolveBassPartIndex(
  allPartEvents: NoteEvent[][],
  xmlText: string,
  requestedBassPartId: string,
): number {
  if (!requestedBassPartId) {
    return findBassPartIndex(allPartEvents);
  }

  const partIds = getPartIdsInOrder(xmlText);
  const idx = partIds.indexOf(requestedBassPartId);
  if (idx === -1) {
    const available = partIds.length > 0 ? partIds.join(", ") : "(none found)";
    throw new Error(
      `Requested bass part id "${requestedBassPartId}" not found. Available part ids: ${available}`,
    );
  }
  return idx;
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

// ─────────────────────────────────────────────────────────────────────────────
// Voice-leading analysis
// Rules sourced from:
//   Piston, Harmony (1948); Kostka & Payne, Tonal Harmony (2004);
//   Wikipedia – "Voice leading" (Common-practice conventions and pedagogy)
// ─────────────────────────────────────────────────────────────────────────────

type VoiceLeadingViolation = {
  rule: string;
  measure: number;
  beat: number;
  timeDiv: number;
  voiceNames: string;
  partIndices: number[];
  noteTargets?: Array<{ partIndex: number; startDiv: number }>;
  detail: string;
};

type ColorLegendEntry = {
  rule: string;
  color: string;
};

const RULE_COLOR_SCHEME: ColorLegendEntry[] = [
  { rule: "Parallel P5ths", color: "#D7263D" },
  { rule: "Parallel octaves", color: "#F46036" },
  { rule: "Parallel unisons", color: "#2E294E" },
  { rule: "Direct octaves", color: "#1B998B" },
  { rule: "Direct 5ths", color: "#6A4C93" },
  { rule: "Voice crossing", color: "#3A86FF" },
  { rule: "Augmented 2nd", color: "#FF006E" },
  { rule: "Melodic tritone", color: "#FB5607" },
  { rule: "Large leap", color: "#8338EC" },
  { rule: "Leading tone unresolved", color: "#FFBE0B" },
];

const RULE_PRIORITY: string[] = [
  "Parallel P5ths",
  "Parallel octaves",
  "Parallel unisons",
  "Direct octaves",
  "Direct 5ths",
  "Voice crossing",
  "Leading tone unresolved",
  "Melodic tritone",
  "Augmented 2nd",
  "Large leap",
];

const HEX_TO_COLOR_NAME: Record<string, string> = {
  "#D7263D": "Crimson Red",
  "#F46036": "Vermilion Orange",
  "#2E294E": "Indigo",
  "#1B998B": "Teal",
  "#6A4C93": "Royal Purple",
  "#3A86FF": "Azure Blue",
  "#FF006E": "Hot Pink",
  "#FB5607": "Safety Orange",
  "#8338EC": "Violet",
  "#FFBE0B": "Golden Yellow",
};

/** Tonic pitch-class (0=C) for a given key signature (fifths). */
function tonicPitchClass(fifths: number): number {
  return ((7 * fifths) % 12 + 12) % 12;
}

/** Human-readable note label, e.g. "F#" or "Bb". */
function noteLabel(n: NoteEvent): string {
  const acc =
    n.alter === 2  ? "##" :
    n.alter === 1  ? "#"  :
    n.alter === -1 ? "b"  :
    n.alter === -2 ? "bb" : "";
  return `${n.step}${acc}`;
}

/** Extract <part-name> values from the score XML in part order. */
function getPartNames(xmlText: string, numParts: number): string[] {
  const names: string[] = [];
  // <part-name> sits inside each <score-part> in <part-list>
  const re = /<part-name[^>]*>([^<]+)<\/part-name>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xmlText)) !== null) {
    names.push(m[1].trim());
  }
  while (names.length < numParts) names.push(`Part ${names.length + 1}`);
  return names.slice(0, numParts);
}

/** Chromatic interval class (0–11) between two MIDI values. */
function chromClass(midiA: number, midiB: number): number {
  return Math.abs(midiA - midiB) % 12;
}

/** Diatonic interval class (0–6, where 0 = unison/octave) between degreeAbs. */
function diatClass(degA: number, degB: number): number {
  return Math.abs(degA - degB) % 7;
}

/** True if the interval between A and B is a perfect fifth (P5 = 7 semitones, diatonic 5th = 4 steps). */
function isPerfectFifth(midiA: number, midiB: number, degA: number, degB: number): boolean {
  return chromClass(midiA, midiB) === 7 && diatClass(degA, degB) === 4;
}

/** True if the interval is a perfect octave (chromatic 0 mod 12, voices not in unison). */
function isPerfectOctave(midiA: number, midiB: number): boolean {
  return midiA !== midiB && chromClass(midiA, midiB) === 0;
}

/**
 * Analyse all parts for baroque voice-leading violations.
 *
 * Rules checked:
 *   1. Parallel perfect fifths   (Piston §5; Kostka & Payne p.78)
 *   2. Parallel perfect octaves  (ibid.)
 *   3. Parallel unisons          (ibid.)
 *   4. Direct / hidden octaves   – outer voices, soprano leaps (Piston p.25)
 *   5. Direct / hidden fifths    – outer voices, soprano leaps (ibid.)
 *   6. Voice crossing            (Wikipedia – voice-leading §chord-connection)
 *   7. Augmented melodic 2nd     (Kostka & Payne p.71-72)
 *   8. Melodic tritone leap      (ibid.)
 *   9. Large leap ≥ minor 7th   (ibid.)
 *  10. Leading-tone non-resolution in upper voices (ibid.)
 */
function analyzeVoiceLeading(
  allPartEvents: NoteEvent[][],
  partNames: string[],
  bassPartIndex: number,
): VoiceLeadingViolation[] {
  const violations: VoiceLeadingViolation[] = [];
  const numParts = allPartEvents.length;

  // Identify soprano (highest average MIDI, excluding bass) and bass for outer-voice checks.
  const avgMidis = allPartEvents.map((events) =>
    events.length === 0 ? -Infinity : events.reduce((s, n) => s + n.midi, 0) / events.length,
  );
  let sopranoIndex = -1;
  let highestAvg = -Infinity;
  for (let i = 0; i < numParts; i++) {
    if (i !== bassPartIndex && avgMidis[i] > highestAvg) {
      highestAvg = avgMidis[i];
      sopranoIndex = i;
    }
  }

  // ── Helper: note sounding in a part at absolute time t ──────────────────
  function soundingAt(part: NoteEvent[], t: number): NoteEvent | null {
    for (const n of part) {
      if (n.start <= t && n.end > t) return n;
    }
    return null;
  }

  // All unique attack times across all parts.
  const allAttacks = new Set<number>();
  for (const part of allPartEvents) {
    for (const n of part) allAttacks.add(n.start);
  }
  const times = [...allAttacks].sort((a, b) => a - b);

  // ── Rule helpers ─────────────────────────────────────────────────────────
  function push(
    rule: string,
    measure: number,
    beat: number,
    timeDiv: number,
    partIndices: number[],
    voiceNames: string,
    detail: string,
    noteTargets?: Array<{ partIndex: number; startDiv: number }>,
  ) {
    violations.push({ rule, measure, beat, timeDiv, partIndices, voiceNames, detail, noteTargets });
  }

  // ── 1–3: Cross-voice parallel & unison analysis ──────────────────────────
  for (let pi = 0; pi < numParts; pi++) {
    for (let pj = pi + 1; pj < numParts; pj++) {
      const partA = allPartEvents[pi];
      const partB = allPartEvents[pj];
      const nameAB = `${partNames[pi]} & ${partNames[pj]}`;
      const isOuterPair = (pi === sopranoIndex && pj === bassPartIndex) ||
                          (pj === sopranoIndex && pi === bassPartIndex);

      let prevA: NoteEvent | null = null;
      let prevB: NoteEvent | null = null;

      for (const t of times) {
        const curA = soundingAt(partA, t);
        const curB = soundingAt(partB, t);

        if (!curA) prevA = null;
        if (!curB) prevB = null;

        if (curA && curB && prevA && prevB) {
          const aAttacked = curA !== prevA;
          const bAttacked = curB !== prevB;

          if (aAttacked || bAttacked) {
            const bothMoved = prevA.midi !== curA.midi && prevB.midi !== curB.midi;

            if (bothMoved) {
              // Rule 1: Parallel perfect fifths
              if (
                isPerfectFifth(prevA.midi, prevB.midi, prevA.degreeAbs, prevB.degreeAbs) &&
                isPerfectFifth(curA.midi, curB.midi, curA.degreeAbs, curB.degreeAbs)
              ) {
                const n = aAttacked ? curA : curB;
                push("Parallel P5ths", n.measure, n.beat,
                  n.start,
                  [pi, pj],
                  nameAB,
                  `P5 → P5 (${noteLabel(prevA)}-${noteLabel(prevB)} → ${noteLabel(curA)}-${noteLabel(curB)})`,
                  [
                    { partIndex: pi, startDiv: prevA.start },
                    { partIndex: pj, startDiv: prevB.start },
                    { partIndex: pi, startDiv: curA.start },
                    { partIndex: pj, startDiv: curB.start },
                  ],
                );
              }

              // Rule 2: Parallel perfect octaves
              if (isPerfectOctave(prevA.midi, prevB.midi) && isPerfectOctave(curA.midi, curB.midi)) {
                const n = aAttacked ? curA : curB;
                push("Parallel octaves", n.measure, n.beat,
                  n.start,
                  [pi, pj],
                  nameAB,
                  `P8 → P8 (${noteLabel(prevA)}-${noteLabel(prevB)} → ${noteLabel(curA)}-${noteLabel(curB)})`,
                  [
                    { partIndex: pi, startDiv: prevA.start },
                    { partIndex: pj, startDiv: prevB.start },
                    { partIndex: pi, startDiv: curA.start },
                    { partIndex: pj, startDiv: curB.start },
                  ],
                );
              }

              // Rule 3: Parallel unisons
              if (prevA.midi === prevB.midi && curA.midi === curB.midi) {
                const n = aAttacked ? curA : curB;
                push("Parallel unisons", n.measure, n.beat,
                  n.start,
                  [pi, pj],
                  nameAB,
                  `unison → unison on ${noteLabel(curA)}`,
                  [
                    { partIndex: pi, startDiv: prevA.start },
                    { partIndex: pj, startDiv: prevB.start },
                    { partIndex: pi, startDiv: curA.start },
                    { partIndex: pj, startDiv: curB.start },
                  ],
                );
              }
            }

            // Rules 4 & 5: Direct / hidden octaves and fifths (outer voices only)
            if (isOuterPair && aAttacked && bAttacked) {
              const soprano = sopranoIndex === pi ? curA : curB;
              const sopranoPrev = sopranoIndex === pi ? prevA : prevB;
              const bass = sopranoIndex === pi ? curB : curA;
              const bassPrev = sopranoIndex === pi ? prevB : prevA;

              const sopranoLeap = Math.abs(soprano.midi - sopranoPrev.midi) > 2; // > whole step
              const sopranoDir = Math.sign(soprano.midi - sopranoPrev.midi);
              const bassDir = Math.sign(bass.midi - bassPrev.midi);
              const similarMotion = sopranoDir !== 0 && sopranoDir === bassDir;

              if (sopranoLeap && similarMotion) {
                if (isPerfectOctave(soprano.midi, bass.midi)) {
                  push("Direct octaves", soprano.measure, soprano.beat,
                    soprano.start,
                    [sopranoIndex, bassPartIndex],
                    `${partNames[sopranoIndex]} & ${partNames[bassPartIndex]}`,
                    `outer voices reach P8 by similar motion, soprano leaps (${noteLabel(sopranoPrev)}→${noteLabel(soprano)})`);
                } else if (isPerfectFifth(soprano.midi, bass.midi, soprano.degreeAbs, bass.degreeAbs)) {
                  push("Direct 5ths", soprano.measure, soprano.beat,
                    soprano.start,
                    [sopranoIndex, bassPartIndex],
                    `${partNames[sopranoIndex]} & ${partNames[bassPartIndex]}`,
                    `outer voices reach P5 by similar motion, soprano leaps (${noteLabel(sopranoPrev)}→${noteLabel(soprano)})`);
                }
              }
            }
          }

          // Rule 6: Voice crossing — check whenever either voice attacks
          if ((aAttacked || bAttacked)) {
            // Suppress common benign textures:
            // - both voices landing on unison (line meeting point)
            // - immediate pitch exchange / handoff (imitative voice swap)
            const landsOnUnison = curA.midi === curB.midi;
            const voiceExchange = curA.midi === prevB.midi && curB.midi === prevA.midi;
            if (landsOnUnison || voiceExchange) {
              // no-op
            } else {
            const prevAHigher = prevA.midi > prevB.midi;
            const curAHigher  = curA.midi  > curB.midi;
            if (prevA.midi !== prevB.midi && prevAHigher !== curAHigher) {
              const n = aAttacked ? curA : curB;
              push("Voice crossing", n.measure, n.beat,
                n.start,
                [pi, pj],
                nameAB,
                `${partNames[pi]} crosses ${partNames[pj]} (${noteLabel(curA)} vs ${noteLabel(curB)})`);
            }
            }
          }
        }

        if (curA) prevA = curA;
        if (curB) prevB = curB;
      }
    }
  }

  // ── 7–10: Per-voice melodic analysis ─────────────────────────────────────
  for (let p = 0; p < numParts; p++) {
    const notes = allPartEvents[p];
    const name  = partNames[p];

    for (let i = 1; i < notes.length; i++) {
      const prev = notes[i - 1];
      const curr = notes[i];

      // Skip simultaneous notes (chord tones) and notes separated by long rests
      if (curr.start === prev.start) continue;

      const chromDist = Math.abs(curr.midi - prev.midi);
      const diatDist  = Math.abs(curr.degreeAbs - prev.degreeAbs);

      // Rule 7: Augmented 2nd (diatonic step = 1 letter, chromatic = 3 semitones)
      // e.g. F natural → G# or G# → F natural
      if (diatDist % 7 === 1 && chromDist % 12 === 3 && chromDist < 12) {
        push("Augmented 2nd", curr.measure, curr.beat,
          curr.start,
          [p],
          name,
          `melodic aug 2nd: ${noteLabel(prev)} → ${noteLabel(curr)}`);
      }

      // Rule 8: Melodic tritone leap (diatonic 4th, chromatic 6 = aug 4th / dim 5th)
      if (diatDist % 7 === 3 && chromDist % 12 === 6 && chromDist < 12) {
        push("Melodic tritone", curr.measure, curr.beat,
          curr.start,
          [p],
          name,
          `tritone leap: ${noteLabel(prev)} → ${noteLabel(curr)}`);
      }

      // Rule 9: Large leap ≥ minor 7th (10 semitones)
      if (chromDist >= 10) {
        push("Large leap", curr.measure, curr.beat,
          curr.start,
          [p],
          name,
          `leap of ${chromDist} semitone${chromDist !== 1 ? "s" : ""}: ${noteLabel(prev)} → ${noteLabel(curr)}`);
      }

      // Rule 10: Leading-tone non-resolution in upper voices
      // Leading tone = 1 semitone below tonic. Should resolve up by half step.
      if (p !== bassPartIndex) {
        const tonic   = tonicPitchClass(prev.keyFifths);
        const leadingPC = (tonic - 1 + 12) % 12;
        if ((prev.midi % 12) === leadingPC) {
          // Tie continuation (or repeated pitch carry-over) is not a melodic
          // leading-tone "failure"; wait for the next pitch change.
          if ((curr.tieStop && curr.midi === prev.midi) || curr.midi === prev.midi) {
            continue;
          }

          // Allow inner-voice descent to the 5th (common baroque exception)
          const fifth = (tonic + 7) % 12;
          const resolvedUp = (curr.midi % 12) === tonic;
          const innerVoiceException = p !== sopranoIndex && (curr.midi % 12) === fifth;
          if (!resolvedUp && !innerVoiceException) {
            push("Leading tone unresolved", prev.measure, prev.beat,
              prev.start,
              [p],
              name,
              `LT ${noteLabel(prev)} → ${noteLabel(curr)} (expected tonic ${["C","C#","D","Eb","E","F","F#","G","Ab","A","Bb","B"][tonic]})`);
          }
        }
      }
    }
  }

  return violations.sort((a, b) => a.measure - b.measure || a.beat - b.beat);
}

function getRuleColor(rule: string): string {
  return RULE_COLOR_SCHEME.find((e) => e.rule === rule)?.color ?? "#C1121F";
}

function getRuleNumber(rule: string): number {
  const idx = RULE_COLOR_SCHEME.findIndex((e) => e.rule === rule);
  return idx >= 0 ? idx + 1 : 0;
}

function formatRuleNumberTag(rules: Set<string>): string {
  const nums = [...rules]
    .map((r) => getRuleNumber(r))
    .filter((n) => n > 0)
    .sort((a, b) => a - b);
  return nums.join(",");
}

function colorNameFromHex(hex: string): string {
  return HEX_TO_COLOR_NAME[hex.toUpperCase()] ?? hex;
}

function chooseColorForRules(rules: Set<string>): string {
  for (const preferred of RULE_PRIORITY) {
    if (rules.has(preferred)) return getRuleColor(preferred);
  }
  const first = [...rules][0];
  return getRuleColor(first);
}

function colorVoiceLeadingViolations(
  xmlText: string,
  violations: VoiceLeadingViolation[],
): string {
  if (violations.length === 0) return xmlText;

  const partIds = getPartIdsInOrder(xmlText);
  const targets = new Map<string, Set<string>>();

  for (const v of violations) {
    if (v.noteTargets && v.noteTargets.length > 0) {
      for (const t of v.noteTargets) {
        if (t.partIndex < 0 || t.partIndex >= partIds.length) continue;
        const key = `${t.partIndex}:${t.startDiv}`;
        if (!targets.has(key)) targets.set(key, new Set<string>());
        targets.get(key)!.add(v.rule);
      }
      continue;
    }

    for (const partIndex of v.partIndices) {
      if (partIndex < 0 || partIndex >= partIds.length) continue;
      const key = `${partIndex}:${v.timeDiv}`;
      if (!targets.has(key)) targets.set(key, new Set<string>());
      targets.get(key)!.add(v.rule);
    }
  }

  const insertions: Array<{ at: number; text: string }> = [];

  for (let partIndex = 0; partIndex < partIds.length; partIndex += 1) {
    const partId = partIds[partIndex];
    const partOpenRegex = new RegExp(`<part\\s[^>]*id="${partId}"[^>]*>`);
    const partMatch = partOpenRegex.exec(xmlText);
    if (!partMatch) continue;

    const partContentStart = partMatch.index + partMatch[0].length;
    const partContentEnd = xmlText.indexOf("</part>", partContentStart);
    if (partContentEnd === -1) continue;

    const segment = xmlText.slice(partContentStart, partContentEnd);
    const tagRe = /<(\/?)(\w[\w.-]*)([^>]*)>/g;

    let absoluteDiv = 0;
    let cursor = 0;
    let chordAnchor = 0;
    let inMeasure = false;
    let inNote = false;
    let inAttributes = false;
    let inBackupForward = false;
    let noteIsChord = false;
    let noteIsRest = false;
    let noteDuration = 0;
    let currentNoteStart = 0;
    let pendingTextConsumer: "duration" | null = null;
    let lastTagEnd = 0;
    let pendingAbsoluteStart: number | null = null;

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
        } else if (tagName === "note") {
          if (pendingAbsoluteStart !== null && !noteIsRest) {
            const key = `${partIndex}:${pendingAbsoluteStart}`;
            const rules = targets.get(key);
            if (rules && rules.size > 0) {
              const color = chooseColorForRules(rules);
              const noteOpenTag = segment.slice(currentNoteStart, segment.indexOf(">", currentNoteStart) + 1);
              if (!/\scolor\s*=/.test(noteOpenTag)) {
                const insertOffset = partContentStart + currentNoteStart + "<note".length;
                insertions.push({ at: insertOffset, text: ` color="${color}"` });
              }

              if (!noteIsChord) {
                const noteBody = segment.slice(currentNoteStart, tagPos);
                if (!/<lyric\b/.test(noteBody)) {
                  const lineStart = segment.lastIndexOf("\n", currentNoteStart) + 1;
                  const noteIndent = segment.slice(lineStart, currentNoteStart).match(/^(\s*)/)?.[1] ?? "      ";
                  const ruleNums = formatRuleNumberTag(rules);
                  const lyricXml =
                    `\n${noteIndent}  <lyric number=\"99\">\n` +
                    `${noteIndent}    <syllabic>single</syllabic>\n` +
                    `${noteIndent}    <text>R${ruleNums}</text>\n` +
                    `${noteIndent}  </lyric>`;
                  insertions.push({ at: partContentStart + tagPos, text: lyricXml });
                }
              }
            }
          }

          if (!noteIsChord) {
            chordAnchor = cursor;
            cursor += noteDuration;
          }

          inNote = false;
          noteIsChord = false;
          noteIsRest = false;
          noteDuration = 0;
          pendingAbsoluteStart = null;
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
          pendingAbsoluteStart = absoluteDiv + cursor;
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
        if (tagName === "chord") {
          noteIsChord = true;
          pendingAbsoluteStart = absoluteDiv + chordAnchor;
        }
        if (tagName === "rest") noteIsRest = true;
        if (tagName === "duration" && !isSelfClose) pendingTextConsumer = "duration";
      }

      if (inBackupForward && tagName === "duration" && !isSelfClose) {
        pendingTextConsumer = "duration";
      }
    }
  }

  insertions.sort((a, b) => b.at - a.at);
  let result = xmlText;
  for (const ins of insertions) {
    result = result.slice(0, ins.at) + ins.text + result.slice(ins.at);
  }
  return result;
}

function buildLegendDirectionsXml(entries: ColorLegendEntry[]): string {
  const lines: string[] = [];
  const titleY = 102;
  const gridStartY = 84;
  const rowHeight = 12;
  const columns = 1;
  const colWidth = 0;
  const gridStartX = 18;

  // Sort entries by rule number
  const sortedEntries = [...entries].sort((a, b) => getRuleNumber(a.rule) - getRuleNumber(b.rule));

  lines.push(
    "    <direction placement=\"above\">\n" +
      "      <direction-type>\n" +
      `        <words default-x=\"10\" default-y=\"${titleY}\" font-weight=\"bold\" enclosure=\"rectangle\">Voice-Leading Flags (R# on notes = multiple rules)</words>\n` +
      "      </direction-type>\n" +
      "    </direction>\n",
  );

  for (let i = 0; i < sortedEntries.length; i += 1) {
    const entry = sortedEntries[i];
    const n = getRuleNumber(entry.rule);
    const col = i % columns;
    const row = Math.floor(i / columns);
    const x = gridStartX + col * colWidth;
    const y = gridStartY - row * rowHeight;

    lines.push(
      "    <direction placement=\"above\">\n" +
        "      <direction-type>\n" +
        `        <words default-x=\"${x}\" default-y=\"${y}\" color=\"${entry.color}\" font-weight=\"bold\" enclosure=\"rectangle\">${n}. [${colorNameFromHex(entry.color)}] ${entry.rule}</words>\n` +
        "      </direction-type>\n" +
        "    </direction>\n",
    );
  }

  return lines.join("");
}

function insertLegendIntoFirstMeasure(xmlText: string, entries: ColorLegendEntry[]): string {
  if (entries.length === 0) return xmlText;
  const partOpen = /<part\s[^>]*id="([^"]+)"[^>]*>/;
  const partMatch = partOpen.exec(xmlText);
  if (!partMatch) return xmlText;

  const partStart = partMatch.index + partMatch[0].length;
  const partEnd = xmlText.indexOf("</part>", partStart);
  if (partEnd === -1) return xmlText;

  const partSegment = xmlText.slice(partStart, partEnd);
  const measureOpen = /<measure\b[^>]*>/;
  const measureMatch = measureOpen.exec(partSegment);
  if (!measureMatch) return xmlText;

  const insertAt = partStart + measureMatch.index + measureMatch[0].length;
  const legendXml = "\n" + buildLegendDirectionsXml(entries);
  return xmlText.slice(0, insertAt) + legendXml + xmlText.slice(insertAt);
}

function formatAnalysisReport(
  violations: VoiceLeadingViolation[],
  inputPath: string,
): string {
  const header = [
    "Voice Leading Analysis",
    "======================",
    `Source: ${path.basename(inputPath)}`,
    `Rules: Piston (1948), Kostka & Payne (2004), Wikipedia – Voice leading`,
    "",
  ];

  if (violations.length === 0) {
    return [...header, "No baroque voice-leading violations found.", ""].join("\n");
  }

  const ruleGroups = new Map<string, VoiceLeadingViolation[]>();
  for (const v of violations) {
    if (!ruleGroups.has(v.rule)) ruleGroups.set(v.rule, []);
    ruleGroups.get(v.rule)!.push(v);
  }

  const lines: string[] = [...header];
  for (const [rule, group] of ruleGroups) {
    lines.push(`── ${rule} (${group.length}) ──`);
    for (const v of group) {
      lines.push(
        `  m.${String(v.measure).padEnd(4)} beat ${String(v.beat.toFixed(2)).padEnd(6)}` +
        `  ${v.voiceNames.padEnd(42)}  ${v.detail}`,
      );
    }
    lines.push("");
  }

  lines.push(`Total violations: ${violations.length}`);
  lines.push("");
  return lines.join("\n");
}

function main() {
  const { input, out, bassPartId, analyze, analyzeOnly, analyzeOut, exportPdf, pdfOut, pdfCmd } = parseArgs(process.argv);

  const xmlText = normalizeXmlText(fs.readFileSync(input, "utf8"));
  const score = parseScore(xmlText);
  const parts = asArray(score.part);

  if (parts.length < 2) {
    throw new Error("Need at least two parts (bass + harmony) to infer figures.");
  }

  const allEvents = parts.map((part) => extractPartEvents(part));
  const bassPartIndex = resolveBassPartIndex(allEvents, xmlText, bassPartId);
  const divisions = extractDivisions(score); // ticks per quarter note
  const partNames = getPartNames(xmlText, parts.length);
  const figures = inferFigures(allEvents, divisions); // minimum segment = 1 quarter note

  const hasExistingFiguredBass = xmlText.includes("<figured-bass>");
  let existing: ExistingFigureEvent[] = [];
  let sourceXmlForInsert = xmlText;
  let changes: FigureChange[] = [];
  let removedFromOtherStaves = 0;

  if (hasExistingFiguredBass) {
    const reviewed = collectAndStripExistingFiguredBass(xmlText, bassPartIndex);
    existing = reviewed.existing;

    // Remove figured bass from all staves so output contains figures on exactly one selected part.
    const globallyStripped = stripAllFiguredBass(reviewed.strippedXml);
    sourceXmlForInsert = globallyStripped.strippedXml;
    removedFromOtherStaves = globallyStripped.removedCount;

    // If selected bass had no pre-existing figures, skip noisy "added missing" entries.
    changes = buildFigureChangeReport(figures, existing, existing.length > 0);
  }

  const outputXml = insertFiguredBass(sourceXmlForInsert, figures, bassPartIndex, true);
  if (!analyzeOnly) {
    fs.writeFileSync(out, outputXml, "utf8");
    if (exportPdf) {
      exportMusicXmlToPdf(out, pdfOut, pdfCmd);
    }
  }

  console.log(`Input:  ${input}`);
  if (!analyzeOnly) console.log(`Output: ${out}`);
  if (!analyzeOnly && exportPdf) console.log(`PDF:    ${pdfOut}`);
  console.log(`Bass part: ${getBassPartId(xmlText, bassPartIndex)}`);
  console.log(`Figure events:    ${figures.length}`);
  console.log(`Non-trivial figures: ${figures.filter((f) => f.slots.length > 0).length}`);
  if (hasExistingFiguredBass) {
    console.log(`Existing figured-bass entries reviewed: ${existing.length}`);
    if (removedFromOtherStaves > 0) {
      console.log(`Removed existing figured-bass blocks from non-selected staves: ${removedFromOtherStaves}`);
    }
    if (changes.length === 0 && removedFromOtherStaves === 0) {
      console.log("Verification: existing figured bass matched inferred analysis (no updates needed).");
    } else if (changes.length === 0 && removedFromOtherStaves > 0) {
      console.log("Verification: kept figures on one selected staff only.");
    } else {
      console.log("Verification: updated figured bass at:");
      for (const change of changes) {
        console.log(`  Measure ${change.measure}: ${change.reason}`);
      }
    }
  }

  if (analyze) {
    const violations = analyzeVoiceLeading(allEvents, partNames, bassPartIndex);
    if (!analyzeOnly) {
      const coloredXml = colorVoiceLeadingViolations(outputXml, violations);
      const usedRules = new Set(violations.map((v) => v.rule));
      const legendEntries = RULE_COLOR_SCHEME.filter((e) => usedRules.has(e.rule));
      const withLegendXml = insertLegendIntoFirstMeasure(coloredXml, legendEntries);
      fs.writeFileSync(out, withLegendXml, "utf8");
    }
    const report = formatAnalysisReport(violations, input);
    if (analyzeOut) {
      fs.writeFileSync(analyzeOut, report, "utf8");
      // Also output JSON for report generation
      const jsonOut = analyzeOut.replace(/\.txt$/, ".json");
      fs.writeFileSync(jsonOut, JSON.stringify({ input, violations }, null, 2), "utf8");
      console.log(`Voice leading report: ${analyzeOut} (${violations.length} violation${violations.length !== 1 ? "s" : ""})`);
    } else {
      console.log("");
      process.stdout.write(report);
    }
  }
}

main();
