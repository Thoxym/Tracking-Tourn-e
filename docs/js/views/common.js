// Éléments partagés par les vues Préparer et Contrôler.

const SVGNS = 'http://www.w3.org/2000/svg';

// Ligne de rue cliquable : liseré de couleur, nom, détail, compte, chevron.
export function streetRow({ color, name, sub, count, again = 0, complete = false, onClick }) {
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
  c.textContent = count;
  if (again) {
    const ag = document.createElement('span');
    ag.className = 'vrow-again';
    ag.textContent = `${again} ↻`;
    c.append(ag);
  }
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

// comparaison sans accents ni casse (recherche de rue)
export const fold = (s) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

export const plural = (n, one, many = `${one}s`) => `${n} ${n > 1 ? many : one}`;
