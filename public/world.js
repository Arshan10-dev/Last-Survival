import * as THREE from 'three';
import { buildConcreteSet, buildMetalSet, buildTileSet, buildDustParticleTexture, buildPaperTexture, buildSignTexture } from './textures.js';

/*
  ══════════════════════════════════════════════════════════════════
  FACILITY LAYOUT  (z-negative = north, z-positive = south)
  ══════════════════════════════════════════════════════════════════

  MAP STRUCTURE (matching reference image):

              EXIT AREA  (0, -30)
                  │
    Security Office ─── SPINE ─── Laboratory
       (-12,-16)    (x=0,w=3)    (12,-16)
                  │
              RECEPTION  (0, 2)   ← largest room, 18×10
            ╔═══╧═══╗
  Storage ──╣       ╠── Break Room
  (-24,2)   ║       ║   (24,2)
  Maint. ───╣       ╠── Admin Office
  (-24,10)  ╚═══╤═══╝   (24,10)
                  │
    Records ──── SPINE ──── Meeting
    (-12,16)              (12,16)
                  │
              ENTRANCE  (0, 30)

  CONSTANTS:
    ROOM_W = 10, ROOM_D = 8  (standard rooms)
    RECEPTION_W = 18, RECEPTION_D = 10
    HALLWAY_W = 3  (spine & all corridors)
    SIDE_CORRIDOR_W = 3
    BRIDGE_LEN = 5.5  (room-to-corridor connector length)
    WALL_H = 3.2, WALL_T = 0.25
══════════════════════════════════════════════════════════════════
*/

// ── Layout Constants ──────────────────────────────────────────────────────────
const WALL_H      = 3.2;
const WALL_T      = 0.25;
const HALLWAY_W   = 3;       // spine & all corridor widths
const ROOM_W      = 10;      // standard room width
const ROOM_D      = 8;       // standard room depth
const ROOM_D_SM   = 7;       // slightly smaller rooms (Maintenance, Admin)
const RECEPTION_W = 18;      // reception hub width
const RECEPTION_D = 10;      // reception hub depth
const BRIDGE_LEN  = 5.5;     // connector from room to corridor

// Room center positions (cx, cz)
const POS = {
    SPINE_CX:       0,
    // Exit / Entrance
    EXIT_CZ:       -30,
    ENTRANCE_CZ:    30,
    // Upper row  (Security Office left, Laboratory right)
    UPPER_CZ:      -16,
    UPPER_LEFT_CX: -12,
    UPPER_RIGHT_CX: 12,
    // Reception center
    RECEPTION_CX:   0,
    RECEPTION_CZ:   2,
    // Mid-west  (Storage upper, Maintenance lower)
    WEST_CX:       -24,
    STORAGE_CZ:     2,
    MAINT_CZ:       10,
    // Mid-east  (Break Room upper, Admin Office lower)
    EAST_CX:        24,
    BREAK_CZ:        2,
    ADMIN_CZ:       10,
    // Lower row  (Records left, Meeting right)
    LOWER_CZ:       16,
    LOWER_LEFT_CX: -12,
    LOWER_RIGHT_CX: 12,
    // Spine extents
    SPINE_NORTH:   -24,
    SPINE_SOUTH:    24,
    // Side corridor extents along Z
    SIDE_CORR_NORTH: 0,
    SIDE_CORR_SOUTH: 12,
    // Bridges
    BRIDGE_GAP:    HALLWAY_W,  // door gap in corridor walls = HALLWAY_W
};

export class World {
    constructor(scene) {
        this.scene = scene;
        this.collidables   = []; // meshes used for collision detection
        this.interactables = []; // { mesh, type, data, prompt, onInteract }
        this.lights        = [];
        this.mainPowerLights  = []; // ceiling lights OFF until generator restored
        this.facilityPowered  = false;
        this.flickerLights    = [];
        this.rooms            = {}; // name → { center: Vector3, w, d }
        this.minimapData      = null;
        this._dust            = null;
        this._gateBarMeshes   = null;
        this.exitUnlocked     = false;

        this.materials = this._buildMaterials();
        this._buildAll();
    }

    // ═══════════════════════════════════════════════════════════════
    // MATERIALS
    // ═══════════════════════════════════════════════════════════════
    _buildMaterials() {
        const concrete = buildConcreteSet();
        const metal    = buildMetalSet();
        const tile     = buildTileSet();

        return {
            matFloor:    new THREE.MeshStandardMaterial({ ...concrete, roughness: 0.92, metalness: 0.04, color: 0x6a6258 }),
            matWall:     new THREE.MeshStandardMaterial({ ...concrete, roughness: 0.88, metalness: 0.06, color: 0x5a5249 }),
            matCeiling:  new THREE.MeshStandardMaterial({ color: 0x2a2622, roughness: 0.95, metalness: 0.03 }),
            matMetal:    new THREE.MeshStandardMaterial({ ...metal, roughness: 0.55, metalness: 0.85, color: 0x8a857c }),
            matTile:     new THREE.MeshStandardMaterial({ ...tile, roughness: 0.45, metalness: 0.02, color: 0xc8c2b4 }),
            matDoor:     new THREE.MeshStandardMaterial({ color: 0x4a3a2a, roughness: 0.5, metalness: 0.4 }),
            matLockedDoor: new THREE.MeshStandardMaterial({ color: 0x6e2a2a, roughness: 0.5, metalness: 0.6, emissive: 0x3a0808, emissiveIntensity: 0.4 }),
            matComputer: new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.4, metalness: 0.7 }),
            matScreen:   new THREE.MeshStandardMaterial({ color: 0x0a1f1a, emissive: 0x12a073, emissiveIntensity: 1.4, roughness: 0.2, metalness: 0.0 }),
            matWater:    new THREE.MeshStandardMaterial({ color: 0x0a0d10, roughness: 0.05, metalness: 0.85, transparent: true, opacity: 0.85 }),
            matEmergency: new THREE.MeshStandardMaterial({ color: 0xc41e1e, emissive: 0xc41e1e, emissiveIntensity: 1.8, roughness: 0.4, metalness: 0.0 }),
            dust: buildDustParticleTexture()
        };
    }

    // ═══════════════════════════════════════════════════════════════
    // BUILD PIPELINE
    // ═══════════════════════════════════════════════════════════════
    _buildAll() {
        this._buildSpine();          // vertical corridor from north to south
        this._buildUpperRooms();     // Security Office + Laboratory
        this._buildReception();      // central hub
        this._buildWestWing();       // Storage + Maintenance + west side corridor
        this._buildEastWing();       // Break Room + Admin Office + east side corridor
        this._buildLowerRooms();     // Records Room + Meeting Room
        this._buildExitArea();       // Exit at north end
        this._buildEntranceArea();   // Entrance at south end
        this._buildAtmosphere();     // ambient light + dust particles + horror spotlights
    }

    // ═══════════════════════════════════════════════════════════════
    // GEOMETRY HELPERS
    // ═══════════════════════════════════════════════════════════════

    /** Horizontal floor plane */
    _floor(x, z, w, d, mat) {
        mat = mat || this.materials.matFloor;
        const m = new THREE.Mesh(new THREE.PlaneGeometry(w, d, 2, 2), mat);
        m.rotation.x = -Math.PI / 2;
        m.position.set(x, 0, z);
        m.receiveShadow = true;
        this.scene.add(m);
        return m;
    }

    /** Ceiling plane */
    _ceiling(x, z, w, d) {
        const m = new THREE.Mesh(new THREE.PlaneGeometry(w, d), this.materials.matCeiling);
        m.rotation.x = Math.PI / 2;
        m.position.set(x, WALL_H, z);
        this.scene.add(m);
        return m;
    }

    /** Solid wall box, added to collidables by default */
    _wall(x, z, w, h, d, mat, opts) {
        mat  = mat  || this.materials.matWall;
        opts = opts || {};
        const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
        m.position.set(x, h / 2, z);
        m.castShadow  = !!opts.castShadow;
        m.receiveShadow = true;
        this.scene.add(m);
        if (opts.solid !== false) this.collidables.push(m);
        return m;
    }

    /**
     * Build a complete room: floor + ceiling + four walls with optional door gaps.
     * doorways: [{ side:'N'|'S'|'E'|'W', offset:0, width:1.8 }]
     * offset is relative to room center along that wall's axis.
     */
    _roomBox(cx, cz, w, d, opts) {
        opts = opts || {};
        const { doorways = [], floorMat, name } = opts;

        this._floor(cx, cz, w, d, floorMat || this.materials.matFloor);
        this._ceiling(cx, cz, w, d);

        const halfW = w / 2, halfD = d / 2;

        // Each wall: side identifier, wall center, axis the wall runs along, total span
        const sides = [
            { side: 'N', center: [cx,       cz - halfD], axis: 'x', span: w },
            { side: 'S', center: [cx,       cz + halfD], axis: 'x', span: w },
            { side: 'W', center: [cx - halfW, cz      ], axis: 'z', span: d },
            { side: 'E', center: [cx + halfW, cz      ], axis: 'z', span: d },
        ];

        sides.forEach(s => {
            const myDoors = doorways
                .filter(dw => dw.side === s.side)
                .map(dw => ({ offset: dw.offset || 0, width: dw.width || HALLWAY_W }))
                .sort((a, b) => a.offset - b.offset);

            let cursor = -s.span / 2;
            myDoors.forEach(dw => {
                const doorStart = dw.offset - dw.width / 2;
                const doorEnd   = dw.offset + dw.width / 2;
                if (doorStart > cursor) this._wallSegment(s, cursor, doorStart);
                cursor = doorEnd;
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
        const len     = toAxis - fromAxis;
        const mid     = (fromAxis + toAxis) / 2;
        const lintelH = 0.6;
        const yTop    = WALL_H - lintelH;
        if (side.axis === 'x') {
            const m = new THREE.Mesh(new THREE.BoxGeometry(len, lintelH, WALL_T), this.materials.matWall);
            m.position.set(side.center[0] + mid, yTop + lintelH / 2, side.center[1]);
            m.receiveShadow = true; this.scene.add(m);
        } else {
            const m = new THREE.Mesh(new THREE.BoxGeometry(WALL_T, lintelH, len), this.materials.matWall);
            m.position.set(side.center[0], yTop + lintelH / 2, side.center[1] + mid);
            m.receiveShadow = true; this.scene.add(m);
        }
    }

    /**
     * Build a wall (horizontal or vertical) with gap openings for doors/passages.
     * @param {number} x - x coordinate (for vertical wall) or center x (for horizontal)
     * @param {number} z - z coordinate (for horizontal wall) or center z (for vertical)
     * @param {number} length - total length of this wall
     * @param {boolean} isHorizontal - true = wall runs along X axis at given Z
     * @param {Array} gaps - [{ center, width }] gap definitions
     */
    _wallWithGaps(x, z, length, isHorizontal, gaps) {
        if (!gaps || gaps.length === 0) {
            if (isHorizontal) this._wall(x, z, length, WALL_H, WALL_T);
            else              this._wall(x, z, WALL_T, WALL_H, length);
            return;
        }

        const sorted = [...gaps].sort((a, b) => a.center - b.center);
        const half   = length / 2;
        let cursor   = isHorizontal ? x - half : z - half;

        sorted.forEach(({ center: gc, width: gw }) => {
            const gStart = gc - gw / 2, gEnd = gc + gw / 2;

            if (gStart > cursor) {
                const segLen = gStart - cursor;
                const mid    = (cursor + gStart) / 2;
                if (isHorizontal) this._wall(mid, z, segLen, WALL_H, WALL_T);
                else              this._wall(x, mid, WALL_T, WALL_H, segLen);
            }
            // Lintel above gap
            if (isHorizontal) {
                const m = new THREE.Mesh(new THREE.BoxGeometry(gw, 0.6, WALL_T), this.materials.matWall);
                m.position.set(gc, WALL_H - 0.3, z); m.receiveShadow = true; this.scene.add(m);
            } else {
                const m = new THREE.Mesh(new THREE.BoxGeometry(WALL_T, 0.6, gw), this.materials.matWall);
                m.position.set(x, WALL_H - 0.3, gc); m.receiveShadow = true; this.scene.add(m);
            }
            cursor = gEnd;
        });

        const endCoord = isHorizontal ? x + half : z + half;
        if (endCoord > cursor) {
            const segLen = endCoord - cursor;
            const mid    = (cursor + endCoord) / 2;
            if (isHorizontal) this._wall(mid, z, segLen, WALL_H, WALL_T);
            else              this._wall(x, mid, WALL_T, WALL_H, segLen);
        }
    }

    /**
     * Build a bridge corridor connecting a room to the main spine/side corridor.
     * Adds floor, ceiling, and side walls — leaves both ends open.
     */
    _bridge(cx, cz, w, len, isNS) {
        // isNS = true → corridor runs north-south (along Z)
        //        false → corridor runs east-west  (along X)
        if (isNS) {
            // corridor runs along Z; w is the east-west width
            this._floor(cx, cz, w, len, this.materials.matTile);
            this._ceiling(cx, cz, w, len);
            this._wall(cx - w / 2, cz, WALL_T, WALL_H, len); // west side
            this._wall(cx + w / 2, cz, WALL_T, WALL_H, len); // east side
        } else {
            // corridor runs along X; w is the north-south depth
            this._floor(cx, cz, len, w, this.materials.matTile);
            this._ceiling(cx, cz, len, w);
            this._wall(cx, cz - w / 2, len, WALL_H, WALL_T); // north side
            this._wall(cx, cz + w / 2, len, WALL_H, WALL_T); // south side
        }
    }

    // ═══════════════════════════════════════════════════════════════
    // LIGHT HELPERS
    // ═══════════════════════════════════════════════════════════════
    _light(color, intensity, x, y, z, distance, decay, opts) {
        distance = distance || 8;
        decay    = decay    || 1.8;
        opts     = opts     || {};
        const L  = new THREE.PointLight(color, intensity, distance, decay);
        L.position.set(x, y, z);
        if (opts.shadow) {
            L.castShadow = true;
            L.shadow.mapSize.set(256, 256);
            L.shadow.bias = -0.002;
            L.shadow.camera.near = 0.2;
            L.shadow.camera.far  = distance;
        }
        this.scene.add(L);
        this.lights.push(L);
        if (opts.flicker) {
            this.flickerLights.push({
                light: L, base: intensity,
                phase: Math.random() * 10,
                rate:  0.3 + Math.random() * 1.2,
                depth: opts.flickerDepth || 0.4
            });
        }
        return L;
    }

    /** Ceiling light that starts OFF — powered on when generator is restored */
    _mainLight(x, z, targetIntensity, distance) {
        targetIntensity = targetIntensity || 2.2;
        distance        = distance        || 9;
        const L = new THREE.PointLight(0xfff6e8, 0, distance, 1.6);
        L.position.set(x, 2.9, z);
        this.scene.add(L);
        this.mainPowerLights.push({ light: L, target: targetIntensity });
        return L;
    }

    setMainPower(on) {
        this.facilityPowered    = on;
        this._powerRampStart    = performance.now();
        this._powerRampFrom     = this.mainPowerLights.map(p => p.light.intensity);
        this._powerRampTo       = on
            ? this.mainPowerLights.map(p => p.target)
            : this.mainPowerLights.map(() => 0);
        this._powerRamping      = true;
    }

    /** Visible ceiling fixture (paired with a _mainLight for actual illumination) */
    _ceilingFixture(x, z) {
        const housing = new THREE.Mesh(
            new THREE.CylinderGeometry(0.5, 0.5, 0.08, 24),
            new THREE.MeshStandardMaterial({ color: 0x2a2620, roughness: 0.5, metalness: 0.6 })
        );
        housing.position.set(x, WALL_H - 0.05, z);
        this.scene.add(housing);

        const glowDisc = new THREE.Mesh(
            new THREE.CylinderGeometry(0.42, 0.42, 0.03, 24),
            new THREE.MeshStandardMaterial({ color: 0xfff6e0, emissive: 0xfff2c8, emissiveIntensity: 0, roughness: 0.3 })
        );
        glowDisc.position.set(x, WALL_H - 0.1, z);
        this.scene.add(glowDisc);

        this.mainPowerLights.push({
            light: {
                get intensity()  { return glowDisc.material.emissiveIntensity; },
                set intensity(v) { glowDisc.material.emissiveIntensity = v; }
            },
            target: 1.6
        });
        return { housing, glowDisc };
    }

    _emergencyFixture(x, y, z) {
        const housing = new THREE.Mesh(
            new THREE.BoxGeometry(0.4, 0.2, 0.25), this.materials.matMetal
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

        this._light(0xff2222, 1.6, x, y - 0.1, z, 8, 1.8, {
            flicker: Math.random() < 0.35, flickerDepth: 0.3
        });
    }

    // ═══════════════════════════════════════════════════════════════
    // SPINE — vertical corridor running north-south through the center
    // x=0, width=HALLWAY_W=3, from z=SPINE_NORTH to z=SPINE_SOUTH
    // ═══════════════════════════════════════════════════════════════
    _buildSpine() {
        const length = POS.SPINE_SOUTH - POS.SPINE_NORTH; // 48
        const centerZ = (POS.SPINE_NORTH + POS.SPINE_SOUTH) / 2; // 0

        this._floor(0, centerZ, HALLWAY_W, length, this.materials.matTile);
        this._ceiling(0, centerZ, HALLWAY_W, length);

        // West wall of spine: gaps at Security Office bridge (z=-16), Reception (z=+2, w=10), Records bridge (z=+16)
        this._wallWithGaps(-HALLWAY_W / 2, centerZ, length, false, [
            { center: POS.UPPER_CZ,       width: HALLWAY_W },
            { center: POS.RECEPTION_CZ,   width: RECEPTION_D },  // wide gap = full Reception access
            { center: POS.LOWER_CZ,       width: HALLWAY_W },
        ]);
        // East wall of spine: same gaps mirrored
        this._wallWithGaps(HALLWAY_W / 2, centerZ, length, false, [
            { center: POS.UPPER_CZ,       width: HALLWAY_W },
            { center: POS.RECEPTION_CZ,   width: RECEPTION_D },
            { center: POS.LOWER_CZ,       width: HALLWAY_W },
        ]);

        // North cap at z=SPINE_NORTH: full gap (exit connector goes north)
        this._wallWithGaps(0, POS.SPINE_NORTH, HALLWAY_W, true, [{ center: 0, width: HALLWAY_W }]);
        // South cap at z=SPINE_SOUTH: full gap (entrance connector goes south)
        this._wallWithGaps(0, POS.SPINE_SOUTH, HALLWAY_W, true, [{ center: 0, width: HALLWAY_W }]);

        // Corridor lighting — emergency fixtures every 8 units
        for (let z = POS.SPINE_NORTH + 4; z <= POS.SPINE_SOUTH - 4; z += 8) {
            this._emergencyFixture(0, 2.7, z);
        }
        this._mainLight(0, POS.UPPER_CZ,     1.6, 8);
        this._mainLight(0, POS.RECEPTION_CZ, 1.4, 8);
        this._mainLight(0, POS.LOWER_CZ,     1.6, 8);

        this._sign(0, 2.6, -6, 'FACILITY CORRIDOR', '#c41e1e', 3.5, 0.7);
    }

    // ═══════════════════════════════════════════════════════════════
    // UPPER ROOMS  — Security Office (west) + Laboratory (east)
    // Both at z = UPPER_CZ = -16.  Horizontal bridge to spine.
    // ═══════════════════════════════════════════════════════════════
    _buildUpperRooms() {
        // ── Security Office ── west side, center (-12, -16)
        this._roomBox(POS.UPPER_LEFT_CX, POS.UPPER_CZ, ROOM_W, ROOM_D, {
            name: 'Security Office',
            doorways: [{ side: 'E', offset: 0, width: HALLWAY_W }]
        });
        this._addSecurityProps(POS.UPPER_LEFT_CX, POS.UPPER_CZ);
        this._emergencyFixture(POS.UPPER_LEFT_CX, 2.7, POS.UPPER_CZ);
        this._mainLight(POS.UPPER_LEFT_CX, POS.UPPER_CZ, 1.8, 9);

        // Bridge: room east wall x=-7 → spine west wall x=-1.5, center x=-4.25, len=5.5
        const secBridgeCX = -4.25;
        this._bridge(secBridgeCX, POS.UPPER_CZ, HALLWAY_W, BRIDGE_LEN, false);
        this._mainLight(secBridgeCX, POS.UPPER_CZ, 1.4, 6);

        // ── Laboratory ── east side, center (+12, -16)
        this._roomBox(POS.UPPER_RIGHT_CX, POS.UPPER_CZ, ROOM_W, ROOM_D, {
            name: 'Laboratory',
            doorways: [{ side: 'W', offset: 0, width: HALLWAY_W }]
        });
        this._addLabProps(POS.UPPER_RIGHT_CX, POS.UPPER_CZ);
        this._emergencyFixture(POS.UPPER_RIGHT_CX, 2.7, POS.UPPER_CZ);
        this._mainLight(POS.UPPER_RIGHT_CX, POS.UPPER_CZ, 1.8, 9);

        // Bridge: room west wall x=+7 → spine east wall x=+1.5, center x=+4.25, len=5.5
        const labBridgeCX = 4.25;
        this._bridge(labBridgeCX, POS.UPPER_CZ, HALLWAY_W, BRIDGE_LEN, false);
        this._mainLight(labBridgeCX, POS.UPPER_CZ, 1.4, 6);
    }

    // ═══════════════════════════════════════════════════════════════
    // RECEPTION HUB — largest room, center (0, 2), 18×10
    // Open on west and east sides to allow side-corridor connections.
    // ═══════════════════════════════════════════════════════════════
    _buildReception() {
        const cx = POS.RECEPTION_CX, cz = POS.RECEPTION_CZ;
        const w  = RECEPTION_W,      d  = RECEPTION_D;

        this._floor(cx, cz, w, d, this.materials.matTile);
        this._ceiling(cx, cz, w, d);

        // North wall (z = cz - d/2 = 2 - 5 = -3): gap for spine (w=HALLWAY_W centered at x=0)
        this._wallWithGaps(0, cz - d / 2, w, true, [{ center: 0, width: HALLWAY_W }]);
        // South wall (z = cz + d/2 = 7): gap for spine
        this._wallWithGaps(0, cz + d / 2, w, true, [{ center: 0, width: HALLWAY_W }]);

        // West wall (x = -9): corner pillars only — the center is open to the west corridor.
        // Pillar at north corner and south corner, each 1.2 wide.
        this._wall(-w / 2, cz - d / 2 + 0.6, WALL_T, WALL_H, 1.2); // NW pillar
        this._wall(-w / 2, cz + d / 2 - 0.6, WALL_T, WALL_H, 1.2); // SW pillar

        // East wall (x = +9): same
        this._wall( w / 2, cz - d / 2 + 0.6, WALL_T, WALL_H, 1.2); // NE pillar
        this._wall( w / 2, cz + d / 2 - 0.6, WALL_T, WALL_H, 1.2); // SE pillar

        this._addReceptionProps(cx, cz);

        // Lighting: three main lights + ceiling fixtures + emergency
        this._mainLight(cx - 4, cz, 2.0, 10);
        this._mainLight(cx,     cz, 2.4, 12);
        this._mainLight(cx + 4, cz, 2.0, 10);
        this._ceilingFixture(cx - 2, cz);
        this._ceilingFixture(cx + 2, cz);
        this._emergencyFixture(0, 2.7, cz - 2);
        this._emergencyFixture(0, 2.7, cz + 3);

        if (!this.rooms['Reception']) {
            this.rooms['Reception'] = { center: new THREE.Vector3(cx, 0, cz), w, d };
        }
    }

    // ═══════════════════════════════════════════════════════════════
    // WEST WING — side corridor + Storage Room + Maintenance Room
    // Side corridor: x=-12, z=0..12 (center z=6)
    // Bridges: east wall of Storage/Maint → corridor west wall at x=-13.5
    // ═══════════════════════════════════════════════════════════════
    _buildWestWing() {
        const corrX     = -12;    // side corridor center X
        const corrZMin  = POS.SIDE_CORR_NORTH; // z = 0
        const corrZMax  = POS.SIDE_CORR_SOUTH; // z = 12
        const corrLen   = corrZMax - corrZMin;  // 12
        const corrCZ    = (corrZMin + corrZMax) / 2; // 6

        // Side corridor floor + ceiling (3 wide, 12 long)
        this._floor(corrX, corrCZ, HALLWAY_W, corrLen, this.materials.matTile);
        this._ceiling(corrX, corrCZ, HALLWAY_W, corrLen);
        // North cap (where it meets Reception corner)
        this._wall(corrX, corrZMin, HALLWAY_W, WALL_H, WALL_T);
        // South cap
        this._wall(corrX, corrZMax, HALLWAY_W, WALL_H, WALL_T);
        // East wall of corridor with gaps for Storage (z=+2) and Maintenance (z=+10)
        this._wallWithGaps(corrX + HALLWAY_W / 2, corrCZ, corrLen, false, [
            { center: POS.STORAGE_CZ, width: HALLWAY_W },
            { center: POS.MAINT_CZ,   width: HALLWAY_W },
        ]);
        // West wall (solid)
        this._wall(corrX - HALLWAY_W / 2, corrCZ, WALL_T, WALL_H, corrLen);

        this._mainLight(corrX, corrCZ, 1.4, 8);
        this._emergencyFixture(corrX, 2.7, corrCZ);

        // Reception west edge x=-9 to corridor east wall x=-10.5: short bridge (1.5 wide, depth=4)
        // This fills the gap between the open Reception west face and the corridor east wall
        const recBridgeCX = -9.75;
        this._floor(recBridgeCX, POS.RECEPTION_CZ, 1.5, RECEPTION_D, this.materials.matTile);
        this._ceiling(recBridgeCX, POS.RECEPTION_CZ, 1.5, RECEPTION_D);
        // Note: no side walls needed here — the Reception corner pillars and corridor wall cap it

        // ── Storage Room ── center (-24, 2)
        const storCX = POS.WEST_CX, storCZ = POS.STORAGE_CZ;
        this._roomBox(storCX, storCZ, ROOM_W, ROOM_D, {
            name: 'Storage Room',
            doorways: [{ side: 'E', offset: 0, width: HALLWAY_W }]
        });
        this._addStorageProps(storCX, storCZ);
        this._emergencyFixture(storCX, 2.7, storCZ);
        this._mainLight(storCX, storCZ, 1.8, 9);

        // Bridge: room east wall x=-19 → corridor east wall x=-10.5, center x=-14.75, len=8.5
        // Actually room east wall x = storCX + ROOM_W/2 = -24 + 5 = -19
        // corridor west wall x = corrX - HALLWAY_W/2 = -12 - 1.5 = -13.5
        // bridge center = (-19 + -13.5)/2 = -16.25, length = 5.5
        const storBridgeCX = -16.25;
        this._bridge(storBridgeCX, storCZ, HALLWAY_W, BRIDGE_LEN, false);
        this._mainLight(storBridgeCX, storCZ, 1.4, 6);

        // ── Maintenance Room ── center (-24, 10)
        const maintCX = POS.WEST_CX, maintCZ = POS.MAINT_CZ;
        this._roomBox(maintCX, maintCZ, ROOM_W, ROOM_D_SM, {
            name: 'Maintenance Room',
            doorways: [{ side: 'E', offset: 0, width: HALLWAY_W }]
        });
        this._addMaintenanceProps(maintCX, maintCZ);
        this._emergencyFixture(maintCX, 2.7, maintCZ);
        this._mainLight(maintCX, maintCZ, 1.8, 8);

        // Bridge (same span as Storage bridge)
        const maintBridgeCX = -16.25;
        this._bridge(maintBridgeCX, maintCZ, HALLWAY_W, BRIDGE_LEN, false);
        this._mainLight(maintBridgeCX, maintCZ, 1.4, 6);
    }

    // ═══════════════════════════════════════════════════════════════
    // EAST WING — side corridor + Break Room + Admin Office
    // Mirror of west wing on east side
    // ═══════════════════════════════════════════════════════════════
    _buildEastWing() {
        const corrX    =  12;
        const corrZMin = POS.SIDE_CORR_NORTH;
        const corrZMax = POS.SIDE_CORR_SOUTH;
        const corrLen  = corrZMax - corrZMin;
        const corrCZ   = (corrZMin + corrZMax) / 2;

        this._floor(corrX, corrCZ, HALLWAY_W, corrLen, this.materials.matTile);
        this._ceiling(corrX, corrCZ, HALLWAY_W, corrLen);
        this._wall(corrX, corrZMin, HALLWAY_W, WALL_H, WALL_T);
        this._wall(corrX, corrZMax, HALLWAY_W, WALL_H, WALL_T);
        // West wall with gaps for Break Room (z=+2) and Admin Office (z=+10)
        this._wallWithGaps(corrX - HALLWAY_W / 2, corrCZ, corrLen, false, [
            { center: POS.BREAK_CZ, width: HALLWAY_W },
            { center: POS.ADMIN_CZ, width: HALLWAY_W },
        ]);
        // East wall (solid)
        this._wall(corrX + HALLWAY_W / 2, corrCZ, WALL_T, WALL_H, corrLen);

        this._mainLight(corrX, corrCZ, 1.4, 8);
        this._emergencyFixture(corrX, 2.7, corrCZ);

        // Reception east edge x=+9 to corridor west wall x=+10.5: short bridge
        const recBridgeCX = 9.75;
        this._floor(recBridgeCX, POS.RECEPTION_CZ, 1.5, RECEPTION_D, this.materials.matTile);
        this._ceiling(recBridgeCX, POS.RECEPTION_CZ, 1.5, RECEPTION_D);

        // ── Break Room ── center (+24, 2)
        const breakCX = POS.EAST_CX, breakCZ = POS.BREAK_CZ;
        this._roomBox(breakCX, breakCZ, ROOM_W, ROOM_D, {
            name: 'Break Room',
            doorways: [{ side: 'W', offset: 0, width: HALLWAY_W }]
        });
        this._addBreakRoomProps(breakCX, breakCZ);
        this._emergencyFixture(breakCX, 2.7, breakCZ);
        this._mainLight(breakCX, breakCZ, 1.8, 9);

        const breakBridgeCX = 16.25;
        this._bridge(breakBridgeCX, breakCZ, HALLWAY_W, BRIDGE_LEN, false);
        this._mainLight(breakBridgeCX, breakCZ, 1.4, 6);

        // ── Admin Office ── center (+24, 10)
        const adminCX = POS.EAST_CX, adminCZ = POS.ADMIN_CZ;
        this._roomBox(adminCX, adminCZ, ROOM_W, ROOM_D_SM, {
            name: 'Admin Office',
            doorways: [{ side: 'W', offset: 0, width: HALLWAY_W }]
        });
        this._addAdminProps(adminCX, adminCZ);
        this._emergencyFixture(adminCX, 2.7, adminCZ);
        this._mainLight(adminCX, adminCZ, 1.8, 8);

        const adminBridgeCX = 16.25;
        this._bridge(adminBridgeCX, adminCZ, HALLWAY_W, BRIDGE_LEN, false);
        this._mainLight(adminBridgeCX, adminCZ, 1.4, 6);
    }

    // ═══════════════════════════════════════════════════════════════
    // LOWER ROOMS — Records Room (west) + Meeting Room (east)
    // Both at z = LOWER_CZ = +16. Horizontal bridge to spine.
    // ═══════════════════════════════════════════════════════════════
    _buildLowerRooms() {
        // ── Records Room ── west side, center (-12, 16)
        this._roomBox(POS.LOWER_LEFT_CX, POS.LOWER_CZ, ROOM_W, ROOM_D, {
            name: 'Records Room',
            doorways: [{ side: 'E', offset: 0, width: HALLWAY_W }]
        });
        this._addRecordsProps(POS.LOWER_LEFT_CX, POS.LOWER_CZ);
        this._emergencyFixture(POS.LOWER_LEFT_CX, 2.7, POS.LOWER_CZ);
        this._mainLight(POS.LOWER_LEFT_CX, POS.LOWER_CZ, 1.8, 9);

        const recBridgeCX = -4.25;
        this._bridge(recBridgeCX, POS.LOWER_CZ, HALLWAY_W, BRIDGE_LEN, false);
        this._mainLight(recBridgeCX, POS.LOWER_CZ, 1.4, 6);

        // ── Meeting Room ── east side, center (+12, 16)
        this._roomBox(POS.LOWER_RIGHT_CX, POS.LOWER_CZ, ROOM_W, ROOM_D, {
            name: 'Meeting Room',
            doorways: [{ side: 'W', offset: 0, width: HALLWAY_W }]
        });
        this._addMeetingProps(POS.LOWER_RIGHT_CX, POS.LOWER_CZ);
        this._emergencyFixture(POS.LOWER_RIGHT_CX, 2.7, POS.LOWER_CZ);
        this._mainLight(POS.LOWER_RIGHT_CX, POS.LOWER_CZ, 1.8, 9);

        const meetBridgeCX = 4.25;
        this._bridge(meetBridgeCX, POS.LOWER_CZ, HALLWAY_W, BRIDGE_LEN, false);
        this._mainLight(meetBridgeCX, POS.LOWER_CZ, 1.4, 6);
    }

    // ═══════════════════════════════════════════════════════════════
    // EXIT AREA — at the north end of the spine (z = -30)
    // Connector: spine north cap z=-24 to room south wall z≈-26.5
    // ═══════════════════════════════════════════════════════════════
    _buildExitArea() {
        const cx = 0, cz = POS.EXIT_CZ; // (0, -30)

        this._roomBox(cx, cz, ROOM_W, ROOM_D_SM, {
            name: 'Exit Area',
            doorways: [{ side: 'S', offset: 0, width: HALLWAY_W }]
        });
        this._addExitGateProps(cx, cz);
        this._emergencyFixture(cx, 2.7, cz);
        this._mainLight(cx, cz, 2.4, 10);
        this._ceilingFixture(cx, cz);

        // Connector: south wall of exit room z = cz + ROOM_D_SM/2 = -30 + 3.5 = -26.5
        // North cap of spine z = SPINE_NORTH = -24
        // Bridge center z = (-26.5 + -24) / 2 = -25.25, length = 2.5
        const connCZ = -25.25, connLen = 2.5;
        this._floor(0, connCZ, HALLWAY_W, connLen, this.materials.matTile);
        this._ceiling(0, connCZ, HALLWAY_W, connLen);
        this._wall(-HALLWAY_W / 2, connCZ, WALL_T, WALL_H, connLen);
        this._wall( HALLWAY_W / 2, connCZ, WALL_T, WALL_H, connLen);
        this._mainLight(0, connCZ, 1.6, 5);

        // Exit trigger position — player must walk past the north wall of exit room
        this.exitTriggerPos = new THREE.Vector3(cx, 0, cz - ROOM_D_SM / 2 - 1.5);
    }

    // ═══════════════════════════════════════════════════════════════
    // ENTRANCE AREA — at the south end of the spine (z = +30)
    // Player spawns here. Walk north to reach Reception.
    // ═══════════════════════════════════════════════════════════════
    _buildEntranceArea() {
        const cx = 0, cz = POS.ENTRANCE_CZ; // (0, 30)

        this._roomBox(cx, cz, ROOM_W, ROOM_D_SM, {
            name: 'Main Entrance',
            doorways: [{ side: 'N', offset: 0, width: HALLWAY_W }]
        });
        this._addEntranceProps(cx, cz);
        this._emergencyFixture(cx, 2.7, cz);
        this._mainLight(cx, cz, 2.2, 10);

        // Connector: north wall z = cz - ROOM_D_SM/2 = 30 - 3.5 = 26.5
        // South cap of spine z = SPINE_SOUTH = +24
        // Bridge center z = (26.5 + 24) / 2 = 25.25, length = 2.5
        const connCZ = 25.25, connLen = 2.5;
        this._floor(0, connCZ, HALLWAY_W, connLen, this.materials.matTile);
        this._ceiling(0, connCZ, HALLWAY_W, connLen);
        this._wall(-HALLWAY_W / 2, connCZ, WALL_T, WALL_H, connLen);
        this._wall( HALLWAY_W / 2, connCZ, WALL_T, WALL_H, connLen);
        this._mainLight(0, connCZ, 1.6, 5);
    }

    // ═══════════════════════════════════════════════════════════════
    // ROOM PROPS
    // ═══════════════════════════════════════════════════════════════

    _addReceptionProps(cx, cz) {
        const deskZ = cz + 2.5;
        this._desk(cx, deskZ, 3);
        this._chair(cx - 1, deskZ + 1.4);
        this._chair(cx + 1, deskZ + 1.4);
        this._crate(cx - 3, deskZ + 1.5);
        this._waterPuddle(cx + 2, deskZ + 1.2, 1.4);
        this._light(0xfff0c0, 0.4, cx, 2.8, deskZ, 6, 1.7, { flicker: Math.random() < 0.5 });
        this._sign(cx, 2.2, cz + RECEPTION_D / 2 - 0.15, 'RECEPTION', '#f0a830', 3, 0.8);
    }

    _addSecurityProps(cx, cz) {
        this._desk(cx, cz, 3.2);
        this._monitor(cx - 1, cz - 0.2, 1.6);
        this._monitor(cx + 1, cz - 0.2, 1.6);
        this._chair(cx, cz + 1.2);

        // KEYCARD — interactable pickup
        const cardGeo = new THREE.BoxGeometry(0.18, 0.01, 0.28);
        const cardMat = new THREE.MeshStandardMaterial({
            color: 0xc41e1e, emissive: 0xc41e1e, emissiveIntensity: 0.6, roughness: 0.4
        });
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

        this._sign(cx, 2.4, cz - ROOM_D / 2 + 0.15, 'SECURITY OFFICE', '#c41e1e', 3.2, 0.7);
        this._light(0xfff0c0, 0.5, cx, 2.8, cz, 7, 1.7, { flicker: true });
        this._light(0x33aaff, 0.4, cx, 1.4, cz - 0.2, 3.5, 2.4);
        this._crate(cx + 3, cz + 2);
        this._pipes(cx - 4, cz + 1);
    }

    _addLabProps(cx, cz) {
        this._labTable(cx - 3, cz);
        this._labTable(cx,     cz);
        this._labTable(cx + 3, cz);
        this._cylinder(cx - 3, cz - 0.4);
        this._cylinder(cx + 3, cz - 0.4);
        this._note(cx, 1.06, cz + 0.6, 'EXPERIMENT 07');
        this._sign(cx, 2.4, cz - ROOM_D / 2 + 0.15, 'LABORATORY', '#4fbc94', 3.2, 0.7);
        this._light(0xa8c8ff, 0.6, cx - 3, 2.8, cz, 6, 1.8, { flicker: true });
        this._light(0xa8c8ff, 0.6, cx,     2.8, cz, 6, 1.8);
        this._light(0xa8c8ff, 0.6, cx + 3, 2.8, cz, 6, 1.8, { flicker: true, flickerDepth: 0.5 });
        this._waterPuddle(cx - 2, cz + 2, 1.6);
    }

    _addStorageProps(cx, cz) {
        for (let i = -1; i <= 1; i++) this._shelf(cx + i * 2.6, cz - 1.5);
        this._crate(cx - 3.5, cz + 1.5);
        this._crate(cx - 2.8, cz + 2);
        this._crate(cx + 3,   cz + 1.5);
        this._crate(cx + 3.5, cz + 2.2);
        this._note(cx, 1.0, cz + 2, 'INVENTORY LOG');
        this._sign(cx, 2.4, cz - ROOM_D / 2 + 0.15, 'STORAGE ROOM', '#f0a830', 3.2, 0.7);
        this._light(0xfff0c0, 0.45, cx, 2.8, cz, 7, 1.7, { flicker: Math.random() < 0.4 });
    }

    _addMaintenanceProps(cx, cz) {
        this._pipes(cx - 4, cz - 2);
        this._pipes(cx + 4, cz - 2);
        this._crate(cx - 3.5, cz + 1);
        this._crate(cx - 2.8, cz + 1.5);
        this._toolbox(cx + 3, cz - 1);
        this._sign(cx, 2.4, cz - ROOM_D_SM / 2 + 0.15, 'MAINTENANCE', '#f0a830', 3.4, 0.7);
        this._light(0xffaa44, 0.4, cx - 3, 2.8, cz, 6, 1.8, { flicker: true });
        this._waterPuddle(cx - 1, cz + 2, 1.6);

        // Generator — Objective: Restore Generator Power
        const gen = new THREE.Group();
        gen.position.set(cx + 2.5, 0, cz + 1);
        const body = new THREE.Mesh(new THREE.BoxGeometry(2.6, 1.9, 1.5), this.materials.matMetal);
        body.position.set(0, 0.95, 0); body.castShadow = body.receiveShadow = true;
        gen.add(body);
        const core = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.45, 1.9, 16), this.materials.matMetal);
        core.position.set(0, 1.0, 0.85); core.rotation.z = Math.PI / 2; core.castShadow = true;
        gen.add(core);
        const panelMat = new THREE.MeshStandardMaterial({
            color: 0x2a0808, emissive: 0x2a0808, emissiveIntensity: 0.4, roughness: 0.4
        });
        const panel = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.35, 0.07), panelMat);
        panel.position.set(0.9, 1.2, 0.78);
        gen.add(panel);
        this.scene.add(gen);
        this.collidables.push(body, core);

        const switchMesh = new THREE.Mesh(
            new THREE.BoxGeometry(0.28, 0.45, 0.16),
            new THREE.MeshStandardMaterial({
                color: 0x6e2a2a, emissive: 0x3a0808, emissiveIntensity: 0.6,
                roughness: 0.4, metalness: 0.5
            })
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

    _addBreakRoomProps(cx, cz) {
        // Round table in center + chairs + vending cabinet
        const tableTop = new THREE.Mesh(
            new THREE.CylinderGeometry(0.8, 0.8, 0.07, 20),
            new THREE.MeshStandardMaterial({ color: 0x3a2f24, roughness: 0.55 })
        );
        tableTop.position.set(cx, 0.9, cz);
        tableTop.castShadow = tableTop.receiveShadow = true;
        this.scene.add(tableTop);
        this.collidables.push(tableTop);

        const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.1, 0.86, 10), this.materials.matMetal);
        leg.position.set(cx, 0.45, cz); this.scene.add(leg);

        this._chair(cx - 1.2, cz);
        this._chair(cx + 1.2, cz);
        this._cabinet(cx,     cz - 3);
        this._crate(cx + 3,   cz + 2);
        this._note(cx - 1.2, 0.97, cz + 0.3, 'BREAK SCHEDULE');
        this._sign(cx, 2.4, cz - ROOM_D / 2 + 0.15, 'BREAK ROOM', '#f0a830', 3, 0.7);
        this._light(0xfff0c0, 0.5, cx, 2.8, cz, 7, 1.7, { flicker: Math.random() < 0.4 });
    }

    _addAdminProps(cx, cz) {
        this._desk(cx, cz - 1, 2.8);
        this._chair(cx, cz + 0.3);
        this._monitor(cx, cz - 1.2, 0.9);
        this._cabinet(cx + 3.5, cz + 1.5);
        this._note(cx + 0.5, 1.06, cz - 1.4, 'ADMIN MEMO');
        this._sign(cx, 2.4, cz - ROOM_D_SM / 2 + 0.15, 'ADMIN OFFICE', '#c41e1e', 3.4, 0.7);
        this._light(0xfff0c0, 0.5, cx, 2.8, cz, 7, 1.7, { flicker: true });
    }

    _addRecordsProps(cx, cz) {
        for (let i = -1; i <= 1; i++) this._shelf(cx + i * 2.6, cz - 1.5);
        this._cabinet(cx - 3.5, cz + 2);
        this._cabinet(cx + 3.5, cz + 2);
        this._desk(cx, cz + 2.2, 2.2);
        this._note(cx, 1.06, cz + 1.7, 'CLASSIFIED FILES');
        this._sign(cx, 2.4, cz - ROOM_D / 2 + 0.15, 'RECORDS ROOM', '#4fbc94', 3.2, 0.7);
        this._light(0xfff0c0, 0.45, cx, 2.8, cz, 7, 1.7, { flicker: Math.random() < 0.4 });
        this._waterPuddle(cx - 2, cz + 3, 1.6);
    }

    _addMeetingProps(cx, cz) {
        // Long conference table + chairs around it + wall panel
        const tableTop = new THREE.Mesh(
            new THREE.BoxGeometry(3.2, 0.06, 1.4), this.materials.matMetal
        );
        tableTop.position.set(cx, 0.85, cz);
        tableTop.castShadow = tableTop.receiveShadow = true;
        this.scene.add(tableTop);
        this.collidables.push(tableTop);

        const leg = (lx, lz) => {
            const m = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.85, 0.07), this.materials.matMetal);
            m.position.set(cx + lx, 0.42, cz + lz); this.scene.add(m);
        };
        leg( 1.5,  0.6); leg(-1.5,  0.6);
        leg( 1.5, -0.6); leg(-1.5, -0.6);

        this._chair(cx - 1.2, cz - 1.4);
        this._chair(cx,       cz - 1.4);
        this._chair(cx + 1.2, cz - 1.4);
        this._chair(cx - 1.2, cz + 1.4);
        this._chair(cx,       cz + 1.4);
        this._chair(cx + 1.2, cz + 1.4);

        // Presentation panel on back wall
        const panel = new THREE.Mesh(
            new THREE.PlaneGeometry(2.4, 1.4),
            new THREE.MeshStandardMaterial({ color: 0x0a1010, emissive: 0x0a2020, emissiveIntensity: 0.3, roughness: 0.2 })
        );
        panel.position.set(cx, 1.6, cz - ROOM_D / 2 + 0.05);
        this.scene.add(panel);

        this._note(cx + 0.8, 0.91, cz + 0.2, 'CASE FILE 07');
        this._sign(cx, 2.4, cz - ROOM_D / 2 + 0.15, 'MEETING ROOM', '#c41e1e', 3.2, 0.7);
        this._light(0xfff6e0, 1.0, cx, 2.4, cz, 6, 1.4, { flicker: Math.random() < 0.3, flickerDepth: 0.5 });
    }

    _addEntranceProps(cx, cz) {
        this._desk(cx + 2, cz, 2.4);
        this._sign(cx, 2.4, cz - ROOM_D_SM / 2 + 0.15, 'MAIN ENTRANCE', '#c41e1e', 4, 1);

        // Sealed exterior doors (south wall)
        const doorL = new THREE.Mesh(new THREE.BoxGeometry(1.5, 2.4, 0.12), this.materials.matMetal);
        doorL.position.set(cx - 0.85, 1.2, cz + ROOM_D_SM / 2 - 0.12);
        doorL.castShadow = true; this.scene.add(doorL);
        const doorR = new THREE.Mesh(new THREE.BoxGeometry(1.5, 2.4, 0.12), this.materials.matMetal);
        doorR.position.set(cx + 0.85, 1.2, cz + ROOM_D_SM / 2 - 0.12);
        doorR.castShadow = true; this.scene.add(doorR);
        this._sign(cx, 1.4, cz + ROOM_D_SM / 2 - 0.05, 'SEALED', '#c41e1e', 1.8, 0.5);

        this._light(0xfff0c0, 0.6, cx, 2.8, cz, 8, 1.6, { flicker: true, flickerDepth: 0.5 });
        this._crate(cx - 3, cz + 2);
        this._crate(cx - 3.5, cz - 2);
        this._pipes(cx + 4, cz - 1);
    }

    _addExitGateProps(cx, cz) {
        // Gate sits inside the north wall of the exit room (x = cx - ROOM_W/2 = -5, but gate is centered)
        // Place gate at the north wall interior face
        const gateZ = cz - ROOM_D_SM / 2 + 0.15; // just inside the north wall

        const gateGroup = new THREE.Group();
        const gateBarMeshes = [];

        for (let i = -3; i <= 3; i++) {
            const bar = new THREE.Mesh(new THREE.BoxGeometry(0.12, 2.8, 0.12), this.materials.matMetal);
            bar.position.set(i * 0.36, 1.4, 0);
            bar.castShadow = true;
            gateGroup.add(bar);
            gateBarMeshes.push(bar);
        }
        const top = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.2, HALLWAY_W), this.materials.matMetal);
        top.position.set(0, 2.8, 0);
        gateGroup.add(top);
        gateBarMeshes.push(top);

        gateGroup.position.set(cx, 0, gateZ);
        this.scene.add(gateGroup);

        // Frame posts flanking the gate (outside the HALLWAY_W gap = ±1.5)
        const frameMat = this.materials.matMetal;
        [
            { geo: [0.18, WALL_H, 0.2], pos: [0, WALL_H / 2, 1.8] },
            { geo: [0.18, WALL_H, 0.2], pos: [0, WALL_H / 2, -1.8] },
            { geo: [0.18, 0.3, HALLWAY_W + 0.6], pos: [0, WALL_H, 0] },
        ].forEach(f => {
            const m = new THREE.Mesh(new THREE.BoxGeometry(...f.geo), frameMat);
            m.position.set(cx + f.pos[0], f.pos[1], gateZ + f.pos[2]);
            this.scene.add(m);
            this.collidables.push(m);
        });

        gateBarMeshes.forEach(m => this.collidables.push(m));
        this._gateBarMeshes = gateBarMeshes;

        // Exit console beside the gate
        const consoleX = cx + 2.2, consoleZ = cz - 1.5;
        const consoleMesh = new THREE.Mesh(
            new THREE.BoxGeometry(0.8, 1.2, 0.6), this.materials.matComputer
        );
        consoleMesh.position.set(consoleX, 0.6, consoleZ);
        consoleMesh.castShadow = true; this.scene.add(consoleMesh);
        this.collidables.push(consoleMesh);

        const screen = new THREE.Mesh(
            new THREE.PlaneGeometry(0.5, 0.3),
            new THREE.MeshStandardMaterial({ color: 0x3a0808, emissive: 0xc41e1e, emissiveIntensity: 1.2 })
        );
        screen.position.set(consoleX, 0.95, consoleZ + 0.31);
        this.scene.add(screen);

        this.interactables.push({
            mesh: consoleMesh, type: 'exit_console',
            prompt: 'UNLOCK EXIT',
            data: { gate: gateGroup, screen, gateZ, gateBarMeshes },
            bobBase: null
        });

        this._sign(cx, 2.4, cz + 1, 'EMERGENCY EXIT', '#c41e1e', 3.8, 0.8);
        this._emergencyFixture(cx + 3, 2.7, cz);
    }

    // ═══════════════════════════════════════════════════════════════
    // PROP PRIMITIVES
    // ═══════════════════════════════════════════════════════════════
    _desk(x, z, w) {
        w = w || 2.4;
        const top = new THREE.Mesh(
            new THREE.BoxGeometry(w, 0.08, 1),
            new THREE.MeshStandardMaterial({ color: 0x3a2f24, roughness: 0.6, metalness: 0.2 })
        );
        top.position.set(x, 1.0, z);
        top.castShadow = top.receiveShadow = true;
        this.scene.add(top);
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

    _monitor(x, z, w) {
        w = w || 1;
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
        const m = new THREE.Mesh(
            new THREE.BoxGeometry(size, size, size),
            new THREE.MeshStandardMaterial({ color: 0x6e5b3a, roughness: 0.7, metalness: 0.1 })
        );
        m.position.set(x, size / 2, z);
        m.rotation.y = Math.random() * 0.4 - 0.2;
        m.castShadow = m.receiveShadow = true;
        this.scene.add(m); this.collidables.push(m);
    }

    _pipes(x, z) {
        const grp = new THREE.Group();
        grp.position.set(x, 0, z);
        for (let i = 0; i < 3; i++) {
            const pipe = new THREE.Mesh(
                new THREE.CylinderGeometry(0.08, 0.08, 4, 8), this.materials.matMetal
            );
            pipe.position.set((i - 1) * 0.22, 2.8, 0); pipe.rotation.z = Math.PI / 2;
            pipe.castShadow = true; grp.add(pipe);
        }
        this.scene.add(grp);
    }

    _waterPuddle(x, z, w) {
        const m = new THREE.Mesh(new THREE.CircleGeometry(w / 2, 24), this.materials.matWater);
        m.rotation.x = -Math.PI / 2; m.position.set(x, 0.015, z); this.scene.add(m);
    }

    _sign(x, y, z, text, color, w, h) {
        color = color || '#c41e1e'; w = w || 2; h = h || 0.5;
        const tex = buildSignTexture(text, color);
        const m = new THREE.Mesh(
            new THREE.PlaneGeometry(w, h),
            new THREE.MeshStandardMaterial({
                map: tex, emissiveMap: tex, emissive: 0xffffff,
                emissiveIntensity: 0.5, roughness: 0.6, metalness: 0.1, side: THREE.DoubleSide
            })
        );
        m.position.set(x, y, z); this.scene.add(m);
    }

    _bed(x, z) {
        const frame = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.5, 2), this.materials.matMetal);
        frame.position.set(x, 0.25, z); frame.castShadow = frame.receiveShadow = true;
        this.scene.add(frame); this.collidables.push(frame);
        const sheet = new THREE.Mesh(
            new THREE.BoxGeometry(0.92, 0.08, 2.02),
            new THREE.MeshStandardMaterial({ color: 0x8a8276, roughness: 0.8 })
        );
        sheet.position.set(x, 0.55, z); this.scene.add(sheet);
    }

    _cabinet(x, z) {
        const m = new THREE.Mesh(
            new THREE.BoxGeometry(0.6, 1.8, 0.4),
            new THREE.MeshStandardMaterial({ color: 0x8a8276, roughness: 0.5, metalness: 0.5 })
        );
        m.position.set(x, 0.9, z); m.castShadow = m.receiveShadow = true;
        this.scene.add(m); this.collidables.push(m);
    }

    _note(x, y, z, label) {
        const tex = buildPaperTexture(label);
        const m = new THREE.Mesh(
            new THREE.PlaneGeometry(0.4, 0.55),
            new THREE.MeshStandardMaterial({ map: tex, roughness: 0.8, side: THREE.DoubleSide })
        );
        m.position.set(x, y, z);
        m.rotation.x = -Math.PI / 2 + 0.1;
        m.rotation.y = Math.random() * 0.2;
        this.scene.add(m);
        this.interactables.push({
            mesh: m, type: 'note', prompt: 'READ NOTE',
            data: { text: this._noteText(label) }, bobBase: y
        });
    }

    _noteText(label) {
        const lib = {
            'MEDICAL LOG':      'Day 41 — Subject 04 is no longer responsive to sedation. The neural rejection is accelerating. Recommend full quarantine. We should never have opened the containment.',
            'INVENTORY LOG':    'Day 39 — Three keycards reported missing. Storage now requires Security clearance only. If you find one, return to the office immediately.',
            'EXPERIMENT 07':    'Day 44 — The samples in tank C are moving on their own. Power fluctuations correlate with their activity. Cut power to the wing if anomaly persists.',
            'CLASSIFIED FILES': 'Day 47 — Files show 12 experiments. Only one subject remains. Do not open the security office door. They are not what they were.',
            'CASE FILE 07':     'Subject 07. Status: Escaped containment. Threat level: Extreme. Last seen: Main corridor. Do NOT engage directly.',
            'ADMIN MEMO':       'All staff must evacuate by 0300. Generator is failing. Security lockdown initiated. God help us.',
            'BREAK SCHEDULE':   'WEDNESDAY SHIFT: A team. Coffee machine is broken again. Generator room is off-limits until maintenance clears it.',
        };
        return lib[label] || 'The text is faded beyond reading.';
    }

    _toolbox(x, z) {
        const m = new THREE.Mesh(
            new THREE.BoxGeometry(0.5, 0.25, 0.3),
            new THREE.MeshStandardMaterial({ color: 0xc41e1e, roughness: 0.5, metalness: 0.5 })
        );
        m.position.set(x, 0.125, z); m.castShadow = true; this.scene.add(m);
        this.collidables.push(m);
    }

    _shelf(x, z) {
        const grp = new THREE.Group();
        grp.position.set(x, 0, z);
        for (let i = 0; i < 4; i++) {
            const shelf = new THREE.Mesh(
                new THREE.BoxGeometry(2.4, 0.05, 0.6),
                new THREE.MeshStandardMaterial({ color: 0x6e6258, roughness: 0.8 })
            );
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
        const top = new THREE.Mesh(
            new THREE.BoxGeometry(1.4, 0.06, 0.9),
            new THREE.MeshStandardMaterial({ color: 0xc8c2b4, roughness: 0.3, metalness: 0.3 })
        );
        top.position.set(x, 0.9, z); top.castShadow = top.receiveShadow = true;
        this.scene.add(top); this.collidables.push(top);
    }

    _cylinder(x, z) {
        const glass = new THREE.Mesh(
            new THREE.CylinderGeometry(0.3, 0.3, 1.6, 24, 1, true),
            new THREE.MeshStandardMaterial({
                color: 0x88ccaa, transparent: true, opacity: 0.35,
                roughness: 0.1, metalness: 0.1, side: THREE.DoubleSide
            })
        );
        glass.position.set(x, 1.8, z); this.scene.add(glass);
        const base = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.34, 0.15, 24), this.materials.matMetal);
        base.position.set(x, 1.0, z); this.scene.add(base);
        const top = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.34, 0.15, 24), this.materials.matMetal);
        top.position.set(x, 2.7, z); this.scene.add(top);
        const blob = new THREE.Mesh(
            new THREE.SphereGeometry(0.18, 16, 12),
            new THREE.MeshStandardMaterial({ color: 0x4fbc94, emissive: 0x4fbc94, emissiveIntensity: 1.4 })
        );
        blob.position.set(x, 1.4, z); this.scene.add(blob);
        this._light(0x4fbc94, 0.4, x, 1.4, z, 3, 2);
    }

    // ═══════════════════════════════════════════════════════════════
    // ATMOSPHERE — ambient light + dust + horror spotlights
    // ═══════════════════════════════════════════════════════════════
    _buildAtmosphere() {
        // Hemisphere: dim enough that the flashlight is still essential
        const hemi = new THREE.HemisphereLight(0x2a2a3a, 0x14100a, 0.5);
        this.scene.add(hemi);

        // Floating dust particles
        const count = 800;
        const geom  = new THREE.BufferGeometry();
        const positions = new Float32Array(count * 3);
        for (let i = 0; i < count; i++) {
            positions[i * 3 + 0] = (Math.random() - 0.5) * 80;
            positions[i * 3 + 1] = Math.random() * 3;
            positions[i * 3 + 2] = (Math.random() - 0.5) * 80;
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

        // Atmospheric horror spotlight along main spine corridor
        const spot = new THREE.SpotLight(0xffeebb, 0.6, 14, Math.PI / 5, 0.5, 1.6);
        spot.position.set(0, 3, 8);
        spot.target.position.set(0, 0, 8);
        spot.castShadow = true;
        spot.shadow.mapSize.set(256, 256);
        spot.shadow.bias = -0.002;
        this.scene.add(spot); this.scene.add(spot.target);
        this.flickerLights.push({ light: spot, base: 0.6, phase: 1.2, rate: 0.6, depth: 0.45 });
    }

    // ═══════════════════════════════════════════════════════════════
    // UPDATE LOOP — called every frame from game.js
    // ═══════════════════════════════════════════════════════════════
    update(dt, time) {
        // Generator power ramp — smooth fade over 3 seconds
        if (this._powerRamping) {
            const elapsed = (performance.now() - this._powerRampStart) / 1000;
            const t       = Math.min(1, elapsed / 3.0);
            const eased   = t * t * (3 - 2 * t); // smoothstep
            this.mainPowerLights.forEach((p, i) => {
                p.light.intensity = this._powerRampFrom[i] +
                    (this._powerRampTo[i] - this._powerRampFrom[i]) * eased;
            });
            if (t >= 1) this._powerRamping = false;
        }

        // Flicker lights
        this.flickerLights.forEach(f => {
            const v = Math.sin(time * f.rate * 8 + f.phase) * 0.4
                    + Math.sin(time * f.rate * 23 + f.phase * 2) * 0.3;
            const r = (Math.random() < 0.02 ? -0.7 : 0);
            f.light.intensity = Math.max(0, f.base * (1 + (v + r) * f.depth));
        });

        // Dust drift
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

        // Fan blades
        if (this._fanBlades) this._fanBlades.rotation.z += dt * (this.fanSpeed || 0.1);

        // Interactable bob + spin
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