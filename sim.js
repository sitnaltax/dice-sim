// sim.js — Physics + geometry logic for prismatic dice simulation

import RAPIER from 'https://cdn.jsdelivr.net/npm/@dimforge/rapier3d-compat@0.12.0/rapier.es.js';

let rapierReady = false;

export async function initRapier() {
  if (rapierReady) return RAPIER;
  await RAPIER.init();
  rapierReady = true;
  return RAPIER;
}

/**
 * Generate vertices for a regular n-gon prism
 * Bottom endcap at y = -faceLength/2, top at y = +faceLength/2
 * @returns Float32Array of [x,y,z, ...]
 */
export function generatePrismVertices(n, circumradius, faceLength) {
  const vertices = [];
  const halfLen = faceLength / 2;
  for (let i = 0; i < n; i++) {
    const angle = (2 * Math.PI * i) / n;
    // Match Three.js CylinderGeometry convention: x=sin, z=cos
    const x = circumradius * Math.sin(angle);
    const z = circumradius * Math.cos(angle);
    // Bottom
    vertices.push(x, -halfLen, z);
    // Top
    vertices.push(x, halfLen, z);
  }
  return new Float32Array(vertices);
}

/**
 * Compute face descriptors for the prism (centroid + outward normal in local space)
 * Returns array of { name, centroid: [x,y,z], normal: [x,y,z] }
 */
export function computeFaceDescriptors(n, circumradius, faceLength) {
  const faces = [];
  const halfLen = faceLength / 2;

  // Bottom endcap — normal points down (-Y)
  faces.push({
    name: 'Endcap (Bottom)',
    centroid: [0, -halfLen, 0],
    normal: [0, -1, 0],
  });

  // Top endcap — normal points up (+Y)
  faces.push({
    name: 'Endcap (Top)',
    centroid: [0, halfLen, 0],
    normal: [0, 1, 0],
  });

  // n rectangular side faces
  for (let i = 0; i < n; i++) {
    // The outward normal of side face i points from axis toward midpoint of edge.
    // midAngle = 2πi/n + π/n — computed directly to avoid wrap-around error on the last face.
    const midAngle = (2 * Math.PI * i) / n + Math.PI / n;
    // Match Three.js CylinderGeometry convention: x=sin, z=cos
    const nx = Math.sin(midAngle);
    const nz = Math.cos(midAngle);

    // Centroid of rectangular face
    const cx = circumradius * Math.sin(midAngle);
    const cz = circumradius * Math.cos(midAngle);

    faces.push({
      name: `Side face ${i + 1}`,
      centroid: [cx, 0, cz],
      normal: [nx, 0, nz],
    });
  }

  return faces;
}

/**
 * Determine which face is "down" after the die has settled.
 * Transforms each face's local normal by the die's rotation quaternion,
 * then picks the one with highest dot product with world-down (0,-1,0).
 *
 * @param {object} rotation - { x, y, z, w } quaternion
 * @param {Array} faceDescriptors - from computeFaceDescriptors
 * @returns index into faceDescriptors
 */
export function detectDownFace(rotation, faceDescriptors) {
  const { x: qx, y: qy, z: qz, w: qw } = rotation;

  let bestIdx = 0;
  let bestDot = -Infinity;

  for (let i = 0; i < faceDescriptors.length; i++) {
    const [lx, ly, lz] = faceDescriptors[i].normal;
    // Rotate local normal by quaternion: v' = v + 2w(q×v) + 2(q×(q×v))
    // where q = [qx,qy,qz] is the vector part, w = qw
    const tx = 2 * (qy * lz - qz * ly);
    const ty = 2 * (qz * lx - qx * lz);
    const tz = 2 * (qx * ly - qy * lx);
    const worldX = lx + qw * tx + (qy * tz - qz * ty);
    const worldY = ly + qw * ty + (qz * tx - qx * tz);
    const worldZ = lz + qw * tz + (qx * ty - qy * tx);

    // Dot with world down (0, -1, 0)
    const dot = -worldY;
    if (dot > bestDot) {
      bestDot = dot;
      bestIdx = i;
    }
  }

  return bestIdx;
}

/**
 * Create a Rapier world with a prism die and flat floor.
 * Returns { world, dieBody, faceDescriptors }
 */
export function createWorld(params, dt = 1 / 60) {
  const { n, circumradius, faceLength, restitution, dropHeight, initialSpin } = params;

  const gravity = { x: 0.0, y: -9.81, z: 0.0 };
  const world = new RAPIER.World(gravity);
  // Set the simulation timestep (Rapier uses integrationParameters.dt)
  try { world.integrationParameters.dt = dt; } catch(e) { /* older API fallback */ }

  // Floor
  const floorColliderDesc = RAPIER.ColliderDesc.cuboid(50.0, 0.1, 50.0)
    .setRestitution(restitution)
    .setFriction(0.8);
  world.createCollider(floorColliderDesc);

  // Random spin direction: generate 4 standard normals, normalize to unit quaternion,
  // then rotate the base spin vector [0, initialSpin, 0] by that quaternion.
  function randn() {
    // Box-Muller
    return Math.sqrt(-2 * Math.log(Math.random())) * Math.cos(2 * Math.PI * Math.random());
  }
  let qa = randn(), qb = randn(), qc = randn(), qd = randn();
  const qlen = Math.sqrt(qa*qa + qb*qb + qc*qc + qd*qd);
  qa /= qlen; qb /= qlen; qc /= qlen; qd /= qlen;
  // Rotate [0, initialSpin, 0] by quaternion (qa, qb, qc, qd) = (x, y, z, w)
  const vx = 0, vy = initialSpin, vz = 0;
  const tx = 2 * (qb * vz - qc * vy);
  const ty = 2 * (qc * vx - qa * vz);
  const tz = 2 * (qa * vy - qb * vx);
  const angVelX = vx + qd * tx + (qb * tz - qc * ty);
  const angVelY = vy + qd * ty + (qc * tx - qa * tz);
  const angVelZ = vz + qd * tz + (qa * ty - qb * tx);

  // Random initial orientation — prevents the die from landing perfectly on an edge
  let rx = randn(), ry = randn(), rz = randn(), rw = randn();
  const rlen = Math.sqrt(rx*rx + ry*ry + rz*rz + rw*rw);
  rx /= rlen; ry /= rlen; rz /= rlen; rw /= rlen;

  // Die rigid body
  const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
    .setTranslation(0, dropHeight, 0)
    .setRotation({ x: rx, y: ry, z: rz, w: rw })
    .setLinvel(
      (Math.random() - 0.5) * 1.0,
      0,
      (Math.random() - 0.5) * 1.0
    )
    .setAngvel({ x: angVelX, y: angVelY, z: angVelZ });

  const dieBody = world.createRigidBody(bodyDesc);

  // Convex hull collider from prism vertices
  const vertices = generatePrismVertices(n, circumradius, faceLength);
  const colliderDesc = RAPIER.ColliderDesc.convexHull(vertices)
    .setRestitution(restitution)
    .setFriction(0.8)
    .setDensity(1.0);

  if (colliderDesc === null) {
    console.error('Failed to create convex hull collider');
  } else {
    world.createCollider(colliderDesc, dieBody);
  }

  const faceDescriptors = computeFaceDescriptors(n, circumradius, faceLength);

  return { world, dieBody, faceDescriptors };
}

/**
 * Run a single simulation until settled or timeout.
 * @param {object} params - die parameters
 * @param {number} dt - time step (e.g. 1/60 or 1/120)
 * @returns { faceIndex, faceName, rotation }
 */
export function runSingleSim(params, dt = 1 / 120) {
  const { world, dieBody, faceDescriptors } = createWorld(params, dt);

  const maxTime = 10.0;
  const restThreshold = 0.5; // seconds at rest before we stop
  const linVelThresh = 0.01;
  const angVelThresh = 0.01;

  let time = 0;
  let restTime = 0;

  while (time < maxTime) {
    world.step();
    time += dt;

    const linVel = dieBody.linvel();
    const angVel = dieBody.angvel();
    const linSpeed = Math.sqrt(linVel.x ** 2 + linVel.y ** 2 + linVel.z ** 2);
    const angSpeed = Math.sqrt(angVel.x ** 2 + angVel.y ** 2 + angVel.z ** 2);

    if (linSpeed < linVelThresh && angSpeed < angVelThresh) {
      restTime += dt;
      if (restTime >= restThreshold) break;
    } else {
      restTime = 0;
    }
  }

  const rotation = dieBody.rotation();
  const faceIndex = detectDownFace(rotation, faceDescriptors);

  world.free();

  return {
    faceIndex,
    faceName: faceDescriptors[faceIndex].name,
    rotation,
  };
}

/**
 * Run batch simulation (headless, no rendering)
 * @param {object} params
 * @param {number} numRolls
 * @param {function} onProgress - optional callback(current, total)
 * @returns Array of { faceIndex, faceName }
 */
export async function runBatch(params, numRolls, onProgress) {
  const results = [];
  const dt = 1 / 120;

  for (let i = 0; i < numRolls; i++) {
    const result = runSingleSim(params, dt);
    results.push(result);
    if (onProgress && i % 10 === 0) {
      onProgress(i + 1, numRolls);
      // Yield to allow UI updates
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  }

  if (onProgress) onProgress(numRolls, numRolls);
  return results;
}

/**
 * Tabulate batch results by face
 * @param {Array} results - from runBatch
 * @param {Array} faceDescriptors
 * @returns Array of { name, count, percentage }
 */
export function tabulateResults(results, faceDescriptors) {
  const counts = new Array(faceDescriptors.length).fill(0);
  for (const r of results) {
    counts[r.faceIndex]++;
  }
  const total = results.length;
  return faceDescriptors.map((fd, i) => ({
    name: fd.name,
    count: counts[i],
    percentage: total > 0 ? ((counts[i] / total) * 100).toFixed(1) : '0.0',
  }));
}
