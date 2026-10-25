// Éléments partagés par les vues Préparer et Contrôler.

const SVGNS = 'http://www.w3.org/2000/svg';

// nombre d'anomalies avec une icône (le caractère ⚠ s'affiche en emoji jaune sur certains systèmes)
export function anomalyCount(cls, n = 0) {
  const s = document.createElement('span');
  s.className = `${cls} anom-n`;
  s.append(document.createTextNode(''));
  const svg = document.createElementNS(SVGNS, 'svg');
  svg.setAttribute('class', 'ico');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  for (const d of ['M12 3.8L2.8 19.8h18.4z', 'M12 9.8v4.6M12 16.9v.4']) {
    const p = document.createElementNS(SVGNS, 'path');
    p.setAttribute('d', d);
    svg.append(p);
  }
  s.append(svg);
  setAnomalyCount(s, n);
  return s;
}

export function setAnomalyCount(el, n) {
  el.firstChild.textContent = n ? String(n) : '';
  el.hidden = !n;
  el.title = n ? `${n} anomalie${n > 1 ? 's' : ''}` : '';
}

// Ligne de rue cliquable : liseré de couleur, nom, détail, compte, chevron.
export function streetRow({ color, name, sub, count = null, again = 0, anomalies = 0, complete = false, onClick }) {
  const li = document.createElement('li');
  const b = document.createElement('button');
  b.type = 'button';
  b.className = `vrow${complete ? ' complete' : ''}`;
  b.style.setProperty('--sc', color);
  const main = document.createElement('span');
  main.className = 'vrow-main';
  const n = document.createElement('span');
  n.className = 'vrow-name';
  n.textContent = name;
  const s = document.createElement('span');
  s.className = 'vrow-sub';
  s.textContent = sub;
  main.append(n, s);
  const c = document.createElement('span');
  c.className = 'vrow-count';
  c.textContent = count ?? '';
  if (again) {
    const ag = document.createElement('span');
    ag.className = 'vrow-again';
    ag.textContent = `${again} ↻`;
    c.append(ag);
  }
  if (anomalies) c.append(anomalyCount('vrow-anom', anomalies));
  const chev = document.createElementNS(SVGNS, 'svg');
  chev.setAttribute('class', 'ico vrow-chev');
  chev.setAttribute('viewBox', '0 0 24 24');
  chev.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(SVGNS, 'path');
  p.setAttribute('d', 'M9 5l7 7-7 7');
  chev.append(p);
  b.append(main, c, chev);
  b.addEventListener('click', onClick);
  li.append(b);
  return li;
}

// Montrer une rue sur la carte : onglet Distribuer, rue sélectionnée et cadrée
export function showStreet(app, i) {
  app.tabs.select('distribute');
  app.ui.selectStreet(i);
}

// Montrer un point à vérifier : onglet Distribuer, carte centrée dessus, repère
export function showPoint(app, x, y) {
  app.tabs.select('distribute');
  app.ui.selectStreet(null);
  app.map.centerOn(x, y, { minK: 3 });
  app.map.mark(x, y);
}

// Montrer une adresse de la tournée : onglet Distribuer, carte centrée, panneau d'adresse ouvert
export function showAddress(app, a) {
  app.tabs.select('distribute');
  app.ui.selectStreet(null);
  app.map.mark(null);
  app.map.centerOn(a.x, a.y, { minK: 3, animate: false });
  app.ui.openSheet(a);
}

// Méthodes d'une vue qui écrivent dans le stockage : une erreur (quota dépassé, base indisponible) est
// signalée par un toast au lieu de se perdre dans une promesse rejetée
export function guard(view, names) {
  for (const name of names) {
    const fn = view[name].bind(view);
    view[name] = async (...args) => {
      try {
        return await fn(...args);
      } catch (err) {
        view.app.ui.toast(`Enregistrement impossible : ${err.message}`, { ms: 6000 });
        return null;
      }
    };
  }
}

// numéro et suffixe : « 22 bis »
export const num = (a) => `${a.n}${a.rep ? ` ${a.rep}` : ''}`;

// comparaison sans accents ni casse (recherche de rue)
export const fold = (s) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

export const plural = (n, one, many = `${one}s`) => `${n} ${n > 1 ? many : one}`;
