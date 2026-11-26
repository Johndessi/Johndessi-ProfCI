// Mise en page DOCX « modèle A » (A4 paysage) des fiches de GRAMMAIRE -- et de
// la Grammaire seulement. Aucune autre activité ne passe par ce module.
//
// Principe : le HTML de la fiche (déjà stocké, déjà corrigé par
// preparerContenuExportFiche) est DÉCOUPÉ en blocs (en-tête, corpus,
// Habiletés/Contenus, Supports/Bibliographie, tableau principal à 3 phases,
// annexe), puis reconstruit avec la librairie docx.
//
// Garde-fou central : si le HTML ne se découpe pas exactement comme prévu
// (balises absentes, phase introuvable, repli « I- / II- » qui ne trouve rien,
// situation d'apprentissage absente...), `genererDocxGrammaireModeleA` LÈVE une
// ErreurDecoupageGrammaire et l'appelant retombe sur l'ancien DOCX
// (genererDocxDepuisHtml, inchangé) -- jamais une mise en page cassée.
//
// Aucun accès base de données, aucun appel Anthropic.
const cheerio = require('cheerio');
const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, WidthType,
  PageOrientation, BorderStyle, AlignmentType, TableLayoutType, VerticalAlign,
  UnderlineType, LineRuleType
} = require('docx');

class ErreurDecoupageGrammaire extends Error {}
const echec = (message) => { throw new ErreurDecoupageGrammaire(message); };

// ---------------------------------------------------------------- constantes
const TWIPS_PAR_CM = 566.929;
const cm = (x) => Math.round(x * TWIPS_PAR_CM);
const MARGE_PAGE = 680;                       // ≈ 1,2 cm
const LARGEURS_PRINCIPAL_CM = [3.4, 4.8, 7.0, 4.9, 7.1]; // total 27,2 cm
const COLONNES_PRINCIPAL = LARGEURS_PRINCIPAL_CM.map(cm);
const LARGEUR_TABLEAUX = COLONNES_PRINCIPAL.reduce((a, b) => a + b, 0);
const LARGEUR_UTILE_PAGE = 16838 - 2 * MARGE_PAGE; // A4 paysage
const MARGE_CELLULE_GD = 108;                 // 0,19 cm (défaut Word)
const POLICE = 'Times New Roman';
const TAILLE_CORPS = 19;                      // 9,5 pt (demi-points)
const TAILLE_TITRE = 22;
const BORD = { style: BorderStyle.SINGLE, size: 4, color: '000000' }; // 0,5 pt
const BORDURES = { top: BORD, bottom: BORD, left: BORD, right: BORD, insideHorizontal: BORD, insideVertical: BORD };
const AUCUN = { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' };
const SANS_BORDURE = { top: AUCUN, bottom: AUCUN, left: AUCUN, right: AUCUN, insideHorizontal: AUCUN, insideVertical: AUCUN };
const ENTETES_PRINCIPAL = ['Moments didactiques/Durée', 'Stratégies/Supports/Plan du cours', 'Activités enseignant', 'Activités apprenants', 'Traces écrites'];

function norm(s) {
  return (s || '').toString().normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

// -------------------------------------------------- lecture du HTML en lignes
// Une « ligne » = un paragraphe du DOCX : { segs: [{text, bold, italic, underline}], blancAvant }.
// Séparateurs : <br>, éléments de bloc, et un retour à la ligne SUIVI de « - »
// (le squelette de fiche sépare ainsi ses actions). Tout autre retour à la
// ligne du source HTML est un simple espace.
const BLOCS = new Set(['p', 'div', 'li', 'ul', 'ol', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'tr']);

function collecterLignes($, racine) {
  const lignes = [];
  let courante = [];
  let blancAvant = false;
  const nonVide = (segs) => segs.some((s) => s.text.trim() !== '');
  const fermer = () => {
    const segs = courante.map((s) => ({ ...s }));
    if (segs.length) {
      segs[0].text = segs[0].text.replace(/^\s+/, '');
      segs[segs.length - 1].text = segs[segs.length - 1].text.replace(/\s+$/, '');
    }
    const utiles = segs.filter((s) => s.text !== '');
    if (utiles.length) { lignes.push({ segs: utiles, blancAvant }); blancAvant = false; }
    courante = [];
  };
  const coupure = () => { if (nonVide(courante)) fermer(); else courante = []; };
  const saut = () => { if (nonVide(courante)) fermer(); else { courante = []; if (lignes.length) blancAvant = true; } };

  const parcourir = (noeud, fmt) => {
    $(noeud).contents().each((_, enfant) => {
      if (enfant.type === 'text') {
        const brut = (enfant.data || '').replace(/[ \t\r\f\v]+/g, ' ');
        brut.split(/\n\s*(?=-\s)/).forEach((morceau, i) => {
          if (i > 0) coupure();
          const texte = morceau.replace(/\s*\n\s*/g, ' ');
          if (texte !== '') courante.push({ text: texte, bold: !!fmt.bold, italic: !!fmt.italic, underline: !!fmt.underline });
        });
      } else if (enfant.type === 'tag') {
        const tag = enfant.name.toLowerCase();
        if (tag === 'br') { saut(); return; }
        if (tag === 'script' || tag === 'style') return;
        if (tag === 'table') echec('tableau imbriqué dans une cellule');
        const style = ($(enfant).attr('style') || '').toLowerCase();
        const f = { ...fmt };
        if (tag === 'strong' || tag === 'b' || /^h[1-6]$/.test(tag) || /font-weight\s*:\s*(bold|[6-9]00)/.test(style)) f.bold = true;
        if (tag === 'em' || tag === 'i' || /font-style\s*:\s*italic/.test(style)) f.italic = true;
        if (tag === 'u' || /text-decoration\s*:\s*underline/.test(style)) f.underline = true;
        const bloc = BLOCS.has(tag);
        if (bloc) coupure();
        parcourir(enfant, f);
        if (bloc) coupure();
      }
    });
  };
  parcourir(racine, {});
  coupure();
  return lignes;
}

const texteLigne = (l) => l.segs.map((s) => s.text).join('');
const texteLignes = (ls) => ls.map(texteLigne).join(' ').replace(/\s+/g, ' ').trim();

// ------------------------------------------------------------- découpage HTML
function lireEntete($) {
  const valeurs = {};
  const $grille = $('.entete-libre').first();
  if ($grille.length) {
    const cases = $grille.children('div').toArray();
    for (let i = 0; i + 1 < cases.length; i += 2) {
      valeurs[norm($(cases[i]).text()).replace(/\s*:\s*$/, '')] = $(cases[i + 1]).text().replace(/\s+/g, ' ').trim();
    }
  } else {
    const $table = $('table.entete-table').first();
    if (!$table.length) echec("en-tête introuvable (ni grille .entete-libre ni tableau .entete-table)");
    $table.find('tr').each((_, tr) => {
      const cells = $(tr).children('td,th').toArray();
      for (let i = 0; i + 1 < cells.length; i += 2) {
        valeurs[norm($(cells[i]).text()).replace(/\s*:\s*$/, '')] = $(cells[i + 1]).text().replace(/\s+/g, ' ').trim();
      }
    });
  }
  for (const cle of ['classe', 'activite', 'lecon', 'seance']) {
    if (!valeurs[cle]) echec(`champ d'en-tête « ${cle} » absent ou vide`);
  }
  return {
    classe: valeurs.classe, competence: valeurs.competence || '', activite: valeurs.activite,
    lecon: valeurs.lecon, seance: valeurs.seance, duree: valeurs.duree || ''
  };
}

const RE_MARQUE_P = /P\s*(\d+)\s*[-–—:.)]\s*/g;

function lireCorpus($, noeudsAvantHabiletes) {
  const phrases = [];
  for (const noeud of noeudsAvantHabiletes) {
    for (const ligne of collecterLignes($, noeud)) {
      const texte = texteLigne(ligne);
      if (/^corpus\s*:?$/i.test(texte.trim())) continue;
      const marques = [...texte.matchAll(RE_MARQUE_P)];
      if (!marques.length) {
        if (phrases.length && !/^Situation d'/i.test(texte)) phrases[phrases.length - 1].texte += ' ' + texte.trim();
        continue;
      }
      marques.forEach((m, i) => {
        const debut = m.index + m[0].length;
        const fin = i + 1 < marques.length ? marques[i + 1].index : texte.length;
        const reste = texte.slice(debut, fin).trim();
        if (reste) phrases.push({ numero: m[1], texte: reste });
      });
    }
  }
  if (!phrases.length) echec('corpus (P1, P2…) introuvable avant le tableau Habiletés');
  return phrases.map((p) => `P${p.numero}- ${p.texte}`);
}

function lignesDeCellule($, cellule) { return collecterLignes($, cellule); }

function lireHabiletes($, table) {
  const rangees = $(table).find('tr').toArray().slice(1);
  const lignes = [];
  for (const tr of rangees) {
    const cells = $(tr).children('td,th').toArray();
    if (cells.length !== 2) echec('ligne du tableau Habiletés/Contenus à ≠ 2 colonnes');
    const h = texteLignes(lignesDeCellule($, cells[0]));
    const c = texteLignes(lignesDeCellule($, cells[1]));
    if (h || c) lignes.push([h, c]);
  }
  if (!lignes.length) echec('tableau Habiletés/Contenus vide');
  return lignes;
}

function lireSupports($, table) {
  const colonnes = [[], []];
  const titres = ['supports didactiques', 'bibliographie'];
  $(table).find('tr').each((_, tr) => {
    const cells = $(tr).children('td,th').toArray();
    if (cells.length !== 2) echec('ligne du tableau Supports/Bibliographie à ≠ 2 colonnes');
    cells.forEach((cell, i) => {
      for (const l of lignesDeCellule($, cell)) {
        const t = texteLigne(l).trim();
        if (norm(t).replace(/\s*:\s*$/, '') === titres[i]) continue;
        colonnes[i].push(t.replace(/^[-–•]\s*/, ''));
      }
    });
  });
  return colonnes;
}

const PHASES = [
  { cle: 'presentation', re: /^(phase d[ue]\s*)?presentation/, libelle: 'Phase de présentation' },
  { cle: 'developpement', re: /^(phase d[ue]\s*)?developpement/, libelle: 'Phase de développement' },
  { cle: 'evaluation', re: /^(phase d['e]\s*)?evaluation/, libelle: "Phase d'évaluation" }
];

function lireTableauPrincipal($, table) {
  const rangees = $(table).find('tr').toArray();
  const lignesDonnees = rangees.slice(1);
  if (lignesDonnees.length !== 3) echec(`tableau principal : ${lignesDonnees.length} ligne(s) de phase au lieu de 3`);
  return lignesDonnees.map((tr, idx) => {
    const cells = $(tr).children('td,th').toArray();
    if (cells.length !== 5) echec(`tableau principal : la phase ${idx + 1} n'a pas 5 colonnes`);
    const col1 = lignesDeCellule($, cells[0]);
    const nomPhase = norm(texteLigne(col1[0] || { segs: [] })).replace(/\s*\(.*$/, '').trim();
    const phase = PHASES[idx];
    if (!phase.re.test(nomPhase)) echec(`tableau principal : phase « ${phase.cle} » introuvable à la ligne ${idx + 1}`);
    const brut = texteLignes(col1);
    const duree = (/\(([^)]*)\)/.exec(brut) || [])[1];
    return {
      cle: phase.cle, libelle: phase.libelle,
      duree: duree ? duree.replace(/\bmn\b\.?/gi, 'min').trim() : '',
      colonnes: [1, 2, 3, 4].map((i) => lignesDeCellule($, cells[i]))
    };
  });
}

const RE_SOUS_TITRE_ROMAIN = /^(?:I{1,3}|IV|V|VI{0,3})\s*[-–—.)]\s*\S/;
const RE_MOT_TITRE = /^(?:D[ée]finition|Exemples?|[ÉE]valuation|Application|Synth[èe]se|Bilan)\s*:?$/i;
const estToutGras = (l) => l.segs.length > 0 && l.segs.every((s) => s.bold);
const aDeLaMiseEnForme = (l) => l.segs.some((s) => s.bold || s.italic || s.underline);

function lireAnnexe($, racine) {
  const $annexe = $('.annexe, [data-annexe]').first();
  let lignes = [];
  if ($annexe.length) {
    lignes = collecterLignes($, $annexe[0]);
  } else {
    // Repli (anciennes fiches) : paragraphes « Situation d'apprentissage » et « Situation d'évaluation ».
    const ps = $('p').toArray();
    const idxApp = ps.findIndex((p) => /^Situation d'apprentissage\s*:/i.test($(p).text().trim()));
    if (idxApp >= 0) lignes = lignes.concat(collecterLignes($, ps[idxApp]));
    const idxEval = ps.findIndex((p) => /^Situation d['’]évaluation\s*:/i.test($(p).text().trim()));
    if (idxEval >= 0) {
      lignes = lignes.concat(collecterLignes($, ps[idxEval]));
      let suivant = $(ps[idxEval]).next();
      while (suivant.length && /^(p|div|ul|ol)$/i.test(suivant[0].name || '')) {
        lignes = lignes.concat(collecterLignes($, suivant[0]));
        suivant = suivant.next();
      }
    }
  }
  if (!lignes.some((l) => /^Situation d'apprentissage\s*:/i.test(texteLigne(l).trim()))) {
    echec("situation d'apprentissage introuvable (ni annexe balisée, ni paragraphe)");
  }
  return lignes;
}

function extraireStructureGrammaire(html) {
  if (!html || !/<table/i.test(html)) echec('HTML vide ou sans tableau');
  const $ = cheerio.load(html);
  const racine = $('.fiche-cours').first().length ? $('.fiche-cours').first() : $('body');
  const entete = lireEntete($);

  const tables = $('table').toArray().filter((t) => !$(t).parents('table').length);
  const premiereLigne = (t) => $(t).find('tr').first().children('td,th').toArray();
  const tHabiletes = tables.find((t) => { const c = premiereLigne(t); return c.length === 2 && norm($(c[0]).text()) === 'habiletes'; });
  const tSupports = tables.find((t) => { const c = premiereLigne(t); return c.length === 2 && norm($(c[0]).text()).startsWith('supports didactiques'); });
  const tPrincipal = tables.find((t) => premiereLigne(t).length === 5);
  if (!tHabiletes) echec('tableau Habiletés/Contenus introuvable');
  if (!tSupports) echec('tableau Supports/Bibliographie introuvable');
  if (!tPrincipal) echec('tableau principal à 5 colonnes introuvable');

  // Corpus : tout bloc situé avant le tableau Habiletés, hors en-tête et situation d'apprentissage.
  const noeudsCorpus = [];
  for (const enfant of racine.children().toArray()) {
    if (enfant === tHabiletes || $(enfant).find(tHabiletes).length) break;
    const $e = $(enfant);
    if ($e.hasClass('entete-libre') || $e.is('table.entete-table') || $e.find('.entete-libre').length) continue;
    if (/^Situation d'apprentissage\s*:/i.test($e.text().trim())) continue;
    noeudsCorpus.push(enfant);
  }
  const corpus = lireCorpus($, noeudsCorpus);
  const habiletes = lireHabiletes($, tHabiletes);
  const [supports, bibliographie] = lireSupports($, tSupports);
  const phases = lireTableauPrincipal($, tPrincipal);
  const annexe = lireAnnexe($, racine);

  // Mise en forme : balises du modèle, sinon repli « I- / II- ». Dans les deux cas il faut
  // retrouver au moins un sous-titre dans le Développement, sinon on renonce.
  const dev = phases.find((p) => p.cle === 'developpement');
  const balisage = dev.colonnes.some((col) => col.some(aDeLaMiseEnForme));
  const sousTitresTrouves = dev.colonnes.some((col) => col.some((l) => estToutGras(l) || RE_SOUS_TITRE_ROMAIN.test(texteLigne(l).trim())));
  if (!sousTitresTrouves) {
    echec(balisage
      ? 'balises présentes mais aucun sous-titre (« I- … ») repérable dans le Développement'
      : "aucune balise <strong>/<u>/<em> et le repli « I- / II- » ne trouve aucun sous-titre dans le Développement");
  }
  return { entete, corpus, habiletes, supports, bibliographie, phases, annexe, repli: !balisage };
}

// -------------------------------------------------------------- construction
const runDe = (seg) => new TextRun({
  text: seg.text, bold: seg.bold || undefined, italics: seg.italic || undefined,
  underline: seg.underline ? { type: UnderlineType.SINGLE } : undefined
});
const paragrapheDe = (segs, opts = {}) => new Paragraph({
  children: segs.map(runDe), alignment: opts.alignement,
  spacing: { before: opts.avant || 0, after: opts.apres || 0, line: 240, lineRule: LineRuleType.AUTO },
  pageBreakBefore: opts.sautDePage || undefined
});
const segs = (texte, o = {}) => ({ text: texte, bold: !!o.bold, italic: !!o.italic, underline: !!o.underline });

function cellule(enfants, largeur, opts = {}) {
  return new TableCell({
    children: enfants.length ? enfants : [paragrapheDe([])],
    width: { size: largeur, type: WidthType.DXA },
    verticalAlign: VerticalAlign.TOP,
    borders: opts.sansBordure ? { top: AUCUN, bottom: AUCUN, left: AUCUN, right: AUCUN } : undefined
  });
}

function tableau(rangees, colonnes, opts = {}) {
  return new Table({
    rows: rangees,
    width: { size: colonnes.reduce((a, b) => a + b, 0), type: WidthType.DXA },
    columnWidths: colonnes,
    layout: TableLayoutType.FIXED,
    borders: opts.sansBordure ? SANS_BORDURE : BORDURES,
    margins: { top: 20, bottom: 20, left: MARGE_CELLULE_GD, right: MARGE_CELLULE_GD }
  });
}

const espaceur = () => new Paragraph({ children: [new TextRun({ text: '', size: 14 })], spacing: { before: 0, after: 0, line: 240, lineRule: LineRuleType.AUTO } });

function ligneEntete(etiquette, valeur) {
  // Gras jusqu'au premier « : » (« Leçon 1 : » ; « Compétence 4 : » ; « Classe : »).
  const complete = `${etiquette}${valeur ? ' ' + valeur : ''}`;
  const m = /^([^:]*:)(.*)$/.exec(complete);
  return m ? [segs(m[1], { bold: true }), segs(m[2])] : [segs(complete)];
}

function construireEntete(e) {
  const avecMot = (mot, v) => (new RegExp('^' + mot, 'i').test(v) ? v : `${mot} ${v}`);
  const competence = /^Compétence\s*\d*\s*:/i.test(e.competence) ? e.competence : `Compétence : ${e.competence}`.trim();
  const gauche = [
    ligneEntete('Classe :', e.classe),
    ligneEntete(competence, ''),
    ligneEntete('Activité :', e.activite)
  ];
  const droite = [
    ligneEntete(avecMot('Leçon', e.lecon), ''),
    ligneEntete(avecMot('Séance', e.seance), ''),
    ligneEntete('Durée :', e.duree)
  ];
  const moitie = Math.floor(LARGEUR_TABLEAUX / 2);
  return tableau([new TableRow({
    children: [
      cellule(gauche.map((s) => paragrapheDe(s)), moitie, { sansBordure: true }),
      cellule(droite.map((s) => paragrapheDe(s)), LARGEUR_TABLEAUX - moitie, { sansBordure: true })
    ]
  })], [moitie, LARGEUR_TABLEAUX - moitie], { sansBordure: true });
}

function construireCorpus(phrases) {
  const parLigne = 4;
  const largeurCase = Math.floor(LARGEUR_TABLEAUX / parLigne);
  const colonnes = Array(parLigne).fill(largeurCase);
  colonnes[parLigne - 1] += LARGEUR_TABLEAUX - largeurCase * parLigne;
  const rangees = [];
  for (let i = 0; i < phrases.length; i += parLigne) {
    const lot = phrases.slice(i, i + parLigne);
    while (lot.length < parLigne) lot.push('');
    rangees.push(new TableRow({ children: lot.map((p, k) => cellule([paragrapheDe(p ? [segs(p)] : [])], colonnes[k])) }));
  }
  return tableau(rangees, colonnes);
}

function construireHabiletes(lignes) {
  const colonnes = [cm(6.8), LARGEUR_TABLEAUX - cm(6.8)];
  const entete = new TableRow({ children: [
    cellule([paragrapheDe([segs('Habiletés', { bold: true })])], colonnes[0]),
    cellule([paragrapheDe([segs('Contenus', { bold: true })])], colonnes[1])
  ] });
  const corps = lignes.map(([h, c]) => new TableRow({ children: [
    cellule([paragrapheDe([segs(h)])], colonnes[0]), cellule([paragrapheDe([segs(c)])], colonnes[1])
  ] }));
  return tableau([entete, ...corps], colonnes);
}

function construireSupports(supports, biblio) {
  const moitie = Math.floor(LARGEUR_TABLEAUX / 2);
  const colonnes = [moitie, LARGEUR_TABLEAUX - moitie];
  const entete = new TableRow({ children: [
    cellule([paragrapheDe([segs('Supports didactiques', { bold: true })])], colonnes[0]),
    cellule([paragrapheDe([segs('Bibliographie', { bold: true })])], colonnes[1])
  ] });
  const lignesDe = (items) => items.map((t) => paragrapheDe([segs(t)]));
  return tableau([entete, new TableRow({ children: [cellule(lignesDe(supports), colonnes[0]), cellule(lignesDe(biblio), colonnes[1])] })], colonnes);
}

// Mise en forme d'une ligne de cellule du tableau principal.
// roles : 0 = moments (traité à part) ; 1 = stratégies ; 2 = enseignant ; 3 = apprenants ; 4 = traces.
function styleLigne(ligne, phase, colonne, repli) {
  let segments = ligne.segs.map((s) => ({ ...s }));
  const texte = texteLigne(ligne).trim();
  let sousTitre = false;
  if (repli && (phase.cle === 'developpement' || phase.cle === 'evaluation')) {
    // Pas de balises dans la fiche : repli sur « I- / II- », mots-titres et exemples.
    if (RE_SOUS_TITRE_ROMAIN.test(texte)) {
      segments = [segs(texte, { bold: true, underline: colonne === 1 || colonne === 4 })];
      sousTitre = true;
    } else if (RE_MOT_TITRE.test(texte)) {
      segments = [segs(texte, { bold: true })];
      sousTitre = true;
    } else if (/^Exemples?\s*:/i.test(texte) || texte.includes('→')) {
      segments = segments.map((s) => ({ ...s, italic: true }));
    }
  } else if (estToutGras(ligne) || RE_SOUS_TITRE_ROMAIN.test(texte)) {
    sousTitre = true;
  }
  if (phase.cle === 'presentation' && colonne === 4) segments = segments.map((s) => ({ ...s, bold: true }));
  if (phase.cle === 'evaluation' && colonne === 2 && /^Passons à l['’]évaluation/i.test(texte)) segments = segments.map((s) => ({ ...s, italic: true }));
  return { segments, sousTitre };
}

function construireTableauPrincipal(phases, repli) {
  const entete = new TableRow({
    tableHeader: true,
    children: ENTETES_PRINCIPAL.map((t, i) => cellule([paragrapheDe([segs(t, { bold: true })])], COLONNES_PRINCIPAL[i]))
  });
  const rangees = phases.map((phase) => {
    const moments = [paragrapheDe([segs(phase.libelle, { bold: true })])];
    if (phase.duree) moments.push(paragrapheDe([segs(`(${phase.duree})`)]));
    const cellules = [cellule(moments, COLONNES_PRINCIPAL[0])];
    phase.colonnes.forEach((lignes, k) => {
      const colonne = k + 1;
      const paragraphes = lignes.map((l, idx) => {
        const { segments, sousTitre } = styleLigne(l, phase, colonne, repli);
        return paragrapheDe(segments, { avant: idx > 0 && (sousTitre || l.blancAvant) ? 60 : 0 });
      });
      cellules.push(cellule(paragraphes, COLONNES_PRINCIPAL[colonne]));
    });
    return new TableRow({ children: cellules });
  });
  return tableau([entete, ...rangees], COLONNES_PRINCIPAL);
}

function construireAnnexe(lignes) {
  const paragraphes = [paragrapheDe([segs('ANNEXE', { bold: true })], { alignement: AlignmentType.CENTER, sautDePage: true })];
  for (const l of lignes) {
    let segments = l.segs;
    const texte = texteLigne(l).trim();
    const m = !aDeLaMiseEnForme(l) && /^(Situation d['’](?:apprentissage|évaluation)\s*:|Exercice\s*\d+\s*:)(.*)$/i.exec(texte);
    if (m) segments = [segs(m[1], { bold: true }), segs(m[2])];
    paragraphes.push(paragrapheDe(segments, { avant: l.blancAvant ? 60 : 0 }));
  }
  return paragraphes;
}

async function genererDocxGrammaireModeleA(html) {
  const s = extraireStructureGrammaire(html); // lève ErreurDecoupageGrammaire si le HTML ne se découpe pas
  const enfants = [
    paragrapheDe([segs('FICHE DE COURS', { bold: true })], { alignement: AlignmentType.CENTER, apres: 80 }),
    construireEntete(s.entete),
    espaceur(),
    paragrapheDe([segs('Corpus', { bold: true })]),
    construireCorpus(s.corpus),
    espaceur(),
    construireHabiletes(s.habiletes),
    espaceur(),
    construireSupports(s.supports, s.bibliographie),
    espaceur(),
    construireTableauPrincipal(s.phases, s.repli),
    ...construireAnnexe(s.annexe)
  ];
  const doc = new Document({
    creator: 'ProfCI', description: 'Fiche de cours', title: 'Fiche de cours',
    styles: {
      default: {
        document: {
          run: { font: POLICE, size: TAILLE_CORPS },
          paragraph: { spacing: { before: 0, after: 0, line: 240, lineRule: LineRuleType.AUTO } }
        }
      }
    },
    sections: [{
      properties: {
        page: {
          size: { orientation: PageOrientation.LANDSCAPE },
          margin: { top: MARGE_PAGE, bottom: MARGE_PAGE, left: MARGE_PAGE, right: MARGE_PAGE }
        }
      },
      children: enfants
    }]
  });
  return Packer.toBuffer(doc);
}

// Détection : champ `activite` de la fiche (fiches récentes), sinon ligne
// « Activité : » de l'en-tête du HTML (anciennes fiches). Égalité stricte avec
// « Grammaire » -- Orthographe et toute autre activité : false.
function estFicheGrammaire(fiche) {
  if (!fiche) return false;
  if (fiche.activite) return norm(fiche.activite) === 'grammaire';
  try {
    const $ = cheerio.load(fiche.contenu || '');
    const $grille = $('.entete-libre').first();
    if (!$grille.length) return false;
    const cases = $grille.children('div').toArray();
    for (let i = 0; i + 1 < cases.length; i += 2) {
      if (norm($(cases[i]).text()).replace(/\s*:\s*$/, '') === 'activite') return norm($(cases[i + 1]).text()) === 'grammaire';
    }
  } catch (e) { /* HTML illisible : pas Grammaire */ }
  return false;
}

module.exports = {
  ErreurDecoupageGrammaire, estFicheGrammaire, extraireStructureGrammaire, genererDocxGrammaireModeleA,
  CONSTANTES: { COLONNES_PRINCIPAL, LARGEUR_TABLEAUX, LARGEUR_UTILE_PAGE, MARGE_PAGE, MARGE_CELLULE_GD, LARGEURS_PRINCIPAL_CM }
};
