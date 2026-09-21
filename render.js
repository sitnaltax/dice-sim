// render.js — Three.js scene, mesh creation, animation loop

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

let scene, camera, renderer, controls;
let dieMesh, floorMesh;
let animFrameId = null;
let currentN, currentCircumradius, currentFaceLength;

export function initRenderer(canvas) {
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x1a1a2e);
  scene.fog = new THREE.Fog(0x1a1a2e, 20, 60);

  const w = canvas.clientWidth || canvas.offsetWidth || 800;
  const h = canvas.clientHeight || canvas.offsetHeight || 600;

  // Camera
  camera = new THREE.PerspectiveCamera(50, w / h, 0.1, 100);
  camera.position.set(4, 4, 8);
  camera.lookAt(0, 1, 0);

  // Renderer
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(w, h);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  // Orbit controls
  controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 1, 0);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.minDistance = 2;
  controls.maxDistance = 20;

  // Lighting
  const ambientLight = new THREE.AmbientLight(0xffffff, 0.4);
  scene.add(ambientLight);

  const dirLight = new THREE.DirectionalLight(0xffffff, 1.2);
  dirLight.position.set(5, 10, 5);
  dirLight.castShadow = true;
  dirLight.shadow.mapSize.width = 1024;
  dirLight.shadow.mapSize.height = 1024;
  dirLight.shadow.camera.near = 0.5;
  dirLight.shadow.camera.far = 50;
  dirLight.shadow.camera.left = -10;
  dirLight.shadow.camera.right = 10;
  dirLight.shadow.camera.top = 10;
  dirLight.shadow.camera.bottom = -10;
  scene.add(dirLight);

  const fillLight = new THREE.PointLight(0x4466ff, 0.5, 20);
  fillLight.position.set(-3, 3, -3);
  scene.add(fillLight);

  // Floor mesh
  const floorGeo = new THREE.PlaneGeometry(20, 20);
  const floorMat = new THREE.MeshStandardMaterial({
    color: 0x16213e,
    roughness: 0.9,
    metalness: 0.1,
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
  });
  floorMesh = new THREE.Mesh(floorGeo, floorMat);
  floorMesh.rotation.x = -Math.PI / 2;
  floorMesh.position.y = 0.1; // matches Rapier floor top surface (cuboid half-extent 0.1, centered at y=0)
  floorMesh.receiveShadow = true;
  scene.add(floorMesh);

  // Grid helper
  const grid = new THREE.GridHelper(20, 20, 0x0f3460, 0x0f3460);
  grid.position.y = 0.101;
  scene.add(grid);

  // Handle resize
  window.addEventListener('resize', onResize);

  startRenderLoop();

  return { scene, camera, renderer, controls };
}

function onResize() {
  const canvas = renderer.domElement;
  const w = canvas.clientWidth || canvas.offsetWidth;
  const h = canvas.clientHeight || canvas.offsetHeight;
  if (w === 0 || h === 0) return;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
}

function startRenderLoop() {
  function animate() {
    animFrameId = requestAnimationFrame(animate);
    controls.update();
    renderer.render(scene, camera);
  }
  animate();
}

/**
 * Create/update the die mesh for given parameters
 */
export function createDieMesh(n, circumradius, faceLength) {
  currentN = n; currentCircumradius = circumradius; currentFaceLength = faceLength;
  if (dieMesh) {
    scene.remove(dieMesh);
    dieMesh.geometry.dispose();
    const mats = Array.isArray(dieMesh.material) ? dieMesh.material : [dieMesh.material];
    mats.forEach(m => m.dispose());
    dieMesh = null;
  }

  // Use CylinderGeometry as approximation (n-sided prism)
  const geometry = new THREE.CylinderGeometry(circumradius, circumradius, faceLength, n);

  // CylinderGeometry groups: 0 = rectangular side faces, 1 = top cap, 2 = bottom cap
  // Give endcaps a distinct colour so they're visually distinguishable from the side faces.
  const sideMaterial = new THREE.MeshStandardMaterial({
    color: 0xe94560,   // red — rectangular side faces
    roughness: 0.3,
    metalness: 0.6,
  });
  const capMaterial = new THREE.MeshStandardMaterial({
    color: 0x4488ff,   // blue — endcap faces
    roughness: 0.3,
    metalness: 0.6,
  });

  dieMesh = new THREE.Mesh(geometry, [sideMaterial, capMaterial, capMaterial]);
  dieMesh.castShadow = true;
  dieMesh.receiveShadow = true;
  // Rest the die on the floor surface (y=0.1) before any simulation runs
  dieMesh.position.y = 0.1 + faceLength / 2;

  // Add edges for clarity
  const edges = new THREE.EdgesGeometry(geometry);
  const lineMat = new THREE.LineBasicMaterial({ color: 0xffffff, opacity: 0.3, transparent: true });
  const wireframe = new THREE.LineSegments(edges, lineMat);
  dieMesh.add(wireframe);

  scene.add(dieMesh);
  return dieMesh;
}

/**
 * Update die mesh transform from Rapier rigid body
 */
export function updateDieTransform(dieBody) {
  if (!dieMesh || !dieBody) return;
  const pos = dieBody.translation();
  const rot = dieBody.rotation();
  dieMesh.position.set(pos.x, pos.y, pos.z);
  dieMesh.quaternion.set(rot.x, rot.y, rot.z, rot.w);
}

/**
 * Smoothly lerp camera to look at die position (optional)
 */
export function focusCamera(x, y, z) {
  controls.target.lerp(new THREE.Vector3(x, y, z), 0.05);
}

export function getScene() { return scene; }
export function getCamera() { return camera; }
export function getRenderer() { return renderer; }
export function getControls() { return controls; }

/**
 * After settling, snap the die mesh to a clean resting pose:
 * rotate so the detected face is exactly flat on the floor,
 * and set the correct center height above the floor surface.
 */
export function snapDieToRest(faceDescriptors, faceIndex, physicsRotation) {
  if (!dieMesh || !physicsRotation) return;

  const [lx, ly, lz] = faceDescriptors[faceIndex].normal;

  // Start from the physics rotation — the die is already roughly in the right orientation.
  const physQ = new THREE.Quaternion(
    physicsRotation.x, physicsRotation.y, physicsRotation.z, physicsRotation.w
  );

  // Find where the face normal currently points in world space.
  const worldNormal = new THREE.Vector3(lx, ly, lz).applyQuaternion(physQ);

  // Compute the minimal rotation to move that world normal to exactly (0,-1,0).
  const correctionQ = new THREE.Quaternion().setFromUnitVectors(worldNormal, new THREE.Vector3(0, -1, 0));

  // Apply correction on top of physics rotation — preserves yaw naturally.
  const snappedQ = correctionQ.multiply(physQ);

  dieMesh.quaternion.copy(snappedQ);

  const floorY = 0.1;
  const margin = 0.003;
  if (faceIndex < 2) {
    dieMesh.position.y = floorY + currentFaceLength / 2 + margin;
  } else {
    dieMesh.position.y = floorY + currentCircumradius * Math.cos(Math.PI / currentN) + margin;
  }
}
