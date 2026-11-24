// Génération d'une leçon entière (Grammaire / Orthographe, 6ème à 3ème).
//
// Ce module ne contient AUCUN accès base de données ni appel Anthropic : seulement
// (1) la règle d'éligibilité d'une leçon et (2) le gestionnaire en mémoire des
// « jetons de lot » qui exemptent les générations d'un lot du limiteur
// d'IP (10 générations / 10 min, cf. limiterGenerationParIp dans server.js).
//
// Garanties du jeton de lot (toutes vérifiées ici, jamais côté navigateur) :
//   - créé par le serveur, seulement après vérification que TOUTES les séances
//     du lot sont éligibles (cf. verifierLeconEligible) ;
//   - valable pour au plus N générations, N = nombre de séances du lot, une par
//     séance, chacune utilisable UNE seule fois (usage unique) ;
//   - les séances doivent être demandées dans l'ordre (le rappel de séance a
//     besoin de la fiche précédente déjà enregistrée) ;
//   - courte durée (30 min par défaut), liée à l'IP et à l'enseignant ;
//   - un seul lot actif à la fois par utilisateur (IP + enseignant), plafond de
//     lots simultanés et de créations par heure et par IP (sinon créer des lots
//     en boucle contournerait le limiteur) ;
//   - dès qu'une séance échoue, le lot est clos : la reprise = un NOUVEAU lot
//     pour les seules séances restantes.
const crypto = require('crypto');

const ACTIVITES_LOT_SANS_SUPPORT = ['grammaire', 'orthographe'];
const CLASSES_LOT = ['6eme', '5eme', '4eme', '3eme'];
const LOT_MAX_SEANCES = 12;
const LOT_DUREE_MS = 30 * 60 * 1000;
const LOT_MAX_CREATIONS_PAR_HEURE_PAR_IP = 6;
const LOT_MAX_SIMULTANES_PAR_IP = 3;

function normaliser(str) {
  return (str || '')
    .toString()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

// Point UNIQUE à modifier quand la PR #84 sera fusionnée et son import fait en
// production : la séance expose alors `typeSupport` (matrices
// catalogue/matrices/) et la règle devient `seance.typeSupport ===
// 'aucun_requis_corpus_catalogue'`. En attendant, l'éligibilité repose sur
// l'activité (Grammaire / Orthographe : aucun support requis pour TOUTES les
// séances de ces activités, d'après les matrices 6e à 3e).
function seanceSansSupport(seance, activite) {
  void seance;
  return ACTIVITES_LOT_SANS_SUPPORT.includes(normaliser(activite));
}

// `lecon` : une entrée de listerLeconsOfficielles() (séances déjà filtrées sur
// l'activité demandée, séances à choix déjà développées en plusieurs entrées).
function verifierLeconEligible(lecon, { classe, activite, niveau }) {
  if (normaliser(niveau) !== 'secondaire') return { ok: false, message: 'Génération de leçon entière réservée au collège (6ème à 3ème).' };
  if (!CLASSES_LOT.includes(normaliser(classe))) return { ok: false, message: 'Classe non éligible (6ème à 3ème uniquement).' };
  if (!ACTIVITES_LOT_SANS_SUPPORT.includes(normaliser(activite))) return { ok: false, message: 'Activité non éligible (Grammaire et Orthographe uniquement).' };
  const seances = (lecon && lecon.seances) || [];
  if (!seances.length) return { ok: false, message: 'Aucune séance dans cette leçon.' };
  if (seances.length > LOT_MAX_SEANCES) return { ok: false, message: `Leçon trop longue pour un lot (${seances.length} séances, maximum ${LOT_MAX_SEANCES}).` };
  const numeros = new Set();
  for (const s of seances) {
    if (!seanceSansSupport(s, activite)) return { ok: false, message: `La séance ${s.numeroSeance} exige un support : leçon non éligible.` };
    if (s.choixLibre || s.optionChoisie) return { ok: false, message: `La séance ${s.numeroSeance} demande un choix de l'enseignant : leçon non éligible.` };
    if (numeros.has(s.numeroSeance)) return { ok: false, message: `Numéro de séance en double (${s.numeroSeance}) : leçon non éligible.` };
    numeros.add(s.numeroSeance);
  }
  return { ok: true };
}

function creerGestionnaireLots({
  maintenant = () => Date.now(),
  dureeMs = LOT_DUREE_MS,
  maxCreationsParHeureParIp = LOT_MAX_CREATIONS_PAR_HEURE_PAR_IP,
  maxSimultanesParIp = LOT_MAX_SIMULTANES_PAR_IP
} = {}) {
  const lots = new Map();            // jeton -> lot
  const creationsParIp = new Map();  // ip -> [horodatages]

  const cleEnseignant = (id) => (id || 'anonyme').toString().trim() || 'anonyme';
  const actif = (lot) => !lot.clos && lot.expireA > maintenant();

  function purger() {
    const t = maintenant();
    for (const [jeton, lot] of lots) if (lot.expireA <= t - 60 * 1000) lots.delete(jeton);
  }

  // `seances` : [{ seanceId, numero, intitule }] dans l'ordre à générer.
  function creerLot({ ip, enseignantId, leconId, classe, activite, seances }) {
    purger();
    const ens = cleEnseignant(enseignantId);
    if (!seances || !seances.length) return { ok: false, code: 'vide', message: 'Aucune séance à générer.' };
    const actifs = [...lots.values()].filter(actif);
    if (actifs.some((l) => l.ip === ip && l.enseignantId === ens)) {
      return { ok: false, code: 'lot_en_cours', message: 'Un lot est déjà en cours pour ce compte. Attends sa fin ou arrête-le avant d\'en lancer un autre.' };
    }
    if (actifs.filter((l) => l.ip === ip).length >= maxSimultanesParIp) {
      return { ok: false, code: 'trop_de_lots', message: 'Trop de lots simultanés depuis cette connexion.' };
    }
    const t = maintenant();
    const recents = (creationsParIp.get(ip) || []).filter((h) => t - h < 60 * 60 * 1000);
    if (recents.length >= maxCreationsParHeureParIp) {
      return { ok: false, code: 'quota_lots', message: `Trop de lots créés en une heure depuis cette connexion (maximum ${maxCreationsParHeureParIp}).` };
    }
    recents.push(t);
    creationsParIp.set(ip, recents);
    const jeton = crypto.randomBytes(24).toString('hex');
    const lot = {
      jeton, ip, enseignantId: ens, leconId: String(leconId), classe: normaliser(classe), activite: normaliser(activite),
      creeA: t, expireA: t + dureeMs, clos: false,
      seances: seances.map((s) => ({ seanceId: String(s.seanceId), numero: s.numero, intitule: s.intitule, etat: 'attente' }))
    };
    lots.set(jeton, lot);
    return { ok: true, jeton, expireA: lot.expireA, nbFiches: lot.seances.length };
  }

  // Appelé par le limiteur AVANT la génération. Réserve la prochaine séance du
  // lot (usage unique) ou refuse avec un message affichable tel quel.
  function reserverSeance({ jeton, ip, enseignantId, leconId, seanceId, classe, activite }) {
    purger();
    const lot = lots.get(String(jeton || ''));
    if (!lot) return { ok: false, message: 'Lot inconnu ou expiré. Relance « Générer toute la leçon ».' };
    if (lot.expireA <= maintenant()) { lot.clos = true; return { ok: false, message: 'Lot expiré. Relance « Générer toute la leçon ».' }; }
    if (lot.clos) return { ok: false, message: 'Ce lot est terminé ou interrompu. Relance « Générer toute la leçon ».' };
    if (lot.ip !== ip) return { ok: false, message: 'Lot lié à une autre connexion.' };
    if (lot.enseignantId !== cleEnseignant(enseignantId)) return { ok: false, message: 'Lot lié à un autre enseignant.' };
    if (lot.leconId !== String(leconId || '')) return { ok: false, message: 'Cette séance n\'appartient pas à la leçon du lot.' };
    if (lot.classe !== normaliser(classe) || lot.activite !== normaliser(activite)) return { ok: false, message: 'Classe ou activité différente de celles du lot.' };
    const suivante = lot.seances.find((s) => s.etat !== 'faite');
    if (!suivante || suivante.etat !== 'attente') return { ok: false, message: 'Une génération du lot est déjà en cours ou le lot est terminé.' };
    if (suivante.seanceId !== String(seanceId || '')) return { ok: false, message: 'Les séances du lot doivent être générées dans l\'ordre.' };
    suivante.etat = 'en_cours';
    return { ok: true, lot, seance: suivante };
  }

  function marquerFaite(jeton, seanceId) {
    const lot = lots.get(jeton);
    if (!lot) return;
    const s = lot.seances.find((x) => x.seanceId === String(seanceId));
    if (s) s.etat = 'faite';
    if (lot.seances.every((x) => x.etat === 'faite')) lot.clos = true;
  }

  // Première séance en échec (ou réponse coupée) : le lot est clos, plus aucune
  // exemption possible avec ce jeton.
  function marquerEchec(jeton, seanceId) {
    const lot = lots.get(jeton);
    if (!lot) return;
    const s = lot.seances.find((x) => x.seanceId === String(seanceId));
    if (s && s.etat === 'en_cours') s.etat = 'echec';
    lot.clos = true;
  }

  function abandonner({ jeton, ip }) {
    const lot = lots.get(String(jeton || ''));
    if (!lot || lot.ip !== ip) return false;
    lot.clos = true;
    return true;
  }

  return { creerLot, reserverSeance, marquerFaite, marquerEchec, abandonner, _lots: lots };
}

module.exports = {
  ACTIVITES_LOT_SANS_SUPPORT, CLASSES_LOT, LOT_MAX_SEANCES, LOT_DUREE_MS,
  seanceSansSupport, verifierLeconEligible, creerGestionnaireLots
};
