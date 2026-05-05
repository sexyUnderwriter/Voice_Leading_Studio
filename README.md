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

Optional output path:

```bash
npm run start -- path/to/score.musicxml --out figures.csv
```

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
