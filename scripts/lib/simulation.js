'use strict';
// Mode à blanc (--simuler) de scripts/importer-catalogues.js : AUCUNE écriture, ni en base ni sur le poste.
// Compare, leçon par leçon, la production (export en lecture seule) au fichier du niveau, et signale les
// valeurs de production absentes des fichiers de `main` du 28/10/2026 (scripts/catalogue-avant-pr84/) :
// des corrections manuelles que l'import écraserait.
const fs = require('fs');
const path = require('path');
const { canonLecon, cleLecon, normaliserClasse } = require('./catalogue-admin');

const CHAMPS_SEANCE = ['intitule', 'activite', 'optionsChoix', 'choixLibre', 'choixLibreLabel', 'texteSupportOfficiel',
  'vocabulaireReference', 'typeSeanceOeuvre', 'typeSupport', 'typeTexte', 'themeIntegre', 'progression'];

const vide = (v) => v === null || v === undefined || v === '' || v === false || (Array.isArray(v) && !v.length);
const texte = (v) => JSON.stringify(v === undefined ? null : v);
const court = (v, n = 70) => { const t = typeof v === 'string' ? v : texte(v); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

// Aplatit une leçon canonique en { chemin: valeur }. Une valeur « vide » est équivalente à une absence.
function aplatir(lecon) {
  const m = new Map();
  if (!lecon) return m;
  m.set('titre', lecon.titreLecon);
  if (lecon.ordre !== null) m.set('ordre', lecon.ordre);
  if (lecon.genreOeuvre) m.set('genreOeuvre', lecon.genreOeuvre);
  const vus = {};
  for (const s of lecon.seances) {
    const k = vus[s.numeroSeance] = (vus[s.numeroSeance] || 0) + 1;
    const base = `S${s.numeroSeance}${k > 1 ? `#${k}` : ''}`;
    m.set(base, true);
    for (const c of CHAMPS_SEANCE) if (!vide(s[c])) m.set(`${base}.${c}`, s[c]);
  }
  return m;
}

const egal = (a, b) => texte(a) === texte(b);
const numSeance = (chemin) => chemin.split('.')[0];

// Écarts a → b : [{ chemin, de, vers }] (undefined = absent)
function ecarts(a, b) {
  const sortie = [];
  for (const chemin of new Set([...a.keys(), ...b.keys()])) {
    const va = a.get(chemin), vb = b.get(chemin);
    if (!egal(va, vb)) sortie.push({ chemin, de: va, vers: vb });
  }
  return sortie;
}

function libelleChamp(chemin) {
  const [s, champ] = [numSeance(chemin), chemin.split('.')[1]];
  return champ ? `${s} ${champ}` : s;
}

// Description lisible des changements prod → fichier (hors corrections manuelles, traitées à part).
function decrireChangements(ec, prodAplati, fichierAplati) {
  const lignes = [];
  const agreges = {};
  const ajoutees = [], retirees = [];
  const intituleDe = (aplati, s) => aplati.get(`${s}.intitule`);
  for (const e of ec) {
    if (e.chemin === 'titre') { lignes.push(`titre : « ${e.de} » → « ${e.vers} »`); continue; }
    if (e.chemin === 'ordre' || e.chemin === 'genreOeuvre') {
      lignes.push(`${e.chemin} : ${court(e.de)} → ${court(e.vers)}${e.vers === undefined ? ' (conservé en base : le fichier n\'en fournit pas)' : ''}`);
      continue;
    }
    if (/^S\d+(#\d+)?$/.test(e.chemin)) {
      if (e.vers === undefined) retirees.push(e.chemin); else ajoutees.push(e.chemin);
      continue;
    }
    const champ = e.chemin.split('.')[1];
    if (champ === 'intitule' && e.de !== undefined && e.vers !== undefined) {
      lignes.push(`${numSeance(e.chemin)} intitulé : « ${court(e.de, 110)} » → « ${court(e.vers, 110)} »`);
      continue;
    }
    // séance entière ajoutée/retirée : déjà décrite par la ligne S<n>
    const sn = numSeance(e.chemin);
    if ((e.vers !== undefined && e.de === undefined && !prodAplati.has(sn)) || (e.de !== undefined && e.vers === undefined && !fichierAplati.has(sn))) continue;
    const type = e.de === undefined ? 'ajouté' : (e.vers === undefined ? 'retiré' : 'modifié');
    const a = agreges[champ] = agreges[champ] || { ajouté: 0, modifié: 0, retiré: 0, exemple: null };
    a[type]++;
    if (!a.exemple && type !== 'ajouté') a.exemple = `${libelleChamp(e.chemin)} : ${court(e.de, 50)} → ${court(e.vers, 50)}`;
  }
  const decrireSeances = (liste, verbe, aplati) => {
    if (!liste.length) return;
    const num = (c) => Number(c.slice(1).split('#')[0]);
    const plages = []; let debut = null, prec = null;
    for (const c of [...liste].sort((x, y) => num(x) - num(y))) {
      if (debut !== null && num(c) === num(prec) + 1) { prec = c; continue; }
      if (debut !== null) plages.push(debut === prec ? debut : `${debut}–${prec}`);
      debut = c; prec = c;
    }
    plages.push(debut === prec ? debut : `${debut}–${prec}`);
    const detail = liste.length <= 3 ? ` : ${liste.map((c) => `« ${court(aplati.get(`${c}.intitule`), 80)} »`).join(' ; ')}` : '';
    lignes.push(`${liste.length} séance(s) ${verbe} : ${plages.join(', ')}${detail}`);
  };
  decrireSeances(ajoutees, 'ajoutée(s)', fichierAplati);
  decrireSeances(retirees, 'retirée(s) de la base', prodAplati);
  for (const [champ, a] of Object.entries(agreges)) {
    const morceaux = ['ajouté', 'modifié', 'retiré'].filter((t) => a[t]).map((t) => `${a[t]} ${t}${a[t] > 1 ? 's' : ''}`);
    lignes.push(`champ ${champ} : ${morceaux.join(', ')}${a.exemple ? ` (ex. ${a.exemple})` : ''}`);
  }
  return lignes;
}

// Valeurs présentes en production, absentes de main, et que l'import supprimerait ou remplacerait.
function correctionsManuelles(prodAplati, mainAplati, fichierAplati) {
  const sortie = [];
  for (const [chemin, vp] of prodAplati) {
    const vm = mainAplati.get(chemin);
    if (egal(vp, vm)) continue;                       // identique à main : pas une correction
    const vf = fichierAplati.get(chemin);
    if (egal(vp, vf)) continue;                       // l'import ne l'efface pas : il écrit la même valeur
    if (chemin === 'ordre' || chemin === 'genreOeuvre') {
      if (vf === undefined) continue;                 // l'import ne touche pas à ces champs s'ils manquent au fichier
    }
    sortie.push({ chemin, production: vp, main: vm, fichier: vf });
  }
  return sortie;
}

function decrireManuelle(c, mainExiste) {
  if (!mainExiste) return null;
  if (/^S\d+(#\d+)?$/.test(c.chemin)) return `${c.chemin} : séance présente en production, absente de main`;
  if (c.chemin === 'titre') return `titre : production « ${c.production} » (main : « ${c.main} »)`;
  const [s, champ] = [numSeance(c.chemin), c.chemin.split('.')[1]];
  const lib = champ ? `${s} ${champ}` : c.chemin;
  return `${lib} : production ${court(c.production, 80)} | main ${c.main === undefined ? 'absent' : court(c.main, 80)} | fichier ${c.fichier === undefined ? 'absent' : court(c.fichier, 80)}`;
}

function chargerReferenceMain(dossier) {
  const m = new Map();
  if (!fs.existsSync(dossier)) return m;
  for (const f of fs.readdirSync(dossier).filter((x) => /^lecons_officielles_.*\.json$/.test(x)).sort()) {
    for (const l of JSON.parse(fs.readFileSync(path.join(dossier, f), 'utf8'))) {
      const c = canonLecon(l); m.set(cleLecon(c), c);
    }
  }
  return m;
}

// niveaux : [{ numero, classe, fichier }]. Retourne le rapport (lignes) et un résumé.
function simuler({ exportProd, niveaux, racine, dossierMain }) {
  const main = chargerReferenceMain(dossierMain);
  const prodParCle = new Map();
  for (const l of exportProd) {
    const c = canonLecon(l);
    const cle = cleLecon(c);
    if (!prodParCle.has(cle)) prodParCle.set(cle, []);
    prodParCle.get(cle).push({ canon: c, classeBrute: l.classe });
  }
  const lignes = [];
  const resume = { identiques: 0, modifiees: 0, creees: 0, avecCorrectionManuelle: [], horsFichier: 0, doublons: 0 };
  for (const n of niveaux) {
    const fichier = JSON.parse(fs.readFileSync(path.join(racine, n.fichier), 'utf8')).map(canonLecon);
    const cles = new Set(fichier.map(cleLecon));
    lignes.push('', `=== ${n.classe} — ${fichier.length} leçons dans ${n.fichier} ===`);
    for (const f of fichier) {
      const cle = cleLecon(f);
      const titre = `${f.activite} L${f.numeroLecon} « ${f.titreLecon} »`;
      const prods = prodParCle.get(cle) || [];
      if (!prods.length) {
        resume.creees++;
        lignes.push(`+ ${titre} : ABSENTE de la production — serait créée (${f.seances.length} séances)`);
        continue;
      }
      if (prods.length > 1) {
        resume.doublons++;
        lignes.push(`! ${titre} : ${prods.length} documents en production pour la même clé (${prods.map((p) => `« ${p.classeBrute} »`).join(', ')}) — l'import réel serait refusé par le contrôle préalable`);
      }
      const prod = prods.find((p) => p.classeBrute === n.classe) || prods[0];
      const pa = aplatir(prod.canon), fa = aplatir(f);
      const mainLecon = main.get(cle);
      const ma = aplatir(mainLecon);
      const ec = ecarts(pa, fa);
      // l'import ne supprime pas `ordre` / `genreOeuvre` absents du fichier : on les signale sans les compter comme changement
      const changements = ec.filter((e) => !((e.chemin === 'ordre' || e.chemin === 'genreOeuvre') && e.vers === undefined));
      const notes = ec.filter((e) => (e.chemin === 'ordre' || e.chemin === 'genreOeuvre') && e.vers === undefined);
      const manuelles = correctionsManuelles(pa, ma, fa);
      if (!changements.length) {
        resume.identiques++;
        lignes.push(`= ${titre} : identique au fichier (${prod.canon.seances.length} séances)`);
        for (const e of notes) lignes.push(`    note : ${e.chemin} = ${court(e.de)} en base, conservé par l'import (absent du fichier)`);
        continue;
      }
      resume.modifiees++;
      lignes.push(`~ ${titre} : ${prod.canon.seances.length} → ${f.seances.length} séances`);
      for (const l of decrireChangements(changements, pa, fa)) lignes.push(`    ${l}`);
      for (const e of notes) lignes.push(`    note : ${e.chemin} = ${court(e.de)} en base, conservé par l'import (absent du fichier)`);
      if (!mainLecon) {
        lignes.push('    ⚠ leçon absente des fichiers de main : impossible de savoir si la base a été modifiée à la main');
      } else if (manuelles.length) {
        resume.avecCorrectionManuelle.push(`${n.classe} / ${titre}`);
        lignes.push(`    ⚠ VALEURS DE PRODUCTION ABSENTES DE MAIN (${manuelles.length}) — corrections manuelles que l'import écraserait :`);
        for (const c of manuelles.slice(0, 25)) lignes.push(`       - ${decrireManuelle(c, true)}`);
        if (manuelles.length > 25) lignes.push(`       ... et ${manuelles.length - 25} autre(s)`);
      }
    }
    const horsFichier = [...prodParCle.entries()].filter(([cle, v]) => !cles.has(cle) && normaliserClasse(v[0].canon.classe) === n.classe);
    for (const [, v] of horsFichier) {
      resume.horsFichier++;
      lignes.push(`? ${v[0].canon.activite} L${v[0].canon.numeroLecon} « ${v[0].canon.titreLecon} » : en production, absente du fichier — l'import n'y touche pas`);
    }
  }
  return { lignes, resume };
}

module.exports = { simuler, aplatir, ecarts, correctionsManuelles };
