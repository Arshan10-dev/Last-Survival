import * as THREE from 'three';

function noiseCanvas(size, baseFn) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(size, size);
  baseFn(img.data, size);
  ctx.putImageData(img, 0, 0);
  return c;
}

function fbm(x, y, octaves = 4) {
  // value noise (cheap) — sufficient as a base
  let v = 0, amp = 1, freq = 1, sum = 0;
  for (let i = 0; i < octaves; i++) {
    const sx = Math.sin(x * freq * 0.9 + i * 13.1);
    const sy = Math.cos(y * freq * 1.1 + i * 7.7);
    v += amp * (sx * sy * 0.5 + 0.5);
    sum += amp;
    amp *= 0.55; freq *= 2.1;
  }
  return v / sum;
}

function hash2(x, y) {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return s - Math.floor(s);
}

function makeTex(canvas, repeat = 4, anisotropy = 8) {
  const t = new THREE.CanvasTexture(canvas);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat, repeat);
  t.anisotropy = anisotropy;
  t.colorSpace = THREE.SRGBColorSpace;
  t.needsUpdate = true;
  return t;
}
function makeDataTex(canvas, repeat = 4) {
  const t = new THREE.CanvasTexture(canvas);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat, repeat);
  t.anisotropy = 4;
  // not sRGB
  t.needsUpdate = true;
  return t;
}

export function buildConcreteSet() {
  const size = 256;
  const diff = noiseCanvas(size, (data, s) => {
    for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
      const i = (y * s + x) * 4;
      const n = fbm(x * 0.05, y * 0.05, 5);
      const grain = (hash2(x, y) - 0.5) * 0.08;
      const cracks = Math.max(0, 1 - Math.abs(Math.sin(x * 0.04 + Math.cos(y * 0.03) * 2) - Math.cos(y * 0.04)) * 8);
      const v = Math.max(0, Math.min(1, 0.32 + n * 0.35 + grain - cracks * 0.25));
      const r = Math.floor(v * 145), g = Math.floor(v * 138), b = Math.floor(v * 128);
      data[i] = r; data[i+1] = g; data[i+2] = b; data[i+3] = 255;
    }
  });
  const rough = noiseCanvas(size, (data, s) => {
    for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
      const i = (y * s + x) * 4;
      const n = fbm(x * 0.07, y * 0.07, 4);
      const v = Math.floor(160 + n * 80);
      data[i] = data[i+1] = data[i+2] = v; data[i+3] = 255;
    }
  });
  const norm = noiseCanvas(size, (data, s) => {
    // pseudo normal map from gradient of height
    for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
      const i = (y * s + x) * 4;
      const h  = fbm(x * 0.08, y * 0.08, 4);
      const hx = fbm((x+1) * 0.08, y * 0.08, 4);
      const hy = fbm(x * 0.08, (y+1) * 0.08, 4);
      const dx = (hx - h) * 6, dy = (hy - h) * 6;
      const nx = -dx, ny = -dy, nz = 1;
      const l = Math.sqrt(nx*nx + ny*ny + nz*nz);
      data[i]   = Math.floor((nx/l * 0.5 + 0.5) * 255);
      data[i+1] = Math.floor((ny/l * 0.5 + 0.5) * 255);
      data[i+2] = Math.floor((nz/l * 0.5 + 0.5) * 255);
      data[i+3] = 255;
    }
  });
  return { map: makeTex(diff, 4), roughnessMap: makeDataTex(rough, 4), normalMap: makeDataTex(norm, 4) };
}

export function buildMetalSet() {
  const size = 256;
  const diff = noiseCanvas(size, (data, s) => {
    for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
      const i = (y * s + x) * 4;
      const stripes = Math.sin(y * 0.6) * 0.05;
      const n = fbm(x * 0.06, y * 0.18, 4);
      const rust = Math.max(0, fbm(x * 0.02, y * 0.02, 3) - 0.55) * 1.6;
      let r = 90 + n * 60 + stripes * 40;
      let g = 92 + n * 55 + stripes * 40;
      let b = 96 + n * 50 + stripes * 40;
      r = r * (1 - rust) + 110 * rust;
      g = g * (1 - rust) + 55 * rust;
      b = b * (1 - rust) + 30 * rust;
      data[i] = Math.max(0, Math.min(255, r));
      data[i+1] = Math.max(0, Math.min(255, g));
      data[i+2] = Math.max(0, Math.min(255, b));
      data[i+3] = 255;
    }
  });
  const rough = noiseCanvas(size, (data, s) => {
    for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
      const i = (y * s + x) * 4;
      const n = fbm(x * 0.1, y * 0.1, 3);
      const rust = Math.max(0, fbm(x * 0.02, y * 0.02, 3) - 0.55) * 1.6;
      const v = Math.floor(80 + n * 40 + rust * 120);
      data[i] = data[i+1] = data[i+2] = Math.min(255, v); data[i+3] = 255;
    }
  });
  const metal = noiseCanvas(size, (data, s) => {
    for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
      const i = (y * s + x) * 4;
      const rust = Math.max(0, fbm(x * 0.02, y * 0.02, 3) - 0.55) * 1.6;
      const v = Math.floor((1 - rust) * 230);
      data[i] = data[i+1] = data[i+2] = v; data[i+3] = 255;
    }
  });
  return { map: makeTex(diff, 2), roughnessMap: makeDataTex(rough, 2), metalnessMap: makeDataTex(metal, 2) };
}

export function buildTileSet() {
  const size = 256;
  const diff = noiseCanvas(size, (data, s) => {
    for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
      const i = (y * s + x) * 4;
      const gx = x % 64, gy = y % 64;
      const edge = (gx < 2 || gx > 61 || gy < 2 || gy > 61) ? 1 : 0;
      const n = fbm(x * 0.05, y * 0.05, 4);
      const stain = Math.max(0, fbm(x * 0.015, y * 0.015, 3) - 0.5) * 2;
      let r = 200 + n * 40, g = 196 + n * 40, b = 188 + n * 40;
      if (edge) { r *= 0.2; g *= 0.2; b *= 0.2; }
      r *= (1 - stain * 0.5); g *= (1 - stain * 0.6); b *= (1 - stain * 0.7);
      data[i] = r; data[i+1] = g; data[i+2] = b; data[i+3] = 255;
    }
  });
  const rough = noiseCanvas(size, (data, s) => {
    for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
      const i = (y * s + x) * 4;
      const gx = x % 64, gy = y % 64;
      const edge = (gx < 2 || gx > 61 || gy < 2 || gy > 61) ? 1 : 0;
      const v = edge ? 200 : 90 + fbm(x*0.1, y*0.1, 2) * 30;
      data[i] = data[i+1] = data[i+2] = v; data[i+3] = 255;
    }
  });
  return { map: makeTex(diff, 6), roughnessMap: makeDataTex(rough, 6) };
}

export function buildDustParticleTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d');
  const grad = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,250,235,0.95)');
  grad.addColorStop(0.4, 'rgba(255,250,235,0.35)');
  grad.addColorStop(1, 'rgba(255,250,235,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function buildPaperTexture(label = 'NOTE') {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 384;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#d8cdb1';
  ctx.fillRect(0, 0, 256, 384);
  // grain
  for (let i = 0; i < 1200; i++) {
    ctx.fillStyle = `rgba(60,40,20,${Math.random() * 0.08})`;
    ctx.fillRect(Math.random() * 256, Math.random() * 384, 1, 1);
  }
  // stains
  for (let i = 0; i < 6; i++) {
    ctx.fillStyle = `rgba(80,50,20,${0.06 + Math.random() * 0.08})`;
    ctx.beginPath();
    ctx.arc(Math.random() * 256, Math.random() * 384, 20 + Math.random() * 40, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = '#2a1a08';
  ctx.font = 'bold 26px monospace';
  ctx.fillText(label, 22, 50);
  ctx.font = '12px monospace';
  const lines = [
    '— day 47 —',
    'the lights fail again at 02:14.',
    'subject 07 is the only one',
    'still responding. the others',
    'have stopped moving entirely.',
    '',
    'if you find this — do not',
    'open the medical bay door.',
    '',
    'they are not what they were.'
  ];
  lines.forEach((l, i) => ctx.fillText(l, 22, 96 + i * 22));
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function buildSignTexture(text, color = '#c41e1e') {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 128;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#181410';
  ctx.fillRect(0, 0, 512, 128);
  ctx.strokeStyle = color; ctx.lineWidth = 4;
  ctx.strokeRect(8, 8, 496, 112);
  ctx.fillStyle = color;
  ctx.font = 'bold 56px \"Big Shoulders Stencil Display\", sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.shadowColor = color; ctx.shadowBlur = 14;
  ctx.fillText(text, 256, 68);
  // weathering
  for (let i = 0; i < 200; i++) {
    ctx.fillStyle = `rgba(0,0,0,${0.3 + Math.random() * 0.3})`;
    ctx.fillRect(Math.random() * 512, Math.random() * 128, 2, 2);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}