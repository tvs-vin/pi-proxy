"use strict";

const loginView = document.getElementById("login-view");
const appView = document.getElementById("app-view");
const toastEl = document.getElementById("toast");

let statsTimer = null;

function toast(message, isError) {
  toastEl.textContent = message;
  toastEl.hidden = false;
  toastEl.className = "toast" + (isError ? " error" : "");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { toastEl.hidden = true; }, 3500);
}

async function api(path, options) {
  const opts = Object.assign({ headers: { "Content-Type": "application/json" } }, options);
  const res = await fetch(path, opts);
  let body = null;
  try { body = await res.json(); } catch (_) { /* no body */ }
  if (!res.ok) {
    const message = (body && body.error) || `Request failed (${res.status})`;
    throw new Error(message);
  }
  return body;
}

// --- Auth --------------------------------------------------------------

async function checkSession() {
  try {
    const status = await api("/api/session");
    if (status.authenticated) {
      showApp();
      return;
    }
  } catch (_) { /* fall through to login */ }
  showLogin();
}

function showLogin() {
  stopStatsPolling();
  loginView.hidden = false;
  appView.hidden = true;
}

function showApp() {
  loginView.hidden = true;
  appView.hidden = false;
  refreshActiveTab();
  startStatsPolling();
}

document.getElementById("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const password = document.getElementById("login-password").value;
  const errorEl = document.getElementById("login-error");
  errorEl.hidden = true;
  try {
    await api("/api/login", { method: "POST", body: JSON.stringify({ password }) });
    document.getElementById("login-password").value = "";
    showApp();
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.hidden = false;
  }
});

document.getElementById("logout-btn").addEventListener("click", async () => {
  await api("/api/logout", { method: "POST" });
  showLogin();
});

// --- Tabs ----------------------------------------------------------------

document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById("tab-" + btn.dataset.tab).classList.add("active");
    refreshActiveTab();
  });
});

function activeTabName() {
  const active = document.querySelector(".tab-btn.active");
  return active ? active.dataset.tab : "dashboard";
}

function refreshActiveTab() {
  const tab = activeTabName();
  if (tab === "wifi") loadWifi();
  else if (tab === "vpn") loadVpn();
  else if (tab === "upstream") loadUpstream();
}

// --- Dashboard / stats -----------------------------------------------------

function formatBytes(bps) {
  if (bps < 1024) return bps + " B/s";
  if (bps < 1024 * 1024) return (bps / 1024).toFixed(1) + " KB/s";
  return (bps / 1024 / 1024).toFixed(1) + " MB/s";
}

function formatUptime(seconds) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return (d ? d + "d " : "") + h + "h " + m + "m";
}

async function pollStats() {
  try {
    const s = await api("/api/stats");
    document.getElementById("stat-cpu").textContent = s.cpu_percent + "%";
    document.getElementById("stat-mem").textContent =
      s.memory.percent + "% (" + s.memory.used_mb.toFixed(0) + "/" + s.memory.total_mb.toFixed(0) + " MB)";
    document.getElementById("stat-uptime").textContent = formatUptime(s.uptime_seconds);
    document.getElementById("stat-load").textContent = s.load_average.map((n) => n.toFixed(2)).join(" / ");
    document.getElementById("stat-ap-net").textContent =
      "↓" + formatBytes(s.ap_net.rx_bps) + " ↑" + formatBytes(s.ap_net.tx_bps);
    document.getElementById("stat-up-net").textContent =
      "↓" + formatBytes(s.upstream_net.rx_bps) + " ↑" + formatBytes(s.upstream_net.tx_bps);

    const tbody = document.querySelector("#clients-table tbody");
    tbody.innerHTML = "";
    document.getElementById("clients-empty").hidden = s.clients.length > 0;
    s.clients.forEach((c) => {
      const tr = document.createElement("tr");
      tr.innerHTML =
        "<td>" + escapeHtml(c.hostname || "unknown") + "</td>" +
        "<td>" + escapeHtml(c.ip) + "</td>" +
        "<td>" + escapeHtml(c.mac) + "</td>";
      tbody.appendChild(tr);
    });
  } catch (err) {
    if (err.message.includes("authentication")) showLogin();
  }
}

function startStatsPolling() {
  stopStatsPolling();
  pollStats();
  statsTimer = setInterval(pollStats, 3000);
}

function stopStatsPolling() {
  if (statsTimer) clearInterval(statsTimer);
  statsTimer = null;
}

// Pause polling when the tab is hidden to save CPU/battery on the Pi and client.
document.addEventListener("visibilitychange", () => {
  if (document.hidden) stopStatsPolling();
  else if (!appView.hidden) startStatsPolling();
});

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str == null ? "" : String(str);
  return div.innerHTML;
}

// --- WiFi ------------------------------------------------------------------

async function loadWifi() {
  const statusEl = document.getElementById("wifi-status");
  try {
    const status = await api("/api/wifi/status");
    statusEl.textContent = status.connected
      ? "Connected to " + status.ssid + (status.ip4 ? " (" + status.ip4 + ")" : "")
      : "Not connected";
  } catch (err) {
    statusEl.textContent = "Status unavailable: " + err.message;
  }
  await scanWifi();
}

async function scanWifi() {
  const list = document.getElementById("wifi-list");
  list.innerHTML = "<li>Scanning…</li>";
  try {
    const networks = await api("/api/wifi/scan");
    list.innerHTML = "";
    if (networks.length === 0) {
      list.innerHTML = "<li>No networks found</li>";
      return;
    }
    networks.forEach((net) => {
      const li = document.createElement("li");
      const secure = net.security && net.security !== "" && net.security !== "--";
      li.innerHTML =
        '<span class="name">' + escapeHtml(net.ssid) + "</span>" +
        '<span class="muted">' + net.signal + "% " + (secure ? "🔒" : "open") + "</span>" +
        (net.in_use ? '<span class="badge active">connected</span>' : "");
      if (!net.in_use) {
        const btn = document.createElement("button");
        btn.textContent = "Connect";
        btn.addEventListener("click", () => connectWifi(net.ssid, secure));
        li.appendChild(btn);
      }
      list.appendChild(li);
    });
  } catch (err) {
    list.innerHTML = "<li>" + escapeHtml(err.message) + "</li>";
  }
}

async function connectWifi(ssid, secure) {
  let password = null;
  if (secure) {
    password = prompt("Password for " + ssid + ":");
    if (password === null) return;
  }
  try {
    await api("/api/wifi/connect", { method: "POST", body: JSON.stringify({ ssid, password }) });
    toast("Connecting to " + ssid + "…");
    setTimeout(loadWifi, 3000);
  } catch (err) {
    toast(err.message, true);
  }
}

document.getElementById("wifi-scan-btn").addEventListener("click", scanWifi);

// --- VPN ---------------------------------------------------------------------

async function loadVpn() {
  const list = document.getElementById("vpn-list");
  list.innerHTML = "<li>Loading…</li>";
  try {
    const connections = await api("/api/vpn");
    list.innerHTML = "";
    if (connections.length === 0) {
      list.innerHTML = "<li>No VPN connections configured</li>";
      return;
    }
    connections.forEach((c) => {
      const li = document.createElement("li");
      li.innerHTML =
        '<span class="name">' + escapeHtml(c.name) + "</span>" +
        '<span class="muted">' + escapeHtml(c.type) + "</span>" +
        '<span class="badge' + (c.active ? " active" : "") + '">' + (c.active ? "active" : "inactive") + "</span>";
      const toggleBtn = document.createElement("button");
      toggleBtn.textContent = c.active ? "Disconnect" : "Connect";
      toggleBtn.addEventListener("click", () => toggleVpn(c.name, c.active));
      li.appendChild(toggleBtn);
      list.appendChild(li);
    });
  } catch (err) {
    list.innerHTML = "<li>" + escapeHtml(err.message) + "</li>";
  }
}

async function toggleVpn(name, active) {
  try {
    await api("/api/vpn/" + encodeURIComponent(name) + "/" + (active ? "deactivate" : "activate"), { method: "POST" });
    toast((active ? "Disconnected " : "Connected ") + name);
    loadVpn();
  } catch (err) {
    toast(err.message, true);
  }
}

document.getElementById("vpn-import-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const type = document.getElementById("vpn-type").value;
  const fileInput = document.getElementById("vpn-file");
  if (!fileInput.files.length) return;
  const formData = new FormData();
  formData.append("type", type);
  formData.append("file", fileInput.files[0]);
  try {
    const res = await fetch("/api/vpn/import", { method: "POST", body: formData });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || "Import failed");
    toast("Imported " + body.name);
    fileInput.value = "";
    loadVpn();
  } catch (err) {
    toast(err.message, true);
  }
});

// --- Upstream device ---------------------------------------------------------

async function loadUpstream() {
  try {
    const cfg = await api("/api/upstream");
    document.querySelector('input[name="method"][value="' + (cfg.method === "manual" ? "manual" : "auto") + '"]').checked = true;
    document.getElementById("upstream-address").value = cfg.address || "";
    document.getElementById("upstream-gateway").value = cfg.gateway || "";
    document.getElementById("upstream-dns").value = (cfg.dns || []).join(", ");
    toggleUpstreamFields();
  } catch (err) {
    toast(err.message, true);
  }
}

function toggleUpstreamFields() {
  const manual = document.querySelector('input[name="method"]:checked').value === "manual";
  document.getElementById("upstream-manual-fields").hidden = !manual;
}

document.querySelectorAll('input[name="method"]').forEach((el) => el.addEventListener("change", toggleUpstreamFields));

document.getElementById("upstream-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const method = document.querySelector('input[name="method"]:checked').value;
  const payload = { method };
  if (method === "manual") {
    payload.address = document.getElementById("upstream-address").value.trim();
    payload.gateway = document.getElementById("upstream-gateway").value.trim();
    payload.dns = document.getElementById("upstream-dns").value.split(",").map((s) => s.trim()).filter(Boolean);
  }
  try {
    await api("/api/upstream", { method: "POST", body: JSON.stringify(payload) });
    toast("Upstream configuration applied");
  } catch (err) {
    toast(err.message, true);
  }
});

checkSession();
