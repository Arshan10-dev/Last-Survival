export class AudioSystem {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.musicGain = null;
    this.sfxGain = null;
    this.listener = null;
    this.ambienceNodes = [];
    this.heartbeatTimer = 0;
    this.heartbeatRate = 0;
    this.creaturePanner = null;
    this.creatureGain = null;
    this.creatureOsc = null;
    this.lastFootstep = 0;
    this.muted = false;
    this.masterVol = 0.8;
  }

  async init() {
    if (this.ctx) return;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    this.ctx = new Ctx();
    this.master = this.ctx.createGain();
    this.master.gain.value = this.masterVol;
    this.master.connect(this.ctx.destination);

    // separate gains for ambience vs sfx
    this.musicGain = this.ctx.createGain(); this.musicGain.gain.value = 0.45;
    this.sfxGain = this.ctx.createGain(); this.sfxGain.gain.value = 0.85;
    this.musicGain.connect(this.master);
    this.sfxGain.connect(this.master);
  }

  resume() { if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume(); }

  setVolume(v) {
    this.masterVol = v;
    if (this.master) this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.1);
  }

  // ----- ambience: deep drone + sub rumble + wind whistle
  startAmbience() {
    if (!this.ctx) return;
    const ctx = this.ctx;

    // sub rumble
    const sub = ctx.createOscillator(); sub.type = 'sine'; sub.frequency.value = 42;
    const subGain = ctx.createGain(); subGain.gain.value = 0.18;
    sub.connect(subGain).connect(this.musicGain);
    sub.start();

    // detuned drone
    const drone1 = ctx.createOscillator(); drone1.type = 'sawtooth'; drone1.frequency.value = 78;
    const drone2 = ctx.createOscillator(); drone2.type = 'sawtooth'; drone2.frequency.value = 79.4;
    const droneFilter = ctx.createBiquadFilter(); droneFilter.type = 'lowpass'; droneFilter.frequency.value = 280; droneFilter.Q.value = 6;
    const droneGain = ctx.createGain(); droneGain.gain.value = 0.06;
    drone1.connect(droneFilter); drone2.connect(droneFilter);
    droneFilter.connect(droneGain).connect(this.musicGain);
    drone1.start(); drone2.start();

    // wind: filtered noise
    const noiseBuf = this._noiseBuffer(4);
    const wind = ctx.createBufferSource(); wind.buffer = noiseBuf; wind.loop = true;
    const windFilter = ctx.createBiquadFilter(); windFilter.type = 'bandpass'; windFilter.frequency.value = 600; windFilter.Q.value = 1.2;
    const windGain = ctx.createGain(); windGain.gain.value = 0.04;
    wind.connect(windFilter).connect(windGain).connect(this.musicGain);
    wind.start();

    // slow LFO modulating wind/drone for unease
    const lfo = ctx.createOscillator(); lfo.frequency.value = 0.07;
    const lfoGain = ctx.createGain(); lfoGain.gain.value = 220;
    lfo.connect(lfoGain).connect(windFilter.frequency);
    lfo.start();

    this.ambienceNodes.push(sub, drone1, drone2, wind, lfo);
  }

  // ----- footstep: short pink-noise burst with low filter (concrete)
  footstep(intensity = 1) {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    const dur = 0.18;
    const buf = this._noiseBuffer(dur);
    const src = this.ctx.createBufferSource(); src.buffer = buf;
    const filt = this.ctx.createBiquadFilter(); filt.type = 'lowpass'; filt.frequency.value = 480 + Math.random() * 200; filt.Q.value = 0.9;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0, now);
    g.gain.linearRampToValueAtTime(0.22 * intensity, now + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, now + dur);
    src.connect(filt).connect(g).connect(this.sfxGain);
    src.start(now); src.stop(now + dur);
  }

  // ----- flashlight click: short triangle/noise blip
  click() {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator(); osc.type = 'triangle'; osc.frequency.value = 1800;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.2, now);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.05);
    osc.connect(g).connect(this.sfxGain);
    osc.start(now); osc.stop(now + 0.06);
  }

  // ----- door creak: filtered noise with pitch sweep
  doorCreak() {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    const dur = 1.4;
    const buf = this._noiseBuffer(dur);
    const src = this.ctx.createBufferSource(); src.buffer = buf;
    const filt = this.ctx.createBiquadFilter(); filt.type = 'bandpass'; filt.Q.value = 8;
    filt.frequency.setValueAtTime(220, now);
    filt.frequency.exponentialRampToValueAtTime(800, now + dur * 0.6);
    filt.frequency.exponentialRampToValueAtTime(180, now + dur);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0, now);
    g.gain.linearRampToValueAtTime(0.18, now + 0.05);
    g.gain.linearRampToValueAtTime(0.04, now + dur * 0.7);
    g.gain.linearRampToValueAtTime(0, now + dur);
    src.connect(filt).connect(g).connect(this.sfxGain);
    src.start(now); src.stop(now + dur);
  }

  // ----- door slam: low thud
  doorSlam() {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator(); osc.type = 'sine'; osc.frequency.value = 90;
    const osc2 = this.ctx.createOscillator(); osc2.type = 'triangle'; osc2.frequency.value = 60;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.6, now);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.35);
    osc.connect(g); osc2.connect(g); g.connect(this.sfxGain);
    osc.frequency.exponentialRampToValueAtTime(40, now + 0.3);
    osc.start(now); osc2.start(now); osc.stop(now + 0.35); osc2.stop(now + 0.35);
  }

  // ----- generator hum loop (toggle on/off)
  startGeneratorHum() {
    if (!this.ctx || this._genHum) return;
    const ctx = this.ctx;
    const o1 = ctx.createOscillator(); o1.type = 'sawtooth'; o1.frequency.value = 60;
    const o2 = ctx.createOscillator(); o2.type = 'square'; o2.frequency.value = 120;
    const filt = ctx.createBiquadFilter(); filt.type = 'lowpass'; filt.frequency.value = 380; filt.Q.value = 2;
    const g = ctx.createGain(); g.gain.value = 0;
    o1.connect(filt); o2.connect(filt); filt.connect(g).connect(this.sfxGain);
    o1.start(); o2.start();
    g.gain.linearRampToValueAtTime(0.05, ctx.currentTime + 1.2);
    this._genHum = { o1, o2, g };
  }
  stopGeneratorHum() {
    if (!this._genHum) return;
    const { o1, o2, g } = this._genHum;
    g.gain.linearRampToValueAtTime(0, this.ctx.currentTime + 0.4);
    setTimeout(() => { o1.stop(); o2.stop(); }, 500);
    this._genHum = null;
  }

  // ----- creature distant breath / growl, panned by relative position
  creatureGrowl(distance, direction) {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    const dur = 1.6 + Math.random() * 0.8;
    const buf = this._noiseBuffer(dur);
    const src = this.ctx.createBufferSource(); src.buffer = buf;
    const filt = this.ctx.createBiquadFilter(); filt.type = 'lowpass';
    filt.frequency.setValueAtTime(180 + Math.random() * 80, now);
    filt.Q.value = 4;
    const panner = this.ctx.createStereoPanner();
    panner.pan.value = Math.max(-1, Math.min(1, direction));
    const g = this.ctx.createGain();
    const vol = Math.max(0.02, Math.min(0.45, 8 / (distance + 4)));
    g.gain.setValueAtTime(0, now);
    g.gain.linearRampToValueAtTime(vol, now + 0.4);
    g.gain.linearRampToValueAtTime(vol * 0.6, now + dur * 0.5);
    g.gain.linearRampToValueAtTime(0, now + dur);
    // sub oscillator beneath
    const sub = this.ctx.createOscillator(); sub.type = 'sine';
    sub.frequency.setValueAtTime(55 + Math.random() * 20, now);
    sub.frequency.linearRampToValueAtTime(38, now + dur);
    const subG = this.ctx.createGain();
    subG.gain.setValueAtTime(0, now);
    subG.gain.linearRampToValueAtTime(vol * 0.7, now + 0.5);
    subG.gain.linearRampToValueAtTime(0, now + dur);
    src.connect(filt).connect(g).connect(panner).connect(this.sfxGain);
    sub.connect(subG).connect(panner);
    src.start(now); src.stop(now + dur);
    sub.start(now); sub.stop(now + dur);
  }

  // ----- whisper (rare horror event): high band-passed noise with pitch wobble
  whisper(direction = 0) {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    const dur = 1.2 + Math.random() * 1.4;
    const buf = this._noiseBuffer(dur);
    const src = this.ctx.createBufferSource(); src.buffer = buf;
    const filt = this.ctx.createBiquadFilter(); filt.type = 'bandpass';
    filt.frequency.value = 1400 + Math.random() * 600; filt.Q.value = 7;
    const lfo = this.ctx.createOscillator(); lfo.frequency.value = 4 + Math.random() * 3;
    const lfoGain = this.ctx.createGain(); lfoGain.gain.value = 600;
    lfo.connect(lfoGain).connect(filt.frequency);
    const panner = this.ctx.createStereoPanner();
    panner.pan.value = Math.max(-1, Math.min(1, direction));
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0, now);
    g.gain.linearRampToValueAtTime(0.07, now + 0.3);
    g.gain.linearRampToValueAtTime(0, now + dur);
    src.connect(filt).connect(g).connect(panner).connect(this.sfxGain);
    src.start(now); src.stop(now + dur); lfo.start(now); lfo.stop(now + dur);
  }

  // ----- damage hit
  damageHit() {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    const buf = this._noiseBuffer(0.25);
    const src = this.ctx.createBufferSource(); src.buffer = buf;
    const filt = this.ctx.createBiquadFilter(); filt.type = 'lowpass'; filt.frequency.value = 600;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.5, now);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.25);
    src.connect(filt).connect(g).connect(this.sfxGain);
    src.start(now); src.stop(now + 0.25);
    // tinnitus ring
    const ring = this.ctx.createOscillator(); ring.type = 'sine'; ring.frequency.value = 4400;
    const rg = this.ctx.createGain();
    rg.gain.setValueAtTime(0.08, now);
    rg.gain.exponentialRampToValueAtTime(0.001, now + 0.9);
    ring.connect(rg).connect(this.sfxGain);
    ring.start(now); ring.stop(now + 0.9);
  }

  // ----- keycard pickup chime
  pickup() {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    const o1 = this.ctx.createOscillator(); o1.type = 'sine'; o1.frequency.value = 880;
    const o2 = this.ctx.createOscillator(); o2.type = 'sine'; o2.frequency.value = 1320;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0, now);
    g.gain.linearRampToValueAtTime(0.18, now + 0.02);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.5);
    o1.connect(g); o2.connect(g); g.connect(this.sfxGain);
    o1.start(now); o2.start(now + 0.08);
    o1.stop(now + 0.5); o2.stop(now + 0.5);
  }

  // ----- ui blip
  uiBlip() {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    const o = this.ctx.createOscillator(); o.type = 'square'; o.frequency.value = 600;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.08, now);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.08);
    o.connect(g).connect(this.sfxGain);
    o.start(now); o.stop(now + 0.09);
  }

  // ----- heartbeat (when low HP / chased)
  heartbeat(intensity = 1) {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    const o = this.ctx.createOscillator(); o.type = 'sine'; o.frequency.value = 72;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.5 * intensity, now);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.25);
    o.connect(g).connect(this.sfxGain);
    o.frequency.exponentialRampToValueAtTime(45, now + 0.25);
    o.start(now); o.stop(now + 0.25);
  }

  // ----- helpers
  _noiseBuffer(seconds) {
    const sr = this.ctx.sampleRate;
    const buf = this.ctx.createBuffer(1, seconds * sr, sr);
    const data = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < data.length; i++) {
      // pink-ish noise via simple IIR
      const white = Math.random() * 2 - 1;
      last = (last + white * 0.05) * 0.97;
      data[i] = last + white * 0.3;
    }
    return buf;
  }
}