// Écran allumé (Screen Wake Lock) : demandé sur action de l'utilisateur, relâché par le système quand
// la page est masquée, redemandé au retour au premier plan tant que le bouton est actif.

const $ = (id) => document.getElementById(id);
export const FALLBACK_HINT = 'Réglez Verrouillage auto sur Jamais pendant la tournée (Réglages › Luminosité et affichage).';

export class WakeLockController {
  constructor({ ui }) {
    this.ui = ui;
    this.supported = typeof navigator.wakeLock?.request === 'function';
    this.wanted = false;     // choix de l'utilisateur
    this.sentinel = null;    // verrou effectivement tenu
    this.lastError = null;
    this.acquisitions = 0;
    this.hinted = false;
    this._retryOnTouch = () => {
      document.removeEventListener('pointerdown', this._retryOnTouch, true);
      if (this.wanted && !this.sentinel) this._acquire(false);
    };
    $('btn-wake').addEventListener('click', () => this.toggle());
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && this.wanted && !this.sentinel) this._acquire(false);
    });
    this._apply();
  }

  get active() {
    return Boolean(this.sentinel);
  }

  // état lisible pour le panneau debug
  get state() {
    if (!this.supported) return 'non supporté';
    if (this.sentinel) return 'actif';
    if (this.wanted) return `demandé, non tenu${this.lastError ? ` (${this.lastError.name})` : ''}`;
    return this.lastError ? `inactif (dernier refus : ${this.lastError.name})` : 'inactif';
  }

  toggle() {
    if (this.wanted) this.disable();
    else this.enable();
  }

  async enable() {
    if (!this.supported) {
      this.ui.toast(`Écran allumé indisponible sur cet appareil. ${FALLBACK_HINT}`, { ms: 8000 });
      return false;
    }
    this.wanted = true;
    const ok = await this._acquire(true);
    if (!ok) {
      this.wanted = false;
      this.ui.toast(`Écran allumé refusé (${this.lastError?.name || 'erreur'}). ${FALLBACK_HINT}`, { ms: 8000 });
    } else if (!this.hinted) {
      this.hinted = true;  // iOS < 18.4 en app installée : la demande peut réussir sans effet
      this.ui.toast(`Écran maintenu allumé. Si l'iPhone se verrouille quand même : ${FALLBACK_HINT.charAt(0).toLowerCase()}${FALLBACK_HINT.slice(1)}`, { ms: 6000 });
    } else {
      this.ui.toast('Écran maintenu allumé');
    }
    this._apply();
    return ok;
  }

  async disable() {
    this.wanted = false;
    document.removeEventListener('pointerdown', this._retryOnTouch, true);
    const s = this.sentinel;
    this.sentinel = null;
    if (s) {
      try {
        await s.release();
      } catch { /* déjà relâché */ }
    }
    this._apply();
    this.ui.toast('Écran : mise en veille normale');
  }

  async _acquire(fromUser) {
    try {
      const s = await navigator.wakeLock.request('screen');
      this.sentinel = s;
      this.lastError = null;
      this.acquisitions += 1;
      s.addEventListener('release', () => {
        if (this.sentinel === s) this.sentinel = null;
        this._apply();
      });
      this._apply();
      return true;
    } catch (err) {
      this.sentinel = null;
      this.lastError = err;
      // reprise refusée hors geste (fréquent sur iOS) : nouvel essai au prochain toucher de l'écran
      if (!fromUser && this.wanted) document.addEventListener('pointerdown', this._retryOnTouch, true);
      this._apply();
      return false;
    }
  }

  _apply() {
    const btn = $('btn-wake');
    btn.setAttribute('aria-pressed', String(this.wanted));
    btn.classList.toggle('pending', this.wanted && !this.sentinel);
    const label = !this.wanted ? 'Garder l\'écran allumé'
      : this.sentinel ? 'Écran maintenu allumé (toucher pour arrêter)'
        : 'Écran allumé en attente (toucher la carte pour réactiver)';
    btn.setAttribute('aria-label', label);
    btn.title = label;
  }
}
