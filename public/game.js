import * as THREE from 'three';
import { createEngine } from './engine.js';
import { World } from './world.js';
import { Player } from './player.js';
import { Creature } from './ai.js';
import { UI } from './ui.js';
import { AudioSystem } from './audio.js';
import './textures.js';

const ui    = new UI();
const audio = new AudioSystem();

// ── Loading sequence tags ────────────────────────────────────────────────────
const loadingSteps = [
    ['Initializing renderer…',              8],
    ['Compiling shaders…',                 18],
    ['Generating facility geometry…',      32],
    ['Building post-processing pipeline…', 48],
    ['Synthesizing audio…',               62],
    ['Spawning entity 04F-X…',            78],
    ['Calibrating subject monitor…',       90],
    ['Ready.',                            100]
];

let game = null;

// ════════════════════════════════════════════════════════════════════
// BOOT
// ════════════════════════════════════════════════════════════════════
async function boot() {
    for (const [tag, pct] of loadingSteps) {
        ui.setLoading(pct, tag);
        await new Promise(r => setTimeout(r, 280 + Math.random() * 220));
    }
    ui.initMenuScene();
    ui.hideLoading();
    ui.showMainMenu();

    // Menu scene animation loop
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

    // Menu item hover + click
    document.querySelectorAll('.menu-item').forEach(el => {
        el.addEventListener('mouseenter', () => {
            document.querySelectorAll('.menu-item').forEach(x => x.classList.remove('active'));
            el.classList.add('active');
            audio.resume();
            audio.init().then(() => audio.uiBlip());
        });
        el.addEventListener('click', () => handleMenuAction(el.dataset.action));
    });

    // Pause menu buttons
    document.getElementById('pauseResume')
        .addEventListener('click', () => resumeGame());
    document.getElementById('pauseSettings')
        .addEventListener('click', () => {
            ui.elems.pause.classList.add('hidden');
            ui.showSettings();
        });
    document.getElementById('pauseMainMenu')
        .addEventListener('click', () => endRunToMenu());

    // Game-over / victory buttons
    document.getElementById('goRestart')
        .addEventListener('click', () => { ui.elems.gameOver.classList.add('hidden'); startNewGame(); });
    document.getElementById('goMenu')
        .addEventListener('click', () => { ui.elems.gameOver.classList.add('hidden'); ui.showMainMenu(); });
    document.getElementById('vcMenu')
        .addEventListener('click', () => { ui.elems.victory.classList.add('hidden'); ui.showMainMenu(); });

    // Settings sliders — live tweaks
    document.getElementById('setSens').addEventListener('input', e => {
        if (game) game.player.controls.pointerSpeed = parseFloat(e.target.value) * 600;
    });
    document.getElementById('setVol').addEventListener('input', e =>
        audio.setVolume(parseFloat(e.target.value))
    );
    document.getElementById('setBloom').addEventListener('input', e => {
        if (game) game.engine.passes.bloomPass.strength = parseFloat(e.target.value);
    });
    document.getElementById('setGrain').addEventListener('input', e => {
        if (game) {
            const fp = game.engine.passes.filmPass;
            if (fp.uniforms?.intensity)  fp.uniforms.intensity.value  = parseFloat(e.target.value);
            else if (fp.uniforms?.nIntensity) fp.uniforms.nIntensity.value = parseFloat(e.target.value);
        }
    });
    document.getElementById('setFov').addEventListener('input', e => {
        if (game) {
            game.engine.camera.fov = parseFloat(e.target.value);
            game.engine.camera.updateProjectionMatrix();
        }
    });
    document.getElementById('setBob').addEventListener('change', e => {
        if (game) game.player.bobEnabled = e.target.checked;
    });

    // Keyboard: Esc = pause, M = facility map
    document.addEventListener('keydown', e => {
        if (e.code === 'Escape') {
            if (game && game.running) togglePause();
        }
        if (e.code === 'KeyM') {
            const overlay = document.getElementById('mapOverlay');
            if (!overlay) return;
            const isHidden = overlay.classList.contains('hidden');
            if (isHidden) {
                overlay.classList.remove('hidden');
                if (game && game.running) {
                    game.paused = true;
                    if (document.pointerLockElement) game.player.controls.unlock();
                }
                drawFacilityMap();
            } else {
                overlay.classList.add('hidden');
                if (game && game.running) {
                    game.paused = false;
                    game.player.controls.lock();
                }
            }
        }
    });
}

// ════════════════════════════════════════════════════════════════════
// FACILITY MAP OVERLAY  (press M)
// Drawn to match the new office layout exactly.
// ════════════════════════════════════════════════════════════════════
function drawFacilityMap() {
    const canvas = document.getElementById('mapCanvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const W   = canvas.width,  H = canvas.height;

    // World-space bounds (same as the new world.js layout)
    // Rooms span roughly x=-29..29, z=-33.5..33.5
    const bounds = { minX: -33, maxX: 33, minZ: -37, maxZ: 37 };
    const PAD    = 72;
    const mapW   = W - PAD * 2, mapH = H - PAD * 2;
    const sx     = mapW / (bounds.maxX - bounds.minX);
    const sy     = mapH / (bounds.maxZ - bounds.minZ);
    const wx     = x => PAD + (x - bounds.minX) * sx;
    const wz     = z => PAD + (z - bounds.minZ) * sy;

    const RED  = 'rgba(196,30,30,';
    const REDF = '#c41e1e';

    // ── Background + CRT effect ──────────────────────────────────
    ctx.fillStyle = '#060504'; ctx.fillRect(0, 0, W, H);
    for (let y = 0; y < H; y += 3) {
        ctx.fillStyle = 'rgba(0,0,0,0.12)'; ctx.fillRect(0, y, W, 1);
    }
    // Grid
    ctx.strokeStyle = RED + '0.06)'; ctx.lineWidth = 0.5;
    for (let x = bounds.minX; x <= bounds.maxX; x += 10) {
        ctx.beginPath(); ctx.moveTo(wx(x), PAD); ctx.lineTo(wx(x), H - PAD); ctx.stroke();
    }
    for (let z = bounds.minZ; z <= bounds.maxZ; z += 10) {
        ctx.beginPath(); ctx.moveTo(PAD, wz(z)); ctx.lineTo(W - PAD, wz(z)); ctx.stroke();
    }

    // ── Room definitions (matching world.js coordinates exactly) ──
    // t: 'c' = corridor, 'b' = bridge, 'r' = room, 's' = special
    const rooms = [
        // Spine: x=0, w=3, z=-24..+24 (center z=0, len=48)
        { x: 0,      z:  0,      w: 3,   d: 48,  t: 'c' },
        // Exit connector: z=-25.25, len=2.5
        { x: 0,      z: -25.25,  w: 3,   d: 2.5, t: 'c' },
        // Entrance connector: z=+25.25, len=2.5
        { x: 0,      z:  25.25,  w: 3,   d: 2.5, t: 'c' },
        // West side corridor: x=-12, z=6, w=3, d=12
        { x: -12,    z:  6,      w: 3,   d: 12,  t: 'c' },
        // East side corridor: x=+12, z=6, w=3, d=12
        { x:  12,    z:  6,      w: 3,   d: 12,  t: 'c' },
        // Upper bridges (Security↔Spine, Laboratory↔Spine)
        { x: -4.25,  z: -16,     w: 5.5, d: 3,   t: 'b' },
        { x:  4.25,  z: -16,     w: 5.5, d: 3,   t: 'b' },
        // Lower bridges (Records↔Spine, Meeting↔Spine)
        { x: -4.25,  z:  16,     w: 5.5, d: 3,   t: 'b' },
        { x:  4.25,  z:  16,     w: 5.5, d: 3,   t: 'b' },
        // West wing bridges (Storage, Maintenance)
        { x: -16.25, z:  2,      w: 5.5, d: 3,   t: 'b' },
        { x: -16.25, z:  10,     w: 5.5, d: 3,   t: 'b' },
        // East wing bridges (Break Room, Admin Office)
        { x:  16.25, z:  2,      w: 5.5, d: 3,   t: 'b' },
        { x:  16.25, z:  10,     w: 5.5, d: 3,   t: 'b' },
        // Reception ↔ west corridor short bridge
        { x: -9.75,  z:  2,      w: 1.5, d: 10,  t: 'b' },
        // Reception ↔ east corridor short bridge
        { x:  9.75,  z:  2,      w: 1.5, d: 10,  t: 'b' },

        // ── Named rooms ──
        // Exit Area (top)
        {
            x: 0,   z: -30,  w: 10, d: 7, t: 's',
            lb: 'EXIT\nAREA', poi: 'obj',
            doors: [{ s: 'S', c: 0, gw: 3 }]
        },
        // Main Entrance (bottom) — player spawn
        {
            x: 0,   z:  30,  w: 10, d: 7, t: 's',
            lb: 'MAIN\nENTRANCE',
            doors: [{ s: 'N', c: 0, gw: 3 }]
        },
        // Reception (center hub, largest room)
        {
            x: 0,   z:  2,   w: 18, d: 10, t: 'r',
            lb: 'RECEPTION', poi: 'poi',
            doors: [{ s: 'N', c: 0, gw: 3 }, { s: 'S', c: 0, gw: 3 }]
        },
        // Security Office (upper-left)
        {
            x: -12, z: -16,  w: 10, d: 8, t: 'r',
            lb: 'SECURITY\nOFFICE', poi: 'poi',
            doors: [{ s: 'E', c: 0, gw: 3 }]
        },
        // Laboratory (upper-right)
        {
            x:  12, z: -16,  w: 10, d: 8, t: 'r',
            lb: 'LABORATORY',
            doors: [{ s: 'W', c: 0, gw: 3 }]
        },
        // Storage Room (middle-left upper)
        {
            x: -24, z:  2,   w: 10, d: 8, t: 'r',
            lb: 'STORAGE\nROOM',
            doors: [{ s: 'E', c: 0, gw: 3 }]
        },
        // Maintenance Room (middle-left lower) — generator objective
        {
            x: -24, z:  10,  w: 10, d: 7, t: 'r',
            lb: 'MAINTENANCE\nROOM', poi: 'obj',
            doors: [{ s: 'E', c: 0, gw: 3 }]
        },
        // Break Room (middle-right upper)
        {
            x:  24, z:  2,   w: 10, d: 8, t: 'r',
            lb: 'BREAK\nROOM',
            doors: [{ s: 'W', c: 0, gw: 3 }]
        },
        // Admin Office (middle-right lower)
        {
            x:  24, z:  10,  w: 10, d: 7, t: 'r',
            lb: 'ADMIN\nOFFICE', poi: 'poi',
            doors: [{ s: 'W', c: 0, gw: 3 }]
        },
        // Records Room (lower-left)
        {
            x: -12, z:  16,  w: 10, d: 8, t: 'r',
            lb: 'RECORDS\nROOM',
            doors: [{ s: 'E', c: 0, gw: 3 }]
        },
        // Meeting Room (lower-right)
        {
            x:  12, z:  16,  w: 10, d: 8, t: 'r',
            lb: 'MEETING\nROOM', poi: 'poi',
            doors: [{ s: 'W', c: 0, gw: 3 }]
        },
    ];

    // ── Draw room function ───────────────────────────────────────
    const drawR = r => {
        const rx = wx(r.x - r.w / 2), ry = wz(r.z - r.d / 2);
        const rw = r.w * sx,           rh = r.d * sy;

        ctx.fillStyle   = (r.t === 'r' || r.t === 's') ? RED + '0.10)' : RED + '0.05)';
        ctx.fillRect(rx, ry, rw, rh);

        ctx.strokeStyle = (r.t === 'r' || r.t === 's') ? RED + '0.90)' : RED + '0.40)';
        ctx.lineWidth   = (r.t === 'r' || r.t === 's') ? 1.5 : 0.8;

        if (!r.doors || !r.doors.length) {
            ctx.strokeRect(rx, ry, rw, rh);
        } else {
            // Build doors-by-side index
            const ds = { N: [], S: [], E: [], W: [] };
            r.doors.forEach(d => ds[d.s] && ds[d.s].push(d));

            // Draw a wall segment with door gap(s)
            const seg = (x1, y1, x2, y2, hz, gaps) => {
                if (!gaps.length) {
                    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke(); return;
                }
                let cur = hz ? x1 : y1;
                const end = hz ? x2 : y2;
                [...gaps].sort((a, b) => a.c - b.c).forEach(d => {
                    const gs = hz ? wx(r.x + d.c - d.gw / 2) : wz(r.z + d.c - d.gw / 2);
                    const ge = hz ? wx(r.x + d.c + d.gw / 2) : wz(r.z + d.c + d.gw / 2);
                    if (gs > cur) {
                        ctx.beginPath();
                        if (hz) { ctx.moveTo(cur, y1); ctx.lineTo(gs, y1); }
                        else    { ctx.moveTo(x1, cur); ctx.lineTo(x1, gs); }
                        ctx.stroke();
                    }
                    // Door tick marks
                    const sv = ctx.strokeStyle, lw = ctx.lineWidth;
                    ctx.strokeStyle = REDF; ctx.lineWidth = 2;
                    if (hz) {
                        ctx.beginPath(); ctx.moveTo(gs, y1 - 5); ctx.lineTo(gs, y1 + 5); ctx.stroke();
                        ctx.beginPath(); ctx.moveTo(ge, y1 - 5); ctx.lineTo(ge, y1 + 5); ctx.stroke();
                    } else {
                        ctx.beginPath(); ctx.moveTo(x1 - 5, gs); ctx.lineTo(x1 + 5, gs); ctx.stroke();
                        ctx.beginPath(); ctx.moveTo(x1 - 5, ge); ctx.lineTo(x1 + 5, ge); ctx.stroke();
                    }
                    ctx.strokeStyle = sv; ctx.lineWidth = lw;
                    cur = ge;
                });
                if (end > cur) {
                    ctx.beginPath();
                    if (hz) { ctx.moveTo(cur, y1); ctx.lineTo(end, y1); }
                    else    { ctx.moveTo(x1, cur); ctx.lineTo(x1, end); }
                    ctx.stroke();
                }
            };

            // For N/S walls, gap centers are relative to room cx (x-axis)
            // For E/W walls, gap centers are relative to room cz (z-axis)
            const ndoors = ds.N.map(d => ({ ...d, c: r.x + (d.c || 0) }));
            const sdoors = ds.S.map(d => ({ ...d, c: r.x + (d.c || 0) }));
            const wdoors = ds.W.map(d => ({ ...d, c: r.z + (d.c || 0) }));
            const edoors = ds.E.map(d => ({ ...d, c: r.z + (d.c || 0) }));

            seg(rx,      ry,      rx + rw, ry,      true,  ndoors);
            seg(rx,      ry + rh, rx + rw, ry + rh, true,  sdoors);
            seg(rx,      ry,      rx,      ry + rh, false, wdoors);
            seg(rx + rw, ry,      rx + rw, ry + rh, false, edoors);
        }

        // Room label
        if (r.lb) {
            const cx2 = rx + rw / 2, cy2 = ry + rh / 2;
            ctx.fillStyle = r.t === 's' ? '#e8dfcc' : '#9a9080';
            ctx.font      = `bold 7px 'Share Tech Mono', monospace`;
            ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
            const lines = r.lb.split('\n');
            lines.forEach((l, i) =>
                ctx.fillText(l, cx2, cy2 - (lines.length - 1) * 9 / 2 + i * 9)
            );
        }

        // POI / objective marker
        if (r.poi) {
            const mx = rx + rw / 2;
            const my = ry + rh / 2 + (r.lb ? Math.ceil(r.lb.split('\n').length) * 5 : 0);
            if (r.poi === 'obj') {
                ctx.strokeStyle = '#f0a830'; ctx.lineWidth = 1.5;
                ctx.beginPath(); ctx.arc(mx, my, 5, 0, Math.PI * 2); ctx.stroke();
            } else {
                ctx.fillStyle = REDF;
                ctx.beginPath(); ctx.arc(mx, my, 3.5, 0, Math.PI * 2); ctx.fill();
            }
        }
    };

    // Draw corridors/bridges first (under rooms)
    rooms.filter(r => r.t === 'c' || r.t === 'b').forEach(drawR);
    // Draw rooms on top
    rooms.filter(r => r.t === 'r' || r.t === 's').forEach(drawR);

    // ── Player marker (spawn = Entrance at z=+30) ───────────────
    const ppx = wx(0), ppy = wz(30);
    ctx.save(); ctx.translate(ppx, ppy);
    ctx.fillStyle = '#fff'; ctx.strokeStyle = 'rgba(255,255,255,0.3)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, -8); ctx.lineTo(5, 6); ctx.lineTo(-5, 6); ctx.closePath();
    ctx.fill(); ctx.stroke(); ctx.restore();

    // ── Title ────────────────────────────────────────────────────
    ctx.fillStyle = REDF;
    ctx.font      = "bold 16px 'Share Tech Mono', monospace";
    ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    ctx.fillText('FACILITY MAP', PAD, 12);
    ctx.strokeStyle = 'rgba(196,30,30,0.4)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(PAD, 32); ctx.lineTo(PAD + 120, 32); ctx.stroke();

    // ── Legend ───────────────────────────────────────────────────
    const litems = [
        {
            draw: () => {
                ctx.fillStyle = '#fff';
                ctx.beginPath(); ctx.moveTo(PAD + 6, 50); ctx.lineTo(PAD + 10, 60);
                ctx.lineTo(PAD + 2, 60); ctx.closePath(); ctx.fill();
            }, lb: 'PLAYER'
        },
        {
            draw: () => {
                ctx.strokeStyle = '#f0a830'; ctx.lineWidth = 1.5;
                ctx.beginPath(); ctx.arc(PAD + 6, 58, 5, 0, Math.PI * 2); ctx.stroke();
            }, lb: 'OBJECTIVE'
        },
        {
            draw: () => {
                ctx.fillStyle = REDF;
                ctx.beginPath(); ctx.arc(PAD + 6, 58, 3.5, 0, Math.PI * 2); ctx.fill();
            }, lb: 'POINT OF INTEREST'
        },
        {
            draw: () => {
                ctx.strokeStyle = RED + '0.9)'; ctx.lineWidth = 1.5;
                ctx.strokeRect(PAD + 1, 53, 10, 10);
            }, lb: 'ROOM / OFFICE'
        },
        {
            draw: () => {
                ctx.strokeStyle = REDF; ctx.lineWidth = 2;
                ctx.beginPath(); ctx.moveTo(PAD + 1, 58); ctx.lineTo(PAD + 11, 58); ctx.stroke();
                ctx.beginPath(); ctx.moveTo(PAD + 3, 54); ctx.lineTo(PAD + 3, 62); ctx.stroke();
                ctx.beginPath(); ctx.moveTo(PAD + 9, 54); ctx.lineTo(PAD + 9, 62); ctx.stroke();
            }, lb: 'DOOR / ENTRY'
        },
    ];
    litems.forEach((it, i) => {
        const oy = i * 18;
        ctx.save(); ctx.translate(0, oy); it.draw(); ctx.restore();
        ctx.fillStyle = '#7a7068'; ctx.font = "9px 'Share Tech Mono', monospace";
        ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
        ctx.fillText(it.lb, PAD + 16, 54 + oy);
    });

    // ── North compass ─────────────────────────────────────────────
    const cpx = W - 48, cpy = H - 48;
    ctx.strokeStyle = REDF; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(cpx, cpy, 16, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = REDF;
    ctx.beginPath(); ctx.moveTo(cpx, cpy - 13); ctx.lineTo(cpx + 4, cpy - 3);
    ctx.lineTo(cpx - 4, cpy - 3); ctx.closePath(); ctx.fill();
    ctx.strokeStyle = 'rgba(196,30,30,0.4)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(cpx, cpy - 3); ctx.lineTo(cpx, cpy + 13); ctx.stroke();
    ctx.fillStyle = REDF; ctx.font = "bold 9px 'Share Tech Mono', monospace";
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('N', cpx, cpy - 21);

    // ── Sector info box ───────────────────────────────────────────
    ctx.strokeStyle = 'rgba(196,30,30,0.35)'; ctx.lineWidth = 1;
    ctx.strokeRect(PAD, H - PAD + 10, 160, 30);
    ctx.fillStyle = '#7a7068'; ctx.font = "9px 'Share Tech Mono', monospace";
    ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    ctx.fillText('SECTOR: A-1',        PAD + 6, H - PAD + 16);
    ctx.fillText('CLEARANCE: LEVEL 4', PAD + 6, H - PAD + 26);

    // Border frame
    ctx.strokeStyle = 'rgba(196,30,30,0.3)'; ctx.lineWidth = 1;
    ctx.strokeRect(3, 3, W - 6, H - 6);
    ctx.strokeStyle = 'rgba(196,30,30,0.12)';
    ctx.strokeRect(7, 7, W - 14, H - 14);
}

// ════════════════════════════════════════════════════════════════════
// MENU ACTIONS
// ════════════════════════════════════════════════════════════════════
function handleMenuAction(action) {
    audio.resume();
    audio.init().then(() => audio.uiBlip());
    if      (action === 'newgame')  startNewGame();
    else if (action === 'resume')   game ? resumeGame() : startNewGame();
    else if (action === 'settings') ui.showSettings();
    else if (action === 'about')    ui.showAbout();
    else if (action === 'exit')     window.location.href = 'about:blank';
}

// ════════════════════════════════════════════════════════════════════
// GAME LIFECYCLE
// ════════════════════════════════════════════════════════════════════
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

// ════════════════════════════════════════════════════════════════════
// BUILD RUN — constructs a full game session
// ════════════════════════════════════════════════════════════════════
function buildRun() {
    const canvas  = document.getElementById('gameCanvas');
    const engine  = createEngine(canvas);
    const world   = new World(engine.scene);
    const player  = new Player(engine.camera, engine.scene, world, audio);
    const creature = new Creature(engine.scene, world, audio);

    // ── Spawn locations ─────────────────────────────────────────
    // Player: inside Main Entrance at the bottom-center of the map.
    // Walking north leads straight into Reception → rest of facility.
    player.setSpawn(0, 30);

    // Creature: Security Office area (upper-left). Its patrol loop
    // covers the full facility so it will eventually find the player.
    creature.setSpawn(-12, -16);

    // ── Camera bounds ────────────────────────────────────────────
    // Update the player's position clamp to match the full new map.
    // The facility spans roughly x=-29..29, z=-34..34 (rooms + corridors).
    // We add a small margin so the player can't walk outside the outer walls.
    // This is enforced in player.update() — update those values here
    // by monkey-patching the update so the old constants don't apply.
    // (player.js clamps to ±34 x and ±44 z, which is fine for this layout.)

    ui.initMinimap(world);

    // ── Objectives ───────────────────────────────────────────────
    const objectives = [
        { id: 1, text: 'Find the Security Keycard',   state: 'current', target: { x: -12, z: -16 } },
        { id: 2, text: 'Open the Security Office',    state: 'pending', target: null                 },
        { id: 3, text: 'Restore Generator Power',     state: 'pending', target: { x: -24, z:  10 } },
        { id: 4, text: 'Unlock the Exit Gate',         state: 'pending', target: { x:   0, z: -30 } },
        { id: 5, text: 'Escape the Facility',          state: 'pending', target: null                 },
    ];
    ui.renderObjectives(objectives);

    // ── Audio ────────────────────────────────────────────────────
    audio.init().then(() => {
        audio.startAmbience();
        ui.showSubtitle(
            'You wake to darkness. The facility hums faintly. Something is wrong.', 6
        );
    });

    // ── Pointer lock overlay ─────────────────────────────────────
    const onClick = () => {
        if (game && !game.paused && !player.dead) player.controls.lock();
    };
    canvas.addEventListener('click', onClick);

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
        <div style="color:#c41e1e;font-size:12px;letter-spacing:0.25em;">MOUSE · WASD · F = FLASHLIGHT · M = MAP</div>
    `;
    lockOverlay.addEventListener('click', () => player.controls.lock());
    document.body.appendChild(lockOverlay);

    player.controls.addEventListener('lock', () => {
        if (lockOverlay.parentNode) lockOverlay.parentNode.removeChild(lockOverlay);
    });
    player.controls.addEventListener('unlock', () => {
        if (game && game.running && !game.paused && !player.dead) {
            if (!lockOverlay.parentNode) document.body.appendChild(lockOverlay);
        }
    });

    // ── Raycaster for interaction ─────────────────────────────────
    const raycaster          = new THREE.Raycaster();
    raycaster.far            = 2.6;
    const tmpDir             = new THREE.Vector3();
    const tmpPos             = new THREE.Vector3();
    let   activeInteractable = null;

    // ── Horror event scheduler ───────────────────────────────────
    let nextHorrorAt = 18 + Math.random() * 18;
    let horrorTime   = 0;

    function triggerHorrorEvent(player) {
        const r = Math.random();
        if (r < 0.35) {
            // Whisper from a random direction
            audio.whisper((Math.random() - 0.5) * 1.8);
        } else if (r < 0.6) {
            // Quick flicker on nearest light
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
            if (Math.random() < 0.5) audio.doorSlam(); else audio.doorCreak();
        } else {
            ui.elems.damage.classList.add('flash');
            setTimeout(() => ui.elems.damage.classList.remove('flash'), 200);
        }
        nextHorrorAt = 18 + Math.random() * 22;
        horrorTime   = 0;
    }

    function findInteractable() {
        player.camera.getWorldDirection(tmpDir);
        tmpPos.copy(player.camera.getWorldPosition(new THREE.Vector3()));
        raycaster.set(tmpPos, tmpDir);
        raycaster.far = 2.6;
        const meshes = world.interactables.map(it => it.mesh);
        const hits   = raycaster.intersectObjects(meshes, false);
        if (hits.length) {
            const hitMesh = hits[0].object;
            return world.interactables.find(it => it.mesh === hitMesh);
        }
        return null;
    }

    function doInteract(it) {
        audio.uiBlip();

        if (it.type === 'keycard') {
            // ── Keycard picked up ───────────────────────────────
            player.inventory.add(it.data.id);
            audio.pickup();
            world.removeInteractable(it);
            objectives[0].state = 'done';
            objectives[1].state = 'current';
            objectives[1].target = { x: -12, z: -16 };
            ui.renderObjectives(objectives);
            ui.showSubtitle('Picked up: SECURITY KEYCARD', 3.2);
            // Security Office is "opened" immediately on keycard pickup
            setTimeout(() => {
                objectives[1].state = 'done';
                objectives[2].state = 'current';
                ui.renderObjectives(objectives);
                ui.showSubtitle('Security Office cleared. Find the generator.', 4);
            }, 800);

        } else if (it.type === 'note') {
            // ── Read note ───────────────────────────────────────
            ui.showSubtitle(it.data.text, 7);

        } else if (it.type === 'generator_switch') {
            // ── Generator switch ─────────────────────────────────
            if (it.data.powered) {
                ui.showSubtitle('Generator already online.', 2.4);
                return;
            }
            if (objectives[2].state !== 'current') {
                ui.showSubtitle("You don't need to touch this yet.", 2.4);
                return;
            }
            it.data.powered = true;
            it.data.panel.material.emissive           = new THREE.Color(0x66aaff);
            it.data.panel.material.emissiveIntensity  = 1.5;
            audio.startGeneratorHum();
            world.fanSpeed = 3.5;
            world.setMainPower(true);
            player.facilityPowered = true;
            objectives[2].state = 'done';
            objectives[3].state = 'current';
            ui.renderObjectives(objectives);
            ui.showSubtitle('POWER RESTORED. The lights flicker back to life. It heard that.', 5);
            // Creature becomes more aggressive after power-on
            creature.detectionRadius = 12;
            creature.speedChase      = 4.8;

        } else if (it.type === 'exit_console') {
            // ── Exit gate console ────────────────────────────────
            if (!player.facilityPowered) {
                ui.showSubtitle('No power. The console is dead.', 3);
                audio.uiBlip();
                return;
            }
            if (!player.inventory.has('security_keycard')) {
                ui.showSubtitle('Requires SECURITY CLEARANCE.', 3);
                return;
            }

            // Remove gate bars from collision immediately
            const gateBarMeshes = it.data.gateBarMeshes;
            world.collidables = world.collidables.filter(c => !gateBarMeshes.includes(c));
            world.exitUnlocked = true;
            ui.showSubtitle('Exit gate unlocked. Go!', 3);

            // Animate gate bars rising
            const gate = it.data.gate;
            const startY = gate.position.y;
            const endY   = startY + 2.9;
            const t0     = performance.now();
            (function anim() {
                const t = Math.min(1, (performance.now() - t0) / 2000);
                gate.position.y = startY + (endY - startY) * t;
                if (t < 1) requestAnimationFrame(anim);
            })();

            it.data.screen.material.emissive = new THREE.Color(0x4fbc94);
            audio.doorCreak();
            objectives[3].state = 'done';
            objectives[4].state = 'current';
            objectives[4].target = { x: 0, z: -30 };
            ui.renderObjectives(objectives);
            ui.showSubtitle('GATE OPENED. RUN NORTH.', 4);
        }
    }

    document.addEventListener('keydown', e => {
        if (e.code === 'KeyE' && activeInteractable && game.running && !game.paused) {
            doInteract(activeInteractable);
        }
    });

    // ════════════════════════════════════════════════════════════
    // MAIN GAME LOOP
    // ════════════════════════════════════════════════════════════
    let prev = performance.now();
    let acc  = 0;
    let alive = { running: true, paused: false, gameLoopId: 0 };

    function tick(now) {
        alive.gameLoopId = requestAnimationFrame(tick);
        if (!alive.running) return;

        const dt   = Math.min(0.05, (now - prev) / 1000);
        prev = now;
        const time = now / 1000;

        if (!alive.paused && !player.dead) {
            player.update(dt, time);
            creature.update(dt, time, player);
            world.update(dt, time);

            // Interaction prompt
            activeInteractable = findInteractable();
            if (activeInteractable) ui.showInteract(activeInteractable.prompt);
            else                    ui.hideInteract();

            // ── Win condition ────────────────────────────────────
            // Player must walk through the exit area and past the north wall.
            // Exit Area: center (0, -30), depth=7, so north wall is at z = -33.5.
            // We trigger victory when the player crosses z = -34 (just past the north wall).
            const ppos = player.controls.getObject().position;
            if (objectives[4].state === 'current' && ppos.z < -34 && Math.abs(ppos.x) < 4) {
                objectives[4].state = 'done';
                ui.renderObjectives(objectives);
                ui.showVictory();
                alive.running = false;
                if (document.pointerLockElement) player.controls.unlock();
            }

            // Damage flash
            if (player.health < (player._prevHealth ?? 100)) ui.flashDamage();
            player._prevHealth = player.health;

            // Death
            if (player.dead) {
                ui.showGameOver('Subject 07 — STATUS: TERMINATED');
                alive.running = false;
                if (document.pointerLockElement) player.controls.unlock();
            }

            // Horror event timer
            horrorTime += dt;
            if (horrorTime > nextHorrorAt) triggerHorrorEvent(player);

            // Heartbeat audio when low HP or creature is close
            const dToCreature = creature.mesh.position.distanceTo(ppos);
            if (player.health < 35 || (creature.state === 'CHASE' && dToCreature < 12)) {
                if (!player._lastHeart || time - player._lastHeart > 0.7) {
                    audio.heartbeat(Math.max(0.6, 1 - dToCreature / 20));
                    player._lastHeart = time;
                }
            }
        }

        // Grade shader: damage tint based on health + creature proximity
        const damageVal = Math.max(0, 1 - player.health / 100) * 0.5
                        + (creature.state === 'CHASE' ? 0.2 : 0);
        if (engine.passes.gradePass && engine.passes.gradePass.uniforms) {
            engine.passes.gradePass.uniforms.uDamage.value +=
                (damageVal - engine.passes.gradePass.uniforms.uDamage.value) * 0.1;
            engine.passes.gradePass.uniforms.uTime.value = time;
        }

        // HUD stats + minimap
        ui.updateStats(player);
        ui.tickSubtitle(dt);

        const targetObj = objectives.find(o => o.state === 'current');
        ui.renderMinimap(
            player.controls.getObject().position,
            player._yaw,
            creature.mesh.position,
            targetObj ? targetObj.target : null
        );

        engine.composer.render();
    }

    function start() {
        alive.running = true;
        alive.paused  = false;
        prev = performance.now();
        tick(prev);
    }

    function dispose() {
        alive.running = false;
        cancelAnimationFrame(alive.gameLoopId);
        canvas.removeEventListener('click', onClick);
        const lo = document.getElementById('lockOverlay');
        if (lo && lo.parentNode) lo.parentNode.removeChild(lo);
        audio.stopGeneratorHum();
        audio.ambienceNodes.forEach(n => { try { n.stop(); } catch (e) {} });
        audio.ambienceNodes = [];
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
        get paused()  { return alive.paused; },
        set paused(v) { alive.paused = v; },
        start, dispose
    };
}

// Resize menu canvas on window resize
window.addEventListener('resize', () => ui.resizeMenuScene());

// Boot the game
boot();