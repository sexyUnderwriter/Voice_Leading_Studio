const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const PDFDocument = require('pdfkit');

// Color scheme matching the analysis
const RULE_COLORS = {
  "Parallel P5ths": { hex: "#D7263D", rgb: [215, 38, 61], title: "Crimson Red" },
  "Parallel octaves": { hex: "#F46036", rgb: [244, 96, 54], title: "Vermilion Orange" },
  "Parallel unisons": { hex: "#2E294E", rgb: [46, 41, 78], title: "Indigo" },
  "Direct octaves": { hex: "#6A4C93", rgb: [106, 76, 147], title: "Royal Purple" },
  "Direct 5ths": { hex: "#6A4C93", rgb: [106, 76, 147], title: "Royal Purple" },
  "Voice crossing": { hex: "#3A86FF", rgb: [58, 134, 255], title: "Azure Blue" },
  "Augmented 2nd": { hex: "#FB5607", rgb: [251, 86, 7], title: "Safety Orange" },
  "Melodic tritone": { hex: "#FB5607", rgb: [251, 86, 7], title: "Safety Orange" },
  "Large leap": { hex: "#8338EC", rgb: [131, 56, 236], title: "Violet" },
  "Leading tone unresolved": { hex: "#FFBE0B", rgb: [255, 190, 11], title: "Golden Yellow" },
};

// Rule explanations
const RULE_EXPLANATIONS = {
  "Parallel P5ths": "Consecutive perfect fifths in two voices create parallel motion that undermines voice independence.",
  "Parallel octaves": "Consecutive perfect octaves eliminate the distinction between voices.",
  "Parallel unisons": "Two voices in unison reduce the texture and blur voice independence.",
  "Direct octaves": "Similar motion in outer voices into an octave (especially with soprano leap) weakens the progression.",
  "Direct 5ths": "Similar motion in outer voices into a perfect fifth weakens the progression.",
  "Voice crossing": "A lower voice temporarily moves above a higher voice, creating confusion in register.",
  "Augmented 2nd": "A diatonic augmented 2nd creates an awkward melodic interval.",
  "Melodic tritone": "A tritone in melodic motion is dissonant and should be avoided in voice leading.",
  "Large leap": "A leap of 10+ semitones should be filled in by stepwise motion in the opposite direction.",
  "Leading tone unresolved": "The leading tone (7th scale degree) should resolve upward to the tonic.",
};

const RULE_NUMBER_ORDER = [
  'Parallel P5ths',
  'Parallel octaves',
  'Parallel unisons',
  'Direct octaves',
  'Direct 5ths',
  'Voice crossing',
  'Augmented 2nd',
  'Melodic tritone',
  'Large leap',
  'Leading tone unresolved',
];

function getRuleNumber(rule) {
  const idx = RULE_NUMBER_ORDER.indexOf(rule);
  return idx >= 0 ? idx + 1 : 0;
}

function sortedBrokenRuleEntries(byRule) {
  return Object.entries(byRule).sort((a, b) => {
    const aNum = getRuleNumber(a[0]);
    const bNum = getRuleNumber(b[0]);
    if (aNum !== bNum) return aNum - bNum;
    return a[0].localeCompare(b[0]);
  });
}

function createProfessionalReport(jsonPath, outputPath) {
  // Read violations JSON
  const data = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
  const { violations, input } = data;

  // Group violations by rule
  const byRule = {};
  violations.forEach(v => {
    if (!byRule[v.rule]) {
      byRule[v.rule] = [];
    }
    byRule[v.rule].push(v);
  });

  // Create PDF with smaller margins
  const doc = new PDFDocument({
    margin: 35,
    size: 'Letter'
  });

  const stream = fs.createWriteStream(outputPath);
  doc.pipe(stream);

  // Title page
  doc.fontSize(22).font('Helvetica-Bold').text('Voice Leading Analysis', { align: 'center' });
  doc.moveDown(0.4);
  doc.fontSize(11).font('Helvetica').text('Baroque Counterpoint Violations Report', { align: 'center' });
  doc.moveDown(1.2);

  // Score info
  doc.fontSize(10).font('Helvetica-Bold').text('Score:');
  doc.fontSize(9).font('Helvetica').text(path.basename(input), { width: 450, align: 'left' });
  doc.moveDown(0.8);

  // Summary stats
  doc.fontSize(10).font('Helvetica-Bold').text('Summary');
  doc.fontSize(9).font('Helvetica');
  doc.text(`Total Violations: ${violations.length}`);
  doc.text(`Rules Violated: ${Object.keys(byRule).length}`);

  const brokenRuleEntries = sortedBrokenRuleEntries(byRule);
  if (brokenRuleEntries.length > 0) {
    doc.moveDown(0.8);

    // Color legend - only broken rules, ordered by stable rule number.
    doc.fontSize(11).font('Helvetica-Bold').text('Color Legend', { underline: true });
    doc.moveDown(0.4);

    doc.fontSize(8).font('Helvetica');

    // Two-column legend
    const midpoint = Math.ceil(brokenRuleEntries.length / 2);
    const leftCol = brokenRuleEntries.slice(0, midpoint);
    const rightCol = brokenRuleEntries.slice(midpoint);

    const legendStartY = doc.y;

    leftCol.forEach(([rule, viols], idx) => {
      const color = RULE_COLORS[rule] || { hex: '#808080' };
      const num = getRuleNumber(rule);
      const label = num > 0 ? `${num}. ${rule} (${viols.length})` : `${rule} (${viols.length})`;
      doc.rect(40, legendStartY + idx * 14, 10, 10).fill(color.hex);
      doc.fillColor('black');
      doc.fontSize(8).font('Helvetica').text(label, 55, legendStartY + idx * 14 + 1, { width: 210 });
    });

    rightCol.forEach(([rule, viols], idx) => {
      const color = RULE_COLORS[rule] || { hex: '#808080' };
      const num = getRuleNumber(rule);
      const label = num > 0 ? `${num}. ${rule} (${viols.length})` : `${rule} (${viols.length})`;
      doc.rect(280, legendStartY + idx * 14, 10, 10).fill(color.hex);
      doc.fillColor('black');
      doc.fontSize(8).font('Helvetica').text(label, 295, legendStartY + idx * 14 + 1, { width: 210 });
    });

    doc.moveDown(Math.max(leftCol.length, rightCol.length) * 0.5 + 0.5);

    // New page for violations
    doc.addPage();
    doc.fontSize(13).font('Helvetica-Bold').text('Detailed Violations', { underline: true });
    doc.moveDown(0.5);

    // List violations by rule (only broken rules)
    brokenRuleEntries.forEach(([rule, viols]) => {
      const color = RULE_COLORS[rule] || { rgb: [128, 128, 128] };
      const num = getRuleNumber(rule);
      const heading = num > 0 ? `${num}. ${rule} (${viols.length})` : `${rule} (${viols.length})`;
      
      // Rule header
      doc.fontSize(10).font('Helvetica-Bold').fillColor(color.rgb[0], color.rgb[1], color.rgb[2]);
      doc.text(heading, { underline: true });
      doc.fillColor('black');
      doc.moveDown(0.2);

      // Rule explanation
      doc.fontSize(8).font('Helvetica-Oblique').text(RULE_EXPLANATIONS[rule] || '', {
        width: 500,
        color: '#555555'
      });
      doc.moveDown(0.3);

      // Violations - formatted for readability
      doc.fontSize(7.5).font('Courier');
      viols.forEach(v => {
        const location = `m.${v.measure}  beat ${v.beat.toFixed(2)}`;
        const text = `${location}  |  ${v.voiceNames}  |  ${v.detail}`;
        doc.text(text, { width: 525 });
      });

      doc.moveDown(0.4);

      // Page break if needed
      if (doc.y > doc.page.height - 80) {
        doc.addPage();
        doc.fillColor('black');
      }
    });

    // Rules reference page (broken rules only)
    doc.addPage();
    doc.fontSize(13).font('Helvetica-Bold').text('Rules Reference', { underline: true });
    doc.moveDown(0.5);

    brokenRuleEntries.forEach(([rule]) => {
      const num = getRuleNumber(rule);
      const heading = num > 0 ? `${num}. ${rule}` : rule;
      doc.fontSize(9).font('Helvetica-Bold').text(heading);
      doc.fontSize(8).font('Helvetica').text(RULE_EXPLANATIONS[rule] || '', { width: 500 });
      doc.moveDown(0.3);
    });
  }

  doc.end();

  return new Promise((resolve, reject) => {
    stream.on('finish', resolve);
    stream.on('error', reject);
  });
}

function findMuseScoreExecutable() {
  const candidates = [
    process.env.MUSESCORE_CMD,
    '/Applications/MuseScore 4.app/Contents/MacOS/mscore',
    '/Applications/MuseScore 3.app/Contents/MacOS/mscore',
    'mscore',
    'musescore',
  ].filter(Boolean);

  for (const cmd of candidates) {
    const probe = spawnSync(cmd, ['--version'], { encoding: 'utf8' });
    if (!probe.error && probe.status === 0) {
      return cmd;
    }
  }

  return '';
}

function guessColoredXmlPath(jsonPath, inputPath) {
  const dir = path.dirname(jsonPath);
  const jsonBase = path.basename(jsonPath, '.json');
  const inputBase = path.basename(inputPath || '', path.extname(inputPath || ''));

  const candidates = [
    `${jsonBase.replace(/-strict-report$/i, '-colored-strict')}.musicxml`,
    `${jsonBase.replace(/-fugal-report$/i, '-colored-fugal')}.musicxml`,
    `${jsonBase.replace(/-report$/i, '-colored')}.musicxml`,
    `${inputBase}-colored-strict.musicxml`,
    `${inputBase}-colored-fugal.musicxml`,
    `${inputBase}-colored.musicxml`,
  ]
    .filter((name) => name && !name.startsWith('-'))
    .map((name) => path.join(dir, name));

  for (const filePath of candidates) {
    if (fs.existsSync(filePath)) {
      return filePath;
    }
  }

  return '';
}

function renderColoredWithMuseScore(xmlPath, pdfPath) {
  const musescoreCmd = findMuseScoreExecutable();
  if (!musescoreCmd) {
    throw new Error(
      'MuseScore CLI not found. Install MuseScore or set MUSESCORE_CMD to the executable path.',
    );
  }

  const result = spawnSync(musescoreCmd, [xmlPath, '-o', pdfPath], { encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    const stderr = (result.stderr || '').trim();
    const stdout = (result.stdout || '').trim();
    const detail = stderr || stdout || (result.error ? result.error.message : 'unknown error');
    throw new Error(`MuseScore render failed: ${detail}`);
  }

  if (!fs.existsSync(pdfPath)) {
    throw new Error(`MuseScore reported success but output was not created: ${pdfPath}`);
  }
}

async function main() {
  const jsonPath = process.argv[2];
  const outputPath = process.argv[3] || jsonPath.replace(/\.json$/, '-report.pdf');
  const coloredXmlPathArg = process.argv[4] || '';
  const coloredPdfPath = process.argv[5] || outputPath.replace(/\.pdf$/i, '-colored-score.pdf');

  if (!jsonPath || !fs.existsSync(jsonPath)) {
    console.error(
      'Usage: node professional-report.cjs violations.json [output.pdf] [colored.musicxml] [colored-output.pdf]',
    );
    process.exit(1);
  }

  const parsed = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
  const resolvedColoredXmlPath =
    coloredXmlPathArg || guessColoredXmlPath(jsonPath, parsed.input);

  if (!resolvedColoredXmlPath || !fs.existsSync(resolvedColoredXmlPath)) {
    throw new Error(
      'Colored MusicXML not found. Pass it explicitly as the 3rd argument, or generate it first with --analyze.',
    );
  }

  console.log(`Reading violations from ${jsonPath}...`);
  await createProfessionalReport(jsonPath, outputPath);
  const stats = fs.statSync(outputPath);
  console.log(`✅ Created ${outputPath} (${(stats.size / 1024).toFixed(1)} KB)`);

  console.log(`Rendering colored score with MuseScore from ${resolvedColoredXmlPath}...`);
  renderColoredWithMuseScore(resolvedColoredXmlPath, coloredPdfPath);
  const coloredStats = fs.statSync(coloredPdfPath);
  console.log(`✅ Created ${coloredPdfPath} (${(coloredStats.size / 1024).toFixed(1)} KB)`);
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
