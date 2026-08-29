document.addEventListener('DOMContentLoaded', async () => {
  const statusEl = document.getElementById('status');
  const networksEl = document.getElementById('networks');
  const connectForm = document.getElementById('connectForm');
  const ssidInput = document.getElementById('ssid');
  const passwordInput = document.getElementById('password');
  const refreshBtn = document.getElementById('refreshBtn');
  const hotspotBtn = document.getElementById('hotspotBtn');
  const messageEl = document.getElementById('message');
  const speedValueEl = document.getElementById('speedValue');
  const connectedValueEl = document.getElementById('connectedValue');
  const speedChartEl = document.getElementById('speedChart');
  const deviceChartEl = document.getElementById('deviceChart');

  const speedHistory = [];
  const deviceHistory = [];
  const MAX_POINTS = 20;
  function showMessage(text, isError = false) {
    messageEl.textContent = text;
    messageEl.classList.toggle('error', isError);
  }

  function renderStatus(data) {
    const connected = data.connectedNetwork ? data.connectedNetwork : 'None';
    const mode = data.mode || 'standby';
    const hotspot = data.hotspotEnabled ? 'Enabled' : 'Disabled';

    statusEl.innerHTML = `
      <strong>Mode:</strong> ${mode}<br>
      <strong>Hotspot:</strong> ${hotspot}<br>
      <strong>Connected network:</strong> ${connected}<br>
      <strong>AP interface:</strong> ${data.apInterface || 'n/a'}<br>
      <strong>Client interface:</strong> ${data.clientInterface || 'n/a'}
    `;
  }

  function renderNetworks(networks) {
    if (!Array.isArray(networks) || !networks.length) {
      networksEl.innerHTML = '<div class="empty-state">No Wi‑Fi networks found. Refresh or check the Pi radio state.</div>';
      return;
    }

    networksEl.innerHTML = networks
      .map((network) => {
        const signalBar = network.signal >= -50 ? '●●●●' : network.signal >= -70 ? '●●●' : network.signal >= -80 ? '●●' : '●';
        const securityText = network.security && network.security !== 'Open' ? network.security : 'Open';

        return `
          <button class="network-card" type="button" data-ssid="${network.ssid}">
            <div class="network-main">
              <div>
                <div class="network-name">${network.ssid}</div>
                <div class="network-meta">${securityText} • ${network.channel ? 'Ch ' + network.channel : 'Auto'}</div>
              </div>
            </div>
            <div class="network-signal">${signalBar}</div>
          </button>
        `;
      })
      .join('');

    networksEl.querySelectorAll('.network-card').forEach((card) => {
      card.addEventListener('click', () => {
        ssidInput.value = card.dataset.ssid;
        window.scrollTo({ top: 0, behavior: 'smooth' });
      });
    });
  }

  function drawLineChart(svg, values, color, maxValue) {
    const width = 420;
    const height = 160;
    const padding = 18;
    if (!values.length) {
      svg.innerHTML = '<text x="50%" y="50%" text-anchor="middle" fill="#9fbad0" font-size="12">Waiting for data...</text>';
      return;
    }

    const max = maxValue || Math.max(...values, 1);
    const points = values.map((value, index) => {
      const x = padding + (index * (width - padding * 2)) / Math.max(values.length - 1, 1);
      const y = height - padding - (value / max) * (height - padding * 2);
      return `${x},${y}`;
    }).join(' ');

    const areaPoints = [
      `${padding},${height - padding}`,
      ...points.split(' '),
      `${width - padding},${height - padding}`
    ].join(' ');

    svg.innerHTML = `
      <defs>
        <linearGradient id="chart-gradient" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stop-color="${color}" stop-opacity="0.35" />
          <stop offset="100%" stop-color="${color}" stop-opacity="0.02" />
        </linearGradient>
      </defs>
      <polyline fill="none" stroke="${color}" stroke-width="3" points="${points}" />
      <polygon points="${areaPoints}" fill="url(#chart-gradient)" />
    `;
  }

  function updateLiveMetrics(data) {
    const speed = Number(data.connection?.combinedSpeedMbps || data.traffic?.downloadMbps || 0);
    const devices = Number(data.clients?.connectedDevices || 0);

    speedValueEl.textContent = `${speed.toFixed(1)} Mbps`;
    connectedValueEl.textContent = String(devices);

    speedHistory.push(speed);
    deviceHistory.push(devices);

    if (speedHistory.length > MAX_POINTS) {
      speedHistory.shift();
    }

    if (deviceHistory.length > MAX_POINTS) {
      deviceHistory.shift();
    }

    drawLineChart(speedChartEl, speedHistory, '#44baf5', 100);
    drawLineChart(deviceChartEl, deviceHistory, '#66d9a8', Math.max(10, Math.max(...deviceHistory, 1)));
  }

  async function loadStatus() {
    try {
      const response = await fetch('/api/status');
      const data = await response.json();
      renderStatus(data);
      renderNetworks(data.wifiNetworks || []);
    } catch (error) {
      showMessage('Unable to read system status.', true);
    }
  }

  async function refreshNetworks() {
    try {
      const response = await fetch('/api/networks');
      const data = await response.json();
      renderNetworks(data.networks || []);
      showMessage(`Found ${data.networks?.length || 0} Wi‑Fi networks.`);
    } catch (error) {
      showMessage('Wi‑Fi scan failed on this device.', true);
    }
  }

  async function fetchLiveData() {
    try {
      const response = await fetch('/api/live-data');
      const data = await response.json();
      updateLiveMetrics(data);
    } catch (error) {
      showMessage('Live metrics feed unavailable.', true);
    }
  }

  connectForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const ssid = ssidInput.value.trim();
    const password = passwordInput.value.trim();

    if (!ssid) {
      showMessage('Select or enter a Wi‑Fi network name first.', true);
      return;
    }

    try {
      showMessage('Connecting to network...');
      const response = await fetch('/api/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ssid, password })
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'Connection failed.');
      }

      showMessage(`Connected to ${data.ssid}.`);
      await loadStatus();
    } catch (error) {
      showMessage(error.message || 'Connection request failed.', true);
    }
  });

  hotspotBtn.addEventListener('click', async () => {
    try {
      showMessage('Starting hotspot...');
      const response = await fetch('/api/start-hotspot', { method: 'POST' });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Hotspot could not be started.');
      }

      showMessage(`Hotspot started: ${data.ssid}. Password: ${data.password}`);
      await loadStatus();
    } catch (error) {
      showMessage(error.message || 'Unable to start hotspot.', true);
    }
  });

  refreshBtn.addEventListener('click', refreshNetworks);
  await loadStatus();
  await refreshNetworks();
  await fetchLiveData();
  setInterval(fetchLiveData, 3000);
});
