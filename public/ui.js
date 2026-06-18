import * as THREE from 'three';

export class UI {
  constructor() {
    this.elems = {
      loading: document.getElementById('loadingScreen'),
      loadFill: document.getElementById('loadingFill'),
      loadTag: document.getElementById('loadingTag'),
      mainMenu: document.getElementById('mainMenu'),
      settings: document.getElementById('settingsPanel'),
      about: document.getElementById('aboutPanel'),
      pause: document.getElementById('pauseMenu'),
      gameOver: document.getElementById('gameOver'),
      victory: document.getElementById('victory'),
      hud: document.getElementById('hud'),
      health: document.getElementById('healthFill'),
      stamina: document.getElementById('staminaFill'),
      battery: document.getElementById('batteryFill'),
      interact: document.getElementById('interactPrompt'),
      interactText: document.getElementById('interactText'),
      subtitle: document.getElementById('subtitle'),
      objList: document.getElementById('objList'),
      minimap: document.getElementById('minimapCanvas'),
      flashInd: document.getElementById('flashIndicator'),
      damage: document.getElementById('damageVignette'),
      lowHealth: document.getElementById('lowHealthOverlay'),
      menuCanvas: document.getElementById('menuCanvas'),
      menuItems: document.querySelectorAll('.menu-item')
    };
    this._subtitleTimer = 0;
    this._setupListeners();
  }

  _setupListeners() {
    document.getElementById('settingsBack').addEventListener('click', () => {
      this.elems.settings.classList.add('hidden');
      this.elems.mainMenu.classList.remove('hidden');
    });
    document.getElementById('aboutBack').addEventListener('click', () => {
      this.elems.about.classList.add('hidden');
      this.elems.mainMenu.classList.remove('hidden');
    });
  }

  // ---------- LOADING ----------
  setLoading(pct, tag) {
    if (this.elems.loadFill) this.elems.loadFill.style.width = pct + '%';
    if (tag && this.elems.loadTag) this.elems.loadTag.textContent = tag;
  }
  hideLoading() { this.elems.loading.classList.add('hidden'); }

  // ---------- MENU ----------
  showMainMenu() {
    this.elems.mainMenu.classList.remove('hidden');
    this.elems.hud.classList.add('hidden');
    this.elems.pause.classList.add('hidden');
    this.elems.gameOver.classList.add('hidden');
    this.elems.victory.classList.add('hidden');
  }
  hideMainMenu() { this.elems.mainMenu.classList.add('hidden'); }
  showSettings() { this.elems.mainMenu.classList.add('hidden'); this.elems.settings.classList.remove('hidden'); }
  showAbout() { this.elems.mainMenu.classList.add('hidden'); this.elems.about.classList.remove('hidden'); }

  showHud() { this.elems.hud.classList.remove('hidden'); }
  hideHud() { this.elems.hud.classList.add('hidden'); }

  showPause() { this.elems.pause.classList.remove('hidden'); }
  hidePause() { this.elems.pause.classList.add('hidden'); }

  showGameOver(text) {
    this.elems.gameOver.classList.remove('hidden');
    this.elems.hud.classList.add('hidden');
    if (text) document.getElementById('goSub').textContent = text;
  }
  showVictory() {
    this.elems.victory.classList.remove('hidden');
    this.elems.hud.classList.add('hidden');
  }

  // ---------- HUD ----------
  updateStats(player) {
    this.elems.health.style.width = (player.health / player.maxHealth * 100) + '%';
    this.elems.stamina.style.width = (player.stamina / player.maxStamina * 100) + '%';
    this.elems.battery.style.width = (player.battery / player.maxBattery * 100) + '%';

    this.elems.flashInd.classList.toggle('on', player.flashOn);

    // low health pulse
    this.elems.lowHealth.classList.toggle('active', player.health < 30);
  }

  showInteract(prompt) {
    this.elems.interact.classList.remove('hidden');
    this.elems.interactText.textContent = prompt;
  }
  hideInteract() { this.elems.interact.classList.add('hidden'); }

  showSubtitle(text, dur = 4) {
    this.elems.subtitle.textContent = text;
    this.elems.subtitle.classList.remove('hidden');
    this._subtitleTimer = dur;
  }
  tickSubtitle(dt) {
    if (this._subtitleTimer > 0) {
      this._subtitleTimer -= dt;
      if (this._subtitleTimer <= 0) this.elems.subtitle.classList.add('hidden');
    }
  }

  flashDamage() {
    this.elems.damage.classList.add('flash');
    setTimeout(() => this.elems.damage.classList.remove('flash'), 350);
  }

  // ---------- OBJECTIVES ----------
  renderObjectives(objectives) {
    const list = this.elems.objList;
    list.innerHTML = '';
    objectives.forEach(o => {
      const li = document.createElement('li');
      li.textContent = o.text;
      if (o.state === 'done') li.classList.add('done');
      else if (o.state === 'current') li.classList.add('current');
      list.appendChild(li);
    });
  }

  // ---------- MINIMAP ----------
  initMinimap(world) {
    this._minimapCtx = this.elems.minimap.getContext('2d');
    this._world = world;
    this._bounds = { minX: -38, maxX: 38, minZ: -40, maxZ: 32 };
    this._rooms = [
      // Main corridor
      { x: -4.5,  z: 14,     w: 55,  d: 3.6  },
      // West branch
      { x: -22,   z: -1,     w: 3.6, d: 26   },
      // East branch
      { x: 4,     z: -1,     w: 3.6, d: 26   },
      // North connector
      { x: -9,    z: -34,    w: 30,  d: 3.6  },
      // South rooms
      { x: -26,   z: 20.8,   w: 9,   d: 10   }, // Main Entrance
      { x: 16,    z: 20.8,   w: 12,  d: 10   }, // Reception
      // West branch rooms (center x=-28.8)
      { x: -28.8, z: 6,      w: 10,  d: 7    }, // Security Office
      { x: -28.8, z: -2,     w: 10,  d: 7    }, // Medical Bay
      { x: -28.8, z: -10,    w: 10,  d: 7    }, // Maintenance
      { x: -28.8, z: -22,    w: 10,  d: 9    }, // Server Room
      // West bridges
      { x: -22,   z: -15.75, w: 3.6, d: 3.5  },
      { x: -22,   z: -29.35, w: 3.6, d: 5.7  },
      // East branch rooms (center x=+7.2)
      { x: 7.2,   z: 6,      w: 10,  d: 7    }, // Storage
      { x: 7.2,   z: -2,     w: 10,  d: 7    }, // Laboratory
      { x: 7.2,   z: -10,    w: 10,  d: 7    }, // Generator
      { x: 7.2,   z: -22,    w: 10,  d: 9    }, // Ventilation
      // East bridges
      { x: 4,     z: -15.75, w: 3.6, d: 3.5  },
      { x: 4,     z: -29.35, w: 3.6, d: 5.7  },
      // Exit gate
      { x: 28,    z: 14,     w: 10,  d: 7    },
      // Central facility core (between the two branches) — internal structure/machinery,
      // not walkable, but rendered so the map doesn't show a dead black void in the middle
      { x: -9,    z: -1,     w: 22,  d: 26   },
    ];
  }
  renderMinimap(playerPos, playerYaw, creaturePos, objectiveTarget) {
    if (!this._minimapCtx) return;
    const ctx = this._minimapCtx;
    const W = this.elems.minimap.width, H = this.elems.minimap.height;

    // Clear
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = 'rgba(8,6,5,0.95)';
    ctx.fillRect(0, 0, W, H);

    const b = this._bounds;
    const rangeX = b.maxX - b.minX;
    const rangeZ = b.maxZ - b.minZ;
    const sx = W / rangeX;
    const sy = H / rangeZ;

    const toX = (x) => (x - b.minX) * sx;
    const toY = (z) => (z - b.minZ) * sy;

    // Draw rooms
    ctx.lineWidth = 1;
    (this._rooms || []).forEach(r => {
      const rx = toX(r.x - r.w / 2);
      const ry = toY(r.z - r.d / 2);
      const rw = r.w * sx;
      const rh = r.d * sy;
      ctx.fillStyle = 'rgba(196,30,30,0.12)';
      ctx.fillRect(rx, ry, rw, rh);
      ctx.strokeStyle = 'rgba(196,30,30,0.5)';
      ctx.strokeRect(rx, ry, rw, rh);
    });

    // Objective marker
    if (objectiveTarget) {
      const ox = toX(objectiveTarget.x);
      const oy = toY(objectiveTarget.z);
      ctx.fillStyle = 'rgba(240,168,48,0.95)';
      ctx.beginPath();
      ctx.arc(ox, oy, 5, 0, Math.PI * 2);
      ctx.fill();
      // pulsing ring
      ctx.strokeStyle = 'rgba(240,168,48,0.45)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(ox, oy, 9 + Math.sin(performance.now() * 0.005) * 2, 0, Math.PI * 2);
      ctx.stroke();
    }

    // Creature blip
    if (creaturePos) {
      const cx2 = toX(creaturePos.x);
      const cy2 = toY(creaturePos.z);
      ctx.fillStyle = 'rgba(220,30,30,0.9)';
      ctx.beginPath();
      ctx.arc(cx2, cy2, 4, 0, Math.PI * 2);
      ctx.fill();
    }

    // Player triangle (yaw: THREE camera yaw = rotation.y but in PointerLockControls
    // the object's rotation.y is the horizontal rotation)
    const px = toX(playerPos.x);
    const py = toY(playerPos.z);
    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(-playerYaw); // negate because map Z goes down
    ctx.fillStyle = '#e9dfca';
    ctx.beginPath();
    ctx.moveTo(0, -7);
    ctx.lineTo(4.5, 5);
    ctx.lineTo(-4.5, 5);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = 'rgba(196,30,30,0.7)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();
  }

  // ---------- MENU 3D BACKGROUND CANVAS ----------
  initMenuScene() {
    const canvas = this.elems.menuCanvas;
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    const w = canvas.clientWidth, h = canvas.clientHeight || 360;
    renderer.setSize(w, h, false);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 0.9;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x050404);
    scene.fog = new THREE.FogExp2(0x0a0807, 0.08);

    const camera = new THREE.PerspectiveCamera(45, w/h, 0.1, 30);
    camera.position.set(0, 1.6, 4);
    camera.lookAt(0, 1.5, 0);

    // floor
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(20, 20),
      new THREE.MeshStandardMaterial({ color: 0x1a1612, roughness: 0.9 })
    );
    floor.rotation.x = -Math.PI / 2; scene.add(floor);

    // survivor silhouette: capsule body + head
    const matChar = new THREE.MeshStandardMaterial({ color: 0x2a2018, roughness: 0.8 });
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.32, 0.9, 4, 10), matChar);
    body.position.y = 0.9; scene.add(body);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.22, 16, 12), matChar);
    head.position.y = 1.65; scene.add(head);
    // flashlight beam from chest
    const beamMat = new THREE.MeshBasicMaterial({ color: 0xfff2c8, transparent: true, opacity: 0.18, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
    const beam = new THREE.Mesh(new THREE.ConeGeometry(0.4, 2.4, 24, 1, true), beamMat);
    beam.rotation.x = Math.PI / 2; beam.position.set(0, 1.1, 1.3);
    scene.add(beam);

    // key light from front (warm)
    const keyLight = new THREE.SpotLight(0xffa050, 6, 8, Math.PI / 4, 0.5, 1.8);
    keyLight.position.set(1.6, 2.5, 2); keyLight.target = body; scene.add(keyLight);
    // rim red
    const rim = new THREE.PointLight(0xc41e1e, 1.0, 6, 1.8);
    rim.position.set(-2, 1.8, -1); scene.add(rim);
    // hemisphere
    scene.add(new THREE.HemisphereLight(0x1a1a2a, 0x080806, 0.18));

    // dust particles
    const dustGeo = new THREE.BufferGeometry();
    const cnt = 200;
    const pos = new Float32Array(cnt * 3);
    for (let i = 0; i < cnt; i++) {
      pos[i*3+0] = (Math.random()-0.5)*8;
      pos[i*3+1] = Math.random()*3;
      pos[i*3+2] = (Math.random()-0.5)*6 + 1;
    }
    dustGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const dust = new THREE.Points(dustGeo, new THREE.PointsMaterial({ size: 0.03, color: 0xc8b88a, transparent: true, opacity: 0.6, depthWrite: false, blending: THREE.AdditiveBlending }));
    scene.add(dust);

    this._menuScene = { renderer, scene, camera, body, head, keyLight, rim, dust, beam };
  }
  updateMenuScene(time, dt) {
    if (!this._menuScene) return;
    const { renderer, scene, camera, body, head, keyLight, rim, dust, beam } = this._menuScene;
    body.rotation.y = Math.sin(time * 0.4) * 0.3;
    head.rotation.y = Math.sin(time * 0.3 + 0.4) * 0.4;
    head.position.y = 1.65 + Math.sin(time * 1.6) * 0.01;
    // flicker
    keyLight.intensity = 5 + Math.sin(time * 9) * 0.6 + (Math.random() < 0.02 ? -3 : 0);
    rim.intensity = 1 + Math.sin(time * 2) * 0.3;
    beam.material.opacity = 0.16 + Math.sin(time * 11) * 0.04;
    // dust drift
    const pa = dust.geometry.attributes.position;
    for (let i = 0; i < pa.count; i++) {
      pa.array[i*3+1] -= dt * 0.1;
      if (pa.array[i*3+1] < 0) pa.array[i*3+1] = 3;
    }
    pa.needsUpdate = true;
    renderer.render(scene, camera);
  }
  resizeMenuScene() {
    if (!this._menuScene) return;
    const c = this.elems.menuCanvas;
    const w = c.clientWidth, h = c.clientHeight;
    if (w > 0 && h > 0) {
      this._menuScene.renderer.setSize(w, h, false);
      this._menuScene.camera.aspect = w / h;
      this._menuScene.camera.updateProjectionMatrix();
    }
  }
}