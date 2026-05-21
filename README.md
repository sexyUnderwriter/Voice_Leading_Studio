# Figured Bass Generator

A small CLI that reads a harmonized MusicXML file and infers figured-bass symbols above the bass line.

## What it does

- Parses a MusicXML score (`score-partwise`).
- Identifies the bass part automatically (lowest average pitch).
- For each bass note onset, checks overlapping upper voices.
- Reduces chord intervals into common figured-bass labels (e.g. `6`, `6/4`, `7`).
- Writes a CSV report with timestamped figure events.

## Install

```bash
npm install
```

## Usage

```bash
npm run start -- path/to/score.musicxml
```

Optional explicit bass part selection (recommended for scores with multiple low staves):

```bash
npm run start -- path/to/score.musicxml --bass-part-id P4
```

Optional output path:

```bash
npm run start -- path/to/score.musicxml --out figures.csv
```

Optional PDF export (default uses headless LilyPond pipeline):

```bash
npm run start -- path/to/score.musicxml --pdf
```

Optional PDF path:

```bash
npm run start -- path/to/score.musicxml --pdf --pdf-out path/to/score.pdf
```

Optional explicit PDF command (overrides default renderer):

```bash
npm run start -- path/to/score.musicxml --pdf --pdf-cmd my-renderer-cli
```

Optional exclude figured bass in generated MusicXML output:

```bash
npm run start -- path/to/score.musicxml --analyze --exclude-figured-bass
```

## Web UI

Run a local frontend for uploading MusicXML and choosing analysis outputs:

```bash
npm run web
```

Then open `http://localhost:4173`.

UI options:
- Select strict report and/or fugal report.
- Include or exclude figured bass in generated colored MusicXML/PDF.
- Generate colored score PDF (requires MuseScore CLI available).

## Output columns

- `measure`
- `beat`
- `startDiv`
- `durationDiv`
- `bassMidi`
- `figures`
- `rawIntervals`

`figures` is simplified. Empty means a plain 5/3 sonority.

## Notes

- Current version handles standard `partwise` MusicXML.
- Accidentals are not yet rendered as altered figure signs (e.g. sharped 6).
- Ties are handled via note overlap across durations.
