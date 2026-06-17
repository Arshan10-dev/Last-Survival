import * as THREE from 'three';
import { EffectComposer }  from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass }      from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass }      from 'three/addons/postprocessing/ShaderPass.js';
import { FilmPass }        from 'three/addons/postprocessing/FilmPass.js';
import { OutputPass }      from 'three/addons/postprocessing/OutputPass.js';

export function createEngine(canvas) {
  const renderer = new THREE.WebGLRenderer({
    canvas, antialias: true, powerPreference: 'high-performance',
    stencil: false, alpha: false
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  // Exposure: 1.0 = natural, was 2.0 which made everything overblown
  renderer.toneMappingExposure = 1.0;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x050505);
  // Moderate fog — not too dense so rooms are visible
  scene.fog = new THREE.FogExp2(0x0a0807, 0.025);

  const camera = new THREE.PerspectiveCamera(
    75, window.innerWidth / window.innerHeight, 0.05, 120
  );
  camera.position.set(0, 1.7, 0);

  // ── Post Processing ────────────────────────────────────────────────────────
  const composer = new EffectComposer(renderer);
  composer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
  composer.setSize(window.innerWidth, window.innerHeight);

  // 1. Render
  composer.addPass(new RenderPass(scene, camera));

  // 2. Bloom — only emissive lights glow (emergency red lights, eyes)
  //    SSAO removed — causes black circle artifact in Three.js r160
  const bloomPass = new UnrealBloomPass(
    new THREE.Vector2(window.innerWidth, window.innerHeight),
    0.4,   // strength — subtle glow
    0.6,   // radius
    0.55   // threshold — only bright emissives bloom, not walls
  );
  composer.addPass(bloomPass);

  // 3. Color grade + vignette + damage tint
  const gradeShader = {
    uniforms: {
      tDiffuse:    { value: null },
      uTime:       { value: 0 },
      uVignette:   { value: 0.85 },
      uColorShift: { value: new THREE.Vector3(0.98, 0.95, 0.90) },
      uDamage:     { value: 0 }
    },
    vertexShader: `
      varying vec2 vUv;
      void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }
    `,
    fragmentShader: `
      uniform sampler2D tDiffuse;
      uniform float uTime, uVignette, uDamage;
      uniform vec3 uColorShift;
      varying vec2 vUv;
      void main(){
        vec4 c = texture2D(tDiffuse, vUv);
        // Subtle warm-to-cool color grade
        c.rgb *= uColorShift;
        // Gentle vignette (not too dark — Granny style)
        vec2  d = vUv - 0.5;
        float v = 1.0 - dot(d,d) * uVignette * 1.8;
        v = clamp(v, 0.2, 1.0);   // floor at 0.2 so edges aren't pitch black
        c.rgb *= v;
        // Subtle chromatic aberration
        float ca = 0.001 + uDamage * 0.008;
        c.r = texture2D(tDiffuse, vUv + vec2(ca, 0.0)).r * uColorShift.r;
        c.b = texture2D(tDiffuse, vUv - vec2(ca, 0.0)).b * uColorShift.b;
        // Damage red flash
        c.rgb = mix(c.rgb, vec3(0.6, 0.05, 0.05), uDamage * 0.45);
        gl_FragColor = c;
      }
    `
  };
  const gradePass = new ShaderPass(gradeShader);
  composer.addPass(gradePass);

  // 4. Subtle film grain
  const filmPass = new FilmPass(0.25, false);
  composer.addPass(filmPass);

  // 5. Output gamma
  composer.addPass(new OutputPass());

  // ── Resize ────────────────────────────────────────────────────────────────
  function onResize() {
    const w = window.innerWidth, h = window.innerHeight;
    camera.aspect = w / h; camera.updateProjectionMatrix();
    renderer.setSize(w, h, false);
    composer.setSize(w, h);
    bloomPass.setSize(w, h);
  }
  window.addEventListener('resize', onResize);

  return {
    renderer, scene, camera, composer,
    passes: { bloomPass, gradePass, filmPass,
              // shim so game.js doesn't crash accessing ssaoPass
              ssaoPass: { setSize: () => {} } },
    onResize
  };
}