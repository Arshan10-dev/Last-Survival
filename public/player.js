import * as THREE from 'three';

const PLAYER_RADIUS = 0.32;
const EYE_HEIGHT    = 1.7;
const WALK_SPEED    = 3.0;
const SPRINT_SPEED  = 5.2;

export class Player {
    constructor(camera, scene, world, audio) {
        this.camera = camera;
        this.scene  = scene;
        this.world  = world;
        this.audio  = audio;

        // ── Custom FPS look: yawObj rotates left/right, camera (child) pitches up/down ──
        // This completely prevents any roll/tilt — roll axis is NEVER touched.
        this.yawObj   = new THREE.Object3D();   // horizontal rotation container
        this.pitchObj = new THREE.Object3D();   // vertical rotation container (= camera parent)
        this.yawObj.add(this.pitchObj);
        this.pitchObj.add(camera);
        scene.add(this.yawObj);

        // Camera sits at eye level inside yawObj
        camera.position.set(0, 0, 0);
        this.yawObj.position.set(0, EYE_HEIGHT, 0);

        // Pitch limits (radians): no looking straight up/down (±80°)
        this._pitchMin = -Math.PI * 0.44;  // ~80° down
        this._pitchMax =  Math.PI * 0.44;  // ~80° up
        this._pitch = 0;  // current pitch angle
        this._yaw   = 0;  // current yaw angle

        // Pointer lock state
        this.isLocked = false;
        this._pointerSpeed = 0.002;
        this._initPointerLock();

        // Fake controls shim so game.js calling controls.getObject() / controls.lock() still works
        const self = this;
        this.controls = {
            getObject : ()  => self.yawObj,
            lock      : ()  => document.body.requestPointerLock(),
            unlock    : ()  => document.exitPointerLock(),
            addEventListener: (e, fn) => {
                if (e === 'lock')   self._onLockCbs.push(fn);
                if (e === 'unlock') self._onUnlockCbs.push(fn);
            },
            get isLocked() { return self.isLocked; },
            get pointerSpeed() { return self._pointerSpeed; },
            set pointerSpeed(v) { self._pointerSpeed = v; }
        };
        this._onLockCbs   = [];
        this._onUnlockCbs = [];

        // Player stats
        this.velocity = new THREE.Vector3();
        this.input    = { f: 0, b: 0, l: 0, r: 0, sprint: false };

        this.health    = 100; this.maxHealth  = 100;
        this.stamina   = 100; this.maxStamina = 100;
        this.battery   = 100; this.maxBattery = 100;

        this.dead       = false;
        this.lastStepT  = 0;
        this.bobT       = 0;
        this.bobEnabled = true;

        // Flashlight
        this.flashOn = false;
        // Wide soft flashlight — Granny style (no harsh circle edge)
        this.flash = new THREE.SpotLight(
            0xfff5e0,      // warm white
            0,             // starts off
            30,            // range (meters)
            Math.PI / 3.2, // wide ~56° cone
            0.88,          // penumbra: near 1 = very soft edge, no visible circle
            1.2            // decay
        );
        this.flash.castShadow = true;
        this.flash.shadow.mapSize.set(1024, 1024);
        this.flash.shadow.bias        = -0.002;
        this.flash.shadow.camera.near = 0.1;
        this.flash.shadow.camera.far  = 30;
        this.flash.shadow.camera.fov  = 65;
        this.flashTarget = new THREE.Object3D();
        camera.add(this.flash);
        camera.add(this.flashTarget);
        this.flash.position.set(0, -0.05, 0.05);
        this.flashTarget.position.set(0, 0, -1);
        this.flash.target = this.flashTarget;

        this._buildBeamCone();

        // Inventory
        this.inventory = new Set();
        this.facilityPowered = false;

        this._bindInput();
    }

    // ── Pointer Lock ──────────────────────────────────────────────────────────
    _initPointerLock() {
        document.addEventListener('pointerlockchange', () => {
            this.isLocked = document.pointerLockElement === document.body;
            if (this.isLocked)  this._onLockCbs.forEach(fn   => fn());
            else                this._onUnlockCbs.forEach(fn => fn());
        });

        document.addEventListener('mousemove', e => {
            if (!this.isLocked) return;
            // Yaw  = left/right (rotate yawObj around world Y)
            this._yaw -= e.movementX * this._pointerSpeed;
            // Pitch = up/down   (rotate pitchObj around local X) — CLAMPED
            this._pitch -= e.movementY * this._pointerSpeed;
            this._pitch  = Math.max(this._pitchMin, Math.min(this._pitchMax, this._pitch));

            // Apply — use Euler with 'YXZ' order so yaw never bleeds into roll
            this.yawObj.rotation.set(0, this._yaw, 0);
            this.pitchObj.rotation.set(this._pitch, 0, 0);
        });
    }

    // ── Beam cone (soft volumetric scatter — barely visible like real flashlight) ──
    _buildBeamCone() {
        const geo = new THREE.ConeGeometry(1.6, 8, 32, 1, true);
        const mat = new THREE.ShaderMaterial({
            transparent: true, depthWrite: false,
            blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
            uniforms: { uIntensity: { value: 0 } },
            vertexShader: `
                varying vec3 vP;
                void main(){
                    vP = position;
                    gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0);
                }`,
            fragmentShader: `
                varying vec3 vP;
                uniform float uIntensity;
                void main(){
                    // Very soft radial + length falloff — just a hint of volume
                    float r = length(vP.xz) / 1.6;
                    float radial = 1.0 - smoothstep(0.0, 1.0, r);
                    float along  = smoothstep(0.0, -6.0, vP.y) * (1.0 - smoothstep(-5.0, -8.0, vP.y));
                    float a      = radial * along * 0.06 * uIntensity;
                    gl_FragColor = vec4(1.0, 0.96, 0.88, a);
                }`
        });
        const cone = new THREE.Mesh(geo, mat);
        cone.rotation.x = -Math.PI / 2;
        cone.position.set(0, -0.08, -4);
        cone.frustumCulled = false;
        this.camera.add(cone);
        this._beamMat = mat;
    }

    // ── Spawn ─────────────────────────────────────────────────────────────────
    setSpawn(x, z) {
        this.yawObj.position.set(x, EYE_HEIGHT, z);
        this._yaw = 0; this._pitch = 0;
        this.yawObj.rotation.set(0, 0, 0);
        this.pitchObj.rotation.set(0, 0, 0);
        this.velocity.set(0, 0, 0);
    }

    // ── Input ─────────────────────────────────────────────────────────────────
    _bindInput() {
        const dn = {
            KeyW: () => this.input.f = 1, KeyS: () => this.input.b = 1,
            KeyA: () => this.input.l = 1, KeyD: () => this.input.r = 1,
            ShiftLeft: () => this.input.sprint = true,
            ShiftRight: () => this.input.sprint = true
        };
        const up = {
            KeyW: () => this.input.f = 0, KeyS: () => this.input.b = 0,
            KeyA: () => this.input.l = 0, KeyD: () => this.input.r = 0,
            ShiftLeft: () => this.input.sprint = false,
            ShiftRight: () => this.input.sprint = false
        };
        document.addEventListener('keydown', e => {
            if (e.repeat) return;
            if (dn[e.code]) dn[e.code]();
            if (e.code === 'KeyF') this.toggleFlash();
        });
        document.addEventListener('keyup', e => { if (up[e.code]) up[e.code](); });
    }

    toggleFlash() {
        if (this.battery <= 0) return;
        this.flashOn = !this.flashOn;
        this.flash.intensity = this.flashOn ? 14 : 0;
        this._beamMat.uniforms.uIntensity.value = this.flashOn ? 1.0 : 0;
        this.audio?.click();
    }

    takeDamage(amount) {
        if (this.dead) return;
        this.health = Math.max(0, this.health - amount);
        this.audio?.damageHit();
        if (this.health <= 0) this.dead = true;
    }

    // ── Collision ─────────────────────────────────────────────────────────────
    _collide(pos) {
        const r = PLAYER_RADIUS;
        // Player occupies roughly floor (y=0) to head height (~1.9m). Anything entirely
        // above or below this range (like a door header near the ceiling, or a floor
        // decal) should NOT block movement — only things the body actually intersects.
        const playerFeet = 0.05, playerHead = 1.9;
        const box = new THREE.Box3();
        for (const c of this.world.collidables) {
            box.setFromObject(c);
            // Y-axis check FIRST: skip entirely if there's no vertical overlap with the player's body
            if (box.max.y < playerFeet || box.min.y > playerHead) continue;

            const minX = box.min.x - r, maxX = box.max.x + r;
            const minZ = box.min.z - r, maxZ = box.max.z + r;
            if (pos.x > minX && pos.x < maxX && pos.z > minZ && pos.z < maxZ) {
                const dxL = pos.x - minX, dxR = maxX - pos.x;
                const dzL = pos.z - minZ, dzR = maxZ - pos.z;
                const m   = Math.min(dxL, dxR, dzL, dzR);
                if      (m === dxL) pos.x = minX;
                else if (m === dxR) pos.x = maxX;
                else if (m === dzL) pos.z = minZ;
                else                pos.z = maxZ;
            }
        }
        return pos;
    }

    // ── Update ────────────────────────────────────────────────────────────────
    update(dt, time) {
        if (!this.isLocked) return;
        if (this.dead) {
            this._beamMat.uniforms.uIntensity.value *= (1 - dt * 4);
            return;
        }

        // Movement direction (camera-forward projected onto XZ)
        const fwd   = new THREE.Vector3();
        this.camera.getWorldDirection(fwd); fwd.y = 0; fwd.normalize();
        const right = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0,1,0)).normalize();
        const dir   = new THREE.Vector3();
        if (this.input.f) dir.add(fwd);
        if (this.input.b) dir.sub(fwd);
        if (this.input.r) dir.add(right);
        if (this.input.l) dir.sub(right);
        if (dir.lengthSq() > 0) dir.normalize();

        const sprinting = this.input.sprint && this.stamina > 1 && dir.lengthSq() > 0;
        const speed     = sprinting ? SPRINT_SPEED : WALK_SPEED;
        const target    = dir.multiplyScalar(speed);

        this.velocity.x += (target.x - this.velocity.x) * Math.min(1, dt * 10);
        this.velocity.z += (target.z - this.velocity.z) * Math.min(1, dt * 10);

        // Position is stored on yawObj (the root)
        const pos  = this.yawObj.position;
        const next = new THREE.Vector3(
            pos.x + this.velocity.x * dt,
            EYE_HEIGHT,
            pos.z + this.velocity.z * dt
        );
        this._collide(next);
        next.x = Math.max(-44, Math.min(40, next.x));
        next.z = Math.max(-44, Math.min(36, next.z));
        pos.copy(next);

        // Head bob — only Y offset on pitchObj, NEVER touch rotation.z
        const moving = dir.lengthSq() > 0.01 &&
                       (Math.abs(this.velocity.x) + Math.abs(this.velocity.z)) > 0.4;
        if (moving) this.bobT += dt * (sprinting ? 11 : 7);
        else        this.bobT *= 0.92;
        if (this.bobEnabled) {
            this.pitchObj.position.y = Math.sin(this.bobT) * (sprinting ? 0.06 : 0.035);
        }

        // Footsteps
        if (moving) {
            const interval = sprinting ? 0.32 : 0.48;
            if (time - this.lastStepT > interval) {
                this.audio?.footstep(sprinting ? 1.2 : 1.0);
                this.lastStepT = time;
            }
        }

        // Stamina
        if (sprinting && moving) this.stamina = Math.max(0, this.stamina - dt * 22);
        else                     this.stamina = Math.min(this.maxStamina, this.stamina + dt * 14);

        // Battery (disabled for now)
        // if (this.flashOn) this.battery = Math.max(0, this.battery - dt * 1.6);
        if (this.flashOn && this.battery <= 0) { this.flashOn = false; }

        // Flashlight intensity
        const targetI = this.flashOn ? 14 : 0;
        this.flash.intensity = targetI;
        this._beamMat.uniforms.uIntensity.value +=
            ((this.flashOn ? 1.0 : 0) - this._beamMat.uniforms.uIntensity.value) * 0.4;

        // Slow health regen
        if (this.health < this.maxHealth)
            this.health = Math.min(this.maxHealth, this.health + dt * 0.7);
    }
}