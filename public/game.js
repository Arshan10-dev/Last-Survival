import * as THREE from 'three';
import { createEngine } from './engine.js';
import { World } from './world.js';
import { Player } from './player.js';
import { Creature } from './ai.js';
import { UI } from './ui.js';
import { AudioSystem } from './audio.js';
import './textures.js';
const ui = new UI();
const audio = new AudioSystem();

// ---------- Boot UI loading sequence ----------
const loadingSteps = [
    ['Initializing renderer…', 8],
    ['Compiling shaders…', 18],
    ['Generating facility geometry…', 32],
    ['Building post-processing pipeline…', 48],
    ['Synthesizing audio…', 62],
    ['Spawning entity 04F-X…', 78],
    ['Calibrating subject monitor…', 90],
    ['Ready.', 100]
];

let game = null;

async function boot() {
    // Animate loading steps over time
    for (const [tag, pct] of loadingSteps) {
        ui.setLoading(pct, tag);
        await new Promise(r => setTimeout(r, 280 + Math.random() * 220));
    }
    ui.initMenuScene();
    ui.hideLoading();
    ui.showMainMenu();

    // Animate menu scene in a loop
    let last = performance.now();
    function menuLoop(now) {
        if (!ui.elems.mainMenu.classList.contains('hidden')) {
            const dt = Math.min(0.05, (now - last) / 1000);
            ui.updateMenuScene(now / 1000, dt);
        }
        last = now;
        requestAnimationFrame(menuLoop);
    }
    requestAnimationFrame(menuLoop);

    // Menu actions
    document.querySelectorAll('.menu-item').forEach(el => {
        el.addEventListener('mouseenter', () => {
            document.querySelectorAll('.menu-item').forEach(x => x.classList.remove('active'));
            el.classList.add('active');
            audio.resume(); audio.init().then(() => audio.uiBlip());
        });
        el.addEventListener('click', () => handleMenuAction(el.dataset.action));
    });

    // pause menu
    document.getElementById('pauseResume').addEventListener('click', () => { resumeGame(); });
    document.getElementById('pauseSettings').addEventListener('click', () => { ui.elems.pause.classList.add('hidden'); ui.showSettings(); });
    document.getElementById('pauseMainMenu').addEventListener('click', () => { endRunToMenu(); });

    document.getElementById('goRestart').addEventListener('click', () => { ui.elems.gameOver.classList.add('hidden'); startNewGame(); });
    document.getElementById('goMenu').addEventListener('click', () => { ui.elems.gameOver.classList.add('hidden'); ui.showMainMenu(); });
    document.getElementById('vcMenu').addEventListener('click', () => { ui.elems.victory.classList.add('hidden'); ui.showMainMenu(); });

    // settings: live tweaks (work both in menu and during game)
    document.getElementById('setSens').addEventListener('input', e => {
        // slider: 0.0005 to 0.005, pointerSpeed range: 0.3 to 3.0
        if (game) game.player.controls.pointerSpeed = parseFloat(e.target.value) * 600;
    });
    document.getElementById('setVol').addEventListener('input', e => audio.setVolume(parseFloat(e.target.value)));
    document.getElementById('setBloom').addEventListener('input', e => {
        if (game) game.engine.passes.bloomPass.strength = parseFloat(e.target.value);
    });
    document.getElementById('setGrain').addEventListener('input', e => {
        if (game) {
            const fp = game.engine.passes.filmPass;
            if (fp.uniforms?.intensity) fp.uniforms.intensity.value = parseFloat(e.target.value);
            else if (fp.uniforms?.nIntensity) fp.uniforms.nIntensity.value = parseFloat(e.target.value);
        }
    });
    document.getElementById('setFov').addEventListener('input', e => {
        if (game) { game.engine.camera.fov = parseFloat(e.target.value); game.engine.camera.updateProjectionMatrix(); }
    });
    document.getElementById('setBob').addEventListener('change', e => {
        if (game) game.player.bobEnabled = e.target.checked;
    });

    // Esc handling
    document.addEventListener('keydown', (e) => {
        if (e.code === 'Escape') {
            if (game && game.running) togglePause();
        }
    });
}

function handleMenuAction(action) {
    audio.resume();
    audio.init().then(() => audio.uiBlip());
    if (action === 'newgame') startNewGame();
    else if (action === 'resume') { if (game) resumeGame(); else startNewGame(); }
    else if (action === 'settings') ui.showSettings();
    else if (action === 'about') ui.showAbout();
    else if (action === 'exit') { window.location.href = 'about:blank'; }
}

// ---------- Build/launch run ----------
function startNewGame() {
    if (game) { game.dispose(); game = null; }
    ui.hideMainMenu();
    ui.elems.settings.classList.add('hidden');
    ui.elems.about.classList.add('hidden');
    ui.elems.gameOver.classList.add('hidden');
    ui.elems.victory.classList.add('hidden');
    ui.showHud();

    game = buildRun();
    game.start();
}

function resumeGame() {
    if (!game) return;
    ui.hidePause();
    ui.elems.settings.classList.add('hidden');
    ui.showHud();
    game.player.controls.lock();
    game.paused = false;
}

function togglePause() {
    if (!game) return;
    game.paused = !game.paused;
    if (game.paused) {
        if (document.pointerLockElement) game.player.controls.unlock();
        // Hide lockOverlay while in pause menu
        const lo = document.getElementById('lockOverlay');
        if (lo && lo.parentNode) lo.parentNode.removeChild(lo);
        ui.showPause();
    } else {
        ui.hidePause();
        game.player.controls.lock();
    }
}

function endRunToMenu() {
    if (game) { game.dispose(); game = null; }
    ui.hidePause();
    ui.hideHud();
    ui.showMainMenu();
}

// ---------- Run lifecycle ----------
function buildRun() {
    const canvas = document.getElementById('gameCanvas');
    const engine = createEngine(canvas);
    const world = new World(engine.scene);
    const player = new Player(engine.camera, engine.scene, world, audio);
    const creature = new Creature(engine.scene, world, audio);

    // spawn player in entrance (new entrance center is -26, 20.8)
    player.setSpawn(-26, 20.8);

    // creature spawns in the west branch (Security Office area) — start of its patrol loop
    creature.setSpawn(-22, 6);

    ui.initMinimap(world);

    // Objectives
    const objectives = [
        { id: 1, text: 'Find the Security Keycard', state: 'current',  target: { x: -28.8, z: 6   } },
        { id: 2, text: 'Open the Security Office',  state: 'pending',  target: null                  },
        { id: 3, text: 'Restore Generator Power',   state: 'pending',  target: { x: 10.8,  z: -10  } },
        { id: 4, text: 'Unlock Main Exit Gate',      state: 'pending',  target: { x: 28,    z: 14   } },
        { id: 5, text: 'Escape the Facility',        state: 'pending',  target: null                  }
    ];
    ui.renderObjectives(objectives);

    // Audio
    audio.init().then(() => {
        audio.startAmbience();
        ui.showSubtitle('You wake to darkness. The facility hums faintly. Something is wrong.', 6);
    });

    // Click to lock — remove game.running check, it blocks the very first click
    const onClick = () => {
        if (game && !game.paused && !player.dead) {
            player.controls.lock();
        }
    };
    canvas.addEventListener('click', onClick);

    // Also lock immediately on start via a short overlay
    const lockOverlay = document.createElement('div');
    lockOverlay.id = 'lockOverlay';
    lockOverlay.style.cssText = `
        position:fixed; inset:0; z-index:30;
        display:flex; align-items:center; justify-content:center;
        background:rgba(0,0,0,0.55); cursor:pointer;
        font-family:'Share Tech Mono',monospace;
        flex-direction:column; gap:16px;
    `;
    lockOverlay.innerHTML = `
        <div style="color:#e9dfca;font-size:22px;letter-spacing:0.3em;">CLICK TO PLAY</div>
        <div style="color:#c41e1e;font-size:12px;letter-spacing:0.25em;">MOUSE · WASD · F = FLASHLIGHT</div>
    `;
    lockOverlay.addEventListener('click', () => {
        player.controls.lock();
    });
    document.body.appendChild(lockOverlay);

    player.controls.addEventListener('lock', () => {
        if (lockOverlay.parentNode) lockOverlay.parentNode.removeChild(lockOverlay);
    });
    player.controls.addEventListener('unlock', () => {
        // Only re-show overlay if game is still running (not paused/dead/menu)
        if (game && game.running && !game.paused && !player.dead) {
            if (!lockOverlay.parentNode) document.body.appendChild(lockOverlay);
        }
    });

    // Mouse sensitivity controlled via player.controls.pointerSpeed (set in player.js and settings)
    // Do NOT override it here — player.js already sets it to 0.12

    const raycaster = new THREE.Raycaster();
    raycaster.far = 2.6;
    const tmpDir = new THREE.Vector3();
    const tmpPos = new THREE.Vector3();
    let activeInteractable = null;

    // Horror events scheduler
    let nextHorrorAt = 18 + Math.random() * 18;
    let horrorTime = 0;

    function triggerHorrorEvent(player) {
        const r = Math.random();
        if (r < 0.35) {
            // Whisper from a random direction
            audio.whisper((Math.random() - 0.5) * 1.8);
        } else if (r < 0.6) {
            // Quick light flicker on nearest light
            let nearest = null, best = Infinity;
            world.lights.forEach(L => {
                const d = L.position.distanceTo(player.controls.getObject().position);
                if (d < best) { best = d; nearest = L; }
            });
            if (nearest) {
                const orig = nearest.intensity;
                nearest.intensity = 0;
                setTimeout(() => { if (nearest) nearest.intensity = orig; }, 200 + Math.random() * 400);
            }
        } else if (r < 0.8) {
            // Distant slam/creak
            if (Math.random() < 0.5) audio.doorSlam(); else audio.doorCreak();
        } else {
            // Hallucination: subtle red vignette pulse + tinnitus
            ui.elems.damage.classList.add('flash');
            setTimeout(() => ui.elems.damage.classList.remove('flash'), 200);
        }
        nextHorrorAt = 18 + Math.random() * 22;
        horrorTime = 0;
    }

    function findInteractable() {
        // raycast from camera forward
        player.camera.getWorldDirection(tmpDir);
        tmpPos.copy(player.camera.getWorldPosition(new THREE.Vector3()));
        raycaster.set(tmpPos, tmpDir);
        raycaster.far = 2.6;

        const meshes = world.interactables.map(it => it.mesh);
        const hits = raycaster.intersectObjects(meshes, false);
        if (hits.length) {
            const hitMesh = hits[0].object;
            return world.interactables.find(it => it.mesh === hitMesh);
        }
        return null;
    }

    function doInteract(it) {
        audio.uiBlip();
        if (it.type === 'keycard') {
            player.inventory.add(it.data.id);
            audio.pickup();
            world.removeInteractable(it);
            objectives[0].state = 'done';
            objectives[1].state = 'current'; objectives[1].target = { x: -22, z: 12 };
            ui.renderObjectives(objectives);
            ui.showSubtitle('Picked up: SECURITY KEYCARD', 3.2);
            // unlock objective 2 = \"Open Security Office\" — actually keycard unlocks no door physically in this build; mark complete on pickup as both done
            setTimeout(() => {
                objectives[1].state = 'done';
                objectives[2].state = 'current';
                ui.renderObjectives(objectives);
                ui.showSubtitle('Security Office cleared. Generator next.', 4);
            }, 800);
        } else if (it.type === 'note') {
            ui.showSubtitle(it.data.text, 7);
        } else if (it.type === 'generator_switch') {
            if (it.data.powered) {
                ui.showSubtitle('Generator already online.', 2.4);
                return;
            }
            if (objectives[2].state !== 'current') {
                ui.showSubtitle('You don\'t need to touch this yet.', 2.4);
                return;
            }
            // power restored
            it.data.powered = true;
            it.data.panel.material.emissive = new THREE.Color(0x66aaff);
            it.data.panel.material.emissiveIntensity = 1.5;
            audio.startGeneratorHum();
            world.fanSpeed = 3.5;
            // FULL FACILITY POWER — all ceiling lights ramp up over 3 seconds
            world.setMainPower(true);
            player.facilityPowered = true;
            objectives[2].state = 'done';
            objectives[3].state = 'current';
            ui.renderObjectives(objectives);
            ui.showSubtitle('POWER RESTORED. The lights flicker back to life. It heard that.', 5);
            // wake creature — chase intensifies
            creature.detectionRadius = 12;
            creature.speedChase = 4.8;
        } else if (it.type === 'exit_console') {
            if (!player.facilityPowered) {
                ui.showSubtitle('No power. The console is dead.', 3);
                audio.uiBlip();
                return;
            }
            if (!player.inventory.has('security_keycard')) {
                ui.showSubtitle('Requires SECURITY CLEARANCE.', 3);
                return;
            }
            // unlock gate — animate bars rising into the header (frame posts stay fixed)
            const gate = it.data.gate;
            const gateBarMeshes = it.data.gateBarMeshes;

            // Remove bars from collision IMMEDIATELY — don't wait for animation to finish.
            // This guarantees the path is walkable the instant the player unlocks the gate,
            // regardless of any matrixWorld/timing edge cases during the rise animation.
            world.collidables = world.collidables.filter(c => !gateBarMeshes.includes(c));
            world.exitUnlocked = true;
            ui.showSubtitle('Exit gate unlocked. Go!', 3);

            const start = gate.position.y;
            const end = start + 2.9;
            const t0 = performance.now();
            function anim() {
                const t = Math.min(1, (performance.now() - t0) / 2000);
                gate.position.y = start + (end - start) * t;
                if (t < 1) requestAnimationFrame(anim);
            }
            anim();
            it.data.screen.material.emissive = new THREE.Color(0x4fbc94);
            audio.doorCreak();
            objectives[3].state = 'done';
            objectives[4].state = 'current'; objectives[4].target = { x: 32, z: 14 };
            ui.renderObjectives(objectives);
            ui.showSubtitle('GATE OPENED. RUN.', 4);
        }
    }

    document.addEventListener('keydown', e => {
        if (e.code === 'KeyE' && activeInteractable && game.running && !game.paused) doInteract(activeInteractable);
    });

    // ---------- main loop ----------
    let prev = performance.now();
    let acc = 0;
    let alive = { running: true, paused: false, gameLoopId: 0 };

    function tick(now) {
        alive.gameLoopId = requestAnimationFrame(tick);
        if (!alive.running) return;
        const dt = Math.min(0.05, (now - prev) / 1000);
        prev = now;
        const time = now / 1000;

        if (!alive.paused && !player.dead) {
            player.update(dt, time);
            creature.update(dt, time, player);
            world.update(dt, time);

            // interaction prompt
            activeInteractable = findInteractable();
            if (activeInteractable) ui.showInteract(activeInteractable.prompt);
            else ui.hideInteract();

            // win condition: reach the end of escape tunnel with gate open + powered
            const ppos = player.controls.getObject().position;
            if (objectives[4].state === 'current' && ppos.x > 38 && Math.abs(ppos.z - 14) < 2) {
                objectives[4].state = 'done';
                ui.renderObjectives(objectives);
                ui.showVictory();
                alive.running = false;
                if (document.pointerLockElement) player.controls.unlock();
            }

            // damage flash
            if (player.health < (player._prevHealth ?? 100)) ui.flashDamage();
            player._prevHealth = player.health;

            // death
            if (player.dead) {
                ui.showGameOver('Subject 07 — STATUS: TERMINATED');
                alive.running = false;
                if (document.pointerLockElement) player.controls.unlock();
            }

            // horror event timer
            horrorTime += dt;
            if (horrorTime > nextHorrorAt) triggerHorrorEvent(player);

            // heartbeat audio when very low HP or chased close
            const dToCreature = creature.mesh.position.distanceTo(player.controls.getObject().position);
            if (player.health < 35 || (creature.state === 'CHASE' && dToCreature < 12)) {
                if (!player._lastHeart || time - player._lastHeart > 0.7) {
                    audio.heartbeat(Math.max(0.6, 1 - dToCreature / 20));
                    player._lastHeart = time;
                }
            }
        }

        // update grade shader: pulse damage based on low health (guard: gradePass may be inactive)
        const damageVal = Math.max(0, 1 - player.health / 100) * 0.5 + (creature.state === 'CHASE' ? 0.2 : 0);
        if (engine.passes.gradePass && engine.passes.gradePass.uniforms) {
            engine.passes.gradePass.uniforms.uDamage.value += (damageVal - engine.passes.gradePass.uniforms.uDamage.value) * 0.1;
            engine.passes.gradePass.uniforms.uTime.value = time;
        }

        // sync UI stats + minimap
        ui.updateStats(player);
        ui.tickSubtitle(dt);

        const targetObj = objectives.find(o => o.state === 'current');
        // PointerLockControls: horizontal yaw is on the controls object (parent), not camera
        const playerYaw = player._yaw;
        ui.renderMinimap(
            player.controls.getObject().position,
            playerYaw,
            creature.mesh.position,
            targetObj ? targetObj.target : null
        );

        engine.composer.render();
    }

    function start() {
        alive.running = true;
        alive.paused = false;
        prev = performance.now();
        tick(prev);
        // request pointer lock on first frame so the user can immediately start playing
    }

    function dispose() {
        alive.running = false;
        cancelAnimationFrame(alive.gameLoopId);
        canvas.removeEventListener('click', onClick);
        // Remove lock overlay if present
        const lo = document.getElementById('lockOverlay');
        if (lo && lo.parentNode) lo.parentNode.removeChild(lo);
        // stop ambient hum (and creature sounds will naturally die)
        audio.stopGeneratorHum();
        audio.ambienceNodes.forEach(n => { try { n.stop(); } catch (e) { } });
        audio.ambienceNodes = [];
        // dispose scene resources
        engine.scene.traverse(o => {
            if (o.geometry) o.geometry.dispose();
            if (o.material) {
                if (Array.isArray(o.material)) o.material.forEach(m => m.dispose());
                else o.material.dispose();
            }
        });
        engine.renderer.dispose();
        if (document.pointerLockElement) player.controls.unlock();
    }

    return {
        engine, world, player, creature, objectives,
        get running() { return alive.running; },
        set running(v) { alive.running = v; },
        get paused() { return alive.paused; },
        set paused(v) { alive.paused = v; },
        start, dispose
    };
}

// Resize menu canvas on window resize
window.addEventListener('resize', () => { ui.resizeMenuScene(); });

// Boot
boot();