const express = require('express');
const path = require('path');
const fs = require('fs');
const { exec, execFile } = require('child_process');

const app = express();
const PORT = process.env.PORT || 3000;
const AP_INTERFACE = process.env.AP_INTERFACE || 'wlan0';
const CLIENT_INTERFACE = process.env.CLIENT_INTERFACE || 'wlan1';
const AP_SSID = process.env.AP_SSID || 'Pi-Proxy';
const AP_PASSPHRASE = process.env.AP_PASSPHRASE || 'pi-proxy-setup';
const DATA_FEED_PATH = path.join(__dirname, 'live-data-feed.json');

const state = {
  mode: 'standby',
  connectedNetwork: null,
  apInterface: AP_INTERFACE,
  clientInterface: CLIENT_INTERFACE,
  upstreamInterface: CLIENT_INTERFACE,
  hotspotEnabled: false,
  wifiNetworks: []
};

app.use(express.json({ limit: '1mb' }));
app.use(express.static(__dirname));

function readLiveDataFeed() {
  try {
    const raw = fs.readFileSync(DATA_FEED_PATH, 'utf8');
    return JSON.parse(raw);
  } catch (error) {
    return {
      status: 'offline',
      timestamp: new Date().toISOString(),
      connection: {
        ssid: 'Not available',
        signalDbm: null,
        signalPercent: 0,
        quality: 'Unknown'
      },
      traffic: {
        downloadMbps: 0,
        uploadMbps: 0,
        totalRxBytes: 0,
        totalTxBytes: 0
      },
      clients: {
        connectedDevices: 0
      }
    };
  }
}

function runCommand(command, args = []) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { shell: false }, (error, stdout, stderr) => {
      if (error) {
        reject({
          command: `${command} ${args.join(' ')}`,
          error: error.message,
          stdout: stdout.trim(),
          stderr: stderr.trim()
        });
        return;
      }

      resolve({
        stdout: stdout.trim(),
        stderr: stderr.trim()
      });
    });
  });
}

function runShell(command) {
  return new Promise((resolve, reject) => {
    exec(command, (error, stdout, stderr) => {
      if (error) {
        reject({
          command,
          error: error.message,
          stdout: stdout.trim(),
          stderr: stderr.trim()
        });
        return;
      }

      resolve({
        stdout: stdout.trim(),
        stderr: stderr.trim()
      });
    });
  });
}

function parseNmcliNetworks(stdout) {
  return stdout
    .split(/\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split(':');
      return {
        ssid: parts[0] || 'Unknown SSID',
        security: parts[1] || 'Open',
        signal: Number(parts[2]) || 0,
        channel: parts[3] || null,
        isConnected: parts[4] === 'yes'
      };
    })
    .filter((net) => net.ssid && net.ssid !== 'SSID');
}

function parseIwlistNetworks(stdout) {
  const networks = [];
  const blocks = stdout.split(/\n\s*Cell\s+[0-9]+\s+-\s+Address:/g).slice(1);

  blocks.forEach((block) => {
    const ssidMatch = block.match(/ESSID:"([^"]+)"/);
    const signalMatch = block.match(/Signal level=([\-0-9]+)/);
    const securityMatch = block.match(/IE: IEEE 802\\.11i\/WPA2 Version 1/)
      ? 'WPA2'
      : block.includes('WEP')
        ? 'WEP'
        : block.includes('WPA')
          ? 'WPA'
          : 'Open';

    if (!ssidMatch) return;

    networks.push({
      ssid: ssidMatch[1],
      security: securityMatch,
      signal: signalMatch ? Number(signalMatch[1]) : 0,
      channel: null,
      isConnected: false
    });
  });

  return networks;
}

async function scanWifiNetworks() {
  const scans = [
    () => runCommand('nmcli', ['-t', '-f', 'SSID,SECURITY,SIGNAL,CHAN,IN-USE', 'device', 'wifi', 'list']),
    () => runCommand('iwlist', [AP_INTERFACE, 'scan'])
  ];

  for (const attempt of scans) {
    try {
      const { stdout } = await attempt();
      const networks = stdout.includes('SSID')
        ? parseNmcliNetworks(stdout)
        : parseIwlistNetworks(stdout);

      if (networks.length) {
        state.wifiNetworks = networks;
        return networks;
      }
    } catch (error) {
      // Keep trying lower-level fallbacks.
    }
  }

  state.wifiNetworks = [];
  return [];
}

async function getCurrentConnectionState() {
  try {
    const { stdout } = await runCommand('nmcli', ['-t', '-f', 'DEVICE,STATE,CONNECTION', 'device']);
    const lines = stdout.split(/\n/).map((line) => line.trim()).filter(Boolean);

    for (const line of lines) {
      const [device, stateName, connection] = line.split(':');
      if (device === state.clientInterface) {
        state.connectedNetwork = connection && connection !== '--' ? connection : null;
        if (stateName.includes('connected')) {
          state.mode = 'client';
        }
      }
    }
  } catch (error) {
    state.connectedNetwork = null;
  }
}

async function ensureIpForwarding() {
  const iptablesCommands = [
    `iptables -t nat -A POSTROUTING -o ${state.clientInterface} -j MASQUERADE`,
    `iptables -A FORWARD -i ${state.clientInterface} -o ${state.apInterface} -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT`,
    `iptables -A FORWARD -i ${state.apInterface} -o ${state.clientInterface} -j ACCEPT`,
    'sysctl -w net.ipv4.ip_forward=1'
  ];

  for (const command of iptablesCommands) {
    try {
      await runShell(command);
    } catch (error) {
      // This is expected on systems without iptables or when rules already exist.
    }
  }
}

async function startHotspot() {
  const commands = [
    `nmcli radio wifi on`,
    `rfkill unblock wlan`,
    `hostapd -B /etc/hostapd/hostapd.conf`
  ];

  for (const command of commands) {
    try {
      await runShell(command);
    } catch (error) {
      // The next command may still succeed or the system may not support hostapd yet.
    }
  }

  await ensureIpForwarding();
  state.hotspotEnabled = true;
  state.mode = 'hotspot';
  return {
    status: 'started',
    ssid: AP_SSID,
    password: AP_PASSPHRASE,
    apInterface: state.apInterface,
    upstreamInterface: state.clientInterface
  };
}

async function connectToWifi(ssid, password) {
  if (!ssid) {
    throw new Error('A Wi-Fi SSID is required.');
  }

  const safePassword = password || '';
  const wifiCommand = ['device', 'wifi', 'connect', ssid, 'password', safePassword, 'ifname', state.clientInterface];

  try {
    await runCommand('nmcli', wifiCommand);
  } catch (error) {
    if (!safePassword) {
      await runCommand('nmcli', ['device', 'wifi', 'connect', ssid, 'ifname', state.clientInterface]);
    } else {
      throw error;
    }
  }

  state.connectedNetwork = ssid;
  state.mode = 'client';
  state.hotspotEnabled = false;

  try {
    await ensureIpForwarding();
  } catch (error) {
    // NAT rules may already exist or iptables may not be available.
  }

  return { status: 'connected', ssid, interface: state.clientInterface };
}

app.get('/api/status', async (req, res) => {
  try {
    await getCurrentConnectionState();
  } catch (error) {
    // Ignore status errors and continue with the current state.
  }

  res.json({
    mode: state.mode,
    hotspotEnabled: state.hotspotEnabled,
    connectedNetwork: state.connectedNetwork,
    apInterface: state.apInterface,
    clientInterface: state.clientInterface,
    ssid: AP_SSID,
    password: AP_PASSPHRASE,
    wifiNetworks: state.wifiNetworks
  });
});

app.get('/api/networks', async (req, res) => {
  try {
    const networks = await scanWifiNetworks();
    res.json({ networks });
  } catch (error) {
    res.status(500).json({ error: 'Unable to scan Wi-Fi networks. Ensure NetworkManager or iwlist is installed.' });
  }
});

app.get('/api/live-data', (req, res) => {
  const liveData = readLiveDataFeed();
  const combinedSpeed = Number(liveData.traffic?.downloadMbps || 0) + Number(liveData.traffic?.uploadMbps || 0);

  res.json({
    ...liveData,
    connection: {
      ...liveData.connection,
      combinedSpeedMbps: combinedSpeed
    }
  });
});

app.post('/api/connect', async (req, res) => {
  const { ssid, password } = req.body || {};

  try {
    const result = await connectToWifi(ssid, password);
    res.json(result);
  } catch (error) {
    res.status(500).json({
      error: error.message || 'Unable to connect to the selected Wi‑Fi network.',
      details: error
    });
  }
});

app.post('/api/start-hotspot', async (req, res) => {
  try {
    const result = await startHotspot();
    res.json(result);
  } catch (error) {
    res.status(500).json({
      error: 'Unable to start the hotspot. Install hostapd and dnsmasq on Raspberry Pi OS and retry.',
      details: error
    });
  }
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, async () => {
  await scanWifiNetworks();
  await getCurrentConnectionState();
  console.log(`Pi-Proxy listening on http://0.0.0.0:${PORT}`);
  console.log('AP SSID:', AP_SSID);
  console.log('Web UI: http://<pi-ip>:' + PORT);
  console.log('Important: Pi 3B cannot do AP + client on the same Wi-Fi chipset. Use a USB Wi‑Fi adapter for the upstream connection or a second interface.');
});
