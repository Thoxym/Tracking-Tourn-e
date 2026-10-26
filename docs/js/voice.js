// Consignes vocales (navigation) : synthèse vocale du système (speechSynthesis), en français, sans réseau (voix de
// l'iPhone). iOS n'autorise la parole qu'après un geste : la première annonce part du toucher sur « Démarrer ».
// Préférence d'appareil : voix activée ou coupée.
// Voix locales seulement : certaines voix de navigateur (Chrome de bureau) sont synthétisées sur un serveur, et les
// annonces contiennent des adresses et les notes des repères. Sans voix française locale, pas de consigne vocale.

const KEY = 'neyron-tournees.voice';

export class Voice {
  constructor() {
    this.synth = typeof window !== 'undefined' && window.speechSynthesis ? window.speechSynthesis : null;
    this.voice = null;
    this.spoken = [];  // dernières annonces (diagnostic, tests)
    let pref = null;
    try { pref = localStorage.getItem(KEY); } catch { /* stockage indisponible */ }
    this.enabled = pref !== 'off';
    if (this.synth) {
      this.pick();
      this.synth.addEventListener?.('voiceschanged', () => this.pick());
    }
  }

  // voix française locale (jamais une voix synthétisée sur un serveur)
  pick() {
    const voices = this.synth?.getVoices() || [];
    this.listed = voices.length > 0;
    const local = voices.filter((v) => v.localService);
    this.voice = local.find((v) => v.lang === 'fr-FR') || local.find((v) => /^fr/i.test(v.lang || '')) || null;
  }

  // liste des voix pas encore chargée : voix par défaut du système (Safari : toujours locale)
  get supported() {
    return Boolean(this.synth) && typeof window.SpeechSynthesisUtterance === 'function' && (Boolean(this.voice) || !this.listed);
  }

  setEnabled(on) {
    this.enabled = on;
    try { localStorage.setItem(KEY, on ? 'on' : 'off'); } catch { /* préférence valable pour la session */ }
    if (!on) this.synth?.cancel();
  }

  // interrupt : la nouvelle consigne remplace celle en cours (une consigne périmée ne doit pas traîner)
  say(text, { interrupt = false } = {}) {
    if (!text || !this.enabled || !this.supported) return false;
    if (interrupt) this.synth.cancel();
    const u = new window.SpeechSynthesisUtterance(text);
    u.lang = 'fr-FR';
    if (this.voice) u.voice = this.voice;
    this.synth.speak(u);
    this.spoken.push(text);
    if (this.spoken.length > 50) this.spoken.shift();
    return true;
  }

  stop() {
    this.synth?.cancel();
  }
}
