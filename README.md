# Figured Bass Generator

CLI and web tooling for inferring figured bass from harmonized MusicXML and running voice-leading analysis.

## What it does

- Parses a MusicXML score (`score-partwise`).
- Identifies the bass part automatically (lowest average pitch).
- For each bass note onset, checks overlapping upper voices.
- Reduces chord intervals into common figured-bass labels (e.g. `6`, `6/4`, `7`).
- Writes a MusicXML output with inferred figured bass, or excludes figured bass when requested.
- Optionally runs voice-leading analysis in strict or fugal mode and writes text/JSON reports.

## Install

```bash
npm install
```

## Usage

```bash
npm run start -- path/to/score.musicxml
```

Common options:

```bash
npm run start -- path/to/score.musicxml --bass-part-id P4
npm run start -- path/to/score.musicxml --out path/to/output.musicxml
npm run start -- path/to/score.musicxml --analyze
npm run start -- path/to/score.musicxml --analyze --analyze-out path/to/report.txt
npm run start -- path/to/score.musicxml --fugal --analyze-out path/to/fugal-report.txt
npm run start -- path/to/score.musicxml --analyze-only --analyze-out path/to/report.txt
npm run start -- path/to/score.musicxml --exclude-figured-bass
npm run start -- path/to/score.musicxml --include-figured-bass
npm run start -- path/to/score.musicxml --pdf
npm run start -- path/to/score.musicxml --pdf --pdf-out path/to/score.pdf
npm run start -- path/to/score.musicxml --pdf --pdf-cmd my-renderer-cli
```

You can also set `PDF_RENDER_CMD` instead of passing `--pdf-cmd`.

Note: `--pdf` cannot be combined with `--analyze-only`.

## Web UI

Run the local UI for uploading MusicXML and choosing analysis outputs:

```bash
npm run web
```

Then open `http://localhost:4173`.

UI options:
- Select strict report and/or fugal report.
- Include or exclude figured bass in generated colored MusicXML/PDF.
- Generate a colored score PDF (requires MuseScore CLI or `MUSESCORE_CMD`).

## Outputs

- Main output score: `*-figured-bass.musicxml` (or custom `--out` path).
- With `--analyze-out path/to/report.txt`:
  - Text report at `report.txt`.
  - JSON report at `report.json`.
- With `--pdf`: PDF exported from the written MusicXML output.

When a file already contains `<figured-bass>`, the tool validates/updates it and keeps figured bass on only the selected bass staff.

## Notes

- Current version handles standard `partwise` MusicXML.
- Accidentals are not yet rendered as altered figure signs (e.g. sharped 6).
- Ties are handled via note overlap across durations.
