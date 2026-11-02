#!/usr/bin/env node
'use strict';
// Retour arrière des catalogues de leçons officielles 3ème à 6ème. Deux sources possibles :
//
//   --export <fichier>   (RECOMMANDÉ) restaure depuis la sauvegarde faite par importer-catalogues.js :
//                        c'est l'état exact de la base avant l'import, quel qu'il fût.
//   --depuis-main        ré-importe les fichiers du dépôt tels qu'ils étaient sur main le 28/10/2026
//                        (scripts/catalogue-avant-pr84/). Ne ramène l'état d'avant QUE si la base
//                        d'avant était identique à ces fichiers -- ce que le script ne peut pas savoir.
//
// Dans les deux cas : l'import (upsert) remplace la liste des séances des leçons concernées ; il ne
// SUPPRIME aucun document (une leçon créée par l'import qui n'existait pas avant resterait : le
// script la signale). Après la restauration, le script compare la base à la source.
// La clé admin est saisie à l'écran (masquée) : jamais écrite, jamais affichée.
const fs = require('fs');
const path = require('path');
const {
  ErreurScript, validerUrl, demander, lireSecret, creerClient, normaliserClasse, comparerCatalogues,
  nbSeances, resumerClasses, detaillerConflits, controlerClasses
} = require('./lib/catalogue-admin');

const DOSSIER_MAIN = path.resolve(__dirname, 'catalogue-avant-pr84');

function usage() {
  return [
    'Usage : node scripts/retour-arriere-catalogues.js <url-du-serveur> (--export <fichier> | --depuis-main) [--niveaux 3,4,5,6]',
    '',
    '  --export <fichier>   sauvegarde créée par importer-catalogues.js (recommandé)',
    '  --depuis-main        fichiers de main du 28/10/2026 (scripts/catalogue-avant-pr84/)',
    '  --niveaux            niveaux à restaurer (défaut : 3,4,5,6)'
  ].join('\n');
}

function lireArguments(argv) {
  const r = { url: null, exportFichier: null, depuisMain: false, niveaux: [3, 4, 5, 6] };
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--export') r.exportFichier = path.resolve(String(argv[++i] || ''));
    else if (argv[i] === '--depuis-main') r.depuisMain = true;
    else if (argv[i] === '--niveaux') r.niveaux = String(argv[++i] || '').split(',').map((n) => Number(n.trim()));
    else if (argv[i] === '--help' || argv[i] === '-h') { console.log(usage()); process.exit(0); }
    else pos.push(argv[i]);
  }
  r.url = pos[0];
  if (!r.url) throw new ErreurScript(`URL du serveur manquante.\n\n${usage()}`);
  if (!!r.exportFichier === r.depuisMain) throw new ErreurScript(`Choisissez exactement une source : --export <fichier> OU --depuis-main.\n\n${usage()}`);
  if (!r.niveaux.length || r.niveaux.some((n) => ![3, 4, 5, 6].includes(n))) throw new ErreurScript('--niveaux : valeurs parmi 3,4,5,6.');
  return r;
}

function chargerSource(args) {
  if (args.exportFichier) {
    if (!fs.existsSync(args.exportFichier)) throw new ErreurScript(`Fichier de sauvegarde introuvable : ${args.exportFichier}`);
    const contenu = JSON.parse(fs.readFileSync(args.exportFichier, 'utf8'));
    const lecons = Array.isArray(contenu) ? contenu : contenu.lecons;
    if (!Array.isArray(lecons) || !lecons.length) throw new ErreurScript('Le fichier n\'est pas une sauvegarde valide (liste de leçons absente ou vide).');
    return { nom: `sauvegarde ${path.basename(args.exportFichier)}`, lecons };
  }
  if (!fs.existsSync(DOSSIER_MAIN)) throw new ErreurScript(`Dossier introuvable : ${DOSSIER_MAIN}`);
  const lecons = [];
  for (const f of fs.readdirSync(DOSSIER_MAIN).filter((x) => /^lecons_officielles_.*\.json$/.test(x)).sort()) {
    lecons.push(...JSON.parse(fs.readFileSync(path.join(DOSSIER_MAIN, f), 'utf8')));
  }
  return { nom: 'fichiers de main du 28/10/2026 (scripts/catalogue-avant-pr84/)', lecons };
}

async function main() {
  const args = lireArguments(process.argv.slice(2));
  const origine = validerUrl(args.url);
  const source = chargerSource(args);
  const classesVisees = new Set(args.niveaux.map((n) => `${n}ème`));

  // Seuls les documents des niveaux visés sont restaurés ; une classe non normalisée (« 4e ») serait
  // restaurée dans un AUTRE document (l'import normalise en « 4ème ») : on refuse plutôt que de mal restaurer.
  const aRestaurer = [];
  const nonNormalisees = [];
  for (const l of source.lecons) {
    const norm = normaliserClasse(l.classe);
    if (!classesVisees.has(norm)) continue;
    if (norm !== l.classe) nonNormalisees.push(`${l.classe} / ${l.activite} / leçon ${l.numeroLecon}`);
    aRestaurer.push(l);
  }
  if (!aRestaurer.length) throw new ErreurScript('Aucune leçon des niveaux demandés dans la source : rien à restaurer.');
  if (nonNormalisees.length) {
    throw new ErreurScript(`Restauration refusée : la source contient des classes non normalisées (${nonNormalisees.slice(0, 5).join(' ; ')}...). L'import les écrirait dans d'autres documents. Traitez-les d'abord à la main.`);
  }

  console.log(`Serveur cible : ${origine}`);
  console.log(`Source : ${source.nom}`);
  console.log(`À restaurer : ${aRestaurer.length} leçons, ${nbSeances(aRestaurer)} séances (niveaux ${args.niveaux.join(', ')}).`);
  if (args.depuisMain) {
    console.log('ATTENTION : cette source ramène le dépôt tel qu\'il était sur main, pas forcément l\'état de la base avant l\'import.');
  }
  const cle = await lireSecret('Clé admin (saisie masquée, rien ne s\'affiche) : ');
  if (!cle) throw new ErreurScript('Clé vide.');
  const client = creerClient(origine, cle);

  const confirmation = await demander('\nCette opération REMPLACE les séances des leçons concernées. Tapez RESTAURER pour continuer : ');
  if (confirmation !== 'RESTAURER') { console.log('Arrêt : rien n\'a été modifié.'); process.exit(0); }

  const envoi = await client.post('/api/admin/lecons-officielles/seed', aRestaurer);
  if (!envoi.ok || !envoi.json || envoi.json.success !== true) {
    throw new ErreurScript(`ÉCHEC de la restauration : HTTP ${envoi.statut} ${(envoi.json && envoi.json.error) || ''}`);
  }
  console.log(`\nRestauration envoyée : upserted = ${envoi.json.upserted} (attendu ${aRestaurer.length}), ignores = ${envoi.json.ignores} (attendu 0)`);

  // Vérification : la base doit correspondre à la source pour les niveaux visés.
  const apres = await client.get(`/api/admin/lecons-officielles/export?niveaux=${args.niveaux.join(',')}`);
  if (!apres.ok || !apres.json || !Array.isArray(apres.json.lecons)) throw new ErreurScript(`Contrôle impossible (HTTP ${apres.statut}).`);
  const cmp = comparerCatalogues(aRestaurer, apres.json.lecons);
  console.log(`Base après restauration : ${apres.json.lecons.length} leçons, ${nbSeances(apres.json.lecons)} séances ; identique à la source : ${cmp.identiques ? 'oui' : 'NON'}`);
  for (const k of cmp.manquantes) console.log(`   manquante : ${k}`);
  for (const k of cmp.differentes) console.log(`   différente : ${k}`);
  if (cmp.enPlus.length) {
    console.log(`   Leçons présentes en base mais absentes de la source (non supprimées) : ${cmp.enPlus.length}`);
    for (const k of cmp.enPlus) console.log(`   en plus : ${k}`);
    console.log('   Elles ont pu être créées par l\'import ; DELETE /api/admin/lecons-officielles permet de les retirer (après vérification).');
  }
  const analyse = await controlerClasses(client, [3, 4, 5, 6]);
  console.log(`Contrôle des classes : ${resumerClasses(analyse)}`);
  for (const l of detaillerConflits(analyse)) console.log(l);
  if (!cmp.identiques || cmp.enPlus.length) process.exit(3);
  console.log('\nRestauration terminée et vérifiée.');
}

main().catch((e) => {
  console.error(e instanceof ErreurScript ? `\n${e.message}` : `\nErreur inattendue : ${e && e.message}`);
  process.exit(1);
});
