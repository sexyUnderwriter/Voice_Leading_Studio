const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');

const textToPdf = (textFilePath, pdfPath) => {
  return new Promise((resolve, reject) => {
    try {
      const text = fs.readFileSync(textFilePath, 'utf-8');
      const writeStream = fs.createWriteStream(pdfPath);
      const doc = new PDFDocument({
        margin: 40,
        size: 'Letter'
      });

      writeStream.on('error', reject);
      doc.on('error', reject);

      doc.pipe(writeStream);
      
      // Split into lines and add to PDF with proper formatting
      const lines = text.split('\n');
      lines.forEach((line, idx) => {
        // Detect headings (lines with === or --- underlines, or numbered rules)
        const nextLine = idx + 1 < lines.length ? lines[idx + 1] : '';
        const isHeading = nextLine && (nextLine.match(/^=+$/) || nextLine.match(/^-+$/));
        const isNumberedRule = line.match(/^\d+\)/);
        
        if (isHeading) {
          // This is a heading - use bold Helvetica
          doc.font('Helvetica-Bold', 11);
          doc.text(line);
        } else if (isNumberedRule) {
          // Numbered rules - bold font
          doc.font('Helvetica-Bold', 10);
          doc.text(line);
        } else if (line.match(/^-+$/) || line.match(/^=+$/)) {
          // Skip underline lines
          return;
        } else {
          // Regular text - normal Helvetica
          doc.font('Helvetica', 9);
          if (line.length > 85) {
            doc.text(line, { width: 480, wrap: true });
          } else {
            doc.text(line);
          }
        }
      });

      doc.end();
      writeStream.on('finish', () => {
        console.log(`  ✓ Created ${pdfPath}`);
        resolve();
      });
    } catch (err) {
      reject(err);
    }
  });
};

const mergePdfsWithGhostscript = async (inputPdfs, outputPath) => {
  const { execSync } = require('child_process');
  
  // Use ghostscript to merge PDFs
  const inputFiles = inputPdfs.map(f => `"${f}"`).join(' ');
  const cmd = `gs -q -dNOPAUSE -dBATCH -sDEVICE=pdfwrite -sOutputFile="${outputPath}" ${inputFiles}`;
  
  console.log(`Merging PDFs: ${cmd.substring(0, 100)}...`);
  execSync(cmd, { stdio: 'inherit' });
};

const main = async () => {
  try {
    console.log('Merging colored score with analysis report...\n');

    // Merge PDFs
    console.log('Combining PDFs...');
    const inputPdfs = [
      'fugue-colored.pdf',           // Colored score with violations visible
      'fugue-professional-report.pdf', // Violations analysis
      'voice-leading-rule-review.txt'  // Will be converted if needed
    ];

    // Check if rule review PDF exists, if not convert it
    if (!fs.existsSync('rule-review.pdf')) {
      console.log('Converting voice-leading-rule-review.txt to PDF...');
      await textToPdf('voice-leading-rule-review.txt', 'rule-review.pdf');
    }

    // Now merge the PDFs
    console.log('Merging all PDFs...');
    const pdfInputs = [
      'fugue-colored.pdf',
      'fugue-professional-report.pdf',
      'rule-review.pdf'
    ];
    
    await mergePdfsWithGhostscript(pdfInputs, 'fugue-complete-analysis.pdf');
    console.log('  ✓ Created fugue-complete-analysis.pdf');
    
    // Show file info
    const stats = fs.statSync('fugue-complete-analysis.pdf');
    console.log(`\n✅ Final PDF: fugue-complete-analysis.pdf (${(stats.size / 1024).toFixed(1)} KB)`);
    console.log('\n📄 PDF contents:');
    console.log('  1. COLORED SCORE - Violations highlighted in color (5 pages)');
    console.log('     Each colored note shows which voice-leading rule is broken');
    console.log('  2. PROFESSIONAL REPORT - Analysis by rule with statistics');
    console.log('  3. RULES REFERENCE - Pedagogical guide and corrections');
    console.log('\n✨ Ready to print and review!');
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
};

main();
