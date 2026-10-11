'use strict';
// Lot 12 -- MIROIR autonome (sans mongoose/express/@anthropic-ai/sdk) du
// validateur de fiche JSON du lot 10 et de ses dépendances (catalogue,
// correction orthographique déterministe), tel qu'il vit dans server.js
// (fonctions chargerCatalogueNiveau/obtenirLeconCatalogueJSON/
// obtenirSeanceCatalogueJSON/corrigerOrthographeFicheJSON/validerFicheJSON,
// section "Lot 9/10" de server.js). Nécessaire pour que
// scripts/import-bibliotheque.js --verifier puisse valider un fichier EN
// LOCAL, sans réseau et sans démarrer tout server.js (qui connecte Mongo,
// initialise l'Anthropic SDK et ouvre un port dès le require).
//
// ATTENTION -- DUPLICATION DÉLIBÉRÉE, PAS UN IMPORT PARTAGÉ : server.js
// définit ces mêmes fonctions en interne (jamais retiré de là, pour ne pas
// toucher au chemin de production -- cf. consigne explicite du lot 12 "ne
// touche pas au chemin legacy"). Toute évolution future du validateur
// sémantique côté serveur (nouvelle règle, nouveau défaut détecté) doit
// être reportée ICI aussi, sous peine que --verifier devienne optimiste par
// rapport à la vraie route POST /api/admin/fiche-bibliotheque. Copié
// verbatim depuis server.js au moment du lot 12 -- toute divergence
// constatée entre les deux doit être corrigée dans les deux fichiers.
const fs = require('fs');
const path = require('path');

const RACINE_DEPOT = path.join(__dirname, '..', '..');

function normaliserTexte(str) {
  return (str || '')
    .toString()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

const CATALOGUE_NIVEAU_CACHE = {};
function chargerCatalogueNiveau(codeNiveau) {
  if (Object.prototype.hasOwnProperty.call(CATALOGUE_NIVEAU_CACHE, codeNiveau)) return CATALOGUE_NIVEAU_CACHE[codeNiveau];
  const chemin = path.join(RACINE_DEPOT, 'catalogue', `${codeNiveau}.json`);
  let catalogue = null;
  try {
    catalogue = JSON.parse(fs.readFileSync(chemin, 'utf8'));
  } catch (e) {
    catalogue = null;
  }
  CATALOGUE_NIVEAU_CACHE[codeNiveau] = catalogue;
  return catalogue;
}
function obtenirLeconCatalogueJSON(catalogue, numeroLecon) {
  if (!catalogue) return null;
  return (catalogue.lecons || []).find((l) => l.numero === numeroLecon) || null;
}
function obtenirSeanceCatalogueJSON(leconCatalogue, numeroSeance) {
  if (!leconCatalogue) return null;
  return (leconCatalogue.seances || []).find((s) => s.numero === numeroSeance) || null;
}

// --- Taxonomie des verbes (cf. server.js, section VERBES_TAXONOMIQUES) ----
const VERBES_TAXONOMIQUES = {
  N1: { nom: 'Connaître', verbes: [{ verbe: 'identifier' }, { verbe: 'relever' }, { verbe: 'citer' }, { verbe: 'énumérer' }, { verbe: 'indiquer' }, { verbe: 'définir' }, { verbe: 'nommer' }, { verbe: 'trouver' }, { verbe: 'présenter' }] },
  N2: { nom: 'Comprendre', verbes: [{ verbe: 'déterminer' }, { verbe: 'formuler' }, { verbe: 'expliquer' }, { verbe: 'distinguer' }, { verbe: 'reformuler' }] },
  N3: { nom: 'Appliquer', verbes: [{ verbe: 'justifier' }, { verbe: 'analyser' }, { verbe: 'interpréter' }, { verbe: 'argumenter' }, { verbe: 'proposer' }, { verbe: 'appliquer' }, { verbe: 'classer' }, { verbe: 'comparer' }] },
  N4: { nom: 'Traiter une situation', verbes: [{ verbe: 'traiter une situation' }] }
};
const NIVEAUX_TAXONOMIQUES_ORDRE = ['N1', 'N2', 'N3', 'N4'];
const TOUS_VERBES_TAXONOMIQUES = NIVEAUX_TAXONOMIQUES_ORDRE.flatMap((n) => VERBES_TAXONOMIQUES[n].verbes.map((v) => v.verbe));
const EXCEPTIONS_IMPERATIF_SINGULIER = { relever: 'relève', 'énumérer': 'énumère', 'interpréter': 'interprète' };
function imperatifSingulierVerbeTaxonomique(verbeComplet) {
  const verbe = verbeComplet.split(/\s+/)[0].toLowerCase();
  if (EXCEPTIONS_IMPERATIF_SINGULIER[verbe]) return EXCEPTIONS_IMPERATIF_SINGULIER[verbe];
  if (/ir$/i.test(verbe)) return verbe.slice(0, -2) + 'is';
  if (/er$/i.test(verbe)) return verbe.slice(0, -2) + 'e';
  return verbe;
}

// --- Correction orthographique déterministe (lot 10) -----------------------
const FAUTES_ORTHOGRAPHE_FREQUENTES_LOT10 = [
  { motif: /\bheroïque(s?)\b/g, correction: 'héroïque$1' },
  { motif: /\btradionnel(s?)\b/g, correction: 'traditionnel$1' }
];
function corrigerOrthographeValeur(valeur) {
  if (typeof valeur !== 'string') return valeur;
  let corrigee = valeur;
  FAUTES_ORTHOGRAPHE_FREQUENTES_LOT10.forEach(({ motif, correction }) => { corrigee = corrigee.replace(motif, correction); });
  return corrigee;
}
function corrigerOrthographeFicheJSON(valeur) {
  if (Array.isArray(valeur)) return valeur.map(corrigerOrthographeFicheJSON);
  if (valeur && typeof valeur === 'object') {
    const copie = {};
    Object.keys(valeur).forEach((cle) => { copie[cle] = corrigerOrthographeFicheJSON(valeur[cle]); });
    return copie;
  }
  return corrigerOrthographeValeur(valeur);
}

// --- Validation sémantique (lots 9-10) --------------------------------------
const VERBES_3E_PERSONNE_INTERDITS_DANS_DEMANDE = /^(Fait|Écrit|Distribue|Lit|Divise|Circule|Invite|Présente\s+le|Annonce|Accorde|Ramasse|Pose|Salue|Répond)\b/;
const EN_WORDS_RE_LOT9 = /(?<![A-Za-zÀ-ÿ])(the|and|of|with|which|because|should|answer|student|teacher|expected|imagined|for|example|like|from|about|your|into|also)(?![A-Za-zÀ-ÿ])/i;
const MOTIFS_CORRIGE_INTERDIT_LOT9 = [
  { re: /(?<![A-Za-zÀ-ÿ])OU(?![A-Za-zÀ-ÿ])/, message: '« OU » (majuscules) -- réponse non unique' },
  { re: /on peut aussi|également adapt|bonus|accepté|accepte aussi|préférable|plusieurs réponses|exemple pour l'extrait/i, message: 'corrigé à réponses multiples / méta-commentaire' },
  { re: /l['’]élève doit|sans justification\b.{0,20}\.|note\s*:/i, message: 'méta-texte dans le corrigé' }
];
const VERBES_TU_IMPERATIF_IRREGULIERS_LOT10 = { lire: 'lis' };
function texteCommenceParVerbeTuImperatifOuQuestion(texte) {
  const brut = (texte || '').trim();
  if (/\?\s*$/.test(brut)) return true;
  const premierMot = (brut.split(/\s+/)[0] || '').toLowerCase().replace(/[.,;:!?»]+$/, '');
  if (TOUS_VERBES_TAXONOMIQUES.some((v) => imperatifSingulierVerbeTaxonomique(v).toLowerCase() === premierMot)) return true;
  return Object.values(VERBES_TU_IMPERATIF_IRREGULIERS_LOT10).some((forme) => forme === premierMot);
}
const MOTIF_ATTRIBUTION_EXTRAIT_FICTIVE_LOT10 = /\bextraits?\s+(?:du|de\s+l['’]|de\s+la|des|d['’])\s+(?:conte|roman|nouvelle|[ée]pop[ée]e|œuvre|livre|r[ée]cit)s?\s+(?:[a-zéèàîïôûâêç]+\s+)?[A-ZÉÈÀÎ][^.]{0,60}:\s*«/;
const MOTIF_REFERENCE_TEXTE_NON_FOURNI_LOT10 = /\bces\s+(?:textes?|r[ée]cits?)\b|\bd[ée]couverts?\s+(?:à|a)\s+la\s+biblioth[èe]que\b|\bci-dessus\b/i;
const VERBES_N4_REPONSE_NON_UNIQUE_LOT10 = /^(Propose|Imagine|Donne\s+ton\s+avis|Choisis)\b/i;
const MOTIF_BIBLIOGRAPHIE_GENERIQUE_LOT10 = /manuels?\s+scolaires?|collectifs?\s+et\s+traduits?|ouvrages?\s+divers|anthologies?\s+diverses?/i;

function validerFicheJSON(ficheJSON, seanceCatalogue) {
  const erreurs = [];
  const ajoute = (section, message) => erreurs.push({ section, message });

  const verifierActionsEnseignant = (actions, section) => {
    (actions || []).forEach((a) => {
      if (a.type !== 'demande') return;
      const texte = (a.texte || '').trim();
      if (VERBES_3E_PERSONNE_INTERDITS_DANS_DEMANDE.test(texte)) {
        ajoute(section, `action type="demande" commence par un verbe à la 3e personne : "${texte.slice(0, 60)}"`);
      }
      if (/\b(Analyse|Identifie|Relève|Cite|Explique|D[ée]termine|Distingue|[ÉE]num[èe]re|Pr[ée]sente|Compare|Classe|Justifie|Interpr[èe]te|Argumente)\b[^.?!]*\b(votre|identifiez|relevez|citez|analysez|d[ée]terminez|distinguez|[ée]num[ée]rez|pr[ée]sentez|comparez|classez|justifiez|interpr[ée]tez|argumentez)\b/i.test(texte)) {
        ajoute(section, `mélange tu/vous dans une consigne : "${texte.slice(0, 60)}"`);
      }
    });
  };

  verifierActionsEnseignant(ficheJSON.presentation && ficheJSON.presentation.enseignant, 'presentation');

  const toutesLesTraces = [];
  (ficheJSON.developpement || []).forEach((partie, i) => {
    const section = `developpement[${i}]`;
    if (!partie.titre || !partie.titre.trim()) ajoute(section, 'titre vide');
    if (!Array.isArray(partie.traces) || partie.traces.length < 2) ajoute(section, 'traces insuffisantes (moins de 2 blocs)');
    verifierActionsEnseignant(partie.enseignant, section);
    (partie.traces || []).forEach((bloc) => {
      toutesLesTraces.push([bloc.texte, ...(bloc.items || [])].filter(Boolean).join(' '));
    });
  });
  const texteTracesConcatene = normaliserTexte(toutesLesTraces.join(' '));

  const consignes = (ficheJSON.evaluation && ficheJSON.evaluation.consignes) || [];
  if (consignes.length !== 3) ajoute('evaluation', `${consignes.length} consigne(s) au lieu de 3`);
  // Lot 13 (server.js) : "N1/N2" (littéral) est accepté pour la 1re consigne
  // depuis le lot 13 (modèles de séance, lecture méthodique) -- reporté ici
  // pour rester synchronisé, cf. l'avertissement de duplication en tête de
  // ce fichier.
  const niveauxAttendus = [['N1', 'N2', 'N1/N2'], ['N3'], ['N4']];
  consignes.forEach((c, j) => {
    const section = `evaluation.consignes[${j}]`;
    if (niveauxAttendus[j] && !niveauxAttendus[j].includes(c.niveau)) {
      ajoute(section, `niveau "${c.niveau}" attendu parmi ${niveauxAttendus[j].join('/')}`);
    }
    if (!texteCommenceParVerbeTuImperatifOuQuestion(c.enonce)) {
      ajoute(section, `énoncé ne commence pas par un verbe à l'impératif "tu" : "${(c.enonce || '').slice(0, 60)}"`);
    }
    MOTIFS_CORRIGE_INTERDIT_LOT9.forEach(({ re, message }) => { if (re.test(c.corrige || '')) ajoute(section, `corrigé : ${message}`); });
    if (c.extrait && c.extrait.trim() && texteTracesConcatene.includes(normaliserTexte(c.extrait.trim()))) {
      ajoute(section, "extrait d'évaluation identique à un extrait déjà utilisé dans le développement");
    }
    if (MOTIF_REFERENCE_TEXTE_NON_FOURNI_LOT10.test(c.enonce || '') && !(c.extrait && c.extrait.trim())) {
      ajoute(section, `consigne non autonome -- renvoie à un texte non fourni ("extrait" vide) : "${(c.enonce || '').slice(0, 80)}"`);
    }
    if (c.niveau === 'N4' && VERBES_N4_REPONSE_NON_UNIQUE_LOT10.test((c.enonce || '').trim())) {
      ajoute(section, `consigne N4 à réponse non unique (verbe d'ouverture interdit pour ce niveau) : "${(c.enonce || '').slice(0, 80)}"`);
    }
  });

  const texteComplet = JSON.stringify(ficheJSON);
  if (EN_WORDS_RE_LOT9.test(texteComplet)) {
    const trouves = texteComplet.match(new RegExp(EN_WORDS_RE_LOT9.source, 'gi')) || [];
    ajoute('global', `mot(s) anglais détecté(s) : ${[...new Set(trouves.map((m) => m.toLowerCase()))].join(', ')}`);
  }
  const texteSituationEtEnonces = [ficheJSON.situation, ...consignes.map((c) => c.enonce)].filter(Boolean).join(' ');
  if (/\ben\s+vers\b/i.test(texteSituationEtEnonces)) ajoute('global', '"en vers" mentionné dans la situation ou un énoncé (séance exclusivement en prose)');
  if (/\d+\s*pages?\b/i.test(texteComplet)) ajoute('global', 'nombre de pages inventé détecté');
  if (/activit[ée]\s+est\s+la\s+lecture|notre\s+activit[ée][^.?!]{0,20}[:»]?\s*lecture\b/i.test(texteComplet)) {
    ajoute('global', 'activité nommée "Lecture" au lieu de "Étude de l\'œuvre intégrale"');
  }
  if (MOTIF_ATTRIBUTION_EXTRAIT_FICTIVE_LOT10.test(texteComplet)) {
    ajoute('global', "un extrait est attribué à une œuvre réelle nommée (ex. « extrait du conte X ») -- utilisez une attribution neutre (\"Extraits composés pour la séance.\"), jamais un titre/auteur précis non vérifiable");
  }
  const notionsInterdites = (seanceCatalogue.notions_interdites_dans_situation || []);
  const situationNormalisee = normaliserTexte(ficheJSON.situation || '');
  notionsInterdites.forEach((n) => {
    const nNormalise = normaliserTexte(n);
    if (nNormalise && situationNormalisee.includes(nNormalise)) ajoute('situation', `la situation mentionne la notion interdite "${n}"`);
  });

  const supports = (ficheJSON.supports || []).filter((s) => s && s.trim());
  const bibliographie = (ficheJSON.bibliographie || []).filter((b) => b && b.trim());
  if (supports.length < 2) ajoute('global', `supports didactiques insuffisants (${supports.length}, attendu au moins 2)`);
  if (bibliographie.length < 2) ajoute('global', `bibliographie insuffisante (${bibliographie.length}, attendu au moins 2)`);
  bibliographie.forEach((entree) => {
    if (MOTIF_BIBLIOGRAPHIE_GENERIQUE_LOT10.test(entree)) {
      ajoute('global', `entrée de bibliographie trop générique (ni titre ni auteur identifiable) : "${entree}"`);
    }
  });

  return { valide: erreurs.length === 0, erreurs };
}

module.exports = {
  chargerCatalogueNiveau,
  obtenirLeconCatalogueJSON,
  obtenirSeanceCatalogueJSON,
  corrigerOrthographeFicheJSON,
  validerFicheJSON
};
