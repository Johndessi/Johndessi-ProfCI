#!/usr/bin/env node
'use strict';
// Import des catalogues de leçons officielles 3ème, 4ème, 5ème, 6ème (PR #84) vers un serveur,
// UN NIVEAU À LA FOIS, avec contrôles avant et après chaque étape. Détails : scripts/README-catalogues.md
//
//   1. contrôle des valeurs de classe (classes-catalogue) : arrêt, sans rien importer, si des
//      documents sont à normaliser (« 4e »...) ou si des clés d'import sont en conflit ;
//   2. sauvegarde : export de toute la collection (GET .../lecons-officielles/export), enregistré
//      sur ce poste ;
//   3. pour chaque niveau : import, affichage de upserted / ignores, nouveau contrôle des classes,
//      comparaison du contenu en base au fichier, puis ARRÊT et confirmation avant le niveau suivant.
//
// La clé admin est saisie à l'écran (masquée) : jamais écrite dans un fichier, jamais affichée.
const fs = require('fs');
const path = require('path');
const {
  ErreurScript, validerUrl, demander, lireSecret, creerClient, comparerCatalogues, nbSeances,
  resumerClasses, detaillerConflits, controlerClasses
} = require('./lib/catalogue-admin');

const RACINE = path.resolve(__dirname, '..');
// Attendus fixés par l'enseignant (leçons importées par niveau) et séances en base après import.
const NIVEAUX = {
  3: { fichier: 'lecons_officielles_3e.json', classe: '3ème', lecons: 16, seances: 74 },
  4: { fichier: 'lecons_officielles_4e.json', classe: '4ème', lecons: 14, seances: 74 },
  5: { fichier: 'lecons_officielles_5e.json', classe: '5ème', lecons: 15, seances: 58 },
  6: { fichier: 'lecons_officielles_6e.json', classe: '6ème', lecons: 15, seances: 59 }
};

function usage() {
  return [
    'Usage : node scripts/importer-catalogues.js <url-du-serveur> [--niveaux 3,4,5,6] [--dossier-sauvegarde <dossier>]',
    '',
    '  <url-du-serveur>       obligatoire, ex. https://exemple.onrender.com (jamais de valeur par défaut)',
    '  --niveaux              niveaux à importer, dans l\'ordre (défaut : 3,4,5,6). Pour reprendre après un arrêt : --niveaux 5,6',
    '  --dossier-sauvegarde   où enregistrer l\'export de sauvegarde (défaut : dossier courant)',
    '',
    'La clé admin est demandée à l\'écran (saisie masquée).'
  ].join('\n');
}

function lireArguments(argv) {
  const r = { url: null, niveaux: [3, 4, 5, 6], dossier: process.cwd() };
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--niveaux') r.niveaux = String(argv[++i] || '').split(',').map((n) => Number(n.trim()));
    else if (argv[i] === '--dossier-sauvegarde') r.dossier = path.resolve(String(argv[++i] || ''));
    else if (argv[i] === '--help' || argv[i] === '-h') { console.log(usage()); process.exit(0); }
    else pos.push(argv[i]);
  }
  r.url = pos[0];
  if (!r.url) throw new ErreurScript(`URL du serveur manquante.\n\n${usage()}`);
  if (!r.niveaux.length || r.niveaux.some((n, i) => !NIVEAUX[n] || (i > 0 && n <= r.niveaux[i - 1]))) {
    throw new ErreurScript('--niveaux : valeurs parmi 3,4,5,6, en ordre croissant.');
  }
  return r;
}

function arreter(code, lignes) {
  console.log('');
  for (const l of lignes) console.log(l);
  process.exit(code);
}

async function main() {
  const args = lireArguments(process.argv.slice(2));
  const origine = validerUrl(args.url);
  console.log(`Serveur cible : ${origine}`);
  if (!fs.existsSync(args.dossier)) throw new ErreurScript(`Dossier de sauvegarde introuvable : ${args.dossier}`);
  for (const n of args.niveaux) {
    if (!fs.existsSync(path.join(RACINE, NIVEAUX[n].fichier))) throw new ErreurScript(`Fichier introuvable : ${NIVEAUX[n].fichier} (lancez le script depuis un dépôt à jour, branche de la PR #84).`);
  }
  const cle = await lireSecret('Clé admin (saisie masquée, rien ne s\'affiche) : ');
  if (!cle) throw new ErreurScript('Clé vide.');
  const client = creerClient(origine, cle);

  // ----- Étape 1 : contrôle des classes (avant tout) -----
  console.log('\n[1/3] Contrôle des valeurs de classe en base (lecture seule)...');
  const tous = [3, 4, 5, 6];
  let analyse = await controlerClasses(client, tous);
  console.log(`   ${resumerClasses(analyse)}`);
  if (analyse.aNormaliser > 0 || analyse.conflits.length > 0) {
    arreter(2, [
      'ARRÊT : rien n\'a été importé.',
      analyse.aNormaliser > 0 ? `   - ${analyse.aNormaliser} document(s) portent une classe non normalisée (« 4e », « 5eme »...) : l'import créerait des doublons.` : '',
      ...detaillerConflits(analyse),
      'Envoyez ce résultat avant de continuer.'
    ].filter(Boolean));
  }
  console.log('   OK : aucune classe à normaliser, aucun conflit.');

  // ----- Étape 2 : sauvegarde -----
  console.log('\n[2/3] Sauvegarde : export de toute la collection des leçons officielles (lecture seule)...');
  const exp = await client.get('/api/admin/lecons-officielles/export');
  if (!exp.ok || !exp.json || !Array.isArray(exp.json.lecons) || !exp.json.lecons.length) {
    throw new ErreurScript(`Export inattendu ou vide (HTTP ${exp.statut}) : aucune sauvegarde, rien n'a été importé.`);
  }
  const horodatage = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const fichierSauvegarde = path.join(args.dossier, `sauvegarde-lecons-officielles-${horodatage}.json`);
  fs.writeFileSync(fichierSauvegarde, JSON.stringify(exp.json, null, 2), { encoding: 'utf8', flag: 'wx' });
  const relu = JSON.parse(fs.readFileSync(fichierSauvegarde, 'utf8'));
  if (relu.lecons.length !== exp.json.nbDocuments) throw new ErreurScript('La sauvegarde relue ne correspond pas à l\'export : arrêt.');
  console.log(`   Sauvegarde enregistrée : ${fichierSauvegarde}`);
  console.log(`   ${relu.nbDocuments} leçons, ${relu.nbSeances} séances. CONSERVEZ ce fichier (retour arrière : scripts/retour-arriere-catalogues.js).`);
  if (args.niveaux[0] !== 3) console.log('   Attention : cette sauvegarde est faite APRÈS des imports précédents ; gardez aussi la toute première.');

  // ----- Étape 3 : un niveau à la fois -----
  for (let i = 0; i < args.niveaux.length; i++) {
    const n = args.niveaux[i];
    const cfg = NIVEAUX[n];
    const fichier = path.join(RACINE, cfg.fichier);
    const lecons = JSON.parse(fs.readFileSync(fichier, 'utf8'));
    if (lecons.length !== cfg.lecons || nbSeances(lecons) !== cfg.seances) {
      throw new ErreurScript(`${cfg.fichier} : ${lecons.length} leçons / ${nbSeances(lecons)} séances au lieu de ${cfg.lecons} / ${cfg.seances} attendues. Fichier modifié ? Arrêt.`);
    }
    const reponse = await demander(`\n[3/3] Importer la ${cfg.classe} (${cfg.lecons} leçons, ${cfg.seances} séances) ? Tapez oui pour continuer : `);
    if (reponse.toLowerCase() !== 'oui') arreter(0, [`Arrêt à votre demande avant la ${cfg.classe}. Sauvegarde : ${fichierSauvegarde}`]);

    const envoi = await client.post('/api/admin/lecons-officielles/seed', lecons);
    if (!envoi.ok || !envoi.json || envoi.json.success !== true) {
      arreter(3, [`ÉCHEC de l'import ${cfg.classe} : HTTP ${envoi.statut} ${(envoi.json && envoi.json.error) || ''}`, `Ne continuez pas. Retour arrière possible avec ${fichierSauvegarde}`]);
    }
    const { upserted, ignores } = envoi.json;
    console.log(`   ${cfg.classe} : upserted = ${upserted} (attendu ${cfg.lecons}), ignores = ${ignores} (attendu 0)`);
    if (upserted !== cfg.lecons || ignores !== 0) {
      arreter(3, ['ARRÊT : résultat différent de l\'attendu. Ne continuez pas.', `Retour arrière possible avec ${fichierSauvegarde}`]);
    }

    analyse = await controlerClasses(client, tous);
    console.log(`   Contrôle des classes : ${resumerClasses(analyse)}`);
    if (analyse.aNormaliser > 0 || analyse.conflits.length > 0) {
      arreter(3, ['ARRÊT : après l\'import, des classes sont à normaliser ou des conflits existent :', ...detaillerConflits(analyse), `Retour arrière possible avec ${fichierSauvegarde}`]);
    }

    const brut = await client.get(`/api/admin/lecons-officielles/brut?classe=${encodeURIComponent(`^${cfg.classe}$`)}`);
    if (!brut.ok || !Array.isArray(brut.json)) throw new ErreurScript(`Lecture de contrôle impossible (HTTP ${brut.statut}).`);
    const cmp = comparerCatalogues(lecons, brut.json);
    const seancesBase = nbSeances(brut.json);
    console.log(`   Contenu en base : ${brut.json.length} leçons, ${seancesBase} séances (attendu ${cfg.lecons} / ${cfg.seances}) ; identique au fichier : ${cmp.identiques ? 'oui' : 'NON'}`);
    if (!cmp.identiques || brut.json.length !== cfg.lecons || seancesBase !== cfg.seances) {
      arreter(3, ['ARRÊT : le contenu en base ne correspond pas au fichier.', ...cmp.manquantes.map((k) => `   manquante : ${k}`), ...cmp.differentes.map((k) => `   différente : ${k}`), `Retour arrière possible avec ${fichierSauvegarde}`]);
    }
    console.log(`   ✅ ${cfg.classe} importée et vérifiée. Ouvrez le formulaire (${cfg.classe}) pour contrôler les menus avant de continuer.`);
    if (i + 1 < args.niveaux.length) {
      console.log(`   Prochain niveau : ${NIVEAUX[args.niveaux[i + 1]].classe}. Pour reprendre plus tard : node scripts/importer-catalogues.js ${origine} --niveaux ${args.niveaux.slice(i + 1).join(',')}`);
    }
  }
  console.log(`\nTerminé. Sauvegarde conservée : ${fichierSauvegarde}`);
}

main().catch((e) => {
  console.error(e instanceof ErreurScript ? `\n${e.message}` : `\nErreur inattendue : ${e && e.message}`);
  process.exit(1);
});
