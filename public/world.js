import * as THREE from 'three';
import { buildConcreteSet, buildMetalSet, buildTileSet, buildDustParticleTexture, buildPaperTexture, buildSignTexture } from './textures.js';

/*
  Grid units = 1 meter. Facility layout — cross-shaped, single central N-S spine.
  (top-down, z negative = north, z positive = south, x negative = west)

                     [EXIT AREA]              z=-38
                          |
         [SERVER]----+----[LAB]               z=-22
                      |
      [SECURITY]------+------[MEDICAL]         z=-12
                      |
   [STORAGE]          |          [BREAK]       z=+2  (Reception, widened)
      |          [RECEPTION]          |
   [MAINT.]           |           [ADMIN]      z=+10
                      |
      [RECORDS]-------+-------[INTERROG.]      z=+22
                      |
               [MAIN ENTRANCE]                 z=+38

  See _buildRoomsClean(), _buildExitArea(), _buildMainEntranceArea() for the full layout.
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
        this._buildExitArea();
        this._buildMainEntranceArea();
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
    // ============================================================================
    // FACILITY LAYOUT — cross-shaped, single central N-S spine corridor.
    // (top-down, z negative = north/up, z positive = south/down, x negative = west)
    //
    //                    [EXIT AREA]            z=-32
    //                         |
    //        [SERVER]----+----[LAB]            z=-22
    //                     |
    //     [SECURITY]------+------[MEDICAL]      z=-12
    //                     |
    //  [STORAGE]          |          [BREAK]    z=+2 (Reception, widened)
    //     |          [RECEPTION]          |
    //  [MAINT.]           |           [ADMIN]   z=+10
    //                     |
    //     [RECORDS]-------+-------[INTERROG.]   z=+22
    //                     |
    //              [MAIN ENTRANCE]              z=+30
    //
    // Spine runs x=0, width=4, from z=-30 (Exit) to z=+28 (Entrance).
    // Rooms sit directly off the spine; Storage/Maintenance and Break/Admin form
    // outer side-columns connected back to the spine via the Security/Medical rooms.
    // ============================================================================

    _buildSpine() {
        const spineW = 4;
        // Full-length central corridor floor/ceiling, one continuous strip
        this._floor(0, -1, spineW, 60, this.materials.matTile);
        this._ceiling(0, -1, spineW, 60);

        // West spine wall (x=-2): gaps wherever a room opens onto the corridor
        this._wallWithGaps(-2, -1, 60, false, [
            { center: -22, width: 2.4 },  // Server Room
            { center: -12, width: 2.4 },  // Security Office
            { center: 22,  width: 2.4 },  // Records Room
        ]);
        // East spine wall (x=+2): mirrored gaps
        this._wallWithGaps(2, -1, 60, false, [
            { center: -22, width: 2.4 },  // Laboratory
            { center: -12, width: 2.4 },  // Medical Office
            { center: 22,  width: 2.4 },  // Interrogation Room
        ]);

        // Spine end caps
        // North cap: gap matches the Exit Area connector corridor width (4)
        this._wallWithGaps(0, -31, spineW, true, [{ center: 0, width: 4 }]);
        // South cap: gap matches the Main Entrance connector corridor width (4)
        this._wallWithGaps(0, 29,  spineW, true, [{ center: 0, width: 4 }]);

        // Corridor lighting along the spine
        for (let z = -26; z <= 24; z += 8) this._emergencyFixture(0, 2.7, z);
        this._mainLight(0, -22, 1.6, 9);
        this._mainLight(0, -12, 1.6, 9);
        this._mainLight(0, 2,   1.4, 8);
        this._mainLight(0, 12,  1.6, 9);
        this._mainLight(0, 22,  1.6, 9);
        this._sign(0, 2.6, -10, 'FACILITY CORRIDOR', '#c41e1e', 3.5, 0.7);
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
        // Each room is a fully independent _roomBox — its own 4 walls, regardless of
        // whether one of those walls sits right next to the spine wall. This avoids
        // the shared-wall alignment bugs from earlier iterations: every room is
        // self-contained and guaranteed sealed except at its own doorway.

        // ── SERVER ROOM (west, upper row, z=-22) ──
        this._roomBox(-11, -22, 10, 9, {
            name: 'Server Room',
            doorways: [{ side: 'E', offset: 0, width: 2.4 }]
        });
        this._addServerProps(-11, -22);
        this._emergencyFixture(-11, 2.7, -22);
        this._mainLight(-11, -22, 1.8, 9);
        // Bridge: Server Room door (x=-6) to spine west wall (x=-2) — closes a 4-unit gap
        this._floor(-4, -22, 4, 2.4, this.materials.matTile);
        this._ceiling(-4, -22, 4, 2.4);
        this._wall(-4, -23.2, 4, WALL_H, WALL_T);
        this._wall(-4, -20.8, 4, WALL_H, WALL_T);

        // ── LABORATORY (east, upper row, z=-22) ──
        this._roomBox(11, -22, 10, 9, {
            name: 'Laboratory',
            doorways: [{ side: 'W', offset: 0, width: 2.4 }]
        });
        this._addLabProps(11, -22);
        this._emergencyFixture(11, 2.7, -22);
        this._mainLight(11, -22, 1.8, 9);
        // Bridge: Laboratory door (x=6) to spine east wall (x=2)
        this._floor(4, -22, 4, 2.4, this.materials.matTile);
        this._ceiling(4, -22, 4, 2.4);
        this._wall(4, -23.2, 4, WALL_H, WALL_T);
        this._wall(4, -20.8, 4, WALL_H, WALL_T);

        // ── SECURITY OFFICE (west, mid row, z=-12) — also connects to Storage/Maint column ──
        this._roomBox(-11, -12, 10, 9, {
            name: 'Security Office',
            doorways: [
                { side: 'E', offset: 0, width: 2.4 },   // to spine
                { side: 'W', offset: 0, width: 2.4 },   // to side corridor (Storage/Maint column)
            ]
        });
        this._addSecurityProps(-11, -12);
        this._emergencyFixture(-11, 2.7, -12);
        this._mainLight(-11, -12, 1.8, 9);
        // Bridge: Security Office door (x=-6) to spine west wall (x=-2)
        this._floor(-4, -12, 4, 2.4, this.materials.matTile);
        this._ceiling(-4, -12, 4, 2.4);
        this._wall(-4, -13.2, 4, WALL_H, WALL_T);
        this._wall(-4, -10.8, 4, WALL_H, WALL_T);

        // ── MEDICAL OFFICE (east, mid row, z=-12) — also connects to Break/Admin column ──
        this._roomBox(11, -12, 10, 9, {
            name: 'Medical Office',
            doorways: [
                { side: 'W', offset: 0, width: 2.4 },   // to spine
                { side: 'E', offset: 0, width: 2.4 },   // to side corridor (Break/Admin column)
            ]
        });
        this._addMedicalProps(11, -12);
        this._emergencyFixture(11, 2.7, -12);
        this._mainLight(11, -12, 1.8, 9);
        // Bridge: Medical Office door (x=6) to spine east wall (x=2)
        this._floor(4, -12, 4, 2.4, this.materials.matTile);
        this._ceiling(4, -12, 4, 2.4);
        this._wall(4, -13.2, 4, WALL_H, WALL_T);
        this._wall(4, -10.8, 4, WALL_H, WALL_T);

        // ── WEST SIDE COLUMN: Storage (z=+2) + Maintenance (z=+10) ──
        // Side corridor's EAST wall must be at x=-16 to exactly meet Security Office's
        // west door (door world-x is fixed at the room's own wall coordinate: -11-5=-16;
        // the 'offset' param only shifts a door along its wall's span, never sideways).
        // Corridor width=4 -> west wall at x=-20, center at x=-18.
        this._floor(-18, -1, 4, 26, this.materials.matTile);
        this._ceiling(-18, -1, 4, 26);
        this._wallWithGaps(-16, -1, 26, false, [{ center: 2, width: 2.4 }, { center: 10, width: 2.4 }]); // east wall: gaps to Storage/Maint
        this._wall(-20, -1, WALL_T, WALL_H, 26); // west wall: solid
        // North cap at z=-12 — wide open, directly continuous with Security Office's
        // doorway (no separate gap math needed; the corridor simply terminates exactly
        // where the room's door is, so there's nothing to misalign).
        this._mainLight(-18, -1, 1.4, 12);
        this._emergencyFixture(-18, 2.7, 4);
        // South dead-end cap only (north end flows directly into Security Office's door)
        this._wall(-18, 12, 4, WALL_H, WALL_T);

        this._roomBox(-29, 2, 10, 9, {
            name: 'Storage Room',
            doorways: [{ side: 'E', offset: 0, width: 2.4 }]
        });
        this._addStorageProps(-29, 2);
        this._emergencyFixture(-29, 2.7, 2);
        this._mainLight(-29, 2, 1.8, 9);
        // Bridge: Storage Room door (x=-24) to side corridor east wall (x=-16) — closes an 8-unit gap
        this._floor(-20, 2, 8, 2.4, this.materials.matTile);
        this._ceiling(-20, 2, 8, 2.4);
        this._wall(-20, 0.8, 8, WALL_H, WALL_T);
        this._wall(-20, 3.2, 8, WALL_H, WALL_T);
        this._mainLight(-20, 2, 1.4, 7);

        this._roomBox(-29, 10, 10, 7, {
            name: 'Maintenance Room',
            doorways: [{ side: 'E', offset: 0, width: 2.4 }]
        });
        this._addMaintenanceProps(-29, 10);
        this._emergencyFixture(-29, 2.7, 10);
        this._mainLight(-29, 10, 1.8, 8);
        // Bridge: Maintenance Room door (x=-24) to side corridor east wall (x=-16)
        this._floor(-20, 10, 8, 2.4, this.materials.matTile);
        this._ceiling(-20, 10, 8, 2.4);
        this._wall(-20, 8.8, 8, WALL_H, WALL_T);
        this._wall(-20, 11.2, 8, WALL_H, WALL_T);
        this._mainLight(-20, 10, 1.4, 7);

        // ── EAST SIDE COLUMN: Break Room (z=+2) + Admin Office (z=+10) ──
        // Mirror of the west side: corridor west wall must be at x=+16 to exactly
        // meet Medical Office's east door (fixed at 11+5=16).
        this._floor(18, -1, 4, 26, this.materials.matTile);
        this._ceiling(18, -1, 4, 26);
        this._wallWithGaps(16, -1, 26, false, [{ center: 2, width: 2.4 }, { center: 10, width: 2.4 }]); // west wall: gaps to Break/Admin
        this._wall(20, -1, WALL_T, WALL_H, 26); // east wall: solid
        this._mainLight(18, -1, 1.4, 12);
        this._emergencyFixture(18, 2.7, 4);
        // South dead-end cap only (north end flows directly into Medical Office's door)
        this._wall(18, 12, 4, WALL_H, WALL_T);

        this._roomBox(29, 2, 10, 9, {
            name: 'Break Room',
            doorways: [{ side: 'W', offset: 0, width: 2.4 }]
        });
        this._addBreakRoomProps(29, 2);
        this._emergencyFixture(29, 2.7, 2);
        this._mainLight(29, 2, 1.8, 9);
        // Bridge: Break Room door (x=24) to side corridor west wall (x=16) — closes an 8-unit gap
        this._floor(20, 2, 8, 2.4, this.materials.matTile);
        this._ceiling(20, 2, 8, 2.4);
        this._wall(20, 0.8, 8, WALL_H, WALL_T);
        this._wall(20, 3.2, 8, WALL_H, WALL_T);
        this._mainLight(20, 2, 1.4, 7);

        this._roomBox(29, 10, 10, 7, {
            name: 'Admin Office',
            doorways: [{ side: 'W', offset: 0, width: 2.4 }]
        });
        this._addAdminProps(29, 10);
        this._emergencyFixture(29, 2.7, 10);
        this._mainLight(29, 10, 1.8, 8);
        // Bridge: Admin Office door (x=24) to side corridor west wall (x=16)
        this._floor(20, 10, 8, 2.4, this.materials.matTile);
        this._ceiling(20, 10, 8, 2.4);
        this._wall(20, 8.8, 8, WALL_H, WALL_T);
        this._wall(20, 11.2, 8, WALL_H, WALL_T);
        this._mainLight(20, 10, 1.4, 7);

        // ── RECEPTION (center, z=+2, widened spine area) ──
        this._floor(0, 2, 8, 10, this.materials.matTile);
        this._ceiling(0, 2, 8, 10);
        // North wall: wide gap matching spine width (this is the ONLY wall mesh here —
        // a duplicate full-width decorative wall was previously drawn on the same spot,
        // visually covering this gap even though it wasn't collidable. Removed.)
        this._wallWithGaps(0, -3, 8, true, [{ center: 0, width: 2.0 }]);
        this._wallWithGaps(0, 7, 8, true, [{ center: 0, width: 2.0 }]);
        this._wall(-4, 2, WALL_T, WALL_H, 10); // west wall solid
        this._wall(4, 2, WALL_T, WALL_H, 10);  // east wall solid
        this._addReceptionProps(0, 2);
        this._mainLight(0, 2, 2.4, 10);
        this._ceilingFixture(0, 2);

        // ── RECORDS ROOM (west, lower row, z=+22) ──
        this._roomBox(-11, 22, 10, 9, {
            name: 'Records Room',
            doorways: [{ side: 'E', offset: 0, width: 2.4 }]
        });
        this._addRecordsProps(-11, 22);
        this._emergencyFixture(-11, 2.7, 22);
        this._mainLight(-11, 22, 1.8, 9);
        // Bridge: Records Room door (x=-6) to spine west wall (x=-2)
        this._floor(-4, 22, 4, 2.4, this.materials.matTile);
        this._ceiling(-4, 22, 4, 2.4);
        this._wall(-4, 20.8, 4, WALL_H, WALL_T);
        this._wall(-4, 23.2, 4, WALL_H, WALL_T);

        // ── INTERROGATION ROOM (east, lower row, z=+22) ──
        this._roomBox(11, 22, 10, 9, {
            name: 'Interrogation Room',
            doorways: [{ side: 'W', offset: 0, width: 2.4 }]
        });
        this._addInterrogationProps(11, 22);
        this._emergencyFixture(11, 2.7, 22);
        this._mainLight(11, 22, 1.8, 9);
        // Bridge: Interrogation Room door (x=6) to spine east wall (x=2)
        this._floor(4, 22, 4, 2.4, this.materials.matTile);
        this._ceiling(4, 22, 4, 2.4);
        this._wall(4, 20.8, 4, WALL_H, WALL_T);
        this._wall(4, 23.2, 4, WALL_H, WALL_T);
    }

    // ---------- CENTRAL RECEPTION is now built inline above (see _buildRoomsClean) ----------
    _buildCentralReception() {
        // intentionally empty — Reception is now built as part of _buildRoomsClean()
        // to keep the cross-shaped layout's center as a single cohesive build pass.
    }

    // ---------- EXIT AREA (north end of spine) ----------
    _buildExitArea() {
        // Exit Area sits beyond the spine's north cap, behind a locked gate.
        // Spine north cap is at z=-31; Exit Area room starts right after it.
        const cz = -38;
        this._roomBox(0, cz, 10, 8, {
            name: 'Exit Area',
            doorways: [{ side: 'S', offset: 0, width: 2.6 }]
        });
        this._addExitGateProps(0, cz);
        this._emergencyFixture(0, 2.7, cz);
        this._mainLight(0, cz, 2.4, 10);
        this._ceilingFixture(0, cz);

        // Short connector corridor between spine north cap (z=-31) and Exit Area south wall (z=-34)
        this._floor(0, -32.5, 4, 3, this.materials.matTile);
        this._ceiling(0, -32.5, 4, 3);
        this._wall(-2, -32.5, WALL_T, WALL_H, 3);
        this._wall(2, -32.5, WALL_T, WALL_H, 3);
        this._mainLight(0, -32.5, 1.6, 6);

        // Win trigger zone — far end of Exit Area, beyond the gate
        this.exitTriggerPos = new THREE.Vector3(0, 0, cz - 3);
    }

    // ---------- MAIN ENTRANCE (south end of spine) ----------
    _buildMainEntranceArea() {
        const cz = 38;
        this._roomBox(0, cz, 10, 8, {
            name: 'Main Entrance Hall',
            doorways: [{ side: 'N', offset: 0, width: 2.6 }]
        });
        this._addEntranceProps(0, cz);
        this._emergencyFixture(0, 2.7, cz);
        this._mainLight(0, cz, 2.2, 10);

        // Short connector corridor between spine south cap (z=29) and entrance hall north wall (z=34)
        this._floor(0, 31.5, 4, 5, this.materials.matTile);
        this._ceiling(0, 31.5, 4, 5);
        this._wall(-2, 31.5, WALL_T, WALL_H, 5);
        this._wall(2, 31.5, WALL_T, WALL_H, 5);
        this._mainLight(0, 31.5, 1.6, 6);
    }

    _addBreakRoomProps(cx, cz) {
        // Break room: small kitchenette table + chairs + vending-style cabinet
        const tableTop = new THREE.Mesh(
            new THREE.CylinderGeometry(0.8, 0.8, 0.07, 20),
            new THREE.MeshStandardMaterial({ color: 0x3a2f24, roughness: 0.55 })
        );
        tableTop.position.set(cx, 0.9, cz);
        tableTop.castShadow = tableTop.receiveShadow = true;
        this.scene.add(tableTop);
        this.collidables.push(tableTop);
        const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.1, 0.86, 10), this.materials.matMetal);
        leg.position.set(cx, 0.45, cz);
        this.scene.add(leg);
        this._chair(cx - 1.3, cz);
        this._chair(cx + 1.3, cz);
        this._cabinet(cx, cz - 3);
        this._crate(cx + 3, cz + 2.5);
        this._note(cx - 1.3, 0.97, cz + 0.3, 'BREAK SCHEDULE');
        this._sign(cx, 2.4, cz - 3.95, 'BREAK ROOM', '#f0a830', 3, 0.7);
        this._light(0xfff0c0, 0.5, cx, 2.8, cz, 7, 1.7, { flicker: Math.random() < 0.4 });
    }

    _addAdminProps(cx, cz) {
        // Admin office: desk + chair + filing cabinet + monitor
        this._desk(cx, cz - 1, 2.8);
        this._chair(cx, cz + 0.3);
        this._monitor(cx, cz - 1.2, 0.9);
        this._cabinet(cx + 3.5, cz + 1.5);
        this._note(cx + 0.5, 1.06, cz - 1.4, 'ADMIN MEMO');
        this._sign(cx, 2.4, cz - 3.45, 'ADMIN OFFICE', '#c41e1e', 3.4, 0.7);
        this._light(0xfff0c0, 0.5, cx, 2.8, cz, 7, 1.7, { flicker: true });
    }

    _addRecordsProps(cx, cz) {
        // Records room: tall filing shelves + scattered cabinets + a desk with papers
        for (let i = -1; i <= 1; i++) {
            this._shelf(cx + i * 2.8, cz - 1.5);
        }
        this._cabinet(cx - 3.6, cz + 2);
        this._cabinet(cx + 3.6, cz + 2);
        this._desk(cx, cz + 2.2, 2.2);
        this._note(cx, 1.06, cz + 1.7, 'CLASSIFIED FILES');
        this._sign(cx, 2.4, cz - 3.45, 'RECORDS', '#4fbc94', 3, 0.7);
        this._light(0xfff0c0, 0.45, cx, 2.8, cz, 7, 1.7, { flicker: Math.random() < 0.4 });
        this._waterPuddle(cx - 2, cz + 3, 1.6);
    }

    _addInterrogationProps(cx, cz) {
        // Interrogation room: bare metal table + two chairs + single hanging light + mirror
        const tableTop = new THREE.Mesh(
            new THREE.BoxGeometry(2.0, 0.06, 1.1),
            this.materials.matMetal
        );
        tableTop.position.set(cx, 0.85, cz);
        tableTop.castShadow = tableTop.receiveShadow = true;
        this.scene.add(tableTop);
        this.collidables.push(tableTop);
        const leg = (lx, lz) => {
            const m = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.85, 0.07), this.materials.matMetal);
            m.position.set(cx + lx, 0.42, cz + lz);
            this.scene.add(m);
        };
        leg(0.9, 0.45); leg(-0.9, 0.45); leg(0.9, -0.45); leg(-0.9, -0.45);
        this._chair(cx, cz - 1.4);
        this._chair(cx, cz + 1.4);
        // single harsh hanging light over the table
        this._light(0xfff6e0, 1.0, cx, 2.4, cz, 6, 1.4, { flicker: Math.random() < 0.3, flickerDepth: 0.5 });
        // one-way mirror panel on the back wall
        const mirror = new THREE.Mesh(
            new THREE.PlaneGeometry(1.6, 1.0),
            new THREE.MeshStandardMaterial({ color: 0x101418, metalness: 0.8, roughness: 0.2 })
        );
        mirror.position.set(cx, 1.5, cz - 4.37);
        this.scene.add(mirror);
        this._sign(cx, 2.4, cz - 3.95, 'INTERROGATION', '#c41e1e', 3.6, 0.7);
        this._note(cx + 0.6, 0.91, cz + 0.2, 'CASE FILE 07');
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
        // Furniture on south half — not visible through the narrow north doorway
        const deskZ = cz + 2.5;
        this._desk(cx, deskZ, 3);
        this._chair(cx - 1, deskZ + 1.4);
        this._chair(cx + 1, deskZ + 1.4);
        this._crate(cx - 2.8, deskZ + 1.5);
        this._waterPuddle(cx + 2, deskZ + 1.2, 1.4);
        this._light(0xfff0c0, 0.4, cx, 2.8, deskZ, 6, 1.7, { flicker: Math.random() < 0.5 });
        // Sign on SOUTH wall (inside the room, not at the north entrance)
        this._sign(cx, 2.2, cz + 4.88, 'RECEPTION', '#f0a830', 3, 0.8);
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
        this._crate(cx - 4, cz + 1);
        this._crate(cx - 3.2, cz + 1.5);
        this._toolbox(cx + 3, cz - 1);
        this._sign(cx, 2.4, cz - 3.45, 'MAINTENANCE', '#f0a830', 3.4, 0.7);
        this._light(0xffaa44, 0.4, cx - 3, 2.8, cz, 6, 1.8, { flicker: true });
        this._waterPuddle(cx - 1, cz + 2, 1.6);

        // ── Generator (objective: Restore Generator Power) ──
        const gen = new THREE.Group();
        gen.position.set(cx + 2.5, 0, cz + 1);
        const body = new THREE.Mesh(new THREE.BoxGeometry(2.6, 1.9, 1.5), this.materials.matMetal);
        body.position.set(0, 0.95, 0); body.castShadow = true; body.receiveShadow = true;
        gen.add(body);
        const core = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.45, 1.9, 16), this.materials.matMetal);
        core.position.set(0, 1.0, 0.85); core.rotation.z = Math.PI / 2; core.castShadow = true;
        gen.add(core);
        const panelMat = new THREE.MeshStandardMaterial({ color: 0x2a0808, emissive: 0x2a0808, emissiveIntensity: 0.4, roughness: 0.4 });
        const panel = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.35, 0.07), panelMat);
        panel.position.set(0.9, 1.2, 0.78);
        gen.add(panel);
        this.scene.add(gen);
        this.collidables.push(body, core);

        const switchMesh = new THREE.Mesh(
            new THREE.BoxGeometry(0.28, 0.45, 0.16),
            new THREE.MeshStandardMaterial({ color: 0x6e2a2a, emissive: 0x3a0808, emissiveIntensity: 0.6, roughness: 0.4, metalness: 0.5 })
        );
        switchMesh.position.set(cx + 1.4, 1.1, cz + 1.78);
        this.scene.add(switchMesh);
        this.interactables.push({
            mesh: switchMesh, type: 'generator_switch',
            prompt: 'RESTORE POWER',
            data: { panel, powered: false },
            bobBase: 1.1
        });
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