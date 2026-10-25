// Préparer › Repères : toutes les adresses repérées (un toucher modifie le repère), « Tout supprimer » ; pastilles
// des repères sur le plan, à jour à chaque changement.

import { addressLabel } from '../ui.js';
import { guard, plural, streetRow } from './common.js';

const $ = (id) => document.getElementById(id);
const date = (t) => new Date(t).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' });

export class TagsView {
  constructor(app) {
    this.app = app;
    this.rank = new Map(app.map.pointable.map((a, k) => [a.id, k]));
    guard(this, ['clearAll']);
    $('tags-clear').addEventListener('click', () => this.clearAll());
    app.store.onChange((d) => {
      if (!d || d.type === 'tags' || d.type === 'import') this.refresh();
    });
    app.tabs.onChange((tab) => { if (tab === 'prepare') this.render(); });
    this.refresh();
  }

  // adresses repérées connues du plan, dans l'ordre des données (rue, numéro)
  entries() {
    const { store, map } = this.app;
    return Object.entries(store.tags).map(([id, t]) => ({ a: map.byId.get(id), t }))
      .filter((x) => x.a).sort((p, q) => this.rank.get(p.a.id) - this.rank.get(q.a.id));
  }

  refresh() {
    this.app.map.setTags(this.entries().map(({ a }) => a));
    this.render();
  }

  render() {
    const { ui } = this.app;
    const list = this.entries();
    $('prep-tags-n').textContent = list.length ? String(list.length) : 'aucun';
    $('tags-empty').hidden = list.length > 0;
    $('tags-list').hidden = !list.length;
    $('tags-clear').hidden = !list.length;
    $('tags-list').replaceChildren(...list.map(({ a, t }) => streetRow({
      color: 'var(--repasser)',
      name: addressLabel(a, ui.streets),
      sub: `${ui.tagText(a.id)}${t.at ? ` · ${date(t.at)}` : ''}`,
      onClick: () => ui.editTags(a),
    })));
  }

  async clearAll() {
    const { ui, store } = this.app;
    const n = this.entries().length;
    const what = n > 1 ? `les ${plural(n, 'repère')}` : 'le repère';
    if (!(await ui.confirm(`Supprimer ${what} de cet appareil ?`, 'Supprimer', { destructive: true }))) return;
    await store.clearTags();
    ui.toast('Repères supprimés');
  }
}
