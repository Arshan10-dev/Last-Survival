const STATE = { IDLE: 'IDLE', PATROL: 'PATROL', SEARCH: 'SEARCH', CHASE: 'CHASE', LOST: 'LOST' };
import * as THREE from 'three';

export class Creature {
  constructor(scene, world, audio) {
    this.scene = scene;
    this.world = world;
    this.audio = audio;
    this.state = STATE.PATROL;
    this.alive = true;
    this.speedPatrol = 1.3;
    this.speedChase = 4.2;
    this.detectionRadius = 9;
    this.peripheralAngle = Math.PI / 2.2;
    this.lastSeen = null;
    this.lastSeenT = -10;
    this.idleT = 0;
    this.target = new THREE.Vector3();
    this.growlT = 0;
    this.attackCooldown = 0;

    this._buildMesh();
    this._setupPatrol();
    this.setSpawn(-22, -22);
  }

  _buildMesh() {
    const grp = new THREE.Group();
    // body — elongated organic shape (capsule + pulsing emissive cores)
    const bodyGeo = new THREE.CapsuleGeometry(0.45, 1.1, 6, 12);
    const bodyMat = new THREE.MeshStandardMaterial({
      color: 0x1a0a0a, roughness: 0.85, metalness: 0.1,
      emissive: 0x4a0808, emissiveIntensity: 0.4
    });
    const body = new THREE.Mesh(bodyGeo, bodyMat);
    body.position.y = 1.0; body.castShadow = true;
    grp.add(body);
    // head — elongated forward
    const headGeo = new THREE.SphereGeometry(0.4, 16, 12);
    const head = new THREE.Mesh(headGeo, bodyMat);
    head.scale.set(1.2, 0.7, 1.6);
    head.position.set(0, 1.55, 0.5);
    head.castShadow = true; grp.add(head);
    // glowing eyes (two)
    const eyeMat = new THREE.MeshStandardMaterial({ color: 0xc41e1e, emissive: 0xff3333, emissiveIntensity: 3.0 });
    const eyeGeo = new THREE.SphereGeometry(0.06, 8, 6);
    const eL = new THREE.Mesh(eyeGeo, eyeMat); eL.position.set(-0.13, 1.62, 0.95); grp.add(eL);
    const eR = new THREE.Mesh(eyeGeo, eyeMat); eR.position.set( 0.13, 1.62, 0.95); grp.add(eR);
    this.eyes = [eL, eR];
    // limbs
    const limbMat = bodyMat.clone(); limbMat.color = new THREE.Color(0x0a0303);
    const armGeo = new THREE.CylinderGeometry(0.08, 0.12, 1.4, 8);
    const a1 = new THREE.Mesh(armGeo, limbMat); a1.position.set(-0.5, 0.7, 0.2); a1.rotation.z = 0.4; grp.add(a1);
    const a2 = new THREE.Mesh(armGeo, limbMat); a2.position.set( 0.5, 0.7, 0.2); a2.rotation.z = -0.4; grp.add(a2);
    // small point light from eyes
    this.eyeLight = new THREE.PointLight(0xff2222, 0.6, 4, 2);
    this.eyeLight.position.set(0, 1.62, 0.95);
    grp.add(this.eyeLight);

    this.mesh = grp;
    this.body = body; this.head = head;
    this.scene.add(grp);
  }

  setSpawn(x, z) {
    this.mesh.position.set(x, 0, z);
  }

  _setupPatrol() {
    // Patrol waypoints matching corrected room centers
    this.waypoints = [
      new THREE.Vector3(-22,   0,  10),   // west branch top
      new THREE.Vector3(-28.8, 0,   6),   // Security Office
      new THREE.Vector3(-28.8, 0,  -2),   // Medical Bay
      new THREE.Vector3(-22,   0,  -5),   // west branch mid
      new THREE.Vector3(-28.8, 0, -10),   // Maintenance
      new THREE.Vector3(-28.8, 0, -18),   // Server Room
      new THREE.Vector3(-22,   0, -27),   // bridge
      new THREE.Vector3(-9,    0, -34),   // north connector
      new THREE.Vector3(4,     0, -27),   // east bridge
      new THREE.Vector3(10.8,  0, -18),   // Ventilation
      new THREE.Vector3(10.8,  0, -10),   // Generator
      new THREE.Vector3(4,     0,  -5),   // east branch mid
      new THREE.Vector3(10.8,  0,   6),   // Storage
      new THREE.Vector3(4,     0,  10),   // east branch top
      new THREE.Vector3(-5,    0,  14),   // main corridor center
    ];
    this.waypointIndex = 0;
    this.target.copy(this.waypoints[0]);
  }

  // can creature see player?
  _canSeePlayer(playerPos, flashlightOn, camDir) {
    const dx = playerPos.x - this.mesh.position.x;
    const dz = playerPos.z - this.mesh.position.z;
    const dist = Math.sqrt(dx*dx + dz*dz);

    let effectiveRadius = this.detectionRadius;
    // Flashlight pointed at creature increases detection (reacts to light)
    if (flashlightOn) {
      const toCreature = new THREE.Vector3(-dx, 0, -dz).normalize();
      const camDirXZ = new THREE.Vector3(camDir.x, 0, camDir.z).normalize();
      const dot = camDirXZ.dot(toCreature);
      if (dot > 0.85) effectiveRadius += 6; // beam hits creature
    }

    if (dist > effectiveRadius) return false;

    // line of sight raycast against world collidables (walls)
    const origin = this.mesh.position.clone(); origin.y = 1.5;
    const dir = playerPos.clone(); dir.y = 1.6;
    dir.sub(origin); const d = dir.length(); dir.normalize();
    const ray = new THREE.Raycaster(origin, dir, 0.2, d);
    const hits = ray.intersectObjects(this.world.collidables, false);
    return hits.length === 0;
  }

  // hearing: if player sprints close, alert
  _heardPlayer(playerPos, playerSprinting) {
    const dx = playerPos.x - this.mesh.position.x;
    const dz = playerPos.z - this.mesh.position.z;
    const dist = Math.sqrt(dx*dx + dz*dz);
    if (playerSprinting && dist < 14) return true;
    if (dist < 5) return true;
    return false;
  }

  // move toward target with simple steering + collision avoidance against walls
  _stepToward(targetPos, speed, dt) {
    const myPos = this.mesh.position;
    const dx = targetPos.x - myPos.x;
    const dz = targetPos.z - myPos.z;
    const d = Math.sqrt(dx*dx + dz*dz);
    if (d < 0.05) return true;
    const vx = (dx / d) * speed;
    const vz = (dz / d) * speed;
    const next = new THREE.Vector3(myPos.x + vx * dt, 0, myPos.z + vz * dt);

    // wall avoidance: check small forward radius
    const r = 0.4;
    const aabb = new THREE.Box3();
    for (const c of this.world.collidables) {
      aabb.setFromObject(c);
      if (next.x > aabb.min.x - r && next.x < aabb.max.x + r &&
          next.z > aabb.min.z - r && next.z < aabb.max.z + r) {
        // push out
        const dxL = next.x - (aabb.min.x - r), dxR = (aabb.max.x + r) - next.x;
        const dzL = next.z - (aabb.min.z - r), dzR = (aabb.max.z + r) - next.z;
        const m = Math.min(dxL, dxR, dzL, dzR);
        if (m === dxL) next.x = aabb.min.x - r;
        else if (m === dxR) next.x = aabb.max.x + r;
        else if (m === dzL) next.z = aabb.min.z - r;
        else next.z = aabb.max.z + r;
      }
    }
    myPos.x = next.x; myPos.z = next.z;
    // face direction of motion
    const desiredYaw = Math.atan2(dx, dz);
    let dy = desiredYaw - this.mesh.rotation.y;
    while (dy > Math.PI) dy -= Math.PI * 2;
    while (dy < -Math.PI) dy += Math.PI * 2;
    this.mesh.rotation.y += dy * Math.min(1, dt * 6);
    return d < 0.4;
  }

  update(dt, time, player) {
    if (!this.alive) return;
    const playerPos = player.controls.getObject().position;
    const camDir = new THREE.Vector3();
    player.camera.getWorldDirection(camDir);

    const sees = this._canSeePlayer(playerPos, player.flashOn, camDir);
    const heard = this._heardPlayer(playerPos, player.input.sprint && (player.input.f || player.input.b || player.input.l || player.input.r));

    if (sees) {
      this.lastSeen = playerPos.clone();
      this.lastSeenT = time;
      this.state = STATE.CHASE;
    } else if (heard && this.state !== STATE.CHASE) {
      this.lastSeen = playerPos.clone();
      this.lastSeenT = time;
      this.state = STATE.SEARCH;
    }

    // pulse eyes (intensity based on state)
    const eyeBase = this.state === STATE.CHASE ? 5.0 : this.state === STATE.SEARCH ? 3.0 : 2.0;
    const flick = (Math.sin(time * 6) * 0.5 + 0.5);
    this.eyes.forEach(e => e.material.emissiveIntensity = eyeBase * (0.7 + 0.3 * flick));
    this.eyeLight.intensity = this.state === STATE.CHASE ? 1.2 : 0.5;

    // periodic growl based on distance
    this.growlT += dt;
    if (this.growlT > 6 + Math.random() * 4) {
      const dx = playerPos.x - this.mesh.position.x;
      const dz = playerPos.z - this.mesh.position.z;
      const dist = Math.sqrt(dx*dx + dz*dz);
      const dir = Math.atan2(dx, dz);
      const pan = Math.sin(dir - player.camera.rotation.y);
      this.audio?.creatureGrowl(dist, pan);
      this.growlT = 0;
    }

    switch (this.state) {
      case STATE.PATROL: {
        const arrived = this._stepToward(this.waypoints[this.waypointIndex], this.speedPatrol, dt);
        if (arrived) {
          this.waypointIndex = (this.waypointIndex + 1) % this.waypoints.length;
          this.target.copy(this.waypoints[this.waypointIndex]);
        }
        break;
      }
      case STATE.SEARCH: {
        if (!this.lastSeen) { this.state = STATE.PATROL; break; }
        const arrived = this._stepToward(this.lastSeen, this.speedPatrol * 1.3, dt);
        if (arrived) {
          this.idleT += dt;
          if (this.idleT > 4) {
            this.state = STATE.LOST;
            this.idleT = 0;
          }
        }
        break;
      }
      case STATE.CHASE: {
        this._stepToward(playerPos, this.speedChase, dt);
        // attack if close
        const dx = playerPos.x - this.mesh.position.x;
        const dz = playerPos.z - this.mesh.position.z;
        const dist = Math.sqrt(dx*dx + dz*dz);
        this.attackCooldown -= dt;
        if (dist < 1.4 && this.attackCooldown <= 0) {
          player.takeDamage(18);
          this.attackCooldown = 1.2;
          if (player.health <= 0) player.dead = true;
        }
        // lose sight
        if (!sees && time - this.lastSeenT > 3.5) {
          this.state = STATE.SEARCH;
        }
        break;
      }
      case STATE.LOST: {
        this.idleT += dt;
        // wander toward nearest waypoint
        let best = 0, bestDist = Infinity;
        this.waypoints.forEach((w, i) => {
          const d = w.distanceTo(this.mesh.position);
          if (d < bestDist) { bestDist = d; best = i; }
        });
        this.waypointIndex = best;
        if (this.idleT > 2) { this.state = STATE.PATROL; this.idleT = 0; }
        break;
      }
      case STATE.IDLE: {
        this.idleT += dt;
        if (this.idleT > 2) { this.state = STATE.PATROL; this.idleT = 0; }
        break;
      }
    }

    // head sway (organic life)
    this.head.position.y = 1.55 + Math.sin(time * 3) * 0.04;
    this.body.rotation.x = Math.sin(time * 4) * 0.05;
  }
}