import express from "express";
import multer from "multer";
import fs from "fs";
import path from "path";
import { spawn, spawnSync } from "child_process";
import { randomUUID } from "crypto";

const app = express();
const port = Number(process.env.PORT || 4173);
const rootDir = process.cwd();
const uiDir = path.join(rootDir, "web", "ui");
const runsDir = path.join(rootDir, "web", "runs");
const uploadDir = path.join(rootDir, "web", "uploads");

fs.mkdirSync(runsDir, { recursive: true });
fs.mkdirSync(uploadDir, { recursive: true });

const upload = multer({ dest: uploadDir, limits: { fileSize: 20 * 1024 * 1024 } });

app.use(express.json());
app.use("/runs", express.static(runsDir));
app.use(express.static(uiDir));

function sanitizeBaseName(name) {
  return name
    .replace(/\.[^.]+$/, "")
    .replace(/[^a-zA-Z0-9._ -]/g, "")
    .replace(/\s+/g, " ")
    .trim() || "score";
}

function findMuseScoreCmd() {
  const candidates = [
    process.env.MUSESCORE_CMD,
    "/Applications/MuseScore 4.app/Contents/MacOS/mscore",
    "/Applications/MuseScore 3.app/Contents/MacOS/mscore",
    "/usr/local/bin/mscore",
    "mscore",
    "musescore",
  ].filter(Boolean);

  return candidates.find((candidate) => {
    const result = spawnSync(candidate, ["--version"], { encoding: "utf8" });
    return !result.error && result.status === 0;
  }) || "";
}

function runCommand(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      reject(error);
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(new Error(`${command} exited with ${code}\n${stderr || stdout}`));
    });
  });
}

function bool(value, fallback = false) {
  if (typeof value !== "string") return fallback;
  return value.toLowerCase() === "true";
}

app.post("/api/run", upload.single("xmlFile"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "Please upload a MusicXML file." });
    }

    const runStrict = bool(req.body.runStrict, true);
    const runFugal = bool(req.body.runFugal, false);
    const includeFiguredBass = bool(req.body.includeFiguredBass, true);
    const makeColoredPdf = bool(req.body.makeColoredPdf, true);

    if (!runStrict && !runFugal) {
      return res.status(400).json({ error: "Select at least one report: strict or fugal." });
    }

    const originalName = req.file.originalname || "score.musicxml";
    const ext = path.extname(originalName).toLowerCase();
    if (![".xml", ".musicxml"].includes(ext)) {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: "Unsupported file type. Upload .xml or .musicxml." });
    }

    const runId = `${Date.now()}-${randomUUID().slice(0, 8)}`;
    const runDir = path.join(runsDir, runId);
    fs.mkdirSync(runDir, { recursive: true });

    const safeBase = sanitizeBaseName(originalName);
    const inputPath = path.join(runDir, `${safeBase}.musicxml`);
    fs.renameSync(req.file.path, inputPath);

    const tsxCmd = path.join(rootDir, "node_modules", ".bin", "tsx");
    const modes = [];
    if (runStrict) modes.push("strict");
    if (runFugal) modes.push("fugal");

    const artifacts = [];
    const logs = [];

    for (const mode of modes) {
      const reportTxt = path.join(runDir, `${safeBase}-${mode}-report.txt`);
      const reportJson = reportTxt.replace(/\.txt$/i, ".json");
      const coloredXml = path.join(runDir, `${safeBase}-colored-${mode}.musicxml`);

      const args = [
        "src/index.ts",
        inputPath,
        "--analyze",
        "--analyze-out",
        reportTxt,
        "--out",
        coloredXml,
      ];

      if (mode === "fugal") args.push("--fugal");
      if (!includeFiguredBass) args.push("--exclude-figured-bass");

      const result = await runCommand(tsxCmd, args, rootDir);
      logs.push({ mode, output: `${result.stdout}${result.stderr}`.trim() });

      artifacts.push({
        label: `${mode} text report`,
        type: "report-txt",
        path: path.relative(rootDir, reportTxt),
        url: `/runs/${runId}/${path.basename(reportTxt)}`,
      });
      artifacts.push({
        label: `${mode} json report`,
        type: "report-json",
        path: path.relative(rootDir, reportJson),
        url: `/runs/${runId}/${path.basename(reportJson)}`,
      });
      artifacts.push({
        label: `${mode} colored score (MusicXML)`,
        type: "colored-xml",
        path: path.relative(rootDir, coloredXml),
        url: `/runs/${runId}/${path.basename(coloredXml)}`,
      });

      if (makeColoredPdf) {
        const musescoreCmd = findMuseScoreCmd();
        if (!musescoreCmd) {
          throw new Error("MuseScore CLI not found. Set MUSESCORE_CMD or install MuseScore.");
        }
        const coloredPdf = path.join(runDir, `${safeBase}-colored-${mode}.pdf`);
        const pdfResult = await runCommand(musescoreCmd, [coloredXml, "-o", coloredPdf], rootDir);
        logs.push({ mode: `${mode}-pdf`, output: `${pdfResult.stdout}${pdfResult.stderr}`.trim() });

        artifacts.push({
          label: `${mode} colored score (PDF)`,
          type: "colored-pdf",
          path: path.relative(rootDir, coloredPdf),
          url: `/runs/${runId}/${path.basename(coloredPdf)}`,
        });
      }
    }

    return res.json({
      runId,
      includeFiguredBass,
      modes,
      artifacts,
      logs,
    });
  } catch (error) {
    return res.status(500).json({ error: error instanceof Error ? error.message : "Unknown error" });
  }
});

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, service: "figured-bass-web" });
});

app.listen(port, () => {
  console.log(`Web UI running on http://localhost:${port}`);
});
