const fs = require('fs');
const path = require('path');
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

  doc.moveDown(0.8);

  // Color legend - simplified layout
  doc.fontSize(11).font('Helvetica-Bold').text('Color Legend', { underline: true });
  doc.moveDown(0.4);

  doc.fontSize(8).font('Helvetica');
  const sortedRules = Object.entries(byRule).sort((a, b) => b[1].length - a[1].length);
  
  // Two-column legend
  const midpoint = Math.ceil(sortedRules.length / 2);
  const leftCol = sortedRules.slice(0, midpoint);
  const rightCol = sortedRules.slice(midpoint);
  
  const legendStartY = doc.y;
  
  leftCol.forEach(([rule, viols], idx) => {
    const color = RULE_COLORS[rule] || { hex: '#808080' };
    doc.rect(40, legendStartY + idx * 14, 10, 10).fill(color.hex);
    doc.fillColor('black');
    doc.fontSize(8).font('Helvetica').text(`${rule} (${viols.length})`, 55, legendStartY + idx * 14 + 1, { width: 200 });
  });
  
  rightCol.forEach(([rule, viols], idx) => {
    const color = RULE_COLORS[rule] || { hex: '#808080' };
    doc.rect(280, legendStartY + idx * 14, 10, 10).fill(color.hex);
    doc.fillColor('black');
    doc.fontSize(8).font('Helvetica').text(`${rule} (${viols.length})`, 295, legendStartY + idx * 14 + 1, { width: 200 });
  });
  
  doc.moveDown(Math.max(leftCol.length, rightCol.length) * 0.5 + 0.5);

  // New page for violations
  doc.addPage();
  doc.fontSize(13).font('Helvetica-Bold').text('Detailed Violations', { underline: true });
  doc.moveDown(0.5);

  // List violations by rule
  Object.entries(byRule)
    .sort((a, b) => b[1].length - a[1].length) // Sort by count descending
    .forEach(([rule, viols]) => {
      const color = RULE_COLORS[rule] || { rgb: [128, 128, 128] };
      
      // Rule header
      doc.fontSize(10).font('Helvetica-Bold').fillColor(color.rgb[0], color.rgb[1], color.rgb[2]);
      doc.text(`${rule} (${viols.length})`, { underline: true });
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

  // Rules reference page
  doc.addPage();
  doc.fontSize(13).font('Helvetica-Bold').text('Rules Reference', { underline: true });
  doc.moveDown(0.5);

  doc.fontSize(9).font('Helvetica');
  const rulesList = [
    ['Parallel perfect intervals', 'Two or more voices moving in parallel into a perfect 5th or octave undermines voice independence.'],
    ['Parallel unison', 'Similar motion leading to unison eliminates register distinction.'],
    ['Direct intervals (outer voices)', 'Similar motion into a perfect interval in the outer voices, especially with soprano leap.'],
    ['Voice crossing', 'Outer voices exchange registers, creating confusion in the texture.'],
    ['Melodic intervals', 'Augmented 2nds and tritones are awkward in a single voice.'],
    ['Large leaps', 'Leaps ≥10 semitones should be filled in by stepwise opposite motion.'],
    ['Leading tone resolution', 'The 7th scale degree should resolve up to the tonic.'],
  ];

  rulesList.forEach(([name, desc]) => {
    doc.fontSize(9).font('Helvetica-Bold').text(name);
    doc.fontSize(8).font('Helvetica').text(desc, { width: 500 });
    doc.moveDown(0.3);
  });

  doc.end();

  return new Promise((resolve, reject) => {
    stream.on('finish', resolve);
    stream.on('error', reject);
  });
}

async function main() {
  const jsonPath = process.argv[2];
  const outputPath = process.argv[3] || jsonPath.replace(/\.json$/, '-report.pdf');

  if (!jsonPath || !fs.existsSync(jsonPath)) {
    console.error('Usage: node professional-report.cjs violations.json [output.pdf]');
    process.exit(1);
  }

  console.log(`Reading violations from ${jsonPath}...`);
  await createProfessionalReport(jsonPath, outputPath);
  const stats = fs.statSync(outputPath);
  console.log(`✅ Created ${outputPath} (${(stats.size / 1024).toFixed(1)} KB)`);
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
