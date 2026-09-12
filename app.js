/* JSON to CSV Converter — 100% client-side.
 * Pure core functions are defined first so they can be unit-tested in Node.
 */
"use strict";

/* ---------------- Core (pure, testable) ---------------- */

function flattenValue(value, prefix, out, depth) {
  if (depth > 10) {
    out[prefix] = stringifyCell(value);
    return;
  }
  if (value === null || value === undefined) {
    out[prefix] = "";
    return;
  }
  if (Array.isArray(value)) {
    // Array of primitives -> join; otherwise JSON-stringify to avoid data loss
    if (value.length > 0 && value.every((v) => v === null || ["string", "number", "boolean"].includes(typeof v))) {
      out[prefix] = value.map((v) => (v === null ? "" : String(v))).join("; ");
    } else if (value.length === 0) {
      out[prefix] = "";
    } else {
      out[prefix] = JSON.stringify(value);
    }
    return;
  }
  if (typeof value === "object") {
    const keys = Object.keys(value);
    if (keys.length === 0) {
      out[prefix] = "";
      return;
    }
    for (const k of keys) {
      const name = prefix ? prefix + "." + k : k;
      flattenValue(value[k], name, out, depth + 1);
    }
    return;
  }
  out[prefix] = String(value);
}

function flattenRecord(obj) {
  const out = {};
  if (obj === null || obj === undefined) return out;
  if (typeof obj !== "object" || Array.isArray(obj)) {
    out["value"] = stringifyCell(obj);
    return out;
  }
  for (const k of Object.keys(obj)) flattenValue(obj[k], k, out, 1);
  return out;
}

function stringifyCell(v) {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

/** Detect convertible records from parsed JSON. Throws a user-friendly Error. */
function detectRecords(parsed) {
  if (parsed === null || parsed === undefined) throw new Error("The file contains empty JSON (null). There is nothing to convert.");
  if (Array.isArray(parsed)) {
    if (parsed.length === 0) throw new Error("The JSON array is empty. There are no records to convert.");
    if (parsed.every((x) => x !== null && typeof x === "object" && !Array.isArray(x))) return parsed;
    if (parsed.every((x) => x === null || ["string", "number", "boolean"].includes(typeof x))) {
      return parsed.map((v) => ({ value: v === null ? "" : v }));
    }
    throw new Error("This JSON array mixes objects with other values, so it can't be converted to a clean table. Please provide an array of objects like [{\"name\": \"Ada\"}, ...].");
  }
  if (typeof parsed === "object") {
    const keys = Object.keys(parsed);
    if (keys.length === 0) throw new Error("The JSON object is empty ({}). There are no records to convert.");
    // Smart unwrap: { "data": [...] }, { "items": [...] }, etc.
    const arrayProp = keys.find((k) => Array.isArray(parsed[k]) && parsed[k].length > 0 && parsed[k].every((x) => x !== null && typeof x === "object" && !Array.isArray(x)));
    if (arrayProp && keys.length <= 5) {
      return parsed[arrayProp];
    }
    return [parsed]; // single object -> one row
  }
  throw new Error("This JSON contains a single " + typeof parsed + ", not a table of data. Please provide an array of objects or an object with fields.");
}

function collectColumns(flatRecords) {
  const cols = [];
  const seen = new Set();
  for (const r of flatRecords) {
    for (const k of Object.keys(r)) {
      if (!seen.has(k)) { seen.add(k); cols.push(k); }
    }
  }
  return cols;
}

function escapeCsvCell(s) {
  if (s === null || s === undefined) return "";
  s = String(s);
  if (s.includes('"') || s.includes(",") || s.includes("\n") || s.includes("\r")) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function recordsToCsv(flatRecords, columns) {
  const lines = [];
  lines.push(columns.map(escapeCsvCell).join(","));
  for (const r of flatRecords) {
    lines.push(columns.map((c) => escapeCsvCell(c in r ? r[c] : "")).join(","));
  }
  return lines.join("\r\n") + "\r\n";
}

function formatBytes(n) {
  if (!isFinite(n)) return "–";
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  return (n / (1024 * 1024)).toFixed(2) + " MB";
}

function friendlyParseError(e) {
  const m = String((e && e.message) || e);
  if (/empty|nothing to convert/i.test(m)) return m;
  if (/unexpected token|is not valid json|in json at position/i.test(m)) {
    return "This file is not valid JSON. Please check for missing commas, brackets, or quotes, then try again. (Details: " + m.slice(0, 140) + ")";
  }
  return m;
}

// Export for Node tests
if (typeof module !== "undefined" && module.exports) {
  module.exports = { flattenValue, flattenRecord, detectRecords, collectColumns, escapeCsvCell, recordsToCsv, formatBytes };
}

/* ---------------- UI (browser only) ---------------- */
if (typeof window !== "undefined") {
  const $ = (id) => document.getElementById(id);
  const dropzone = $("dropzone"), fileInput = $("fileInput"), chooseBtn = $("chooseBtn");
  const fileInfo = $("fileInfo"), fileName = $("fileName"), fileSize = $("fileSize");
  const replaceBtn = $("replaceBtn"), removeBtn = $("removeBtn");
  const actionsRow = $("actionsRow"), validateBtn = $("validateBtn"), previewBtn = $("previewBtn");
  const convertBtn = $("convertBtn"), resetBtn = $("resetBtn");
  const errorBox = $("errorBox"), errorTitle = $("errorTitle"), errorMsg = $("errorMsg"), errorClose = $("errorClose");
  const statsSection = $("statsSection"), validText = $("validText");
  const statRecords = $("statRecords"), statCols = $("statCols"), statSize = $("statSize"), colsList = $("colsList");
  const previewSection = $("previewSection"), previewHead = $("previewHead"), previewBody = $("previewBody"), previewNote = $("previewNote");
  const progressSection = $("progressSection"), progressStage = $("progressStage"), progressPct = $("progressPct");
  const progressFill = $("progressFill"), progressSub = $("progressSub"), progressBarWrap = $("progressBarWrap");
  const successSection = $("successSection"), successFile = $("successFile"), successRecords = $("successRecords");
  const successSize = $("successSize"), downloadBtn = $("downloadBtn"), againBtn = $("againBtn");
  const steps = Array.from(document.querySelectorAll(".step"));
  const sampleBtn = $("sampleBtn");

  const MAX_FILE_BYTES = 200 * 1024 * 1024;
  const PREVIEW_ROWS = 10;

  let state = {
    file: null,
    rawText: null,
    parsed: null,
    records: null,      // raw record objects
    flat: null,         // flattened records
    columns: [],
    csvText: null,
    csvBlobUrl: null,
    outputName: "data.csv",
    validated: false,
  };

  function setStep(n) {
    steps.forEach((s) => {
      const k = Number(s.dataset.step);
      s.classList.toggle("active", k === n);
      s.classList.toggle("done", k < n);
    });
  }
  function showError(title, msg) {
    errorTitle.textContent = title;
    errorMsg.textContent = msg;
    errorBox.classList.remove("hidden");
    errorBox.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }
  function hideError() { errorBox.classList.add("hidden"); }
  function setProgress(pct, stage, sub) {
    pct = Math.max(0, Math.min(100, Math.round(pct)));
    progressFill.style.width = pct + "%";
    progressPct.textContent = pct + "%";
    progressBarWrap.setAttribute("aria-valuenow", String(pct));
    if (stage) progressStage.textContent = stage;
    if (sub !== undefined) progressSub.textContent = sub;
  }
  const tick = () => new Promise((r) => setTimeout(r, 0));

  function resetAll(keepFile) {
    hideError();
    statsSection.classList.add("hidden");
    previewSection.classList.add("hidden");
    progressSection.classList.add("hidden");
    successSection.classList.add("hidden");
    actionsRow.classList.toggle("hidden", !state.file);
    if (state.csvBlobUrl) { URL.revokeObjectURL(state.csvBlobUrl); state.csvBlobUrl = null; }
    Object.assign(state, { rawText: null, parsed: null, records: null, flat: null, columns: [], csvText: null, validated: false });
    setStep(1);
    if (!keepFile) {
      state.file = null;
      fileInput.value = "";
      fileInfo.classList.add("hidden");
      dropzone.classList.remove("hidden");
      actionsRow.classList.add("hidden");
    }
  }

  function selectFile(file) {
    hideError();
    if (!file) return;
    const isJson = /\.json$/i.test(file.name) || file.type.includes("json");
    if (!isJson) {
      showError("Unsupported file type", "Please choose a file ending in .json (you selected \"" + file.name + "\").");
      return;
    }
    if (file.size === 0) {
      showError("Empty file", "The file \"" + file.name + "\" is empty (0 bytes). Please choose a file that contains JSON data.");
      return;
    }
    if (file.size > MAX_FILE_BYTES) {
      showError("File too large", "This file is " + formatBytes(file.size) + ". To keep your browser fast and stable, files up to ~200 MB are supported. Try splitting the file into smaller parts.");
      return;
    }
    resetAll(true);
    state.file = file;
    state.outputName = file.name.replace(/\.json$/i, "") + ".csv";
    fileName.textContent = file.name;
    fileSize.textContent = formatBytes(file.size);
    fileInfo.classList.remove("hidden");
    dropzone.classList.add("hidden");
    actionsRow.classList.remove("hidden");
    setStep(1);
  }

  function readFileWithProgress(file, onPct) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onprogress = (e) => {
        if (e.lengthComputable) onPct(Math.round((e.loaded / e.total) * 100));
      };
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(new Error("Could not read the file. It may be locked by another app or corrupted. Please try again or choose a different file."));
      try {
        reader.readAsText(file);
      } catch (err) {
        reject(new Error("Could not read the file. Please try again."));
      }
    });
  }

  async function ensureParsed() {
    if (state.parsed && state.records) return true;
    if (!state.file) { showError("No file selected", "Please upload a JSON file first."); return false; }
    hideError();
    progressSection.classList.remove("hidden");
    successSection.classList.add("hidden");
    setProgress(2, "Reading file…", "Opening \"" + state.file.name + "\"…");
    let text;
    try {
      text = await readFileWithProgress(state.file, (p) => setProgress(2 + p * 0.13, "Reading file…", "Read " + p + "% of file…"));
    } catch (e) {
      progressSection.classList.add("hidden");
      showError("Could not read file", e.message);
      return false;
    }
    await tick();
    if (!text || !text.trim()) {
      progressSection.classList.add("hidden");
      showError("Empty file", "This file has no content. Please choose a file containing JSON data.");
      return false;
    }
    setProgress(16, "Validating JSON…", "Checking syntax…");
    await tick();
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      progressSection.classList.add("hidden");
      showError("Invalid JSON", friendlyParseError(e));
      return false;
    }
    setProgress(22, "Validating JSON…", "Detecting records and columns…");
    await tick();
    let records;
    try {
      records = detectRecords(parsed);
    } catch (e) {
      progressSection.classList.add("hidden");
      showError("Can't convert this structure", e.message);
      return false;
    }
    state.rawText = text;
    state.parsed = parsed;
    state.records = records;
    state.validated = true;
    // Flatten in chunks so progress is real and UI stays responsive
    setProgress(26, "Processing records…", "Flattening 0 of " + records.length + "…");
    const flat = new Array(records.length);
    const CHUNK = 1500;
    for (let i = 0; i < records.length; i += CHUNK) {
      const end = Math.min(records.length, i + CHUNK);
      for (let j = i; j < end; j++) flat[j] = flattenRecord(records[j]);
      setProgress(26 + (end / records.length) * 50, "Processing records…", "Flattening " + end + " of " + records.length + "…");
      await tick();
    }
    state.flat = flat;
    state.columns = collectColumns(flat);
    if (state.columns.length === 0) {
      progressSection.classList.add("hidden");
      showError("No data found", "The JSON parsed, but no usable fields were found in any record.");
      return false;
    }
    if (state.columns.length > 500) {
      progressSection.classList.add("hidden");
      showError("Too many columns", "This file produced " + state.columns.length + " distinct columns, which is too wide for a readable CSV. The data may be deeply irregular — consider cleaning it first.");
      return false;
    }
    return true;
  }

  function renderStats() {
    statsSection.classList.remove("hidden");
    validText.textContent = "Valid JSON — " + state.records.length + (state.records.length === 1 ? " record" : " records") + " found";
    statRecords.textContent = state.records.length.toLocaleString();
    statCols.textContent = String(state.columns.length);
    // rough CSV size estimate from first rows
    const sample = state.flat.slice(0, 20);
    const est = sample.length ? new Blob([recordsToCsv(sample, state.columns)]).size / sample.length * state.flat.length : 0;
    statSize.textContent = formatBytes(Math.round(est));
    colsList.innerHTML = "";
    const MAX_CHIPS = 60;
    state.columns.slice(0, MAX_CHIPS).forEach((c) => {
      const s = document.createElement("span");
      s.className = "col-chip";
      s.textContent = c;
      s.title = c;
      colsList.appendChild(s);
    });
    if (state.columns.length > MAX_CHIPS) {
      const more = document.createElement("span");
      more.className = "col-chip";
      more.textContent = "+" + (state.columns.length - MAX_CHIPS) + " more";
      colsList.appendChild(more);
    }
  }

  function renderPreview() {
    previewSection.classList.remove("hidden");
    previewHead.innerHTML = "";
    previewBody.innerHTML = "";
    const cols = state.columns.slice(0, 12);
    cols.forEach((c) => {
      const th = document.createElement("th");
      th.textContent = c;
      th.title = c;
      previewHead.appendChild(th);
    });
    if (state.columns.length > 12) {
      const th = document.createElement("th");
      th.textContent = "… (+" + (state.columns.length - 12) + " more)";
      previewHead.appendChild(th);
    }
    state.flat.slice(0, PREVIEW_ROWS).forEach((r) => {
      const tr = document.createElement("tr");
      cols.forEach((c) => {
        const td = document.createElement("td");
        const v = c in r ? r[c] : "";
        if (v === "" || v === null) { td.textContent = "—"; td.className = "cell-empty"; }
        else { td.textContent = String(v).slice(0, 120); td.title = String(v).slice(0, 500); }
        tr.appendChild(td);
      });
      if (state.columns.length > 12) {
        const td = document.createElement("td");
        td.textContent = "…";
        tr.appendChild(td);
      }
      previewBody.appendChild(tr);
    });
    previewNote.textContent = "— showing first " + Math.min(PREVIEW_ROWS, state.flat.length) + " of " + state.flat.length.toLocaleString() + " rows";
  }

  validateBtn.addEventListener("click", async () => {
    const ok = await ensureParsed();
    progressSection.classList.add("hidden");
    if (!ok) return;
    renderStats();
    setStep(2);
    progressSection.classList.remove("hidden");
    setProgress(100, "Completed", "Validation successful.");
  });

  previewBtn.addEventListener("click", async () => {
    const ok = await ensureParsed();
    progressSection.classList.add("hidden");
    if (!ok) return;
    renderStats();
    renderPreview();
    setStep(2);
  });

  convertBtn.addEventListener("click", async () => {
    convertBtn.disabled = true;
    try {
      const ok = await ensureParsed();
      if (!ok) return;
      renderStats();
      renderPreview();
      setStep(3);
      // Generate CSV in chunks (real progress)
      const { flat, columns } = state;
      const parts = [columns.map(escapeCsvCell).join(",") + "\r\n"];
      const CHUNK = 1500;
      for (let i = 0; i < flat.length; i += CHUNK) {
        const end = Math.min(flat.length, i + CHUNK);
        let buf = "";
        for (let j = i; j < end; j++) {
          const r = flat[j];
          buf += columns.map((c) => escapeCsvCell(c in r ? r[c] : "")).join(",") + "\r\n";
        }
        parts.push(buf);
        setProgress(76 + (end / flat.length) * 19, "Generating CSV…", "Wrote " + end.toLocaleString() + " of " + flat.length.toLocaleString() + " rows…");
        await tick();
      }
      setProgress(97, "Finalizing…", "Preparing download…");
      await tick();
      const blob = new Blob(parts, { type: "text/csv;charset=utf-8" });
      if (state.csvBlobUrl) URL.revokeObjectURL(state.csvBlobUrl);
      state.csvBlobUrl = URL.createObjectURL(blob);
      state.csvText = null;
      setProgress(100, "Completed", "Done — " + flat.length.toLocaleString() + " records converted.");
      successSection.classList.remove("hidden");
      successFile.textContent = state.outputName;
      successRecords.textContent = flat.length.toLocaleString() + (flat.length === 1 ? " record" : " records");
      successSize.textContent = formatBytes(blob.size);
      setStep(4);
      successSection.scrollIntoView({ behavior: "smooth", block: "nearest" });
    } catch (e) {
      showError("Conversion failed", "Something went wrong while building the CSV. Please try again with a smaller or simpler file.");
    } finally {
      convertBtn.disabled = false;
    }
  });

  downloadBtn.addEventListener("click", () => {
    if (!state.csvBlobUrl) return;
    const a = document.createElement("a");
    a.href = state.csvBlobUrl;
    a.download = state.outputName;
    document.body.appendChild(a);
    a.click();
    a.remove();
  });

  againBtn.addEventListener("click", () => resetAll(false));
  resetBtn.addEventListener("click", () => resetAll(true));
  removeBtn.addEventListener("click", () => resetAll(false));
  replaceBtn.addEventListener("click", () => fileInput.click());
  errorClose.addEventListener("click", hideError);

  chooseBtn.addEventListener("click", (e) => { e.stopPropagation(); fileInput.click(); });
  dropzone.addEventListener("click", (e) => { if (e.target !== sampleBtn) fileInput.click(); });
  dropzone.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fileInput.click(); } });
  fileInput.addEventListener("change", () => { if (fileInput.files[0]) selectFile(fileInput.files[0]); });

  ["dragenter", "dragover"].forEach((ev) => dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.add("dragging"); }));
  ["dragleave", "drop"].forEach((ev) => dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.remove("dragging"); }));
  dropzone.addEventListener("drop", (e) => {
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) selectFile(f);
  });

  sampleBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const sample = [
      { id: 1, name: "Ada Lovelace", email: "ada@example.com", address: { city: "London", zip: "E1" }, tags: ["math", "code"] },
      { id: 2, name: "Grace Hopper", email: "grace@example.com", address: { city: "New York", zip: "10001" }, tags: ["navy", "cobol"] },
      { id: 3, name: "Katherine Johnson", address: { city: "Virginia" }, tags: [] },
    ];
    const blob = new Blob([JSON.stringify(sample, null, 2)], { type: "application/json" });
    selectFile(new File([blob], "sample.json", { type: "application/json" }));
  });
}
