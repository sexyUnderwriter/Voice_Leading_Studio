import Verovio from "verovio";
import fs from "fs";
import path from "path";
import { execSync } from "child_process";

async function renderColoredMusicXml(xmlPath, pdfPath) {
  try {
    console.log(`Loading MusicXML: ${xmlPath}`);
    const xmlData = fs.readFileSync(xmlPath, "utf-8");

    // Initialize Verovio
    const verovio = new Verovio();
    verovio.setOptions({
      pageHeight: 2970,  // A4 in 100ths of mm
      pageWidth: 2100,   // A4 in 100ths of mm
      scale: 100,
      spacingLinear: 0.25,
      spacingNonLinear: 0.6,
      breaks: "encoded",
    });

    console.log("Rendering with Verovio...");
    verovio.loadData(xmlData);
    const svg = verovio.renderToSVG(1);  // Render first page

    // Save SVG to temporary file
    const svgPath = pdfPath.replace(/\.pdf$/, ".svg");
    fs.writeFileSync(svgPath, svg, "utf-8");
    console.log(`✓ SVG created: ${svgPath}`);

    // Convert SVG to PDF using Inkscape
    console.log("Converting SVG to PDF with Inkscape...");
    const cmd = `/usr/local/bin/inkscape --pdf-poppler "${svgPath}" -o "${pdfPath}"`;
    try {
      execSync(cmd, { stdio: "inherit" });
    } catch (err) {
      // Inkscape may exit with non-zero but still create the PDF, try alternate syntax
      const cmd2 = `/usr/local/bin/inkscape -l "${pdfPath}" "${svgPath}"`;
      execSync(cmd2, { stdio: "inherit" });
    }

    const stats = fs.statSync(pdfPath);
    console.log(`✅ PDF created: ${pdfPath} (${(stats.size / 1024).toFixed(1)} KB)`);

  } catch (err) {
    console.error("Error rendering:", err.message);
    process.exit(1);
  }
}

const xmlPath = process.argv[2];
const pdfPath = process.argv[3] || xmlPath.replace(/\.musicxml$/, "-colored.pdf");

if (!xmlPath || !fs.existsSync(xmlPath)) {
  console.error("Usage: node render-colored.mjs path/to/score.musicxml [output.pdf]");
  process.exit(1);
}

renderColoredMusicXml(xmlPath, pdfPath);
