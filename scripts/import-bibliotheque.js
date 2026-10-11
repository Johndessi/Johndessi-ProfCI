#!/usr/bin/env node
'use strict';
// Lot 12 -- importe dans la bibliothèque de fiches (lot 11) des fichiers
// JSON {niveau, discipline, activite, lecon, seance, fiche} lus depuis un
// dossier local, sans écrire de curl à la main. Node natif uniquement
// (fetch/AbortController globaux depuis Node 18) -- aucune dépendance
// ajoutée au projet. Usage et détails : voir scripts/README-import.md.
const fs = require('fs');
const path = require('path');
const {
  chargerCatalogueNiveau, obtenirLeconCatalogueJSON, obtenirSeanceCatalogueJSON,
  corrigerOrthographeFicheJSON, validerFicheJSON
} = require('./lib/fiche-validateur');

const URL_PAR_DEFAUT = 'https://johndessi-profci.onrender.com';
const TIMEOUT_RESEAU_MS = 60000;
const DELAI_RETRY_MS = 3000;

function afficherUsage() {
  return [
    'Usage : node scripts/import-bibliotheque.js <dossier> [--url <url>] [--verifier]',
    '',
    '  <dossier>    dossier local contenant les fichiers *.json à importer',
    '               (chacun de la forme {niveau, discipline, activite, lecon, seance, fiche})',
    `  --url        URL de base du serveur (défaut : ${URL_PAR_DEFAUT})`,
    '  --verifier   valide chaque fichier EN LOCAL (validateur du lot 10), sans réseau et sans clé',
    '',
    'Sans --verifier, la variable d\'environnement ADMIN_SEED_KEY doit être définie',
    '(jamais affichée -- ni ici, ni dans les logs, ni dans les messages d\'erreur).'
  ].join('\n');
}

function analyserArguments(argv) {
  const resultat = { dossier: null, url: URL_PAR_DEFAUT, verifier: false };
  const positionnels = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--verifier') { resultat.verifier = true; continue; }
    if (a === '--url') { resultat.url = argv[++i]; continue; }
    positionnels.push(a);
  }
  resultat.dossier = positionnels[0] || null;
  return resultat;
}

function listerFichiersJSON(dossier) {
  return fs.readdirSync(dossier)
    .filter((f) => f.toLowerCase().endsWith('.json'))
    .sort((a, b) => a.localeCompare(b, 'fr'));
}

function delai(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function formaterErreurs(erreurs) {
  if (!Array.isArray(erreurs) || !erreurs.length) return '';
  return erreurs.map((e) => `${e.section}: ${e.message}`).join(' ; ');
}

// Champs attendus par la route (cf. POST /api/admin/fiche-bibliotheque, lot
// 11) -- vérifiés ICI, avant tout envoi réseau ou toute recherche catalogue,
// pour distinguer clairement "fichier mal formé" d'un vrai refus de la route.
function champsEnveloppeManquants(contenu) {
  return ['niveau', 'discipline', 'activite', 'lecon', 'seance', 'fiche']
    .filter((c) => contenu[c] === undefined || contenu[c] === null || contenu[c] === '');
}

function lireEtParserJSON(cheminComplet) {
  const texte = fs.readFileSync(cheminComplet, 'utf8');
  return JSON.parse(texte);
}

// --- Mode --verifier : validateur du lot 10 en local, aucun réseau ---------
function verifierFichierEnLocal(contenu) {
  const niveauN = String(contenu.niveau).trim();
  const leconN = parseInt(contenu.lecon, 10);
  const seanceN = parseInt(contenu.seance, 10);
  const catalogue = chargerCatalogueNiveau(niveauN);
  const leconCatalogue = obtenirLeconCatalogueJSON(catalogue, leconN);
  const seanceCatalogue = obtenirSeanceCatalogueJSON(leconCatalogue, seanceN);
  if (!catalogue || !leconCatalogue || !seanceCatalogue) {
    return { resultat: 'refusé', detail: `leçon/séance introuvable dans le catalogue (${niveauN}, leçon ${contenu.lecon}, séance ${contenu.seance})` };
  }
  const ficheCorrigee = corrigerOrthographeFicheJSON(contenu.fiche);
  const { valide, erreurs } = validerFicheJSON(ficheCorrigee, seanceCatalogue);
  if (!valide) return { resultat: 'invalide', detail: formaterErreurs(erreurs) };
  return { resultat: 'valide', detail: '' };
}

// --- Mode import réel : POST vers la route, avec retry réseau unique ------
async function posterFiche(urlComplete, cleAdmin, corps) {
  const controller = new AbortController();
  const minuteur = setTimeout(() => controller.abort(), TIMEOUT_RESEAU_MS);
  try {
    const reponse = await fetch(urlComplete, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-key': cleAdmin },
      body: JSON.stringify(corps),
      signal: controller.signal
    });
    const json = await reponse.json().catch(() => null);
    return { status: reponse.status, json };
  } finally {
    clearTimeout(minuteur);
  }
}

// Une seule reprise, et UNIQUEMENT sur erreur réseau (fetch qui rejette --
// timeout, connexion refusée, DNS...) : une réponse HTTP reçue, même 4xx/5xx,
// n'est jamais une exception ici et ne doit jamais être rejouée. Render peut
// être endormi et ne répondre qu'au 2e essai.
async function posterFicheAvecRetry(urlComplete, cleAdmin, corps) {
  try {
    return await posterFiche(urlComplete, cleAdmin, corps);
  } catch (e) {
    await delai(DELAI_RETRY_MS);
    return await posterFiche(urlComplete, cleAdmin, corps);
  }
}

async function importerFichierVersServeur(contenu, url, cleAdmin) {
  let reponse;
  try {
    reponse = await posterFicheAvecRetry(`${url.replace(/\/+$/, '')}/api/admin/fiche-bibliotheque`, cleAdmin, contenu);
  } catch (e) {
    return { resultat: 'refusé', detail: `erreur réseau (après une reprise) -- ${e.message}` };
  }
  if (reponse.status === 401) {
    return { resultat: 'refusé', detail: 'non autorisé (401) -- vérifiez ADMIN_SEED_KEY' };
  }
  if (!reponse.json || reponse.json.success !== true) {
    const detail = (reponse.json && Array.isArray(reponse.json.erreurs) && formaterErreurs(reponse.json.erreurs))
      || (reponse.json && reponse.json.error)
      || `statut HTTP ${reponse.status}`;
    return { resultat: 'refusé', detail };
  }
  const version = reponse.json.version;
  return { resultat: version === 1 ? 'créé' : `mis à jour v${version}`, detail: '' };
}

// --- Traitement d'un fichier, mode indifférent -----------------------------
async function traiterUnFichier(nomFichier, cheminComplet, args, cleAdmin) {
  let contenu;
  try {
    contenu = lireEtParserJSON(cheminComplet);
  } catch (e) {
    return { nomFichier, seance: '?', resultat: 'refusé', detail: `JSON invalide -- ${e.message}` };
  }
  const manquants = champsEnveloppeManquants(contenu);
  const seanceAffichee = contenu && contenu.seance != null ? contenu.seance : '?';
  if (manquants.length) {
    return { nomFichier, seance: seanceAffichee, resultat: 'refusé', detail: `structure invalide -- champ(s) manquant(s) : ${manquants.join(', ')}` };
  }
  const { resultat, detail } = args.verifier
    ? verifierFichierEnLocal(contenu)
    : await importerFichierVersServeur(contenu, args.url, cleAdmin);
  return { nomFichier, seance: seanceAffichee, resultat, detail };
}

async function main() {
  const args = analyserArguments(process.argv.slice(2));
  if (!args.dossier) {
    console.error(afficherUsage());
    process.exit(1);
    return;
  }
  if (!fs.existsSync(args.dossier) || !fs.statSync(args.dossier).isDirectory()) {
    console.error(`Dossier introuvable : ${args.dossier}`);
    process.exit(1);
    return;
  }

  let cleAdmin = null;
  if (!args.verifier) {
    cleAdmin = process.env.ADMIN_SEED_KEY;
    if (!cleAdmin) {
      console.error(
        "ADMIN_SEED_KEY absente de l'environnement -- arrêt (jamais de valeur par défaut).\n" +
        "Définissez-la puis relancez (ex. Windows cmd : set ADMIN_SEED_KEY=...), ou utilisez --verifier pour valider sans réseau ni clé."
      );
      process.exit(1);
      return;
    }
  }

  const fichiers = listerFichiersJSON(args.dossier);
  if (!fichiers.length) {
    console.log(`Aucun fichier .json trouvé dans ${args.dossier}.`);
    process.exit(0);
    return;
  }

  console.log(args.verifier
    ? `Vérification locale de ${fichiers.length} fichier(s) dans ${args.dossier} (validateur du lot 10, aucun réseau)...\n`
    : `Import de ${fichiers.length} fichier(s) depuis ${args.dossier} vers ${args.url}...\n`);

  let nbEchecs = 0;
  for (const nomFichier of fichiers) {
    const cheminComplet = path.join(args.dossier, nomFichier);
    let resultat;
    try {
      resultat = await traiterUnFichier(nomFichier, cheminComplet, args, cleAdmin);
    } catch (e) {
      // Un fichier qui échoue de façon inattendue ne doit jamais interrompre
      // les autres -- capturé ici en dernier recours.
      resultat = { nomFichier, seance: '?', resultat: 'refusé', detail: `erreur inattendue -- ${e.message}` };
    }
    const estEchec = resultat.resultat === 'refusé' || resultat.resultat === 'invalide';
    if (estEchec) nbEchecs++;
    const ligne = `${resultat.nomFichier} (séance ${resultat.seance}) : ${resultat.resultat}` + (resultat.detail ? ` -- ${resultat.detail}` : '');
    console.log((estEchec ? '❌ ' : '✅ ') + ligne);
  }

  console.log(`\n${fichiers.length - nbEchecs}/${fichiers.length} fichier(s) ${args.verifier ? 'valide(s)' : 'importé(s) avec succès'}.`);
  process.exit(nbEchecs > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('Erreur inattendue :', e.message);
  process.exit(1);
});
