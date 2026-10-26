// Simulation de tournée : une position qui avance seule le long du trajet de l'arrêt en cours (navigation), à la
// vitesse du mode, s'arrête le temps de service prévu à chaque arrêt, puis le sert (statuts en mémoire seulement).
// Pause, vitesse ×1 / ×2 / ×4 / ×8. La position passe par gps.simulate, comme celle du panneau debug : la navigation,
// les alertes des repères et le point sur le plan réagissent comme avec le vrai GPS.

import { pointAlong } from './guidance.js';

const $ = (id) => document.getElementById(id);
const TICK_MS = 200;
export const SPEEDS = [1, 2, 4, 8];
const KMH = { car: 30, bike: 15 };  // vitesse moyenne simulée (à pied : vitesse de marche des réglages)

export class Simulator {
  constructor(nav) {
    this.nav = nav;
    this.speed = 1;
    this.factor = 1;      // multiplicateur supplémentaire (tests)
    this.playing = false;
    this.timer = null;
    this.legRef = null;
    this.d = 0;
    this.dwell = 0;       // secondes de service restantes à l'arrêt
    this.servedK = -1;
    const st = nav.plan.ctx.st;
    this.mps = (nav.mode === 'foot' ? st.walkKmh : nav.mode === 'bike' ? st.bikeKmh || KMH.bike : KMH.car) / 3.6;
    this._render();
  }

  // départ : à l'arrêt précédent (ou au point de départ, ou sur l'arrêt lui-même), puis lecture
  start(k) {
    const { stops, plan } = this.nav;
    const from = stops[k - 1] || plan.ctx.st.start || stops[k];
    this.jump(from.x, from.y);
    this.play();
  }

  jump(x, y) {
    this.resetLeg();
    this._emit(x, y);
  }

  resetLeg() {
    this.legRef = null;
    this.d = 0;
    this.dwell = 0;
    this.servedK = -1;
  }

  play() {
    if (this.playing) return;
    this.playing = true;
    this.last = performance.now();
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this._render();
  }

  pause() {
    this.playing = false;
    clearInterval(this.timer);
    this.timer = null;
    this._render();
  }

  toggle() {
    if (this.playing) this.pause();
    else this.play();
  }

  cycleSpeed() {
    this.speed = SPEEDS[(SPEEDS.indexOf(this.speed) + 1) % SPEEDS.length];
    this._render();
  }

  stop() {
    this.pause();
  }

  tick() {
    const nav = this.nav;
    if (!nav.active || !nav.sim) {
      this.stop();
      return;
    }
    const now = performance.now();
    const dt = ((now - this.last) / 1000) * this.speed * this.factor;
    this.last = now;
    const k = nav.k;
    const stop = nav.stops[k];
    if (this.servedK === k) return;  // arrêt servi : la navigation passe au suivant
    if (this.dwell > 0) {            // à l'arrêt : temps de service
      this.dwell -= dt;
      if (this.dwell <= 0) {
        this.servedK = k;
        nav.simServe();
      }
      return;
    }
    const leg = nav.leg;
    if (!leg) {  // pas de trajet (arrêt atteint, ou premier arrêt sans point de départ) : on y est
      this._emit(stop.x, stop.y);
      this._arrive(stop);
      return;
    }
    if (leg !== this.legRef) {
      this.legRef = leg;
      this.d = 0;
    }
    this.d += this.mps * dt;
    if (this.d >= leg.total) {
      const p = leg.pts[leg.pts.length - 1];
      this._emit(p.x, p.y);
      this._arrive(stop);
    } else {
      const p = pointAlong(leg, this.d);
      this._emit(p.x, p.y);
    }
  }

  _arrive(stop) {
    if (this.dwell > 0) return;
    this.dwell = Math.max(1, stop.service || 1);
  }

  _emit(x, y) {
    this.nav.app.gps.simulate(x, y, 5);
  }

  _render() {
    $('sim-play').setAttribute('aria-label', this.playing ? 'Pause' : 'Lecture');
    $('sim-play').dataset.playing = String(this.playing);
    $('sim-speed').textContent = `×${this.speed}`;
    $('sim-speed').setAttribute('aria-label', `Vitesse ×${this.speed} (toucher pour changer)`);
  }
}
