const GAUGES = {
  ion: { command: "F", label: "Ion gauge", color: "#4cc0b2" },
  a: { command: "G", label: "Gauge A", color: "#ee8a5e" },
  b: { command: "H", label: "Gauge B", color: "#d9b65d" },
};

const state = {
  port: null,
  reader: null,
  writer: null,
  connected: false,
  demo: true,
  pollTimer: null,
  demoTimer: null,
  activeRange: 300,
  hidden: new Set(),
  data: { ion: [], a: [], b: [] },
  pendingGauge: null,
  pendingSince: 0,
  buffer: "",
  sessionStarted: Date.now(),
};

const $ = (selector) => document.querySelector(selector);
const canvas = $("#pressureChart");
const ctx = canvas.getContext("2d");
const themeToggle = $("#themeToggle");
const themeColor = document.querySelector('meta[name="theme-color"]');

function setTheme(theme, persist = true) {
  const dark = theme === "dark";
  document.documentElement.dataset.theme = theme;
  themeToggle.querySelector("span:first-child").textContent = dark ? "☀" : "☾";
  themeToggle.querySelector(".theme-label").textContent = dark ? "Light" : "Dark";
  themeToggle.setAttribute("aria-label", `Switch to ${dark ? "light" : "dark"} mode`);
  themeToggle.title = `Switch to ${dark ? "light" : "dark"} mode`;
  themeColor.content = dark ? "#0b1212" : "#eef0ea";
  if (persist) localStorage.setItem("theme", theme);
  draw();
}

const savedTheme = localStorage.getItem("theme");
setTheme(savedTheme || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"), false);

function seedDemo() {
  const now = Date.now();
  for (let i = 150; i >= 0; i--) {
    const t = now - i * 2000;
    const progress = 150 - i;
    addPoint("ion", t, 7.8e-6 * Math.exp(-progress / 43) * (1 + Math.sin(i / 7) * .07), false);
    addPoint("a", t, 1.7e-2 * Math.exp(-progress / 85) * (1 + Math.sin(i / 11) * .05), false);
    addPoint("b", t, 70 + Math.sin(i / 13) * 7 + progress * .04, false);
  }
}

function addPoint(gauge, time, value, refresh = true) {
  if (!Number.isFinite(value) || value <= 0) return;
  state.data[gauge].push({ time, value });
  const cutoff = Date.now() - 60 * 60 * 1000;
  state.data[gauge] = state.data[gauge].filter((point) => point.time >= cutoff);
  updateReading(gauge);
  if (refresh) draw();
}

function parsePressure(raw) {
  const text = raw.trim();
  const compact = text.replace(/\s+/g, "");
  if (compact === "0") return { status: "off" };
  if (compact === "-900") return { status: "disconnected" };
  if (compact === "-999") return { status: "not-zeroed" };
  if (/^999/.test(compact)) return { status: "error" };

  // Manual examples include spaced "14 -6", "47 0", "91 1", and compact "23-6".
  let match = text.match(/^([+-]?\d{1,3})\s+([+-]?\d{1,2})$/);
  if (!match) match = compact.match(/^([+-]?\d{2})([+-]\d{1,2})$/);
  if (!match) match = compact.match(/^(\d{2})(\d{1,2})$/);
  if (!match) return null;
  const mantissa = Number(match[1]);
  const exponent = Number(match[2]);
  const value = mantissa * 10 ** exponent;
  return Number.isFinite(value) && value > 0 ? { value, mantissa, exponent } : null;
}

function formatScientific(value) {
  if (!Number.isFinite(value) || value <= 0) return "—";
  const exponent = Math.floor(Math.log10(value));
  const mantissa = value / 10 ** exponent;
  const exp = String(exponent).replace("-", "−");
  return `${mantissa.toFixed(1)} × 10<sup>${exp}</sup>`;
}

function updateReading(gauge) {
  const points = state.data[gauge];
  if (!points.length) return;
  const latest = points.at(-1).value;
  $(`#${gauge}Value`).innerHTML = formatScientific(latest);
  const prior = points.find((point) => point.time >= points.at(-1).time - 30000) || points[0];
  const change = ((latest - prior.value) / prior.value) * 100;
  const trend = $(`#${gauge}Trend`);
  trend.textContent = `${change <= 0 ? "↘" : "↗"} ${Math.abs(change).toFixed(1)}%`;
  trend.className = `trend ${change <= 0 ? "down" : "up"}`;
}

function setStatus(kind, message) {
  const status = $("#status");
  status.className = `status ${kind}`;
  status.querySelector("span").textContent = message;
}

async function connect() {
  if (state.connected) return disconnect();
  if (!("serial" in navigator)) {
    setStatus("error", "Web Serial unavailable");
    alert("Web Serial is not available. Open this app in Chrome or Edge over HTTPS or localhost.");
    return;
  }
  try {
    const port = await navigator.serial.requestPort();
    await port.open({ baudRate: 9600, dataBits: 8, stopBits: 1, parity: "none", flowControl: "none" });
    state.port = port;
    state.connected = true;
    state.demo = false;
    stopDemo();
    state.sessionStarted = Date.now();
    $("#connectButton").textContent = "Disconnect";
    $("#demoButton").textContent = "Start demo";
    $("#sessionLabel").textContent = "Hardware session · live";
    setStatus("connected", "Terranova 934 connected");
    readLoop();
    startPolling();
  } catch (error) {
    if (error.name !== "NotFoundError") setStatus("error", error.message || "Connection failed");
  }
}

async function disconnect() {
  state.connected = false;
  clearInterval(state.pollTimer);
  try { await state.reader?.cancel(); } catch {}
  try { state.reader?.releaseLock(); } catch {}
  try { state.writer?.releaseLock(); } catch {}
  try { await state.port?.close(); } catch {}
  state.reader = state.writer = state.port = null;
  $("#connectButton").innerHTML = '<span class="usb-icon">⌁</span> Connect device';
  $("#sessionLabel").textContent = "Session paused";
  setStatus("", "Device disconnected");
}

async function readLoop() {
  const decoder = new TextDecoder();
  state.reader = state.port.readable.getReader();
  try {
    while (state.connected) {
      const { value, done } = await state.reader.read();
      if (done) break;
      state.buffer += decoder.decode(value, { stream: true });
      const lines = state.buffer.split(/\r\n|\r|\n/);
      state.buffer = lines.pop();
      for (const line of lines) handleResponse(line);
      // Some firmware responses may arrive without a terminator.
      if (state.buffer && parsePressure(state.buffer)) {
        handleResponse(state.buffer);
        state.buffer = "";
      }
    }
  } catch (error) {
    if (state.connected) setStatus("error", `Read error: ${error.message}`);
  }
}

function handleResponse(line) {
  if (!state.pendingGauge) return;
  const parsed = parsePressure(line);
  if (!parsed) return;
  const gauge = state.pendingGauge;
  state.pendingGauge = null;
  state.pendingSince = 0;
  if (parsed.value) addPoint(gauge, Date.now(), parsed.value);
  else setStatus("error", `${GAUGES[gauge].label}: ${parsed.status}`);
}

function startPolling() {
  let index = 0;
  const gauges = Object.keys(GAUGES);
  const poll = async () => {
    if (!state.connected) return;
    if (state.pendingGauge && Date.now() - state.pendingSince < 1800) return;
    state.pendingGauge = null;
    const gauge = gauges[index++ % gauges.length];
    try {
      state.writer = state.port.writable.getWriter();
      state.pendingGauge = gauge;
      state.pendingSince = Date.now();
      await state.writer.write(new TextEncoder().encode(GAUGES[gauge].command));
      state.writer.releaseLock();
      state.writer = null;
    } catch (error) {
      state.pendingGauge = null;
      state.pendingSince = 0;
      setStatus("error", `Write error: ${error.message}`);
    }
  };
  poll();
  state.pollTimer = setInterval(poll, 650);
}

function startDemo() {
  if (state.connected) return;
  state.demo = true;
  $("#demoButton").textContent = "Stop demo";
  $("#sessionLabel").textContent = "Demo session · live";
  setStatus("", "Demo signal");
  state.demoTimer = setInterval(() => {
    const now = Date.now();
    const elapsed = (now - state.sessionStarted) / 1000;
    const last = (key, fallback) => state.data[key].at(-1)?.value || fallback;
    addPoint("ion", now, Math.max(1.2e-9, last("ion", 2e-7) * (.965 + Math.random() * .055)), false);
    addPoint("a", now, Math.max(8e-5, last("a", 3e-3) * (.982 + Math.random() * .04)), false);
    addPoint("b", now, 76 + Math.sin(elapsed / 15) * 9 + (Math.random() - .5) * 2, false);
    draw();
  }, 2000);
}

function stopDemo() {
  state.demo = false;
  clearInterval(state.demoTimer);
  $("#demoButton").textContent = "Start demo";
  if (!state.connected) {
    $("#sessionLabel").textContent = "Demo session · paused";
    setStatus("", "Demo paused");
  }
}

function draw() {
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  if (canvas.width !== rect.width * dpr || canvas.height !== rect.height * dpr) {
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const w = rect.width, h = rect.height;
  ctx.clearRect(0, 0, w, h);
  const pad = { left: 58, right: 15, top: 15, bottom: 28 };
  const pw = w - pad.left - pad.right, ph = h - pad.top - pad.bottom;
  const maxLog = 3, minLog = -10;
  const end = Date.now(), start = end - state.activeRange * 1000;
  const x = (time) => pad.left + ((time - start) / (end - start)) * pw;
  const y = (value) => pad.top + ((maxLog - Math.log10(value)) / (maxLog - minLog)) * ph;
  const theme = getComputedStyle(document.documentElement);
  const gridStrong = theme.getPropertyValue("--grid-strong").trim();
  const gridSoft = theme.getPropertyValue("--grid-soft").trim();
  const chartLabel = theme.getPropertyValue("--chart-label").trim();

  ctx.font = "10px ui-sans-serif, system-ui";
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  for (let decade = maxLog; decade >= minLog; decade--) {
    const yy = pad.top + ((maxLog - decade) / (maxLog - minLog)) * ph;
    ctx.strokeStyle = decade % 2 === 0 ? gridStrong : gridSoft;
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(pad.left, yy); ctx.lineTo(w - pad.right, yy); ctx.stroke();
    if (decade % 2 === 0 || decade === minLog) {
      ctx.fillStyle = chartLabel;
      ctx.fillText(`10${superscript(decade)}`, pad.left - 12, yy);
    }
  }
  ctx.textAlign = "center"; ctx.textBaseline = "top"; ctx.fillStyle = chartLabel;
  for (let i = 0; i <= 5; i++) {
    const xx = pad.left + (pw * i) / 5;
    const timestamp = start + ((end - start) * i) / 5;
    ctx.fillText(new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }), xx, h - 19);
  }

  Object.entries(GAUGES).forEach(([key, gauge]) => {
    if (state.hidden.has(key)) return;
    const points = state.data[key].filter((p) => p.time >= start && p.value >= 1e-10 && p.value <= 1e3);
    if (points.length < 2) return;
    ctx.strokeStyle = gauge.color;
    ctx.lineWidth = 2.1;
    ctx.lineJoin = "round";
    ctx.beginPath();
    points.forEach((point, i) => i ? ctx.lineTo(x(point.time), y(point.value)) : ctx.moveTo(x(point.time), y(point.value)));
    ctx.stroke();
    const last = points.at(-1);
    ctx.fillStyle = gauge.color; ctx.beginPath(); ctx.arc(x(last.time), y(last.value), 3.4, 0, Math.PI * 2); ctx.fill();
  });
}

function superscript(n) {
  return String(n).replace("-", "⁻").replace(/\d/g, (d) => "⁰¹²³⁴⁵⁶⁷⁸⁹"[d]);
}

function exportCsv() {
  const rows = ["timestamp,gauge,pressure_torr"];
  Object.entries(state.data).forEach(([gauge, points]) => points.forEach((p) => {
    rows.push(`${new Date(p.time).toISOString()},${gauge},${p.value}`);
  }));
  const blob = new Blob([rows.join("\n")], { type: "text/csv" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `terranova-934-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(link.href);
}

$("#connectButton").addEventListener("click", connect);
themeToggle.addEventListener("click", () => {
  setTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
});
$("#demoButton").addEventListener("click", () => state.demo ? stopDemo() : startDemo());
$("#exportButton").addEventListener("click", exportCsv);
$("#rangeButtons").addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (!button) return;
  state.activeRange = Number(button.dataset.range);
  document.querySelectorAll("#rangeButtons button").forEach((b) => b.classList.toggle("selected", b === button));
  draw();
});
$("#legend").addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (!button) return;
  const gauge = button.dataset.gauge;
  state.hidden.has(gauge) ? state.hidden.delete(gauge) : state.hidden.add(gauge);
  button.classList.toggle("disabled", state.hidden.has(gauge));
  draw();
});
window.addEventListener("resize", draw);
navigator.serial?.addEventListener("disconnect", () => state.connected && disconnect());

seedDemo();
startDemo();
draw();
