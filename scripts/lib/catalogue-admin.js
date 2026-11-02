'use strict';
// Outils communs aux scripts d'import / de retour arrière des catalogues de leçons
// officielles. Node natif uniquement (fetch global depuis Node 18), aucune dépendance.
//
// SÉCURITÉ DE LA CLÉ ADMIN : elle est saisie à l'écran (saisie masquée), gardée en mémoire,
// envoyée uniquement dans l'en-tête `x-admin-key`, et n'est jamais écrite dans un fichier ni
// affichée -- aucun message d'erreur ne reprend l'en-tête, l'URL de la requête est affichée
// sans paramètre sensible (la clé ne passe jamais dans l'URL).
const readline = require('readline');

const TIMEOUT_RESEAU_MS = 60000;

class ErreurScript extends Error {}

function validerUrl(brute) {
  let u;
  try { u = new URL(String(brute || '').trim()); } catch (e) { throw new ErreurScript(`URL invalide : « ${brute} ».`); }
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) {
    throw new ErreurScript('L\'URL doit commencer par https:// (http:// n\'est accepté que pour 127.0.0.1 / localhost).');
  }
  return u.origin;
}

// Saisie visible (confirmations).
function demander(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
    rl.question(question, (reponse) => { resolve(String(reponse).trim()); rl.close(); });
    rl.on('close', () => resolve(''));
  });
}

// Saisie MASQUÉE (rien n'est affiché pendant la frappe, ni les caractères ni des étoiles).
function lireSecret(question) {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') {
      reject(new ErreurScript('Saisie masquée impossible : lancez le script dans un terminal interactif (PowerShell, cmd ou bash), sans redirection.'));
      return;
    }
    process.stdout.write(question);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    let saisie = '';
    const terminer = () => {
      process.stdin.removeListener('data', surDonnees);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write('\n');
    };
    const surDonnees = (morceau) => {
      for (const c of morceau) {
        if (c === '\r' || c === '\n') { terminer(); resolve(saisie.trim()); return; }
        if (c === '\u0003') { terminer(); reject(new ErreurScript('Interrompu.')); return; }
        if (c === '\u007f' || c === '\b') { saisie = saisie.slice(0, -1); continue; }
        if (c >= ' ') saisie += c;
      }
    };
    process.stdin.on('data', surDonnees);
  });
}

// Client HTTP : la clé reste dans la closure, jamais renvoyée ni affichée.
function creerClient(origine, cle) {
  async function appeler(methode, chemin, corps, { reessayer = false } = {}) {
    const tentatives = reessayer ? 2 : 1;
    let derniere;
    for (let i = 0; i < tentatives; i++) {
      try {
        const reponse = await fetch(origine + chemin, {
          method: methode,
          headers: { 'x-admin-key': cle, ...(corps !== undefined ? { 'Content-Type': 'application/json' } : {}) },
          body: corps !== undefined ? JSON.stringify(corps) : undefined,
          signal: AbortSignal.timeout(TIMEOUT_RESEAU_MS)
        });
        let json = null;
        try { json = await reponse.json(); } catch (e) { json = null; }
        if (reponse.status === 401) throw new ErreurScript('Clé admin refusée par le serveur (401). Rien n\'a été modifié.');
        if (reponse.status === 404) throw new ErreurScript(`Route absente (404) : ${methode} ${chemin.split('?')[0]}. Le serveur n'a probablement pas la version de code attendue (PR #84 / #85 non déployées).`);
        return { statut: reponse.status, ok: reponse.ok, json };
      } catch (e) {
        if (e instanceof ErreurScript) throw e;
        derniere = new ErreurScript(`Erreur réseau sur ${methode} ${chemin.split('?')[0]} : ${(e.cause && e.cause.code) || e.name || 'inconnue'}. ${e.name === 'TimeoutError' ? 'Le serveur met trop de temps à répondre (service endormi ?).' : ''}`.trim());
        if (i + 1 < tentatives) await new Promise((r) => setTimeout(r, 3000));
      }
    }
    throw derniere;
  }
  return {
    get: (chemin) => appeler('GET', chemin, undefined, { reessayer: true }),
    post: (chemin, corps) => appeler('POST', chemin, corps)
  };
}

// ---------- Forme canonique : ce que la route d'import persiste réellement ----------
function normaliserClasse(classe) {
  const c = String(classe || '').trim();
  const m = c.match(/^([3-6])(?:e|eme|ème)$/i);
  return m ? `${m[1]}ème` : c;
}

function canonSeance(s) {
  return {
    numeroSeance: Number(s.numeroSeance),
    intitule: String(s.intitule || '').trim(),
    activite: String(s.activite || '').trim(),
    optionsChoix: Array.isArray(s.optionsChoix) ? s.optionsChoix.map((o) => String(o).trim()).filter(Boolean) : [],
    choixLibre: !!s.choixLibre,
    choixLibreLabel: String(s.choixLibreLabel || '').trim(),
    texteSupportOfficiel: String(s.texteSupportOfficiel || '').trim(),
    vocabulaireReference: (s.vocabulaireReference && typeof s.vocabulaireReference === 'object') ? s.vocabulaireReference : null,
    typeSeanceOeuvre: String(s.typeSeanceOeuvre || '').trim() || null,
    typeSupport: String(s.typeSupport || '').trim() || null,
    typeTexte: String(s.typeTexte || '').trim() || null,
    themeIntegre: String(s.themeIntegre || '').trim() || null,
    progression: Array.isArray(s.progression) ? s.progression.filter((o) => o && typeof o === 'object') : []
  };
}

function canonLecon(l) {
  const ordre = l.ordre !== undefined && l.ordre !== null ? parseInt(l.ordre, 10) : null;
  return {
    discipline: String(l.discipline || '').trim(),
    classe: normaliserClasse(l.classe),
    activite: String(l.activite || '').trim(),
    numeroLecon: Number(l.numeroLecon),
    titreLecon: String(l.titreLecon || '').trim(),
    ordre: Number.isFinite(ordre) ? ordre : null,
    genreOeuvre: String(l.genreOeuvre || '').trim() || null,
    seances: (l.seances || []).map(canonSeance)
  };
}

function trier(valeur) {
  if (Array.isArray(valeur)) return valeur.map(trier);
  if (valeur && typeof valeur === 'object') {
    return Object.keys(valeur).sort().reduce((acc, k) => { acc[k] = trier(valeur[k]); return acc; }, {});
  }
  return valeur;
}

const cleLecon = (l) => `${l.discipline}|${l.classe}|${l.activite}|${l.numeroLecon}`;

// Compare deux listes de leçons (forme fichier d'import OU forme export) sur la forme canonique.
// `ignorerOrdre` : l'import n'écrase pas `ordre` quand le fichier n'en fournit pas.
function comparerCatalogues(attendu, obtenu, { ignorerOrdreSiAbsent = true } = {}) {
  const A = new Map(attendu.map((l) => { const c = canonLecon(l); return [cleLecon(c), c]; }));
  const O = new Map(obtenu.map((l) => { const c = canonLecon(l); return [cleLecon(c), c]; }));
  const manquantes = [], differentes = [];
  for (const [cle, a] of A) {
    const o = O.get(cle);
    if (!o) { manquantes.push(cle); continue; }
    const x = { ...a }, y = { ...o };
    if (ignorerOrdreSiAbsent && a.ordre === null) { x.ordre = null; y.ordre = null; }
    if (JSON.stringify(trier(x)) !== JSON.stringify(trier(y))) differentes.push(cle);
  }
  return { identiques: !manquantes.length && !differentes.length, manquantes, differentes, enPlus: [...O.keys()].filter((k) => !A.has(k)) };
}

const nbSeances = (lecons) => lecons.reduce((acc, l) => acc + (l.seances || []).length, 0);

function resumerClasses(analyse) {
  const formes = (analyse.formes || []).map((f) => `« ${f.classe} » : ${f.n}`).join(' ; ') || 'aucune';
  return `valeurs de classe : ${formes} ; à normaliser : ${analyse.aNormaliser} ; conflits : ${(analyse.conflits || []).length}`;
}

function detaillerConflits(analyse) {
  return (analyse.conflits || []).map((c) => `   - ${c.discipline} / ${c.classe} / ${c.activite} / leçon ${c.numeroLecon} : ${c.documents.map((d) => `« ${d.classe} » (${d.nbSeances} séances)`).join(' + ')}`);
}

// Appelle classes-catalogue et renvoie l'analyse des leçons officielles.
async function controlerClasses(client, niveaux) {
  const r = await client.get(`/api/admin/classes-catalogue?niveaux=${niveaux.join(',')}`);
  if (!r.ok || !r.json || !r.json.resultat) throw new ErreurScript(`Réponse inattendue de classes-catalogue (HTTP ${r.statut}).`);
  return r.json.resultat.leconsOfficielles;
}

module.exports = {
  ErreurScript, validerUrl, demander, lireSecret, creerClient, normaliserClasse, canonLecon,
  comparerCatalogues, nbSeances, resumerClasses, detaillerConflits, controlerClasses, cleLecon
};
