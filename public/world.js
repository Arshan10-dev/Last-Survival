import * as THREE from 'three';
import { buildConcreteSet, buildMetalSet, buildTileSet, buildDustParticleTexture, buildPaperTexture, buildSignTexture } from './textures.js';

/*
  Grid units = 1 meter. Facility layout (top-down, x runs right, z runs forward into screen):

     z
     ▼
     -42  Server Room      |  Ventilation
     -34  ─── corridor ────┼──────────────
     -26  Maintenance Tun. |  Generator Room
     -18  ─── corridor ────┼──────────────
     -10  Medical Bay      |  Laboratory Wing
      -2  ─── corridor ────┼──────────────
       6  Security Office  |  Storage Room
      14  Main Corridor (east-west spine)
      20  Reception
      28  Main Entrance
      36  Exit Gate (north return path on east side)

  Rooms are placed in cells of an east/west spine, with the main corridor at z≈14, and
  branching corridors going north (negative z). The Exit Gate is reached by following the
  corridor back east at z≈36.
*/

const WALL_H = 3.2;
const WALL_T = 0.25;

export class World {
    constructor(scene) {
        this.scene = scene;
        this.collidables = []; // boxes used for collision
        this.interactables = []; // { mesh, type, data, prompt, onInteract }
        this.lights = [];
        this.mainPowerLights = []; // bright ceiling lights, OFF until generator restored
        this.facilityPowered = false;
        this.flickerLights = [];
        this.rooms = {}; // name -> { center, bounds, label }
        this.minimapData = null; // for UI minimap renderer
        this._dust = null;

        this.materials = this._buildMaterials();
        this._buildAll();
    }

    _buildMaterials() {
        const concrete = buildConcreteSet();
        const metal = buildMetalSet();
        const tile = buildTileSet();

        const matFloor = new THREE.MeshStandardMaterial({
            ...concrete, roughness: 0.92, metalness: 0.04,
            color: 0x6a6258
        });
        const matWall = new THREE.MeshStandardMaterial({
            ...concrete, roughness: 0.88, metalness: 0.06,
            color: 0x5a5249
        });
        const matCeiling = new THREE.MeshStandardMaterial({
            color: 0x2a2622, roughness: 0.95, metalness: 0.03
        });
        const matMetal = new THREE.MeshStandardMaterial({
            ...metal, roughness: 0.55, metalness: 0.85, color: 0x8a857c
        });
        const matTile = new THREE.MeshStandardMaterial({
            ...tile, roughness: 0.45, metalness: 0.02, color: 0xc8c2b4
        });
        const matDoor = new THREE.MeshStandardMaterial({
            color: 0x4a3a2a, roughness: 0.5, metalness: 0.4
        });
        const matLockedDoor = new THREE.MeshStandardMaterial({
            color: 0x6e2a2a, roughness: 0.5, metalness: 0.6,
            emissive: 0x3a0808, emissiveIntensity: 0.4
        });
        const matComputer = new THREE.MeshStandardMaterial({
            color: 0x1a1a1a, roughness: 0.4, metalness: 0.7
        });
        const matScreen = new THREE.MeshStandardMaterial({
            color: 0x0a1f1a, emissive: 0x12a073, emissiveIntensity: 1.4,
            roughness: 0.2, metalness: 0.0
        });
        const matWater = new THREE.MeshStandardMaterial({
            color: 0x0a0d10, roughness: 0.05, metalness: 0.85,
            transparent: true, opacity: 0.85
        });
        const matEmergency = new THREE.MeshStandardMaterial({
            color: 0xc41e1e, emissive: 0xc41e1e, emissiveIntensity: 1.8,
            roughness: 0.4, metalness: 0.0
        });
        return {
            matFloor, matWall, matCeiling, matMetal, matTile, matDoor, matLockedDoor,
            matComputer, matScreen, matWater, matEmergency, dust: buildDustParticleTexture()
        };
    }

    _buildAll() {
        this._buildSpine();
        this._buildRooms();
        this._buildCentralReception();
        this._buildExitArea();
        this._buildAtmosphere();
    }

    // ---------- HELPERS ----------
    _floor(x, z, w, d, mat = this.materials.matFloor) {
        const g = new THREE.PlaneGeometry(w, d, 2, 2);
        const m = new THREE.Mesh(g, mat);
        m.rotation.x = -Math.PI / 2;
        m.position.set(x, 0, z);
        m.receiveShadow = true;
        this.scene.add(m);
        return m;
    }
    _ceiling(x, z, w, d) {
        const g = new THREE.PlaneGeometry(w, d);
        const m = new THREE.Mesh(g, this.materials.matCeiling);
        m.rotation.x = Math.PI / 2;
        m.position.set(x, WALL_H, z);
        this.scene.add(m);
        return m;
    }
    _wall(x, z, w, h, d, mat = this.materials.matWall, opts = {}) {
        const g = new THREE.BoxGeometry(w, h, d);
        const m = new THREE.Mesh(g, mat);
        m.position.set(x, h / 2, z);
        m.castShadow = !!opts.castShadow;
        m.receiveShadow = true;
        this.scene.add(m);
        if (opts.solid !== false) this.collidables.push(m);
        return m;
    }
    _roomBox(cx, cz, w, d, opts = {}) {
        // build floor, ceiling, and four walls. Doorways: array of {side:'N|S|E|W', offset:0, width:1.6}
        const { doorways = [], floorMat, name } = opts;
        this._floor(cx, cz, w, d, floorMat || this.materials.matFloor);
        this._ceiling(cx, cz, w, d);

        const halfW = w / 2, halfD = d / 2;

        // For each wall, subtract doorways
        const sides = [
            { side: 'N', center: [cx, cz - halfD], axis: 'x', span: w }, // along x
            { side: 'S', center: [cx, cz + halfD], axis: 'x', span: w },
            { side: 'W', center: [cx - halfW, cz], axis: 'z', span: d }, // along z
            { side: 'E', center: [cx + halfW, cz], axis: 'z', span: d },
        ];
        sides.forEach(s => {
            const myDoors = doorways.filter(dw => dw.side === s.side)
                .map(dw => ({ offset: dw.offset || 0, width: dw.width || 1.8 }))
                .sort((a, b) => a.offset - b.offset);
            // Build wall segments around door cuts. Coord along axis runs from -span/2 .. +span/2
            let cursor = -s.span / 2;
            myDoors.forEach(dw => {
                const doorStart = dw.offset - dw.width / 2;
                const doorEnd = dw.offset + dw.width / 2;
                if (doorStart > cursor) this._wallSegment(s, cursor, doorStart);
                cursor = doorEnd;
                // top lintel above door
                this._lintel(s, doorStart, doorEnd);
            });
            if (cursor < s.span / 2) this._wallSegment(s, cursor, s.span / 2);
        });

        if (name) {
            this.rooms[name] = { center: new THREE.Vector3(cx, 0, cz), w, d };
        }
    }
    _wallSegment(side, fromAxis, toAxis) {
        const len = toAxis - fromAxis;
        if (len < 0.05) return;
        const mid = (fromAxis + toAxis) / 2;
        if (side.axis === 'x') {
            this._wall(side.center[0] + mid, side.center[1], len, WALL_H, WALL_T);
        } else {
            this._wall(side.center[0], side.center[1] + mid, WALL_T, WALL_H, len);
        }
    }
    _lintel(side, fromAxis, toAxis) {
        const len = toAxis - fromAxis;
        const mid = (fromAxis + toAxis) / 2;
        const lintelH = 0.6;
        const yTop = WALL_H - lintelH;
        if (side.axis === 'x') {
            const g = new THREE.BoxGeometry(len, lintelH, WALL_T);
            const m = new THREE.Mesh(g, this.materials.matWall);
            m.position.set(side.center[0] + mid, yTop + lintelH / 2, side.center[1]);
            m.receiveShadow = true;
            this.scene.add(m);
        } else {
            const g = new THREE.BoxGeometry(WALL_T, lintelH, len);
            const m = new THREE.Mesh(g, this.materials.matWall);
            m.position.set(side.center[0], yTop + lintelH / 2, side.center[1] + mid);
            m.receiveShadow = true;
            this.scene.add(m);
        }
    }

    _light(color, intensity, x, y, z, distance = 8, decay = 1.8, opts = {}) {
        const L = new THREE.PointLight(color, intensity, distance, decay);
        L.position.set(x, y, z);
        if (opts.shadow) {
            L.castShadow = true;
            L.shadow.mapSize.set(256, 256);
            L.shadow.bias = -0.002;
            L.shadow.camera.near = 0.2;
            L.shadow.camera.far = distance;
        }
        this.scene.add(L);
        this.lights.push(L);
        if (opts.flicker) this.flickerLights.push({ light: L, base: intensity, phase: Math.random() * 10, rate: 0.3 + Math.random() * 1.2, depth: opts.flickerDepth || 0.4 });
        return L;
    }

    // Bright white ceiling light — OFF (intensity 0) until generator restores power.
    // Placed at room center, casts no shadow (cheap, just floods the room).
    _mainLight(x, z, targetIntensity = 2.2, distance = 9) {
        const L = new THREE.PointLight(0xfff6e8, 0, distance, 1.6);
        L.position.set(x, 2.9, z);
        this.scene.add(L);
        this.mainPowerLights.push({ light: L, target: targetIntensity });
        return L;
    }

    // Called once when the generator is switched on — ramps all main lights up smoothly.
    setMainPower(on) {
        this.facilityPowered = on;
        this._powerRampStart = performance.now();
        this._powerRampFrom = this.mainPowerLights.map(p => p.light.intensity);
        this._powerRampTo   = on ? this.mainPowerLights.map(p => p.target) : this.mainPowerLights.map(() => 0);
        this._powerRamping  = true;
    }

    // Visible ceiling fixture mesh (chandelier-style glow disc) — purely visual, paired with
    // a _mainLight() point light placed at the same spot for actual illumination.
    _ceilingFixture(x, z) {
        const housing = new THREE.Mesh(
            new THREE.CylinderGeometry(0.5, 0.5, 0.08, 24),
            new THREE.MeshStandardMaterial({ color: 0x2a2620, roughness: 0.5, metalness: 0.6 })
        );
        housing.position.set(x, WALL_H - 0.05, z);
        this.scene.add(housing);

        const glowDisc = new THREE.Mesh(
            new THREE.CylinderGeometry(0.42, 0.42, 0.03, 24),
            new THREE.MeshStandardMaterial({
                color: 0xfff6e0, emissive: 0xfff2c8, emissiveIntensity: 0,
                roughness: 0.3
            })
        );
        glowDisc.position.set(x, WALL_H - 0.1, z);
        this.scene.add(glowDisc);
        // Track so it brightens in sync with the room's main power light
        this.mainPowerLights.push({ light: { get intensity() { return glowDisc.material.emissiveIntensity; }, set intensity(v) { glowDisc.material.emissiveIntensity = v; } }, target: 1.6 });
        return { housing, glowDisc };
    }
    _emergencyFixture(x, y, z) {
        // Red emergency light fixture (emissive cylinder + caged housing)
        const housing = new THREE.Mesh(
            new THREE.BoxGeometry(0.4, 0.2, 0.25),
            this.materials.matMetal
        );
        housing.position.set(x, y, z);
        this.scene.add(housing);

        const dome = new THREE.Mesh(
            new THREE.SphereGeometry(0.13, 16, 12, 0, Math.PI * 2, 0, Math.PI / 2),
            this.materials.matEmergency
        );
        dome.position.set(x, y - 0.08, z);
        dome.rotation.x = Math.PI;
        this.scene.add(dome);

        this._light(0xff2222, 1.6, x, y - 0.1, z, 8, 1.8, { flicker: Math.random() < 0.35, flickerDepth: 0.3 });
    }

    // ---------- CORRIDOR SPINE ----------
    _buildSpine() {
        /*
         PRECISE LAYOUT:
         Main corridor:  x = -32 to +23,  z = 12.2 to 15.8  (center z=14, width=3.6)
         West branch:    x = -23.8 to -20.2,  z = -14 to +12  (center x=-22, width=3.6)
         East branch:    x = +2.2 to +5.8,    z = -14 to +12  (center x=+4,  width=3.6)
         North connector: x = -24 to +6,  z = -35.8 to -32.2  (center z=-34)

         Gap positions (ALL 2.0m wide):
           Main N wall (z=12.2): x=-20 (west branch entry), x=+4 (east branch entry)
           Main S wall (z=15.8): x=-26 (entrance), x=+16 (reception)
           West E wall (x=-20.2): z=+6, z=-2, z=-10, z=-18 (room entries)
           West W wall (x=-23.8): CLOSED (rooms are on the left side)
           East W wall (x=+2.2):  CLOSED (rooms are on the right side)
           East E wall (x=+5.8):  z=+6, z=-2, z=-10, z=-18 (room entries)
        */

        // ── Main east-west corridor ──
        this._floor(-4.5, 14, 55, 3.6, this.materials.matTile);
        this._ceiling(-4.5, 14, 55, 3.6);
        // North wall z=12.2 — gaps at x=-20 (west branch) and x=+4 (east branch)
        this._wallWithGaps(-4.5, 12.2, 55, true, [-20, 4]);
        // South wall z=15.8 — gaps at x=-26 (entrance) and x=+16 (reception)
        this._wallWithGaps(-4.5, 15.8, 55, true, [-26, 16]);
        // West end cap at x=-32
        this._wall(-32, 14, WALL_T, WALL_H, 3.6);
        // East end is open — exit gate room attaches here at x=+23

        for (let x = -28; x <= 18; x += 8) this._emergencyFixture(x, 2.7, 12.4);
        this._mainLight(-26, 14, 1.6, 10);
        this._mainLight(-9,  14, 1.6, 12);
        this._mainLight(8,   14, 1.6, 12);
        this._sign(-4.5, 2.4, 12.1, 'MAIN CORRIDOR', '#c41e1e', 3.0, 0.8);

        // ── West branch corridor  x=-22,  z = -14 to +12 ──
        this._floor(-22, -1, 3.6, 26, this.materials.matTile);
        this._ceiling(-22, -1, 3.6, 26);
        // East wall x=-20.2 — gap at z=2 connects to central reception room (widened to 3.0)
        this._wallWithGaps(-20.2, -1, 26, false, [{ center: 2, width: 3.0 }]);
        // West wall x=-23.8 — gaps at z=+6, -2, -10 where rooms open to the LEFT
        this._wallWithGaps(-23.8, -1, 26, false, [6, -2, -10]);
        // South cap z=+12
        this._wall(-22, 12, 3.6, WALL_H, WALL_T);
        for (let z = -10; z <= 8; z += 6) this._emergencyFixture(-22, 2.7, z);
        this._mainLight(-22, 0, 1.4, 14);

        // ── East branch corridor  x=+4,  z = -14 to +12 ──
        this._floor(4, -1, 3.6, 26, this.materials.matTile);
        this._ceiling(4, -1, 3.6, 26);
        // West wall x=+2.2 — gaps at z=6,-2,-10 (rooms, width 2.0) plus z=2 (central reception, width 3.0)
        this._wallWithGaps(2.2, -1, 26, false, [6, -2, -10, { center: 2, width: 3.0 }]);
        // East wall x=+5.8 — CLOSED (no rooms on right side of east branch)
        this._wall(5.8, -1, WALL_T, WALL_H, 26);
        // South cap z=+12
        this._wall(4, 12, 3.6, WALL_H, WALL_T);
        for (let z = -10; z <= 8; z += 6) this._emergencyFixture(4, 2.7, z);
        this._mainLight(4, 0, 1.4, 14);

        // ── Far north connector  z=-34,  x = -24 to +6 ──
        // Center x = (-24+6)/2 = -9,  length = 30
        this._floor(-9, -34, 30, 3.6, this.materials.matTile);
        this._ceiling(-9, -34, 30, 3.6);
        // North wall z=-35.8 — solid
        this._wall(-9, -35.8, 30, WALL_H, WALL_T);
        // South wall z=-32.2 — gaps at x=-22 (west bridge) and x=+4 (east bridge)
        this._wallWithGaps(-9, -32.2, 30, true, [-22, 4]);
        // East and west caps
        this._wall(-24, -34, WALL_T, WALL_H, 3.6);
        this._wall(6, -34, WALL_T, WALL_H, 3.6);
        this._emergencyFixture(-15, 2.7, -35.4);
        this._emergencyFixture(-3, 2.7, -35.4);
    }

    _wallWithGaps(x, z, length, isHorizontal, gapCenters, gapWidth = 2.0) {
        // builds a wall segment with gaps. isHorizontal=true means along x-axis at given z
        // gapCenters entries can be a plain number (uses default gapWidth) or
        // an object { center, width } for a custom-width gap.
        if (gapCenters.length === 0) {
            if (isHorizontal) this._wall(x, z, length, WALL_H, WALL_T);
            else this._wall(x, z, WALL_T, WALL_H, length);
            return;
        }
        const normalized = gapCenters.map(g =>
            typeof g === 'object' ? g : { center: g, width: gapWidth }
        );
        const sorted = [...normalized].sort((a, b) => a.center - b.center);
        const half = length / 2;
        let cursor = (isHorizontal ? x - half : z - half);
        sorted.forEach(({ center: gc, width: gw }) => {
            const gStart = gc - gw / 2;
            const gEnd = gc + gw / 2;
            if (gStart > cursor) {
                const segLen = gStart - cursor;
                const mid = (cursor + gStart) / 2;
                if (isHorizontal) this._wall(mid, z, segLen, WALL_H, WALL_T);
                else this._wall(x, mid, WALL_T, WALL_H, segLen);
            }
            // lintel
            if (isHorizontal) {
                const g = new THREE.BoxGeometry(gw, 0.6, WALL_T);
                const m = new THREE.Mesh(g, this.materials.matWall);
                m.position.set(gc, WALL_H - 0.3, z); m.receiveShadow = true;
                this.scene.add(m);
            } else {
                const g = new THREE.BoxGeometry(WALL_T, 0.6, gw);
                const m = new THREE.Mesh(g, this.materials.matWall);
                m.position.set(x, WALL_H - 0.3, gc); m.receiveShadow = true;
                this.scene.add(m);
            }
            cursor = gEnd;
        });
        const endCoord = (isHorizontal ? x + half : z + half);
        if (endCoord > cursor) {
            const segLen = endCoord - cursor;
            const mid = (cursor + endCoord) / 2;
            if (isHorizontal) this._wall(mid, z, segLen, WALL_H, WALL_T);
            else this._wall(x, mid, WALL_T, WALL_H, segLen);
        }
    }

    // ---------- ROOMS ----------
    _buildRooms() {
        this._buildRoomsClean();
    }

    _buildRoomsClean() {
        /*
         FINAL CORRECT LAYOUT:
         West branch west wall = x=-23.8 (has gaps at z=6,-2,-10) → rooms open LEFT (west)
           Room east edge = x=-23.8, width=10, center x = -23.8-5 = -28.8
           Build: N, S, W walls only. NO east wall (branch west wall is shared)

         East branch west wall = x=+2.2 (has gaps at z=6,-2,-10) → rooms open RIGHT (east)
           Room west edge = x=+2.2, width=10, center x = 2.2+5 = +7.2
           Build: N, S, E walls only. NO west wall (branch west wall is shared)
        */

        // ── MAIN ENTRANCE ──
        this._floor(-26, 20.8, 9, 10, this.materials.matFloor);
        this._ceiling(-26, 20.8, 9, 10);
        this._wall(-26, 25.8, 9, WALL_H, WALL_T);       // South
        this._wall(-21.5, 20.8, WALL_T, WALL_H, 10);    // East
        this._wall(-30.5, 20.8, WALL_T, WALL_H, 10);    // West
        // No north wall — corridor S wall gap at x=-26 handles entry
        this.rooms['Main Entrance'] = { center: new THREE.Vector3(-26, 0, 20.8), w: 9, d: 10 };
        this._addEntranceProps(-26, 20.8);
        this._emergencyFixture(-26, 2.7, 19);
        this._mainLight(-26, 20.8, 2.0, 9);

        // ── RECEPTION ──
        this._floor(16, 20.8, 12, 10, this.materials.matFloor);
        this._ceiling(16, 20.8, 12, 10);
        this._wall(16, 25.8, 12, WALL_H, WALL_T);
        this._wall(22, 20.8, WALL_T, WALL_H, 10);
        this._wall(10, 20.8, WALL_T, WALL_H, 10);
        this.rooms['Reception'] = { center: new THREE.Vector3(16, 0, 20.8), w: 12, d: 10 };
        this._addReceptionProps(16, 20.8);
        this._emergencyFixture(16, 2.7, 19);
        this._mainLight(16, 20.8, 2.2, 10);

        // ── WEST BRANCH ROOMS (open from branch west wall x=-23.8) ──
        const wx = -28.8;  // center x = -23.8 - 5
        const wrW = 10;

        const buildWestRoom = (cz, rD, name, addProps) => {
            const rHalf = rD / 2;
            this._floor(wx, cz, wrW, rD, this.materials.matFloor);
            this._ceiling(wx, cz, wrW, rD);
            this._wall(wx, cz - rHalf, wrW, WALL_H, WALL_T);  // North
            this._wall(wx, cz + rHalf, wrW, WALL_H, WALL_T);  // South
            this._wall(wx - 5, cz, WALL_T, WALL_H, rD);        // West far wall x=-33.8
            // NO east wall — branch west wall x=-23.8 shared with gaps
            this.rooms[name] = { center: new THREE.Vector3(wx, 0, cz), w: wrW, d: rD };
            addProps();
            this._emergencyFixture(wx, 2.7, cz);
            this._mainLight(wx, cz, 2.0, 8);
        };

        buildWestRoom(6,   7, 'Security Office',    () => this._addSecurityProps(wx, 6));
        buildWestRoom(-2,  7, 'Medical Bay',        () => this._addMedicalProps(wx, -2));
        buildWestRoom(-10, 7, 'Maintenance Tunnel', () => this._addMaintenanceProps(wx, -10));

        // Server Room — positioned at the BRANCH CENTER (x=-22) so its south doorway
        // aligns perfectly with the bridge corridor below it. Previously this room was
        // at the same x as the other west rooms (-28.8) while its door+bridge were built
        // at x=-22 — a 6.8 unit misalignment that made the doorway open into a dark,
        // disconnected void instead of a walkable path.
        const serverX = -22;
        this._roomBox(serverX, -22, wrW, 9, {
            name: 'Server Room',
            doorways: [{ side: 'S', offset: 0, width: 2.2 }]
        });
        this._addServerProps(serverX, -22);
        this._emergencyFixture(serverX, 2.7, -22);
        this._mainLight(serverX, -22, 1.8, 9);

        // Bridge: branch end z=-14 → server S edge z=-17.5 (len=3.5) — now correctly
        // aligned under the room since both share x=-22
        this._floor(-22, -15.75, 3.6, 3.5, this.materials.matTile);
        this._ceiling(-22, -15.75, 3.6, 3.5);
        this._wall(-23.8, -15.75, WALL_T, WALL_H, 3.5);
        this._wall(-20.2, -15.75, WALL_T, WALL_H, 3.5);
        // Bridge: server N edge z=-26.5 → connector S wall z=-32.2 (len=5.7)
        this._floor(-22, -29.35, 3.6, 5.7, this.materials.matTile);
        this._ceiling(-22, -29.35, 3.6, 5.7);
        this._wall(-23.8, -29.35, WALL_T, WALL_H, 5.7);
        this._wall(-20.2, -29.35, WALL_T, WALL_H, 5.7);
        this._emergencyFixture(-22, 2.7, -29.35);

        // ── EAST BRANCH ROOMS (open from branch west wall x=+2.2) ──
        const ex = 7.2;   // center x = 2.2 + 5
        const erW = 10;

        const buildEastRoom = (cz, rD, name, addProps) => {
            const rHalf = rD / 2;
            this._floor(ex, cz, erW, rD, this.materials.matFloor);
            this._ceiling(ex, cz, erW, rD);
            this._wall(ex, cz - rHalf, erW, WALL_H, WALL_T);  // North
            this._wall(ex, cz + rHalf, erW, WALL_H, WALL_T);  // South
            this._wall(ex + 5, cz, WALL_T, WALL_H, rD);        // East far wall x=+12.2
            // NO west wall — branch west wall x=+2.2 shared with gaps
            this.rooms[name] = { center: new THREE.Vector3(ex, 0, cz), w: erW, d: rD };
            addProps();
            this._emergencyFixture(ex, 2.7, cz);
            this._mainLight(ex, cz, 2.0, 8);
        };

        buildEastRoom(6,   7, 'Storage Room',    () => this._addStorageProps(ex, 6));
        buildEastRoom(-2,  7, 'Laboratory Wing', () => this._addLabProps(ex, -2));
        buildEastRoom(-10, 7, 'Generator Room',  () => this._addGeneratorProps(ex, -10));

        // Ventilation Section — positioned at branch center (x=4) so its south
        // doorway aligns with the bridge below it (same fix as Server Room)
        const ventX = 4;
        this._roomBox(ventX, -22, erW, 9, {
            name: 'Ventilation Section',
            doorways: [{ side: 'S', offset: 0, width: 2.2 }]
        });
        this._addVentilationProps(ventX, -22);
        this._emergencyFixture(ventX, 2.7, -22);
        this._mainLight(ventX, -22, 1.8, 9);

        // East bridges (mirror west) — correctly aligned under the room since both share x=4
        this._floor(4, -15.75, 3.6, 3.5, this.materials.matTile);
        this._ceiling(4, -15.75, 3.6, 3.5);
        this._wall(2.2, -15.75, WALL_T, WALL_H, 3.5);
        this._wall(5.8, -15.75, WALL_T, WALL_H, 3.5);
        this._floor(4, -29.35, 3.6, 5.7, this.materials.matTile);
        this._ceiling(4, -29.35, 3.6, 5.7);
        this._wall(2.2, -29.35, WALL_T, WALL_H, 5.7);
        this._wall(5.8, -29.35, WALL_T, WALL_H, 5.7);
        this._emergencyFixture(4, 2.7, -29.35);
    }

    // ── Central Reception: fills the dead void between west/east branches with a
    // proper walkable room. Connects to both branches via gaps at z=2 in their
    // shared walls. Furnished like a waiting/break area — desk, table, chairs.
    _buildCentralReception() {
        const cx = -9, cz = 2, w = 22.4, d = 10;
        const halfW = w / 2, halfD = d / 2;

        this._floor(cx, cz, w, d, this.materials.matTile);
        this._ceiling(cx, cz, w, d);
        // North wall (full span, no doorways needed here)
        this._wall(cx, cz - halfD, w, WALL_H, WALL_T);
        // South wall (full span)
        this._wall(cx, cz + halfD, w, WALL_H, WALL_T);
        // West and East walls are OMITTED — they're shared with the branch corridor
        // walls (x=-20.2 and x=+2.2) which already have gaps cut at z=2 for this room.

        this.rooms['Central Reception'] = { center: new THREE.Vector3(cx, 0, cz), w, d };

        // ── Lighting: bright, evenly spaced (this was the darkest dead zone before) ──
        this._mainLight(cx - 6, cz, 2.2, 9);
        this._mainLight(cx,     cz, 2.4, 10);
        this._mainLight(cx + 6, cz, 2.2, 9);
        this._ceilingFixture(cx - 6, cz);
        this._ceilingFixture(cx,     cz);
        this._ceilingFixture(cx + 6, cz);
        this._emergencyFixture(cx - 9, 2.7, cz - 3);
        this._emergencyFixture(cx + 9, 2.7, cz - 3);

        // ── Furniture: reception desk facing the main corridor side, plus a
        // break-area table with chairs as requested ──
        this._desk(cx - 7, cz - 1.5, 3.0);
        this._chair(cx - 7, cz - 0.1);
        this._monitor(cx - 7.7, cz - 1.7, 0.9);
        this._monitor(cx - 6.3, cz - 1.7, 0.9);

        // Central break table with four chairs around it
        const tableTop = new THREE.Mesh(
            new THREE.CylinderGeometry(1.1, 1.1, 0.08, 24),
            new THREE.MeshStandardMaterial({ color: 0x3a2f24, roughness: 0.55, metalness: 0.2 })
        );
        tableTop.position.set(cx, 0.92, cz);
        tableTop.castShadow = tableTop.receiveShadow = true;
        this.scene.add(tableTop);
        this.collidables.push(tableTop);
        const tableLeg = new THREE.Mesh(
            new THREE.CylinderGeometry(0.1, 0.12, 0.9, 12),
            this.materials.matMetal
        );
        tableLeg.position.set(cx, 0.46, cz);
        this.scene.add(tableLeg);
        [[1.5, 0], [-1.5, 0], [0, 1.5], [0, -1.5]].forEach(([dx, dz]) => {
            this._chair(cx + dx, cz + dz);
        });

        // Side furniture — crates, cabinet, pipes for atmosphere/clutter
        this._crate(cx + 7, cz - 3);
        this._crate(cx + 7.5, cz - 2.4);
        this._cabinet(cx - 9, cz + 3);
        this._cabinet(cx + 9, cz + 3);
        this._pipes(cx - 9.5, cz - 3.5);
        this._pipes(cx + 9.5, cz - 3.5);
        this._waterPuddle(cx + 3, cz + 3.2, 1.8);

        this._sign(cx, 2.4, cz - halfD + 0.05, 'CENTRAL ATRIUM', '#c41e1e', 4.2, 0.8);
        this._note(cx - 1.2, 0.97, cz - 0.2, 'BREAK ROOM');
    }

    _buildExitArea() {
        // Exit Gate room: west wall connects to corridor (door W), east wall has
        // an OPENING (not solid) where the locked gate sits. Behind the gate is a
        // short escape tunnel leading outside — win trigger at the far end.
        this._roomBox(28, 14, 10, 7, {
            name: 'Exit Gate',
            doorways: [
                { side: 'W', offset: 0, width: 2.2 },  // from corridor
                { side: 'E', offset: 0, width: 2.6 }   // toward escape tunnel (behind gate)
            ]
        });
        this._addExitGateProps(28, 14);
        this._emergencyFixture(28, 2.7, 14);
        this._mainLight(28, 14, 3.2, 11);
        // Central ceiling fixture (chandelier-style) — visible warm glow source at room center
        this._ceilingFixture(28, 14);

        // ── Escape tunnel: x = 33 to 40, z = 14 (continues east through the gate gap) ──
        // Room east wall is at cx+w/2 = 28+5 = 33, gap there leads into this tunnel
        const tunnelCX = 36.5, tunnelLen = 7;
        this._floor(tunnelCX, 14, tunnelLen, 3.2, this.materials.matConcrete);
        this._ceiling(tunnelCX, 14, tunnelLen, 3.2);
        this._wall(tunnelCX, 12.4, tunnelLen, WALL_H, WALL_T); // North wall
        this._wall(tunnelCX, 15.6, tunnelLen, WALL_H, WALL_T); // South wall
        // West end open (connects to gate room gap) — no wall
        // East end OPEN — this is the facility exterior, win trigger sits here
        this._emergencyFixture(34, 2.7, 14);
        // Main ceiling lights spaced along the tunnel (like the corridor has)
        this._mainLight(34.5, 14, 2.0, 7);
        this._mainLight(38,   14, 1.8, 7);
        this._ceilingFixture(34.5, 14);
        // Faint daylight glow at the tunnel mouth (visual cue: "outside")
        const exitGlow = new THREE.PointLight(0xcfe8ff, 1.4, 10, 1.6);
        exitGlow.position.set(40, 2.2, 14);
        this.scene.add(exitGlow);
        this._sign(36.5, 2.6, 12.55, 'EXIT TUNNEL', '#4fbc94', 2.4, 0.6);

        // Win trigger zone — stored for game.js to check distance against
        this.exitTriggerPos = new THREE.Vector3(40, 0, 14);
    }

    // ---------- PROPS PER ROOM ----------
    _addEntranceProps(cx, cz) {
        // Reception desk + welcome sign + double doors
        this._desk(cx + 2, cz, 2.4);
        this._sign(cx, 2.4, cz - 5.85, 'MAIN ENTRANCE', '#c41e1e', 4, 1);
        // double \"exterior\" doors (sealed - cannot be exited that way)
        const doorL = new THREE.Mesh(new THREE.BoxGeometry(1.5, 2.4, 0.12), this.materials.matMetal);
        doorL.position.set(cx - 0.85, 1.2, cz + 5.85);
        doorL.castShadow = true; this.scene.add(doorL);
        const doorR = new THREE.Mesh(new THREE.BoxGeometry(1.5, 2.4, 0.12), this.materials.matMetal);
        doorR.position.set(cx + 0.85, 1.2, cz + 5.85);
        doorR.castShadow = true; this.scene.add(doorR);
        this._sign(cx, 1.4, cz + 5.78, 'SEALED', '#c41e1e', 1.8, 0.5);
        // ceiling lamp (off)
        this._light(0xfff0c0, 0.6, cx, 2.8, cz, 8, 1.6, { flicker: true, flickerDepth: 0.5 });
        this._crate(cx - 3, cz + 3);
        this._crate(cx - 3.6, cz - 4);
        this._pipes(cx + 4, cz - 1);
    }

    _addReceptionProps(cx, cz) {
        this._desk(cx, cz, 3);
        this._chair(cx - 1, cz + 1.4);
        this._chair(cx + 1, cz + 1.4);
        this._light(0xfff0c0, 0.4, cx, 2.8, cz, 7, 1.7, { flicker: Math.random() < 0.5 });
        this._sign(cx + 4, 2.2, cz - 3.95, 'RECEPTION', '#f0a830', 3, 0.8);
        this._crate(cx - 6, cz + 2);
        this._waterPuddle(cx + 2, cz + 2, 1.8);
    }

    _addSecurityProps(cx, cz) {
        // Security desk with monitors + keycard on desk
        this._desk(cx, cz, 3.2);
        const mon1 = this._monitor(cx - 1, cz - 0.2, 1.6);
        const mon2 = this._monitor(cx + 1, cz - 0.2, 1.6);
        this._chair(cx, cz + 1.2);
        // KEYCARD (interactable)
        const cardGeo = new THREE.BoxGeometry(0.18, 0.01, 0.28);
        const cardMat = new THREE.MeshStandardMaterial({ color: 0xc41e1e, emissive: 0xc41e1e, emissiveIntensity: 0.6, roughness: 0.4 });
        const card = new THREE.Mesh(cardGeo, cardMat);
        card.position.set(cx + 0.4, 1.06, cz - 0.05);
        card.userData.spin = true;
        this.scene.add(card);
        this.interactables.push({
            mesh: card, type: 'keycard',
            prompt: 'PICK UP KEYCARD',
            data: { id: 'security_keycard' },
            bobBase: 1.06
        });
        this._sign(cx, 2.4, cz - 3.45, 'SECURITY', '#c41e1e', 3, 0.7);
        this._light(0xfff0c0, 0.5, cx, 2.8, cz, 7, 1.7, { flicker: true });
        this._light(0x33aaff, 0.4, cx, 1.4, cz - 0.2, 3.5, 2.4); // monitor glow
        this._crate(cx + 3, cz + 2);
        this._pipes(cx - 4, cz + 1);
    }

    _addMedicalProps(cx, cz) {
        // Hospital beds, IV stands, broken glass cabinet
        for (let i = -1; i <= 1; i++) {
            this._bed(cx + i * 2.8, cz - 1.5);
        }
        this._cabinet(cx + 5, cz + 1);
        this._cabinet(cx - 5, cz + 1);
        this._waterPuddle(cx, cz + 2, 2.4);
        this._note(cx + 5, 1.06, cz + 1.6, 'MEDICAL LOG');
        this._sign(cx, 2.4, cz - 3.45, 'MEDICAL', '#4fbc94', 3, 0.7);
        this._light(0xa8c8ff, 0.55, cx - 2, 2.8, cz, 6, 1.8, { flicker: true, flickerDepth: 0.6 });
        this._light(0xa8c8ff, 0.35, cx + 2, 2.8, cz, 6, 1.8);
        this._pipes(cx, cz - 3.2);
    }

    _addMaintenanceProps(cx, cz) {
        this._pipes(cx - 5, cz - 2);
        this._pipes(cx + 5, cz - 2);
        this._pipes(cx, cz + 3);
        this._crate(cx - 4, cz + 1);
        this._crate(cx - 3.2, cz + 1.5);
        this._crate(cx + 3, cz - 1);
        this._toolbox(cx + 1, cz);
        this._sign(cx, 2.4, cz - 3.45, 'MAINTENANCE', '#f0a830', 3.4, 0.7);
        this._light(0xffaa44, 0.5, cx, 2.8, cz, 7, 1.8, { flicker: true });
        this._waterPuddle(cx - 1, cz + 1.5, 2);
    }

    _addServerProps(cx, cz) {
        // Server racks
        for (let i = -2; i <= 2; i++) {
            this._serverRack(cx + i * 1.5, cz - 1.5);
        }
        this._sign(cx, 2.4, cz - 4.45, 'SERVER ROOM', '#4fbc94', 3, 0.7);
        // Cold blue light
        this._light(0x66aaff, 0.7, cx, 2.8, cz, 8, 1.7, { flicker: false });
        this._light(0x66aaff, 0.35, cx - 3, 1.6, cz - 1.5, 4, 2);
        this._light(0x66aaff, 0.35, cx + 3, 1.6, cz - 1.5, 4, 2);
        this._waterPuddle(cx + 2, cz + 2, 2);
    }

    _addStorageProps(cx, cz) {
        // Tall shelving + crates
        for (let i = -1; i <= 1; i++) {
            this._shelf(cx + i * 2.8, cz - 1.5);
        }
        this._crate(cx - 3.6, cz + 1.5);
        this._crate(cx - 2.8, cz + 2);
        this._crate(cx + 3, cz + 1.5);
        this._crate(cx + 3.6, cz + 2.2);
        this._note(cx, 1.0, cz + 2, 'INVENTORY LOG');
        this._sign(cx, 2.4, cz - 3.45, 'STORAGE', '#f0a830', 3, 0.7);
        this._light(0xfff0c0, 0.45, cx, 2.8, cz, 7, 1.7, { flicker: Math.random() < 0.4 });
    }

    _addLabProps(cx, cz) {
        // Lab tables + glass cylinders + suspended equipment
        this._labTable(cx - 4, cz);
        this._labTable(cx, cz);
        this._labTable(cx + 4, cz);
        this._cylinder(cx - 4, cz - 0.4);
        this._cylinder(cx + 4, cz - 0.4);
        this._note(cx, 1.06, cz + 0.6, 'EXPERIMENT 07');
        this._sign(cx, 2.4, cz - 3.95, 'LABORATORY', '#4fbc94', 3.2, 0.7);
        this._light(0xa8c8ff, 0.6, cx - 4, 2.8, cz, 6, 1.8, { flicker: true });
        this._light(0xa8c8ff, 0.6, cx, 2.8, cz, 6, 1.8);
        this._light(0xa8c8ff, 0.6, cx + 4, 2.8, cz, 6, 1.8, { flicker: true, flickerDepth: 0.5 });
        this._waterPuddle(cx - 2, cz + 2, 1.6);
    }

    _addGeneratorProps(cx, cz) {
        // Big generator (cylindrical core + box housing + pipes)
        const gen = new THREE.Group();
        gen.position.set(cx, 0, cz);
        const body = new THREE.Mesh(new THREE.BoxGeometry(3.4, 2.2, 1.8), this.materials.matMetal);
        body.position.set(0, 1.1, 0); body.castShadow = true; body.receiveShadow = true;
        gen.add(body);
        const core = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.6, 2.4, 16), this.materials.matMetal);
        core.position.set(0, 1.2, 1.0); core.rotation.z = Math.PI / 2; core.castShadow = true;
        gen.add(core);
        // emissive panel (off initially)
        const panelMat = new THREE.MeshStandardMaterial({ color: 0x2a0808, emissive: 0x2a0808, emissiveIntensity: 0.4, roughness: 0.4 });
        const panel = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.4, 0.08), panelMat);
        panel.position.set(1.2, 1.4, 0.95);
        gen.add(panel);
        this.scene.add(gen);
        this.collidables.push(body, core);
        // Interactive switch
        const switchMesh = new THREE.Mesh(
            new THREE.BoxGeometry(0.3, 0.5, 0.18),
            new THREE.MeshStandardMaterial({ color: 0x6e2a2a, emissive: 0x3a0808, emissiveIntensity: 0.6, roughness: 0.4, metalness: 0.5 })
        );
        switchMesh.position.set(cx - 1.4, 1.3, cz + 0.95);
        this.scene.add(switchMesh);
        this.interactables.push({
            mesh: switchMesh, type: 'generator_switch',
            prompt: 'RESTORE POWER',
            data: { panel, powered: false },
            bobBase: 1.3
        });
        this._pipes(cx - 5, cz - 1);
        this._pipes(cx + 5, cz + 1);
        this._sign(cx, 2.4, cz - 3.95, 'GENERATOR', '#f0a830', 3.4, 0.7);
        this._light(0xff6622, 0.7, cx, 2.7, cz, 8, 1.8, { flicker: true, flickerDepth: 0.7 });
    }

    _addVentilationProps(cx, cz) {
        // Large fan, ducts
        const fanRing = new THREE.Mesh(
            new THREE.TorusGeometry(1.2, 0.18, 12, 24),
            this.materials.matMetal
        );
        fanRing.position.set(cx, 2.2, cz - 4.35);
        fanRing.rotation.y = Math.PI / 2;
        this.scene.add(fanRing);
        const fanBlades = new THREE.Group();
        for (let i = 0; i < 5; i++) {
            const b = new THREE.Mesh(new THREE.BoxGeometry(0.14, 1.1, 0.05), this.materials.matMetal);
            b.position.y = 0.55;
            const a = (i / 5) * Math.PI * 2;
            const grp = new THREE.Group();
            grp.add(b); grp.rotation.z = a;
            fanBlades.add(grp);
        }
        fanBlades.position.set(cx, 2.2, cz - 4.32);
        fanBlades.rotation.x = Math.PI / 2;
        this.scene.add(fanBlades);
        this._fanBlades = fanBlades;
        this._pipes(cx - 4, cz);
        this._pipes(cx + 4, cz);
        this._sign(cx, 2.4, cz - 4.45, 'VENTILATION', '#4fbc94', 3, 0.7);
        this._light(0xa8c8ff, 0.45, cx, 2.8, cz, 7, 1.8, { flicker: true });
    }

    _addExitGateProps(cx, cz) {
        // Gate sits exactly in the room's east wall gap (x = cx+5 = 33)
        const gateX = cx + 5;
        const gateGroup = new THREE.Group();
        const gateBarMeshes = []; // explicit list — guarantees removal regardless of parent quirks

        for (let i = -3; i <= 3; i++) {
            const bar = new THREE.Mesh(new THREE.BoxGeometry(0.12, 2.8, 0.12), this.materials.matMetal);
            bar.position.set(0, 1.4, i * 0.4);
            bar.castShadow = true;
            gateGroup.add(bar);
            gateBarMeshes.push(bar);
        }
        const top = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.2, 3), this.materials.matMetal);
        top.position.set(0, 2.8, 0);
        gateGroup.add(top);
        gateBarMeshes.push(top);

        gateGroup.position.set(gateX, 0, cz);
        this.scene.add(gateGroup);

        // Frame posts pushed well outside the doorway opening (doorway width=2.6 → ±1.3)
        // Extra margin added so there is zero chance of overlap with the walkable path.
        const frameMat = this.materials.matMetal;
        const frameSides = [
            { geo: [0.15, WALL_H, 0.2], pos: [0, WALL_H / 2, 1.7] },   // right post — well clear of ±1.3 gap
            { geo: [0.15, WALL_H, 0.2], pos: [0, WALL_H / 2, -1.7] },  // left post — well clear of ±1.3 gap
            { geo: [0.15, 0.3, 3.6],    pos: [0, WALL_H, 0] }          // top header (above 2.8 bar height)
        ];
        frameSides.forEach(f => {
            const m = new THREE.Mesh(new THREE.BoxGeometry(...f.geo), frameMat);
            m.position.set(gateX, f.pos[1], cz + f.pos[2]);
            this.scene.add(m);
            this.collidables.push(m); // frame stays solid permanently — it's the door frame, not the door
        });

        // Push gate bars into collidables and keep a direct reference for guaranteed removal later
        gateBarMeshes.forEach(m => this.collidables.push(m));
        this._gateBarMeshes = gateBarMeshes; // world.js exposes this so game.js can remove by identity

        // Console next to gate (inside the room, near west side of gate)
        const consoleX = cx + 2.2, consoleZ = cz - 2.4;
        const console = new THREE.Mesh(
            new THREE.BoxGeometry(0.8, 1.2, 0.6),
            this.materials.matComputer
        );
        console.position.set(consoleX, 0.6, consoleZ);
        console.castShadow = true; this.scene.add(console);
        this.collidables.push(console);
        const screen = new THREE.Mesh(
            new THREE.PlaneGeometry(0.5, 0.3),
            new THREE.MeshStandardMaterial({ color: 0x3a0808, emissive: 0xc41e1e, emissiveIntensity: 1.2 })
        );
        screen.position.set(consoleX, 0.95, consoleZ + 0.31);
        this.scene.add(screen);
        this.interactables.push({
            mesh: console, type: 'exit_console',
            prompt: 'UNLOCK EXIT',
            data: { gate: gateGroup, screen, gateX, gateZ: cz, gateBarMeshes },
            bobBase: null
        });
        this._sign(cx, 2.4, cz - 3.4, 'EMERGENCY EXIT', '#c41e1e', 3.8, 0.8);
        this._emergencyFixture(cx, 2.7, cz);
    }

    // ---------- PROP PRIMITIVES ----------
    _desk(x, z, w = 2.4) {
        const top = new THREE.Mesh(new THREE.BoxGeometry(w, 0.08, 1), new THREE.MeshStandardMaterial({ color: 0x3a2f24, roughness: 0.6, metalness: 0.2 }));
        top.position.set(x, 1.0, z); top.castShadow = top.receiveShadow = true; this.scene.add(top);
        this.collidables.push(top);
        const leg = (lx, lz) => {
            const m = new THREE.Mesh(new THREE.BoxGeometry(0.08, 1, 0.08), this.materials.matMetal);
            m.position.set(lx, 0.5, lz); this.scene.add(m);
        };
        leg(x - w / 2 + 0.1, z - 0.4); leg(x + w / 2 - 0.1, z - 0.4);
        leg(x - w / 2 + 0.1, z + 0.4); leg(x + w / 2 - 0.1, z + 0.4);
    }
    _chair(x, z) {
        const seat = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.08, 0.5), this.materials.matMetal);
        seat.position.set(x, 0.5, z); seat.castShadow = true; this.scene.add(seat);
        const back = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.6, 0.06), this.materials.matMetal);
        back.position.set(x, 0.8, z + 0.22); back.castShadow = true; this.scene.add(back);
    }
    _monitor(x, z, w = 1) {
        const stand = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.3, 0.1), this.materials.matComputer);
        stand.position.set(x, 1.15, z); this.scene.add(stand);
        const screen = new THREE.Mesh(new THREE.BoxGeometry(w, 0.6, 0.06), this.materials.matComputer);
        screen.position.set(x, 1.6, z); screen.castShadow = true; this.scene.add(screen);
        const glow = new THREE.Mesh(new THREE.PlaneGeometry(w * 0.92, 0.5), this.materials.matScreen);
        glow.position.set(x, 1.6, z + 0.035); this.scene.add(glow);
        return screen;
    }
    _crate(x, z) {
        const size = 0.7 + Math.random() * 0.3;
        const m = new THREE.Mesh(new THREE.BoxGeometry(size, size, size),
            new THREE.MeshStandardMaterial({ color: 0x6e5b3a, roughness: 0.7, metalness: 0.1 }));
        m.position.set(x, size / 2, z);
        m.rotation.y = Math.random() * 0.4 - 0.2;
        m.castShadow = m.receiveShadow = true;
        this.scene.add(m); this.collidables.push(m);
    }
    _pipes(x, z) {
        const grp = new THREE.Group();
        grp.position.set(x, 0, z);
        for (let i = 0; i < 3; i++) {
            const pipe = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 4, 8), this.materials.matMetal);
            pipe.position.set((i - 1) * 0.22, 2.8, 0); pipe.rotation.z = Math.PI / 2;
            pipe.castShadow = true; grp.add(pipe);
        }
        this.scene.add(grp);
    }
    _waterPuddle(x, z, w) {
        const m = new THREE.Mesh(new THREE.CircleGeometry(w / 2, 24), this.materials.matWater);
        m.rotation.x = -Math.PI / 2; m.position.set(x, 0.015, z); this.scene.add(m);
    }
    _sign(x, y, z, text, color = '#c41e1e', w = 2, h = 0.5) {
        const tex = buildSignTexture(text, color);
        const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshStandardMaterial({
            map: tex, emissiveMap: tex, emissive: 0xffffff, emissiveIntensity: 0.5,
            roughness: 0.6, metalness: 0.1, side: THREE.DoubleSide
        }));
        m.position.set(x, y, z);
        this.scene.add(m);
    }
    _bed(x, z) {
        const frame = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.5, 2), this.materials.matMetal);
        frame.position.set(x, 0.25, z); frame.castShadow = frame.receiveShadow = true;
        this.scene.add(frame); this.collidables.push(frame);
        const sheet = new THREE.Mesh(new THREE.BoxGeometry(0.92, 0.08, 2.02),
            new THREE.MeshStandardMaterial({ color: 0x8a8276, roughness: 0.8 }));
        sheet.position.set(x, 0.55, z); this.scene.add(sheet);
    }
    _cabinet(x, z) {
        const m = new THREE.Mesh(new THREE.BoxGeometry(0.6, 1.8, 0.4),
            new THREE.MeshStandardMaterial({ color: 0x8a8276, roughness: 0.5, metalness: 0.5 }));
        m.position.set(x, 0.9, z); m.castShadow = m.receiveShadow = true;
        this.scene.add(m); this.collidables.push(m);
    }
    _note(x, y, z, label) {
        const tex = buildPaperTexture(label);
        const m = new THREE.Mesh(new THREE.PlaneGeometry(0.4, 0.55), new THREE.MeshStandardMaterial({
            map: tex, roughness: 0.8, side: THREE.DoubleSide
        }));
        m.position.set(x, y, z); m.rotation.x = -Math.PI / 2 + 0.1; m.rotation.y = Math.random() * 0.2;
        this.scene.add(m);
        this.interactables.push({
            mesh: m, type: 'note', prompt: 'READ NOTE',
            data: { text: this._noteText(label) }, bobBase: y
        });
    }
    _noteText(label) {
        const lib = {
            'MEDICAL LOG': 'Day 41 — Subject 04 is no longer responsive to sedation. The neural rejection is accelerating. Recommend full quarantine. We should never have opened the containment.',
            'INVENTORY LOG': 'Day 39 — Three keycards reported missing. Storage now requires Security clearance only. If you find one, return to the office immediately.',
            'EXPERIMENT 07': 'Day 44 — The samples in tank C are moving on their own. Power fluctuations correlate with their activity. Cut power to the wing if anomaly persists.'
        };
        return lib[label] || 'The text is faded beyond reading.';
    }
    _toolbox(x, z) {
        const m = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.25, 0.3),
            new THREE.MeshStandardMaterial({ color: 0xc41e1e, roughness: 0.5, metalness: 0.5 }));
        m.position.set(x, 0.125, z); m.castShadow = true; this.scene.add(m);
        this.collidables.push(m);
    }
    _serverRack(x, z) {
        const m = new THREE.Mesh(new THREE.BoxGeometry(0.7, 2.4, 1),
            new THREE.MeshStandardMaterial({ color: 0x12120f, roughness: 0.4, metalness: 0.7 }));
        m.position.set(x, 1.2, z); m.castShadow = m.receiveShadow = true; this.scene.add(m);
        this.collidables.push(m);
        // blinking LEDs
        for (let i = 0; i < 5; i++) {
            const led = new THREE.Mesh(new THREE.PlaneGeometry(0.04, 0.04),
                new THREE.MeshStandardMaterial({
                    color: Math.random() < 0.5 ? 0x4fbc94 : 0x66aaff,
                    emissive: Math.random() < 0.5 ? 0x4fbc94 : 0x66aaff,
                    emissiveIntensity: 1.4
                }));
            led.position.set(x, 0.5 + i * 0.4, z + 0.51); this.scene.add(led);
        }
    }
    _shelf(x, z) {
        const grp = new THREE.Group();
        grp.position.set(x, 0, z);
        for (let i = 0; i < 4; i++) {
            const shelf = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.05, 0.6),
                new THREE.MeshStandardMaterial({ color: 0x6e6258, roughness: 0.8 }));
            shelf.position.y = 0.5 + i * 0.6; shelf.castShadow = shelf.receiveShadow = true;
            grp.add(shelf);
        }
        const side1 = new THREE.Mesh(new THREE.BoxGeometry(0.06, 2.4, 0.6), this.materials.matMetal);
        side1.position.set(-1.2, 1.2, 0); grp.add(side1);
        const side2 = side1.clone(); side2.position.set(1.2, 1.2, 0); grp.add(side2);
        this.scene.add(grp);
        this.collidables.push(side1, side2);
    }
    _labTable(x, z) {
        const top = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.06, 0.9),
            new THREE.MeshStandardMaterial({ color: 0xc8c2b4, roughness: 0.3, metalness: 0.3 }));
        top.position.set(x, 0.9, z); top.castShadow = top.receiveShadow = true;
        this.scene.add(top); this.collidables.push(top);
    }
    _cylinder(x, z) {
        const glass = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 1.6, 24, 1, true),
            new THREE.MeshStandardMaterial({
                color: 0x88ccaa, transparent: true, opacity: 0.35,
                roughness: 0.1, metalness: 0.1, side: THREE.DoubleSide
            }));
        glass.position.set(x, 1.8, z); this.scene.add(glass);
        const base = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.34, 0.15, 24), this.materials.matMetal);
        base.position.set(x, 1.0, z); this.scene.add(base);
        const top = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.34, 0.15, 24), this.materials.matMetal);
        top.position.set(x, 2.7, z); this.scene.add(top);
        // bioluminescent contents
        const blob = new THREE.Mesh(new THREE.SphereGeometry(0.18, 16, 12),
            new THREE.MeshStandardMaterial({ color: 0x4fbc94, emissive: 0x4fbc94, emissiveIntensity: 1.4 }));
        blob.position.set(x, 1.4, z); this.scene.add(blob);
        this._light(0x4fbc94, 0.4, x, 1.4, z, 3, 2);
    }

    // ---------- ATMOSPHERE ----------
    _buildAtmosphere() {
        // Dim ambient — enough to see room shapes, flashlight does the real work
        const hemi = new THREE.HemisphereLight(
            0x2a2a3a,   // sky: dim blue (ceiling bounce)
            0x14100a,   // ground: dim warm
            0.5         // raised slightly — enough to make out room/corridor shapes
                         // before generator power, flashlight still does the real work
        );
        this.scene.add(hemi);

        // dust particles in air
        const count = 800;
        const geom = new THREE.BufferGeometry();
        const positions = new Float32Array(count * 3);
        const initialY = new Float32Array(count);
        for (let i = 0; i < count; i++) {
            positions[i * 3 + 0] = (Math.random() - 0.5) * 80;
            positions[i * 3 + 1] = Math.random() * 3;
            positions[i * 3 + 2] = (Math.random() - 0.5) * 80 - 8;
            initialY[i] = positions[i * 3 + 1];
        }
        geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        const mat = new THREE.PointsMaterial({
            size: 0.05, map: this.materials.dust, transparent: true,
            opacity: 0.55, depthWrite: false, blending: THREE.AdditiveBlending,
            color: 0xc8b88a
        });
        this._dust = new THREE.Points(geom, mat);
        this._dust.userData.t = 0;
        this.scene.add(this._dust);

        // distant pin-point ground spotlights along main corridor (cast soft shadows)
        const spot1 = new THREE.SpotLight(0xffeebb, 0.6, 14, Math.PI / 5, 0.5, 1.6);
        spot1.position.set(-5, 3, 14); spot1.target.position.set(-5, 0, 14);
        spot1.castShadow = true; spot1.shadow.mapSize.set(256, 256); spot1.shadow.bias = -0.002;
        this.scene.add(spot1); this.scene.add(spot1.target);
        this.flickerLights.push({ light: spot1, base: 0.6, phase: 1.2, rate: 0.6, depth: 0.45 });
    }

    // ---------- UPDATE LOOP ----------
    update(dt, time) {
        // generator power ramp — smoothly fade ceiling lights in/out over 3 seconds
        if (this._powerRamping) {
            const elapsed = (performance.now() - this._powerRampStart) / 1000;
            const t = Math.min(1, elapsed / 3.0);
            const eased = t * t * (3 - 2 * t); // smoothstep
            this.mainPowerLights.forEach((p, i) => {
                p.light.intensity = this._powerRampFrom[i] + (this._powerRampTo[i] - this._powerRampFrom[i]) * eased;
            });
            if (t >= 1) this._powerRamping = false;
        }
        // flicker lights
        this.flickerLights.forEach(f => {
            const v = Math.sin(time * f.rate * 8 + f.phase) * 0.4 + Math.sin(time * f.rate * 23 + f.phase * 2) * 0.3;
            const r = (Math.random() < 0.02 ? -0.7 : 0);
            f.light.intensity = Math.max(0, f.base * (1 + (v + r) * f.depth));
        });
        // dust drift
        if (this._dust) {
            const pos = this._dust.geometry.attributes.position;
            this._dust.userData.t += dt;
            for (let i = 0; i < pos.count; i++) {
                pos.array[i * 3 + 1] -= dt * 0.05;
                pos.array[i * 3 + 0] += Math.sin(this._dust.userData.t * 0.5 + i) * dt * 0.02;
                if (pos.array[i * 3 + 1] < 0.05) pos.array[i * 3 + 1] = 3;
            }
            pos.needsUpdate = true;
        }
        // fan blades spin (only after generator on, but we keep slow drift anyway)
        if (this._fanBlades) this._fanBlades.rotation.z += dt * (this.fanSpeed || 0.1);
        // floating interactables bob
        this.interactables.forEach(it => {
            if (it.bobBase != null && it.mesh.userData.spin) {
                it.mesh.rotation.y += dt * 0.6;
                it.mesh.position.y = it.bobBase + Math.sin(time * 2 + (it.mesh.id || 0)) * 0.05;
            }
        });
    }

    removeInteractable(it) {
        this.scene.remove(it.mesh);
        this.interactables = this.interactables.filter(x => x !== it);
    }
}