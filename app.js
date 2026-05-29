(async () => {
  async function loadRows(id, url) {
    const embedded = document.getElementById(id);
    if (embedded) return JSON.parse(embedded.textContent);
    return fetch(url).then(response => response.json());
  }
  const [admin, base] = await Promise.all([
    loadRows("admin-data", "data/map_admin.json"),
    loadRows("base-data", "data/map_base.json")
  ]);
  const all = admin;
  const canvas = document.getElementById("map");
  const ctx = canvas.getContext("2d");
  const tip = document.getElementById("tip");
  let showAdmin = true;
  let showLabels = true;
  let showBase = true;
  let showElevation = false;
  const elevationCache = new Map();
  let zoom = 0;
  let scale = 1;
  let center = { x: 0.5, y: 0.5 };
  let dragging = false;
  let dragStart = null;
  let lastHover = null;

  function mercator(lon, lat) {
    const x = (lon + 180) / 360;
    const s = Math.sin(lat * Math.PI / 180);
    const y = 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
    return { x, y };
  }
  function rank(row) {
    if (row.kind === "admin") return Math.max(1, 10 - Number(row.level || 9));
    return 3;
  }
  function minZoomFor(row) {
    const level = Number(row.level || 0);
    if (row.kind === "admin" && level <= 6) return -0.8;
    if (row.kind === "admin" && level === 8) return 1.05;
    if (row.kind === "admin" && level >= 9) return 2.05;
    return 2.25;
  }
  for (const row of all) {
    row.xy = mercator(row.lon, row.lat);
    row.rank = rank(row);
    row.minZoom = minZoomFor(row);
  }
  for (const layer of base.layers || []) {
    for (const feature of layer.features) {
      feature.xy = feature.coords.map(coord => mercator(coord[0], coord[1]));
    }
  }
  const bounds = all.reduce((b, row) => ({
    minX: Math.min(b.minX, row.xy.x),
    maxX: Math.max(b.maxX, row.xy.x),
    minY: Math.min(b.minY, row.xy.y),
    maxY: Math.max(b.maxY, row.xy.y)
  }), { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity });
  function resize() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.floor(window.innerWidth * dpr);
    canvas.height = Math.floor(window.innerHeight * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    fit(false);
  }
  function currentRows() {
    return all.filter(row => {
      if (zoom < row.minZoom) return false;
      return row.kind === "admin" && showAdmin;
    });
  }
  function fit(drawNow = true) {
    const w = window.innerWidth;
    const h = window.innerHeight;
    center = { x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2 };
    scale = Math.min(w / (bounds.maxX - bounds.minX), h / (bounds.maxY - bounds.minY)) * 0.82;
    zoom = 0;
    if (drawNow) draw();
  }
  function toScreen(row) {
    const s = scale * Math.pow(2, zoom);
    return { x: (row.xy.x - center.x) * s + window.innerWidth / 2, y: (row.xy.y - center.y) * s + window.innerHeight / 2 };
  }
  function drawPath(points, closePath = false) {
    let started = false;
    for (const xy of points) {
      const p = toScreen({ xy });
      if (!started) {
        ctx.moveTo(p.x, p.y);
        started = true;
      } else {
        ctx.lineTo(p.x, p.y);
      }
    }
    if (closePath) ctx.closePath();
  }

  function elevationColor(elevation) {
    if (elevation < 3200) return [124, 166, 118, 210];
    if (elevation < 4000) return [180, 180, 120, 218];
    if (elevation < 4700) return [198, 161, 104, 224];
    if (elevation < 5400) return [180, 134, 116, 230];
    if (elevation < 6200) return [190, 178, 168, 232];
    return [238, 240, 240, 238];
  }

  function decodeTerrarium(image) {
    const tileCanvas = document.createElement("canvas");
    tileCanvas.width = 256;
    tileCanvas.height = 256;
    const tileCtx = tileCanvas.getContext("2d", { willReadFrequently: true });
    tileCtx.drawImage(image, 0, 0);
    const imageData = tileCtx.getImageData(0, 0, 256, 256);
    const data = imageData.data;
    for (let i = 0; i < data.length; i += 4) {
      const elevation = data[i] * 256 + data[i + 1] + data[i + 2] / 256 - 32768;
      const color = elevationColor(elevation);
      data[i] = color[0];
      data[i + 1] = color[1];
      data[i + 2] = color[2];
      data[i + 3] = color[3];
    }
    tileCtx.putImageData(imageData, 0, 0);
    return tileCanvas;
  }

  function drawElevation() {
    if (!showElevation) return;
    const w = window.innerWidth;
    const h = window.innerHeight;
    const worldPx = scale * Math.pow(2, zoom);
    const tileZoom = Math.max(3, Math.min(9, Math.round(Math.log2(worldPx / 256))));
    const tiles = 2 ** tileZoom;
    const left = center.x - w / 2 / worldPx;
    const right = center.x + w / 2 / worldPx;
    const top = center.y - h / 2 / worldPx;
    const bottom = center.y + h / 2 / worldPx;
    const x0 = Math.floor(left * tiles) - 1;
    const x1 = Math.floor(right * tiles) + 1;
    const y0 = Math.max(0, Math.floor(top * tiles) - 1);
    const y1 = Math.min(tiles - 1, Math.floor(bottom * tiles) + 1);
    const tileSize = worldPx / tiles;
    ctx.save();
    ctx.globalAlpha = 0.86;
    for (let x = x0; x <= x1; x += 1) {
      const wrappedX = ((x % tiles) + tiles) % tiles;
      for (let y = y0; y <= y1; y += 1) {
        const key = `${tileZoom}/${wrappedX}/${y}`;
        let entry = elevationCache.get(key);
        if (!entry) {
          entry = { image: new Image(), canvas: null, failed: false };
          entry.image.crossOrigin = "anonymous";
          entry.image.onload = () => {
            try {
              entry.canvas = decodeTerrarium(entry.image);
              draw();
            } catch (error) {
              entry.failed = true;
            }
          };
          entry.image.onerror = () => entry.failed = true;
          entry.image.src = `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${tileZoom}/${wrappedX}/${y}.png`;
          elevationCache.set(key, entry);
        }
        if (entry.canvas) {
          const screenX = (x / tiles - center.x) * worldPx + w / 2;
          const screenY = (y / tiles - center.y) * worldPx + h / 2;
          ctx.drawImage(entry.canvas, screenX, screenY, tileSize + 1, tileSize + 1);
        }
      }
    }
    ctx.restore();
    ctx.fillStyle = "rgba(255,255,255,0.14)";
    ctx.fillRect(0, 0, w, h);
  }

  function baseLayerVisible(kind) {
    if (kind === "road_minor") return zoom >= 1.1;
    if (kind === "water_line") return zoom >= 0.35;
    return true;
  }

  function drawLocalBase() {
    if (!showBase || !base || !base.layers) return;
    for (const layer of base.layers) {
      if (!baseLayerVisible(layer.kind)) continue;
      if (layer.kind === "water_area") {
        ctx.beginPath();
        for (const feature of layer.features) drawPath(feature.xy, true);
        ctx.fillStyle = "rgba(128, 182, 205, 0.34)";
        ctx.strokeStyle = "rgba(88, 143, 171, 0.34)";
        ctx.lineWidth = 0.8;
        ctx.fill();
        ctx.stroke();
      }
    }
    for (const layer of base.layers) {
      if (!baseLayerVisible(layer.kind)) continue;
      if (layer.kind !== "water_line") continue;
      ctx.beginPath();
      for (const feature of layer.features) drawPath(feature.xy);
      ctx.strokeStyle = "rgba(78, 143, 178, 0.55)";
      ctx.lineWidth = 1.1;
      ctx.stroke();
    }
    for (const layer of base.layers) {
      if (!baseLayerVisible(layer.kind)) continue;
      if (!layer.kind.startsWith("road_")) continue;
      ctx.beginPath();
      for (const feature of layer.features) drawPath(feature.xy);
      ctx.strokeStyle = layer.kind === "road_major" ? "rgba(178, 136, 89, 0.72)" : "rgba(190, 166, 122, 0.58)";
      ctx.lineWidth = layer.kind === "road_major" ? 1.4 : 0.9;
      ctx.stroke();
    }
  }
  function labelVisible(row) {
    if (!showLabels) return false;
    return zoom >= row.minZoom;
  }
  function drawLabel(text, x, y, color, size) {
    ctx.font = `650 ${size}px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
    ctx.lineWidth = 3;
    ctx.strokeStyle = "rgba(255,255,255,0.95)";
    ctx.strokeText(text, x + 6, y - 5);
    ctx.fillStyle = color;
    ctx.fillText(text, x + 6, y - 5);
  }
  function draw() {
    ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
    drawElevation();
    drawLocalBase();
    const visible = [];
    for (const row of currentRows()) {
      const p = toScreen(row);
      if (p.x < -20 || p.y < -20 || p.x > window.innerWidth + 20 || p.y > window.innerHeight + 20) continue;
      visible.push([row, p]);
    }
    visible.sort((a, b) => a[0].rank - b[0].rank);
    for (const [row, p] of visible) {
      const adminPoint = row.kind === "admin";
      ctx.beginPath();
      ctx.arc(p.x, p.y, adminPoint ? 4 : row.place === "village" ? 2.2 : 3, 0, Math.PI * 2);
      ctx.fillStyle = adminPoint ? "#a9433b" : "#1f6f53";
      ctx.fill();
      ctx.lineWidth = 1.2;
      ctx.strokeStyle = "rgba(255,255,255,0.92)";
      ctx.stroke();
    }
    visible.sort((a, b) => b[0].rank - a[0].rank);
    let drawn = 0;
    for (const [row, p] of visible) {
      if (!labelVisible(row) || drawn > 650 + zoom * 180) continue;
      drawLabel(row.label, p.x, p.y, row.kind === "admin" ? "#7a2f2a" : "#1d4f3c", row.kind === "admin" ? 13 : 12);
      drawn += 1;
    }
  }
  function nearest(mouseX, mouseY) {
    let best = null;
    let bestD = 14;
    for (const row of currentRows()) {
      const p = toScreen(row);
      const d = Math.hypot(p.x - mouseX, p.y - mouseY);
      if (d < bestD) {
        best = { row, p };
        bestD = d;
      }
    }
    return best;
  }
  function showTip(hit, event) {
    if (!hit) {
      tip.style.display = "none";
      lastHover = null;
      return;
    }
    const row = hit.row;
    if (lastHover === row.id) return;
    lastHover = row.id;
    tip.innerHTML = `<strong>${row.label}</strong><div>Tibetan: ${row.bo || "missing"}</div><div>English: ${row.en || "missing"}</div><div>OSM name: ${row.name || "missing"}</div><div>Type: ${row.place || "admin level " + row.level}</div><div>Source: ${row.id}</div>`;
    tip.style.left = `${Math.min(event.clientX + 14, window.innerWidth - 280)}px`;
    tip.style.top = `${Math.min(event.clientY + 14, window.innerHeight - 150)}px`;
    tip.style.display = "block";
  }
  canvas.addEventListener("wheel", event => {
    event.preventDefault();
    const before = { x: (event.clientX - window.innerWidth / 2) / (scale * Math.pow(2, zoom)) + center.x, y: (event.clientY - window.innerHeight / 2) / (scale * Math.pow(2, zoom)) + center.y };
    zoom = Math.max(-0.8, Math.min(4.2, zoom + (event.deltaY < 0 ? 0.22 : -0.22)));
    const afterScale = scale * Math.pow(2, zoom);
    center.x = before.x - (event.clientX - window.innerWidth / 2) / afterScale;
    center.y = before.y - (event.clientY - window.innerHeight / 2) / afterScale;
    draw();
  }, { passive: false });
  canvas.addEventListener("mousedown", event => {
    dragging = true;
    canvas.classList.add("dragging");
    dragStart = { x: event.clientX, y: event.clientY, center: { ...center } };
  });
  window.addEventListener("mouseup", () => {
    dragging = false;
    canvas.classList.remove("dragging");
  });
  window.addEventListener("mousemove", event => {
    if (dragging && dragStart) {
      const s = scale * Math.pow(2, zoom);
      center.x = dragStart.center.x - (event.clientX - dragStart.x) / s;
      center.y = dragStart.center.y - (event.clientY - dragStart.y) / s;
      tip.style.display = "none";
      draw();
    } else {
      showTip(nearest(event.clientX, event.clientY), event);
    }
  });
  function toggle(id, setter) {
    const button = document.getElementById(id);
    button.addEventListener("click", () => {
      const active = button.getAttribute("aria-pressed") === "true";
      button.setAttribute("aria-pressed", String(!active));
      setter(!active);
      tip.style.display = "none";
      draw();
    });
  }
  toggle("toggleAdmin", value => showAdmin = value);
  toggle("toggleBase", value => showBase = value);
  toggle("toggleElevation", value => showElevation = value);
  toggle("toggleLabels", value => showLabels = value);
  document.getElementById("fitMap").addEventListener("click", () => fit(true));

  const installButton = document.getElementById("installApp");
  let deferredInstallPrompt = null;
  window.addEventListener("beforeinstallprompt", event => {
    event.preventDefault();
    deferredInstallPrompt = event;
    installButton.classList.add("available");
  });
  installButton.addEventListener("click", async () => {
    if (!deferredInstallPrompt) return;
    deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    installButton.classList.remove("available");
  });
  window.addEventListener("appinstalled", () => {
    deferredInstallPrompt = null;
    installButton.classList.remove("available");
  });
  if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }

  window.__mapStats = () => ({ total: all.length, admin: admin.length, baseLayers: base.layers.length, tibetan: 782, zoom, showElevation });
  window.addEventListener("resize", resize);
  resize();
  draw();
})().catch(error => {
  console.error(error);
  const tip = document.getElementById("tip");
  tip.textContent = error.message;
  tip.style.display = "block";
  tip.style.left = "16px";
  tip.style.top = "190px";
});
