// Feuille à crans posée sur la carte (comme Localiser ou Plans) : petit cran (l'essentiel de la page, marqué
// data-peek), moyen (la moitié de l'écran) et grand. On la tire par sa poignée ou son en-tête, ou par son
// contenu tant qu'elle n'est pas au grand cran (au grand cran, le contenu défile ; tiré vers le bas en haut de
// liste, il réduit la feuille). Grand écran : panneau latéral fixe, sans crans.
//
// Elle contient une vue par onglet (et la fiche d'adresse), chacune avec une pile de pages : [data-push="x"]
// ouvre la page data-page="x" de la même vue, [data-back] revient à la précédente. Chaque vue garde son cran.
//
// La hauteur (et non une translation) suit le doigt : le contenu qui défile a toujours la taille de la partie
// visible, si bien qu'un élément focalisé ou ciblé se fait voir en faisant défiler la page, sans cran caché.

const DETENTS = ['peek', 'medium', 'large'];
const desktop = window.matchMedia('(min-width: 900px)');
const DRAG_SLOP = 6;    // px avant de considérer un glisser (un toucher reste un toucher)
const FLICK = 0.45;     // px/ms : un geste vif passe au cran suivant dans sa direction

export class Panel {
  constructor() {
    this.el = document.getElementById('panel');
    this.app = document.getElementById('app');
    this.listeners = [];
    this.view = null;        // vue affichée
    this.detents = new Map(); // cran mémorisé par vue
    this.stacks = new Map();  // pile de pages par vue
    this.detent = 'peek';
    this.height = 0;          // hauteur visée (px), hors animation
    this._suppressUntil = 0;
    this._bindNav();
    this._bindDrag();
    new ResizeObserver(() => this.layout(false)).observe(this.app);
    const peeks = new ResizeObserver(() => this.layout());  // contenu du petit cran changé : nouvelle hauteur
    for (const el of this.el.querySelectorAll('[data-peek]')) peeks.observe(el);
    desktop.addEventListener('change', () => this.layout(false));
  }

  get desktop() {
    return desktop.matches;
  }

  onChange(fn) {
    this.listeners.push(fn);
  }

  _emit() {
    for (const fn of this.listeners) fn(this);
  }

  // ------------------------------------------------------------ vues et pages

  // affiche une vue (onglet ou fiche d'adresse) au cran qu'elle avait, ou au cran demandé
  show(view, detent = null) {
    if (this.view && this.view !== view) {
      this.view.hidden = true;
      this.detents.set(this.view, this.detent);
    }
    this.view = view;
    view.hidden = false;
    this.setDetent(detent || this.detents.get(view) || view.dataset.detent || 'peek');
  }

  page(view = this.view) {
    return [...view.children].find((p) => p.classList.contains('page') && !p.hidden) || view.querySelector('.page');
  }

  push(view, name) {
    const target = view.querySelector(`:scope > .page[data-page="${name}"]`);
    const current = this.page(view);
    if (!target || target === current) return;
    const stack = this.stacks.get(view) || [];
    stack.push(current.dataset.page);
    this.stacks.set(view, stack);
    this._swap(current, target, 'push-in');
    if (view === this.view && this.detent === 'peek' && !target.querySelector('[data-peek]')) this.setDetent('medium');
    else this.layout();
  }

  back(view) {
    const stack = this.stacks.get(view) || [];
    const name = stack.pop() || 'root';
    const target = view.querySelector(`:scope > .page[data-page="${name}"]`);
    this._swap(this.page(view), target, 'pop-in');
    this.layout();
  }

  // revient à la page racine de la vue (sans animation)
  reset(view) {
    this.stacks.set(view, []);
    const root = view.querySelector(':scope > .page[data-page="root"]');
    for (const p of view.querySelectorAll(':scope > .page')) p.hidden = p !== root;
    this.layout();
  }

  _swap(from, to, anim) {
    from.hidden = true;
    to.hidden = false;
    to.classList.remove('push-in', 'pop-in');
    void to.offsetWidth;  // relance l'animation
    to.classList.add(anim);
    to.querySelector('.page-body')?.scrollTo(0, 0);
    // focus sur la page ouverte (lecteur d'écran, clavier), sans faire défiler
    (to.querySelector('.nav-back') || to.querySelector('.nav-title'))?.focus?.({ preventScroll: true });
  }

  _bindNav() {
    this.el.addEventListener('click', (e) => {
      if (performance.now() < this._suppressUntil) {  // fin d'un glisser : pas un toucher
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      const push = e.target.closest('[data-push]');
      const back = e.target.closest('[data-back]');
      const view = e.target.closest('.view');
      if (push && view) this.push(view, push.dataset.push);
      else if (back && view) this.back(view);
    }, true);
    this.el.querySelector('.grabber').addEventListener('click', () => {
      const i = DETENTS.indexOf(this.detent);
      this.setDetent(i === DETENTS.length - 1 ? 'peek' : DETENTS[i + 1]);
    });
  }

  // ------------------------------------------------------------------ crans

  // hauteur de chaque cran, d'après l'écran et la page affichée
  heights() {
    const H = this.app.clientHeight;
    // grand cran : jusque sous la barre d'état (le bouton Annuler est à safe-area + 12 px du haut)
    let top = document.getElementById('btn-undo').offsetTop;
    // navigation : le grand cran s'arrête sous le bandeau de consigne (et la capsule de simulation)
    if (this.app.dataset.mode === 'nav') {
      for (const id of ['nav-banner', 'sim-bar']) {
        const el = document.getElementById(id);
        if (el && !el.hidden) top = Math.max(top, el.offsetTop + el.offsetHeight + 12);
      }
    }
    const large = Math.round(H - 6 - Math.max(8, top - 4));
    let peek = 180;
    const page = this.view && this.page();
    const mark = page && page.querySelector('[data-peek]');
    if (page && mark) {
      const body = page.querySelector('.page-body');
      const head = page.querySelector('.nav');
      const tabZone = parseFloat(getComputedStyle(page).paddingBottom) || 0;
      const markBottom = mark.offsetTop + mark.offsetHeight - (body ? body.offsetTop : 0);
      peek = (head ? head.offsetHeight : 0) + (body ? body.offsetTop - (head ? head.offsetTop + head.offsetHeight : 0) : 0)
        + markBottom + tabZone + 10;
    }
    peek = Math.round(Math.min(Math.max(peek, 150), H * 0.68, large));
    const medium = Math.round(Math.min(Math.max(H * 0.52, peek + 60), large));
    return { peek, medium, large };
  }

  setDetent(detent, animate = true) {
    if (!DETENTS.includes(detent)) detent = 'peek';
    this.detent = detent;
    if (this.view) this.detents.set(this.view, detent);
    this.el.dataset.detent = detent;
    this.layout(animate);
  }

  // applique la hauteur du cran courant (contenu ou écran changés)
  layout(animate = true) {
    if (this.dragging) return;
    if (this.desktop) {
      this.el.style.removeProperty('--panel-h');
      this.height = this.el.offsetHeight;
      this._emit();
      return;
    }
    const h = this.heights()[this.detent];
    if (h === this.height && this.el.style.getPropertyValue('--panel-h')) return;
    this.height = h;
    this.el.classList.toggle('anim', animate);
    this.el.style.setProperty('--panel-h', `${h}px`);
    this._emit();
  }

  // partie de l'écran couverte en bas (pour les cadrages de la carte) ; grand écran : 0
  covered() {
    if (this.desktop) return 0;
    const cap = this.heights().medium;
    return Math.min(this.height, cap) + 6;
  }

  // largeur couverte à gauche (grand écran)
  coveredLeft() {
    if (!this.desktop) return 0;
    const r = this.el.getBoundingClientRect();
    return r.right - this.app.getBoundingClientRect().left;
  }

  // ---------------------------------------------------------------- glisser

  _bindDrag() {
    const el = this.el;
    let start = null;
    const begin = (y, src) => {
      start = { y, h: this.height, t: performance.now(), src, moved: false, lastY: y, lastT: performance.now(), v: 0 };
    };
    const move = (y) => {
      if (!start) return false;
      const dy = y - start.y;
      if (!start.moved) {
        if (Math.abs(dy) < DRAG_SLOP) return false;
        start.moved = true;
        this.dragging = true;
        el.classList.remove('anim');
      }
      const now = performance.now();
      if (now > start.lastT) start.v = (y - start.lastY) / (now - start.lastT);
      start.lastY = y;
      start.lastT = now;
      const { peek, large } = this.heights();
      let h = start.h - dy;
      if (h > large) h = large + (h - large) * 0.2;              // résistance au-delà des bornes
      if (h < peek) h = peek - (peek - h) * 0.35;
      el.style.setProperty('--panel-h', `${Math.round(h)}px`);
      this.height = h;
      return true;
    };
    const end = () => {
      if (!start) return;
      const s = start;
      start = null;
      if (!s.moved) return;
      this.dragging = false;
      this._suppressUntil = performance.now() + 400;
      const hs = DETENTS.map((d) => this.heights()[d]);
      const h = this.height;
      let i;
      if (s.v < -FLICK) i = Math.max(0, hs.findIndex((x) => x > h + 1));  // geste vif vers le haut : cran au-dessus
      else if (s.v > FLICK) i = Math.max(0, hs.findLastIndex((x) => x < h - 1));  // vers le bas : cran en dessous
      else i = hs.reduce((best, x, k) => (Math.abs(x - h) < Math.abs(hs[best] - h) ? k : best), 0);
      if (s.v < -FLICK && hs.every((x) => x <= h + 1)) i = hs.length - 1;
      this.height = -1;  // forcer l'application
      this.setDetent(DETENTS[i]);
    };

    // poignée, en-tête et, hors grand cran, tout le contenu : événements de pointeur (touch-action: none)
    el.addEventListener('pointerdown', (e) => {
      if (this.desktop || e.button > 0) return;
      const onHead = e.target.closest('.grabber, .nav');
      const inBody = e.target.closest('.page-body');
      if (!onHead && !(inBody && this.detent !== 'large')) return;
      if (e.target.closest('input, textarea, select')) return;
      begin(e.clientY, 'pointer');
      start.id = e.pointerId;
    });
    window.addEventListener('pointermove', (e) => {
      if (start && start.src === 'pointer' && e.pointerId === start.id) move(e.clientY);
    });
    window.addEventListener('pointerup', (e) => { if (start && start.src === 'pointer' && e.pointerId === start.id) end(); });
    window.addEventListener('pointercancel', (e) => { if (start && start.src === 'pointer' && e.pointerId === start.id) end(); });

    // grand cran : le contenu défile ; tiré vers le bas tout en haut de la liste, il réduit la feuille (iOS)
    el.addEventListener('touchstart', (e) => {
      if (this.desktop || this.detent !== 'large' || e.touches.length !== 1) return;
      const body = e.target.closest('.page-body');
      if (!body || e.target.closest('.nav, .grabber')) return;
      this._touch = { y: e.touches[0].clientY, body };
    }, { passive: true });
    el.addEventListener('touchmove', (e) => {
      const t = this._touch;
      if (!t) return;
      const y = e.touches[0].clientY;
      if (!start) {
        if (t.body.scrollTop > 0 || y - t.y < DRAG_SLOP) {
          if (y - t.y < 0) this._touch = null;  // défilement normal vers le haut
          return;
        }
        begin(t.y, 'touch');
      }
      if (move(y)) e.preventDefault();
    }, { passive: false });
    const touchEnd = () => {
      this._touch = null;
      if (start && start.src === 'touch') end();
    };
    el.addEventListener('touchend', touchEnd);
    el.addEventListener('touchcancel', touchEnd);
  }
}
