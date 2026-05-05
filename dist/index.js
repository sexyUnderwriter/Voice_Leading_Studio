import fs from "node:fs";
import path from "node:path";
import { XMLParser } from "fast-xml-parser";
const STEP_TO_SEMITONE = {
    C: 0,
    D: 2,
    E: 4,
    F: 5,
    G: 7,
    A: 9,
    B: 11,
};
const STEP_TO_INDEX = {
    C: 0,
    D: 1,
    E: 2,
    F: 3,
    G: 4,
    A: 5,
    B: 6,
};
function asArray(value) {
    if (value === undefined) {
        return [];
    }
    return Array.isArray(value) ? value : [value];
}
function parseArgs(argv) {
    const args = argv.slice(2);
    if (args.length === 0) {
        throw new Error("Usage: npm run start -- <input.musicxml> [--out output.csv]");
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
        out = path.join(parsed.dir, `${parsed.name}-figured-bass.csv`);
    }
    return { input, out };
}
function pitchToMidi(pitch) {
    const semitone = STEP_TO_SEMITONE[pitch.step] + pitch.alter;
    return (pitch.octave + 1) * 12 + semitone;
}
function simplifyIntervals(intervals) {
    const uniqueSorted = [...new Set(intervals)].sort((a, b) => a - b);
    const has = (n) => uniqueSorted.includes(n);
    if (has(3) && has(5) && uniqueSorted.length === 2) {
        return "";
    }
    if (has(3) && has(5) && has(7)) {
        return "7";
    }
    if (has(3) && has(6) && uniqueSorted.length === 2) {
        return "6";
    }
    if (has(4) && has(6) && uniqueSorted.length === 2) {
        return "6/4";
    }
    return [...uniqueSorted].sort((a, b) => b - a).join("/");
}
function toIntervalNumber(bassDegreeAbs, upperDegreeAbs) {
    let interval = upperDegreeAbs - bassDegreeAbs + 1;
    while (interval > 9) {
        interval -= 7;
    }
    while (interval < 2) {
        interval += 7;
    }
    return interval;
}
function parseScore(xmlText) {
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
function readDivisions(measure, fallback) {
    const attributes = measure.attributes;
    const divisions = attributes?.divisions;
    if (typeof divisions === "number" && divisions > 0) {
        return divisions;
    }
    return fallback;
}
function extractPartEvents(part) {
    const measures = asArray(part.measure);
    const events = [];
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
                const step = String(p.step);
                const alter = Number(p.alter ?? 0);
                const octave = Number(p.octave);
                if (Number.isFinite(octave) && STEP_TO_INDEX[step] !== undefined) {
                    const pitch = { step, alter, octave };
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
function averageMidi(events) {
    if (events.length === 0) {
        return Number.POSITIVE_INFINITY;
    }
    const total = events.reduce((sum, e) => sum + e.midi, 0);
    return total / events.length;
}
function inferFigures(allPartEvents) {
    const bassIndex = allPartEvents
        .map((events, index) => ({ index, avg: averageMidi(events) }))
        .sort((a, b) => a.avg - b.avg)[0]?.index;
    if (bassIndex === undefined) {
        return [];
    }
    const bassEvents = allPartEvents[bassIndex];
    const upperParts = allPartEvents.filter((_, i) => i !== bassIndex);
    return bassEvents.map((bass) => {
        const intervals = [];
        for (const part of upperParts) {
            for (const n of part) {
                const overlaps = n.start < bass.end && n.end > bass.start;
                if (!overlaps || n.midi <= bass.midi) {
                    continue;
                }
                const interval = toIntervalNumber(bass.degreeAbs, n.degreeAbs);
                intervals.push(interval);
            }
        }
        const uniqueIntervals = [...new Set(intervals)].sort((a, b) => a - b);
        const figures = simplifyIntervals(uniqueIntervals);
        return {
            measure: bass.measure,
            beat: Number(bass.beat.toFixed(3)),
            startDiv: bass.start,
            durationDiv: bass.end - bass.start,
            bassMidi: bass.midi,
            figures,
            rawIntervals: uniqueIntervals.join("/"),
        };
    });
}
function toCsv(rows) {
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
        lines.push([
            row.measure,
            row.beat,
            row.startDiv,
            row.durationDiv,
            row.bassMidi,
            row.figures,
            row.rawIntervals,
        ]
            .map((v) => `"${String(v).replaceAll('"', '""')}"`)
            .join(","));
    }
    return `${lines.join("\n")}\n`;
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
    const figures = inferFigures(allEvents);
    const csv = toCsv(figures);
    fs.writeFileSync(out, csv, "utf8");
    console.log(`Input: ${input}`);
    console.log(`Output: ${out}`);
    console.log(`Figure events: ${figures.length}`);
}
main();
