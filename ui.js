// ui.js — UI controls, event handlers, table rendering

import { initRapier, createWorld, runBatch, tabulateResults, computeFaceDescriptors, detectDownFace } from './sim.js';
import { initRenderer, createDieMesh, updateDieTransform, snapDieToRest } from './render.js';

// ---- State ----
let rapierReady = false;
let simState = null; // { world, dieBody, faceDescriptors }
let animFrameId = null;
let visualRunning = false;

// ---- DOM refs ----
const canvas = document.getElementById('sim-canvas');
const statusEl = document.getElementById('status');
const resultEl = document.getElementById('result-display');
const batchTableEl = document.getElementById('batch-table');
const batchProgressEl = document.getElementById('batch-progress');
const dropBtn = document.getElementById('btn-drop');
const batchBtn = document.getElementById('btn-batch');

// Control inputs
function getParams() {
  return {
    n: parseInt(document.getElementById('ctrl-n').value),
    faceLength: parseFloat(document.getElementById('ctrl-face-length').value),
    circumradius: parseFloat(document.getElementById('ctrl-circumradius').value),
    restitution: parseFloat(document.getElementById('ctrl-restitution').value),
    dropHeight: parseFloat(document.getElementById('ctrl-drop-height').value),
    initialSpin: parseFloat(document.getElementById('ctrl-spin').value),
    numRolls: parseInt(document.getElementById('ctrl-num-rolls').value),
  };
}

// ---- Slider sync ----
function bindSlider(id, displayId) {
  const slider = document.getElementById(id);
  const display = document.getElementById(displayId);
  if (!slider || !display) return;
  display.textContent = slider.value;
  slider.addEventListener('input', () => {
    display.textContent = slider.value;
    // If die mesh needs rebuild on n or size change
    if (id === 'ctrl-n' || id === 'ctrl-face-length' || id === 'ctrl-circumradius') {
      rebuildDieMesh();
    }
  });
}

function rebuildDieMesh() {
  const p = getParams();
  createDieMesh(p.n, p.circumradius, p.faceLength);
}

// ---- Visual simulation loop ----
function startVisualSim() {
  if (visualRunning) {
    stopVisualSim();
  }

  const params = getParams();

  // Create Rapier world
  simState = createWorld(params, 1 / 60);
  const { world, dieBody, faceDescriptors } = simState;

  // Reset die mesh position
  createDieMesh(params.n, params.circumradius, params.faceLength);
  updateDieTransform(dieBody);

  const dt = 1 / 60;
  const maxTime = 10.0;
  const restThreshold = 0.5;
  const linVelThresh = 0.01;
  const angVelThresh = 0.01;

  let time = 0;
  let restTime = 0;
  visualRunning = true;

  setStatus('Simulating…', 'running');

  function step() {
    if (!visualRunning) return;

    world.step();
    time += dt;
    updateDieTransform(dieBody);

    const linVel = dieBody.linvel();
    const angVel = dieBody.angvel();
    const linSpeed = Math.sqrt(linVel.x ** 2 + linVel.y ** 2 + linVel.z ** 2);
    const angSpeed = Math.sqrt(angVel.x ** 2 + angVel.y ** 2 + angVel.z ** 2);

    if (linSpeed < linVelThresh && angSpeed < angVelThresh) {
      restTime += dt;
    } else {
      restTime = 0;
    }

    const settled = restTime >= restThreshold || time >= maxTime;

    if (settled) {
      visualRunning = false;
      const rotation = dieBody.rotation();
      const faceIndex = detectDownFace(rotation, faceDescriptors);
      const faceName = faceDescriptors[faceIndex].name;
      snapDieToRest(faceDescriptors, faceIndex, rotation);
      showResult(faceName, faceIndex, faceDescriptors.length);
      setStatus('Settled', 'settled');
      world.free();
      simState = null;
    } else {
      animFrameId = requestAnimationFrame(step);
    }
  }

  animFrameId = requestAnimationFrame(step);
}

function stopVisualSim() {
  visualRunning = false;
  if (animFrameId) {
    cancelAnimationFrame(animFrameId);
    animFrameId = null;
  }
  if (simState) {
    simState.world.free();
    simState = null;
  }
}

// ---- Batch mode ----
async function startBatch() {
  const params = getParams();
  const numRolls = params.numRolls;

  batchBtn.disabled = true;
  dropBtn.disabled = true;
  setStatus(`Running ${numRolls} rolls…`, 'running');
  batchTableEl.innerHTML = '';
  batchProgressEl.textContent = '';

  const faceDescriptors = computeFaceDescriptors(params.n, params.circumradius, params.faceLength);

  const results = await runBatch(params, numRolls, (current, total) => {
    batchProgressEl.textContent = `Progress: ${current} / ${total}`;
  });

  const tabulated = tabulateResults(results, faceDescriptors);
  renderBatchTable(tabulated);

  batchProgressEl.textContent = `Done — ${numRolls} rolls completed.`;
  setStatus('Batch complete', 'settled');
  batchBtn.disabled = false;
  dropBtn.disabled = false;
}

// ---- UI helpers ----
function setStatus(msg, type) {
  statusEl.textContent = msg;
  statusEl.className = 'status ' + (type || '');
}

function showResult(faceName, faceIndex, totalFaces) {
  const isEndcap = faceIndex < 2;
  resultEl.innerHTML = `
    <div class="result-box ${isEndcap ? 'endcap' : 'side'}">
      <div class="result-label">Landed on:</div>
      <div class="result-face">${faceName}</div>
    </div>
  `;
}

function renderBatchTable(tabulated) {
  const maxCount = Math.max(...tabulated.map(r => r.count));

  let html = `
    <table>
      <thead>
        <tr>
          <th>Face</th>
          <th>Count</th>
          <th>Percentage</th>
          <th>Bar</th>
        </tr>
      </thead>
      <tbody>
  `;

  for (const row of tabulated) {
    const isMax = row.count === maxCount && maxCount > 0;
    const barWidth = maxCount > 0 ? (row.count / maxCount * 100).toFixed(1) : 0;
    const isEndcap = row.name.startsWith('Endcap');
    html += `
      <tr class="${isMax ? 'highlight' : ''} ${isEndcap ? 'row-endcap' : 'row-side'}">
        <td>${row.name}</td>
        <td>${row.count}</td>
        <td>${row.percentage}%</td>
        <td><div class="bar-wrap"><div class="bar" style="width:${barWidth}%"></div></div></td>
      </tr>
    `;
  }

  html += '</tbody></table>';
  batchTableEl.innerHTML = html;
}

// ---- Init ----
export async function initUI() {
  // Init renderer
  initRenderer(canvas);

  // Init Rapier
  setStatus('Loading physics engine…', 'running');
  try {
    await initRapier();
    rapierReady = true;
    setStatus('Ready', '');
  } catch (e) {
    setStatus('Failed to load physics: ' + e.message, 'error');
    console.error(e);
    return;
  }

  // Bind sliders
  bindSlider('ctrl-n', 'val-n');
  bindSlider('ctrl-face-length', 'val-face-length');
  bindSlider('ctrl-circumradius', 'val-circumradius');
  bindSlider('ctrl-restitution', 'val-restitution');
  bindSlider('ctrl-drop-height', 'val-drop-height');
  bindSlider('ctrl-spin', 'val-spin');

  // Initial die mesh
  rebuildDieMesh();

  // Buttons
  dropBtn.addEventListener('click', () => {
    if (!rapierReady) return;
    resultEl.innerHTML = '';
    startVisualSim();
  });

  batchBtn.addEventListener('click', () => {
    if (!rapierReady) return;
    stopVisualSim();
    startBatch();
  });
}
