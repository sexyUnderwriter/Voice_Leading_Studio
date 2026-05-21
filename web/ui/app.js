const form = document.getElementById("runForm");
const runBtn = document.getElementById("runBtn");
const statusPanel = document.getElementById("statusPanel");
const statusText = document.getElementById("statusText");
const resultPanel = document.getElementById("resultPanel");
const artifactList = document.getElementById("artifactList");
const logBox = document.getElementById("logBox");
const previewPanel = document.getElementById("previewPanel");
const previewSelect = document.getElementById("previewSelect");
const previewFrame = document.getElementById("previewFrame");

let currentArtifacts = [];

function showStatus(message, kind = "ok") {
  statusPanel.hidden = false;
  statusText.className = kind;
  statusText.textContent = message;
}

function boolFromCheckbox(name) {
  const input = form.elements.namedItem(name);
  return input instanceof HTMLInputElement ? input.checked : false;
}

function renderArtifacts(artifacts) {
  currentArtifacts = Array.isArray(artifacts) ? artifacts : [];
  artifactList.textContent = "";
  previewSelect.textContent = "";

  for (const artifact of currentArtifacts) {
    const li = document.createElement("li");
    const link = document.createElement("a");
    link.href = artifact.url;
    link.textContent = `${artifact.label} (${artifact.path})`;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    li.appendChild(link);
    artifactList.appendChild(li);

    const option = document.createElement("option");
    option.value = artifact.url;
    option.textContent = artifact.label;
    previewSelect.appendChild(option);
  }

  const preferredPreview =
    currentArtifacts.find((artifact) => artifact.type === "colored-pdf") ||
    currentArtifacts.find((artifact) => artifact.type === "colored-xml") ||
    currentArtifacts[0];

  if (preferredPreview) {
    previewSelect.value = preferredPreview.url;
    previewFrame.src = preferredPreview.url;
    previewPanel.hidden = false;
  }
}

previewSelect.addEventListener("change", () => {
  previewFrame.src = previewSelect.value;
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  const runStrict = boolFromCheckbox("runStrict");
  const runFugal = boolFromCheckbox("runFugal");

  if (!runStrict && !runFugal) {
    showStatus("Select at least one report type.", "error");
    return;
  }

  const formData = new FormData();
  const xmlFileInput = form.elements.namedItem("xmlFile");
  if (!(xmlFileInput instanceof HTMLInputElement) || !xmlFileInput.files?.[0]) {
    showStatus("Choose a MusicXML file first.", "error");
    return;
  }

  formData.append("xmlFile", xmlFileInput.files[0]);
  formData.append("runStrict", String(runStrict));
  formData.append("runFugal", String(runFugal));
  formData.append("includeFiguredBass", String(boolFromCheckbox("includeFiguredBass")));
  formData.append("makeColoredPdf", String(boolFromCheckbox("makeColoredPdf")));

  runBtn.disabled = true;
  showStatus("Running analysis. This can take a little while for larger scores...");
  resultPanel.hidden = true;

  try {
    const response = await fetch("/api/run", {
      method: "POST",
      body: formData,
    });

    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || "Analysis failed");
    }

    renderArtifacts(payload.artifacts || []);
    logBox.textContent = (payload.logs || [])
      .map((entry) => `## ${entry.mode}\n${entry.output || "(no output)"}`)
      .join("\n\n");

    resultPanel.hidden = false;
    previewPanel.hidden = false;
    showStatus(`Completed run ${payload.runId}.`, "ok");
  } catch (error) {
    showStatus(error instanceof Error ? error.message : "Unexpected error", "error");
  } finally {
    runBtn.disabled = false;
  }
});
