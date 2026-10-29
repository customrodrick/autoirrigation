
/* ============================================================
   AUTOIRRIGATION LIVE DASHBOARD
   ESP32 + Firebase Realtime Database

   Sensors:
   - Soil moisture sensor
   - Tank ultrasonic sensor

   Outputs:
   - Water pump
   - Solenoid valve
   - Green LED
   - Orange LED

   Firebase paths:
   /AutoIrrigation/latest
   /AutoIrrigation/history
   ============================================================ */

// 1. FIREBASE SDK IMPORTS

import {
  initializeApp
} from "firebase/app";

import {
  getDatabase,
  ref,
  onValue,
  query,
  limitToLast
} from "firebase/database";


// 2. FIREBASE CONFIGURATION
// Retained from your existing project.

const firebaseConfig = {
  apiKey: import.meta.env.VITE_API_KEY,
  authDomain: import.meta.env.VITE_AUTH_DOMAIN,
  databaseURL: import.meta.env.VITE_DB_URL,
  projectId: import.meta.env.VITE_PROJECT_ID,   
  storageBucket: import.meta.env.VITE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_APP_ID,
  measurementId: import.meta.env.VITE_MEASUREMENT_ID
};


// 3. INITIALIZE FIREBASE

const app = initializeApp(firebaseConfig);
const database = getDatabase(app);


// 4. GENERAL SETTINGS

const $ = id => document.getElementById(id);

const CACHE_KEY = import.meta.env.VITE_CACHE_KEY;
const HISTORY_LIMIT = 20;
const STALE_AFTER_MS = 30000;

let chart = null;
let chartLabels = [];
let chartValues = [];

let firebaseConnected = false;
let firebaseError = false;

let latestData = null;
let lastSnapshotAt = null;
let lastDeviceTimestamp = null;
let previousSignature = null;
let initialSnapshotReceived = false;


// 5. GENERAL HELPER FUNCTIONS

function setText(id, value) {
  const element = $(id);

  if (element) {
    element.textContent = value;
  }
}

function setChip(id, label, status = "neutral") {
  const element = $(id);

  if (!element) return;

  element.textContent = label;
  element.className = "status-chip " + status;
}

function setDot(id, status = "") {
  const element = $(id);

  if (!element) return;

  element.className = "status-dot";

  if (status) {
    element.classList.add(status);
  }
}

function formatTime(timestamp) {
  if (!timestamp || !Number.isFinite(Number(timestamp))) {
    return "--";
  }

  return new Date(Number(timestamp)).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
}

function parseTimestamp(data) {
  const value =
    data.timestamp ??
    data.lastSeen ??
    data.updatedAt ??
    data.lastUpdated;

  if (value === undefined || value === null) {
    return null;
  }

  if (typeof value === "string" && isNaN(Number(value))) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  let timestamp = Number(value);

  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    return null;
  }

  // Convert Unix seconds to milliseconds.
  if (timestamp < 1000000000000) {
    timestamp *= 1000;
  }

  return timestamp;
}

function isTrue(value) {
  return value === true ||
    ["true", "on", "1", "active", "running"].includes(
      String(value).trim().toLowerCase()
    );
}

function normalizeStatus(value) {
  return String(value ?? "").trim().toUpperCase();
}


// 6. SOIL MOISTURE HISTORY CHART

function initializeChart() {
  const canvas = $("moisture-chart");

  if (!canvas || typeof Chart === "undefined") {
    console.warn("Chart.js or moisture-chart element is missing.");
    return;
  }

  chart = new Chart(canvas, {
    type: "line",

    data: {
      labels: chartLabels,

      datasets: [{
        label: "Soil Moisture",
        data: chartValues,
        borderColor: "#27875b",
        backgroundColor: "rgba(39,135,91,0.10)",
        fill: true,
        tension: 0.35,
        borderWidth: 2,
        pointRadius: 3
      }]
    },

    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,

      plugins: {
        legend: {
          display: false
        }
      },

      scales: {
        x: {
          grid: {
            display: false
          }
        },

        y: {
          min: 0,
          max: 100,

          ticks: {
            callback: value => value + "%"
          }
        }
      }
    }
  });
}

function addHistoryPoint(value, timestamp) {
  if (!Number.isFinite(value) || value < 0 || value > 100) {
    return;
  }

  chartLabels.push(formatTime(timestamp || Date.now()));
  chartValues.push(Math.round(value));

  while (chartLabels.length > HISTORY_LIMIT) {
    chartLabels.shift();
    chartValues.shift();
  }

  if (chart) {
    chart.update();
  }

  saveCache();
}


// 7. SOIL MOISTURE DISPLAY

function updateSoil(data, recordHistory = false) {
  const moisture = Number(data.soilMoisture);

  const valid =
    data.soilSensorValid !== false &&
    data.soilMoisture !== null &&
    data.soilMoisture !== undefined &&
    data.soilMoisture !== "" &&
    Number.isFinite(moisture) &&
    moisture >= 0 &&
    moisture <= 100;

  if (!valid) {
    setText("moisture-value", "--");
    setText("moisture-state", "Soil sensor fault");

    const bar = $("moisture-bar");
    if (bar) bar.style.width = "0%";
  } else {
    setText("moisture-value", Math.round(moisture));

    const bar = $("moisture-bar");
    if (bar) bar.style.width = moisture + "%";

    if (moisture < 30) {
      setText("moisture-state", "Very dry — irrigation may be needed");
    } else if (moisture < 50) {
      setText("moisture-state", "Moderate moisture");
    } else {
      setText("moisture-state", "Soil is sufficiently moist");
    }

    if (recordHistory) {
      addHistoryPoint(moisture, lastDeviceTimestamp || Date.now());
    }
  }

  setText(
    "raw-value",
    data.rawSensorValue !== undefined
      ? "Raw: " + data.rawSensorValue
      : "Raw: --"
  );

  setText(
    "soil-sensor-text",
    valid
      ? "Soil sensor reading is valid."
      : "FAULT: Soil moisture reading is invalid."
  );
}


// 8. TANK WATER LEVEL DISPLAY

function updateTank(data) {
  const level = Number(data.tankLevel);
  const distance = Number(data.tankDistanceCm);

  const valid =
    data.tankSensorValid === true &&
    data.tankLevel !== null &&
    data.tankLevel !== undefined &&
    Number.isFinite(level) &&
    level >= 0 &&
    level <= 100;

  if (!valid) {
    setText("tank-value", "--");
    setText("tank-state", "Ultrasonic sensor fault");

    const bar = $("tank-bar");
    if (bar) bar.style.width = "0%";
  } else {
    setText("tank-value", Math.round(level));

    const bar = $("tank-bar");
    if (bar) bar.style.width = level + "%";

    if (level <= 30) {
      setText("tank-state", "LOW WATER LEVEL");
    } else if (level >= 85) {
      setText("tank-state", "Tank nearly full");
    } else {
      setText("tank-state", "Water available");
    }
  }

  setText(
    "tank-distance",
    Number.isFinite(distance) && distance >= 0
      ? "Distance: " + distance.toFixed(1) + " cm"
      : "Distance: invalid"
  );

  setText(
    "tank-sensor-text",
    valid
      ? "Ultrasonic sensor is reporting valid data."
      : "FAULT: Tank measurement is invalid or missing."
  );
}


// 9. WATER PUMP STATUS

function updatePump(data) {
  const status = normalizeStatus(data.pumpStatus);

  const known = ["ON", "OFF"].includes(status);
  const running = status === "ON";

  setText("pump-value", known ? status : "--");

  setDot(
    "pump-indicator",
    !known ? "" : running ? "on" : "off"
  );

  setChip(
    "pump-chip",
    !known ? "UNKNOWN" : running ? "RUNNING" : "STOPPED",
    !known ? "neutral" : running ? "good" : "neutral"
  );

  setText(
    "pump-description",
    !known
      ? "Pump status has not been received."
      : running
        ? "Pump is reported ON for filling the reservoir."
        : "Pump is reported OFF."
  );
}


// 10. SOLENOID VALVE STATUS

function updateValve(data) {
  const status = normalizeStatus(data.solenoidStatus);

  const known = ["OPEN", "CLOSED"].includes(status);
  const open = status === "OPEN";

  setText("valve-value", known ? status : "--");

  setDot(
    "valve-indicator",
    !known ? "" : open ? "on" : "off"
  );

  setChip(
    "valve-chip",
    !known ? "UNKNOWN" : open ? "OPEN" : "CLOSED",
    !known ? "neutral" : open ? "good" : "neutral"
  );

  setText(
    "valve-description",
    !known
      ? "Valve status has not been received."
      : open
        ? "Valve is open; water can flow to the field."
        : "Valve is closed; irrigation flow is stopped."
  );
}


// 11. LED STATUS

function updateLED(prefix, value) {
  const known = value !== undefined && value !== null;
  const active = isTrue(value);

  setText(
    prefix + "-value",
    !known ? "--" : active ? "ON" : "OFF"
  );

  setDot(
    prefix + "-indicator",
    !known ? "" : active ? "on" : "off"
  );

  setChip(
    prefix + "-chip",
    !known ? "UNKNOWN" : active ? "ACTIVE" : "INACTIVE",
    !known ? "neutral" : active ? "good" : "neutral"
  );
}


// 12. SYSTEM AND WIFI DIAGNOSTICS

function updateDiagnostics(data) {
  const system = normalizeStatus(data.systemStatus);
  const wifi = normalizeStatus(data.wifiStatus);

  const tankFault = data.tankSensorValid === false;
  const soilFault = data.soilSensorValid === false;

  const systemFault =
    system === "SENSOR_FAULT" ||
    system === "FAULT" ||
    tankFault ||
    soilFault;

  setText("system-value", system || "--");

  setDot(
    "system-indicator",
    systemFault ? "warn" : system === "NORMAL" ? "on" : ""
  );

  setChip(
    "system-chip",
    systemFault ? "SENSOR FAULT" : system || "UNKNOWN",
    systemFault ? "warn" : system === "NORMAL" ? "good" : "neutral"
  );

  setText(
    "system-description",
    systemFault
      ? "Check the sensor readings and wiring before relying on automatic irrigation."
      : "System status reported by the ESP32."
  );

  setText("wifi-value", wifi || "--");

  setDot(
    "wifi-indicator",
    wifi === "CONNECTED" ? "on" :
      wifi ? "warn" : ""
  );

  setChip(
    "wifi-chip",
    wifi || "UNKNOWN",
    wifi === "CONNECTED" ? "good" :
      wifi ? "warn" : "neutral"
  );

  setText(
    "wifi-description",
    wifi === "CONNECTED"
      ? "ESP32 reports Wi-Fi connected."
      : wifi
        ? "ESP32 reports Wi-Fi status: " + wifi
        : "Wi-Fi status has not been reported."
  );

  const faults = [];

  if (tankFault) faults.push("tank ultrasonic sensor");
  if (soilFault) faults.push("soil moisture sensor");

  setText(
    "fault-notice",
    systemFault
      ? "FAULT DETECTED: " + faults.join(" and ") +
        (faults.length ? "." : " Check ESP32 system status.")
      : "No sensor fault is reported. Verify physical sensor readings during testing."
  );
}


// 13. UPDATE THE COMPLETE DASHBOARD

function renderDashboard(data, addHistory = false) {
  if (!data || typeof data !== "object") return;

  updateSoil(data, addHistory);
  updateTank(data);
  updatePump(data);
  updateValve(data);

  updateLED("green", data.greenLED);
  updateLED("orange", data.orangeLED);

  updateDiagnostics(data);

  setText(
    "last-updated",
    "Updated at " + formatTime(lastSnapshotAt)
  );

  setText(
    "connection-time",
    formatTime(lastSnapshotAt)
  );

  updateDeviceStatus(data);
}


// 14. FIREBASE CONNECTION STATUS

function updateFirebaseStatus(connected, error = null) {
  firebaseConnected = connected;
  firebaseError = !!error;

  const label = connected
    ? "CONNECTED"
    : error
      ? "ERROR"
      : "CONNECTING";

  const css = connected
    ? "good"
    : error
      ? "warn"
      : "neutral";

  setChip("connection-chip", label, css);

  setText(
    "connection-text",
    connected
      ? "Firebase Realtime Database listener is connected."
      : error
        ? "Firebase error: " + error
        : "Connecting to Firebase..."
  );

  setText("firebase-status-label", "Firebase " + label.toLowerCase());

  setText(
    "firebase-status-detail",
    connected ? "Listening for live updates" : error || "Connecting..."
  );

  const dot = $("firebase-status-dot");

  if (dot) {
    dot.className = "pulse " + css;
  }

  updateOverallStatus();
}

function updateOverallStatus() {
  const pill = $("live-status-pill");
  const label = $("live-status-label");

  if (!pill || !label) return;

  let text = "CONNECTING";
  let css = "neutral";

  if (!navigator.onLine || firebaseError) {
    text = "OFFLINE";
    css = "warn";
  } else if (!firebaseConnected) {
    text = "CONNECTING";
    css = "neutral";
  } else if (
    lastDeviceTimestamp &&
    Date.now() - lastDeviceTimestamp < STALE_AFTER_MS
  ) {
    text = "LIVE DATA";
    css = "good";
  } else if (lastDeviceTimestamp) {
    text = "OFFLINE";
    css = "warn";
  } else {
    text = "DATABASE CONNECTED";
    css = "neutral";
  }

  label.textContent = text;
  pill.className = "live-pill " + css;
}

function updateDeviceStatus(data) {
  if (!data) return;

  const timestamp = parseTimestamp(data);

  if (timestamp) {
    lastDeviceTimestamp = timestamp;
  }

  if (!lastDeviceTimestamp) {
    setText(
      "device-status-text",
      "Data received, but a device timestamp or heartbeat is needed to verify freshness."
    );
  } else {
    const age = Date.now() - lastDeviceTimestamp;

    setText(
      "device-status-text",
      age >= 0 && age < STALE_AFTER_MS
        ? "Recent device heartbeat received at " + formatTime(lastDeviceTimestamp) + "."
        : "Data may be stale. Last device timestamp: " + formatTime(lastDeviceTimestamp) + "."
    );
  }

  updateOverallStatus();
}


// 15. SAVE AND RESTORE BROWSER CACHE

function saveCache() {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({
      latest: latestData,
      receivedAt: lastSnapshotAt,
      history: chartLabels.map((label, i) => ({
        label,
        value: chartValues[i]
      }))
    }));
  } catch (error) {
    console.warn("Could not save dashboard cache:", error);
  }
}

function loadCache() {
  try {
    const cache = JSON.parse(
      localStorage.getItem(CACHE_KEY) || "null"
    );

    if (!cache) return;

    if (Array.isArray(cache.history)) {
      cache.history.slice(-HISTORY_LIMIT).forEach(point => {
        if (
          point &&
          typeof point.label === "string" &&
          Number.isFinite(Number(point.value))
        ) {
          chartLabels.push(point.label);
          chartValues.push(Number(point.value));
        }
      });
    }

    if (cache.latest && typeof cache.latest === "object") {
      latestData = cache.latest;
      lastSnapshotAt = cache.receivedAt || null;

      renderDashboard(latestData, false);

      setText(
        "last-updated",
        "Showing cached data · " + formatTime(lastSnapshotAt)
      );
    }
  } catch (error) {
    console.warn("Could not restore cached data:", error);
  }
}


// 16. LISTEN TO FIREBASE LIVE DATA

function startFirebaseListeners() {
  // Monitor actual Firebase connection.
  onValue(
    ref(database, ".info/connected"),

    snapshot => {
      updateFirebaseStatus(snapshot.val() === true);
    },

    error => {
      console.error("Firebase connection error:", error);
      updateFirebaseStatus(false, error.message);
    }
  );

  // Listen to the current ESP32 readings.
  onValue(
    ref(database, "AutoIrrigation/latest"),

    snapshot => {
      const data = snapshot.val();

      if (!data || typeof data !== "object") {
        setText(
          "device-status-text",
          "No data found at /AutoIrrigation/latest."
        );
        return;
      }

      const signature = JSON.stringify(data);
      const changed = signature !== previousSignature;

      previousSignature = signature;
      lastSnapshotAt = Date.now();
      latestData = data;

      const timestamp = parseTimestamp(data);

      if (timestamp) {
        lastDeviceTimestamp = timestamp;
      } else if (changed) {
        // This records when the browser received a changed value.
        // It does not prove the ESP32 is continuously online.
        lastDeviceTimestamp = Date.now();
      }

      renderDashboard(
        data,
        initialSnapshotReceived && changed
      );

      initialSnapshotReceived = true;

      saveCache();

      console.log("Latest ESP32 data:", data);
    },

    error => {
      console.error("Latest data listener error:", error);
      updateFirebaseStatus(false, error.message);
    }
  );

  // Read only the last 20 history entries.
  onValue(
    query(
      ref(database, "AutoIrrigation/history"),
      limitToLast(HISTORY_LIMIT)
    ),

    snapshot => {
      const history = snapshot.val();

      if (!history || typeof history !== "object") return;

      // Do not replace history already restored from the browser cache.
      if (chartLabels.length > 0) return;

      const entries = Object.values(history);

      entries.forEach(row => {
        if (!row || row.soilSensorValid === false) return;

        const moisture = Number(row.soilMoisture);

        if (
          !Number.isFinite(moisture) ||
          moisture < 0 ||
          moisture > 100
        ) return;

        chartLabels.push(
          formatTime(parseTimestamp(row) || Date.now())
        );

        chartValues.push(Math.round(moisture));
      });

      while (chartLabels.length > HISTORY_LIMIT) {
        chartLabels.shift();
        chartValues.shift();
      }

      if (chart) chart.update();

      saveCache();
    },

    error => {
      console.warn("History could not be loaded:", error.message);
    }
  );
}


// 17. START THE DASHBOARD

function startDashboard() {
  loadCache();

  initializeChart();

  if (chart) {
    chart.update();
  }

  startFirebaseListeners();

  window.addEventListener("online", updateOverallStatus);
  window.addEventListener("offline", updateOverallStatus);

  // Refresh the freshness display every second.
  setInterval(() => {
    if (latestData) {
      updateDeviceStatus(latestData);
    } else {
      updateOverallStatus();
    }
  }, 1000);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", startDashboard);
} else {
  startDashboard();
}

// END OF AUTOIRRIGATION DASHBOARD
