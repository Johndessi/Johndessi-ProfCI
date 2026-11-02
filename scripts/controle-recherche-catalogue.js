#!/usr/bin/env node
'use strict';
// Contrôle automatique, 100 % hors ligne (aucun réseau, aucune base, aucun appel Anthropic) : pour chaque
// leçon et chaque séance des fichiers lecons_officielles_*.json, appelle les MÊMES fonctions de recherche que
// /api/generer-fiche (server.js) et liste toute combinaison qui ne retrouve pas sa leçon.
//
//   node scripts/controle-recherche-catalogue.js [--fichiers <dossier>] [--classes 3ème,4ème,5ème,6ème]
//
// Trois modes de recherche sont éprouvés, parce que la génération en utilise deux :
//   ID      menus Leçon -> Séance du formulaire : trouverLeconEtSeanceParId(idLeçon, idSéance). Doit TOUJOURS réussir.
//   SÉANCE  saisie libre de l'intitulé de la séance : trouverLeconOfficielleDPFC({ lecon: intitulé }).
//   TITRE   saisie libre du titre de la leçon : trouverLeconOfficielleDPFC({ lecon: titre }).
// La recherche libre ne compare le texte saisi QU'AUX INTITULÉS DE SÉANCE (inclusion dans un sens ou dans l'autre) :
// ni le titre de la leçon, ni son numéro ne sont jamais comparés. Un titre de leçon seul ne retrouve donc sa leçon
// que si un intitulé de séance de la même classe/activité le contient. Code de sortie 1 si un échec « ID » existe
// (défaut bloquant) ; les échecs « TITRE » et « SÉANCE » sont listés mais ne font pas échouer le contrôle.
// Une séance dont l'intitulé est identique à celui d'une séance précédente de la même leçon (la progression en
// contient beaucoup) est comptée à part (« homonymes ») : la leçon est bien retrouvée, mais la recherche libre
// renvoie la première séance portant cet intitulé.
const fs = require('fs');
const path = require('path');

const RACINE = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const val = (nom) => { const i = args.indexOf(nom); return i >= 0 ? args[i + 1] : null; };
const dossierFichiers = path.resolve(val('--fichiers') || RACINE);
const classesVisees = (val('--classes') || '3ème,4ème,5ème,6ème').split(',').map((c) => c.trim());

const mongoose = require(path.join(RACINE, 'node_modules', 'mongoose'));
mongoose.connect = async () => {};
process.env.PORT = process.env.PORT || '0';
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'controle-hors-ligne';
const logOriginal = console.log, warnOriginal = console.warn;
console.log = () => {}; console.warn = () => {};
const srv = require(path.join(RACINE, 'server.js'));
console.log = logOriginal; console.warn = warnOriginal;
if (typeof srv.trouverLeconOfficielleDPFC !== 'function' || typeof srv.trouverLeconEtSeanceParId !== 'function') {
  console.error('server.js n\'exporte pas les fonctions de recherche : version du code inattendue.');
  process.exit(2);
}

const LO = mongoose.models.LeconOfficielleDPFC;
const docs = [];
for (const f of fs.readdirSync(dossierFichiers).filter((x) => /^lecons_officielles_.*\.json$/.test(x)).sort()) {
  for (const l of JSON.parse(fs.readFileSync(path.join(dossierFichiers, f), 'utf8'))) {
    if (classesVisees.includes(l.classe)) docs.push(new LO(l));
  }
}
// Mêmes filtres que les requêtes réelles (discipline/classe : égalité exacte insensible à la casse).
LO.find = async (filtre) => docs.filter((d) => (!filtre.discipline || filtre.discipline.test(d.discipline)) && (!filtre.classe || filtre.classe.test(d.classe)));
LO.findById = async (id) => docs.find((d) => String(d._id) === String(id)) || null;

const echecs = { ID: [], SEANCE: [], TITRE: [] };
const homonymes = new Map();
const compte = { ID: 0, SEANCE: 0, TITRE: 0 };
const etiquette = (d, s) => `${d.classe} / ${d.activite} / leçon ${d.numeroLecon} « ${d.titreLecon} »${s ? ` / séance ${s.numeroSeance} « ${s.intitule} »` : ''}`;

(async () => {
  for (const d of docs) {
    // TITRE : une fois par leçon (sa recherche ne dépend pas de la séance)
    compte.TITRE++;
    const rt = await srv.trouverLeconOfficielleDPFC({ discipline: d.discipline, classe: d.classe, lecon: d.titreLecon, theme: '', activite: d.activite });
    if (!rt) echecs.TITRE.push(`${etiquette(d)} -> aucune leçon trouvée en saisissant « ${d.titreLecon} »`);
    else if (String(rt.lecon._id) !== String(d._id)) echecs.TITRE.push(`${etiquette(d)} -> trouve une AUTRE leçon : ${etiquette(rt.lecon, rt.seance)}`);
    for (const s of d.seances) {
      compte.ID++; compte.SEANCE++;
      const ri = await srv.trouverLeconEtSeanceParId(String(d._id), String(s._id));
      if (!ri || String(ri.lecon._id) !== String(d._id) || String(ri.seance._id) !== String(s._id)) echecs.ID.push(`${etiquette(d, s)} -> non retrouvée par identifiants`);
      const rs = await srv.trouverLeconOfficielleDPFC({ discipline: d.discipline, classe: d.classe, lecon: s.intitule, theme: '', activite: d.activite });
      if (!rs) echecs.SEANCE.push(`${etiquette(d, s)} -> aucune leçon trouvée en saisissant l'intitulé`);
      else if (String(rs.lecon._id) !== String(d._id)) echecs.SEANCE.push(`${etiquette(d, s)} -> trouve une AUTRE leçon : ${etiquette(rs.lecon, rs.seance)}`);
      else if (String(rs.seance._id) !== String(s._id)) {
        const cle = `${etiquette(d)} : séance(s) ${rs.seance.numeroSeance}`;
        if (!homonymes.has(cle)) homonymes.set(cle, []);
        homonymes.get(cle).push(s.numeroSeance);
      }
    }
  }
  console.log(`Fichiers : ${dossierFichiers}`);
  console.log(`Classes : ${classesVisees.join(', ')} — ${docs.length} leçons, ${docs.reduce((a, d) => a + d.seances.length, 0)} séances`);
  for (const mode of ['ID', 'SEANCE', 'TITRE']) {
    const libelle = { ID: 'menus (identifiants)', SEANCE: 'saisie libre de l\'intitulé de la séance', TITRE: 'saisie libre du titre de la leçon' }[mode];
    console.log(`\n[${mode}] ${libelle} : ${compte[mode] - echecs[mode].length}/${compte[mode]} retrouvées, ${echecs[mode].length} échec(s)`);
    for (const e of echecs[mode]) console.log(`   ✗ ${e}`);
  }
  const nbHomonymes = [...homonymes.values()].reduce((a, v) => a + v.length, 0);
  console.log(`\n[HOMONYMES] séances confondues avec une autre séance de la même leçon (intitulé identique ou inclus dans le leur) : ${nbHomonymes} (leçon retrouvée, mais la recherche libre renvoie la première séance portant cet intitulé)`);
  for (const [cle, nums] of homonymes) console.log(`   ~ ${cle.replace(/ : séance\(s\) (\d+)$/, '')} : les séances ${nums.join(', ')} sont confondues avec la séance ${cle.match(/(\d+)$/)[1]} (intitulé identique, ou contenu dans le leur)`);
  process.exit(echecs.ID.length ? 1 : 0);
})();
