const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const Anthropic = require('@anthropic-ai/sdk');
const multer = require('multer');
const mammoth = require('mammoth');
const pdfParse = require('pdf-parse');
const chromium = require('@sparticuz/chromium').default;
const puppeteer = require('puppeteer-core');
const cheerio = require('cheerio');
const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  WidthType, ShadingType, PageOrientation, BorderStyle, VerticalAlign
} = require('docx');

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static('public'));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = file.originalname.split('.').pop().toLowerCase();
    if (['pdf', 'doc', 'docx', 'jpg', 'jpeg', 'png'].includes(ext)) return cb(null, true);
    cb(new Error('Format non supporté (PDF, DOC, DOCX, JPG, JPEG, PNG uniquement)'));
  }
});

function uploadModeleFichier(req, res, next) {
  upload.single('fichier')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    next();
  });
}

function uploadTexteSupportFichier(req, res, next) {
  upload.single('texteSupportFichier')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    next();
  });
}

function normaliserTextePdf(texte) {
  return (texte || '')
    // fusionne un tiret de césure suivi d'un retour à la ligne (ex. "quatre-vingt-\ntrois")
    // en un seul mot, SANS espace parasite : "-\n" (ou "- \n") -> "-"
    .replace(/-\s*\n/g, '-')
    // normalise ensuite tous les runs d'espaces/retours à la ligne restants en un seul espace
    .replace(/\s+/g, ' ')
    .trim();
}

const MEDIA_TYPE_PAR_EXTENSION_IMAGE = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png'
};

// Pas d'OCR classique (Tesseract...) : l'image est envoyée telle quelle à Claude
// en multimodal, qui la lit nativement et retranscrit fidèlement le texte visible.
async function extraireTexteDepuisImage(file, ext) {
  const mediaType = MEDIA_TYPE_PAR_EXTENSION_IMAGE[ext] || file.mimetype || 'image/jpeg';
  const base64 = file.buffer.toString('base64');
  const reponse = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
        { type: 'text', text: 'Extrait fidèlement tout le texte visible dans cette image, sans reformuler ni résumer.' }
      ]
    }]
  });
  return reponse.content[0].text;
}

async function extraireTexteFichier(file) {
  const ext = file.originalname.split('.').pop().toLowerCase();
  if (ext === 'pdf') {
    const data = await pdfParse(file.buffer);
    return normaliserTextePdf(data.text);
  }
  if (['jpg', 'jpeg', 'png'].includes(ext)) {
    return extraireTexteDepuisImage(file, ext);
  }
  const result = await mammoth.extractRawText({ buffer: file.buffer });
  return result.value;
}

function slugFichier(fiche) {
  const brut = `fiche_${fiche.discipline || ''}_${fiche.classe || ''}`;
  const slug = brut.toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return slug || 'fiche_cours';
}

let browserPromise = null;
function getBrowser() {
  if (!browserPromise) {
    browserPromise = (async () => {
      return puppeteer.launch({
        args: chromium.args,
        executablePath: await chromium.executablePath(),
        headless: chromium.headless
      });
    })();
  }
  return browserPromise;
}

// Repère le tableau pédagogique à 5 colonnes (Moments / Stratégies /
// Activités enseignant / Activités élèves / Traces écrites) : c'est le seul
// tableau de la fiche dont la première ligne compte exactement 5 <th> --
// signature de contenu, pas une classe CSS, pour ne jamais toucher au HTML de
// la fiche tel que stocké/affiché/exporté en Word. Transformation appliquée
// uniquement à la copie en mémoire envoyée à Puppeteer pour le rendu PDF :
// ajoute un <thead>/<tbody> réels (pour que l'en-tête se répète sur chaque
// page) et marque le tableau pour lui appliquer une pagination différente
// (saut de page avant, lignes libres de se couper) des petits tableaux.
function preparerHtmlPourPdf(contenuHTML) {
  if (!contenuHTML) return contenuHTML;
  const $ = cheerio.load(contenuHTML);
  $('table').each((_, table) => {
    const $table = $(table);
    // .find() et non .children() : le parseur HTML de cheerio enveloppe
    // automatiquement les <tr> orphelins dans un <tbody> implicite, donc les
    // lignes ne sont presque jamais des enfants DIRECTS de <table>.
    const $lignes = $table.find('tr');
    const $premiereLigne = $lignes.first();
    if ($premiereLigne.length && $premiereLigne.children('th').length === 5) {
      $table.addClass('pdf-tableau-deroulement');
      const $autresLignes = $lignes.slice(1);
      const $thead = $('<thead></thead>').append($premiereLigne);
      const $tbody = $('<tbody></tbody>').append($autresLignes);
      $table.empty().append($thead).append($tbody);
    }
  });
  const $racine = $('.fiche-cours').first();
  return $racine.length ? $.html($racine) : contenuHTML;
}

async function genererPdfDepuisHtml(contenuHTML, landscape) {
  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8">
<style>
  @page { size: A4 ${landscape ? 'landscape' : 'portrait'}; margin: 15mm; }
  * { box-sizing: border-box; }
  body { font-family: Arial, sans-serif; font-size: 11px; color: #000; margin: 0; }
  table { width: 100%; border-collapse: collapse; }
  td, th { border: 1px solid #000; padding: 5px; }
  tr, td { page-break-inside: avoid; break-inside: avoid; }
  /* Chromium répète nativement un <thead> sur chaque page (table-header-group
     fait partie de sa feuille de style par défaut, même sans règle explicite) --
     on l'annule ici pour que l'en-tête du tableau 5 colonnes n'apparaisse
     qu'une seule fois, là où il se trouve dans le document (page 2). */
  thead { display: table-row-group; }
  .pdf-tableau-deroulement { page-break-before: always; break-before: page; }
  .pdf-tableau-deroulement tr, .pdf-tableau-deroulement td { page-break-inside: auto; break-inside: auto; }
</style>
</head><body>${preparerHtmlPourPdf(contenuHTML)}</body></html>`;

  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setContent(html, { waitUntil: 'networkidle0' });
    const pdfBytes = await page.pdf({ format: 'A4', landscape, printBackground: true });
    return Buffer.from(pdfBytes);
  } finally {
    await page.close();
  }
}

// --- Conversion HTML (fiche générée) -> éléments docx natifs ---

const DOCX_BORDERS = {
  top: { style: BorderStyle.SINGLE, size: 4, color: '000000' },
  bottom: { style: BorderStyle.SINGLE, size: 4, color: '000000' },
  left: { style: BorderStyle.SINGLE, size: 4, color: '000000' },
  right: { style: BorderStyle.SINGLE, size: 4, color: '000000' },
  insideHorizontal: { style: BorderStyle.SINGLE, size: 4, color: '000000' },
  insideVertical: { style: BorderStyle.SINGLE, size: 4, color: '000000' }
};

const DOCX_NO_BORDERS = {
  top: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
  bottom: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
  left: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
  right: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
  insideHorizontal: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
  insideVertical: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' }
};

function widthPctFromStyle(style) {
  const m = /width\s*:\s*([\d.]+)\s*%/i.exec(style || '');
  return m ? parseFloat(m[1]) : null;
}

function fontSizeFromStyle(style) {
  const m = /font-size\s*:\s*([\d.]+)\s*px/i.exec(style || '');
  return m ? parseFloat(m[1]) : null;
}

// docx exprime la taille de police en demi-points ; à 96 dpi, 1px = 0.75pt,
// donc demi-points = px * 1.5.
function pxVersDemiPoints(px) {
  return Math.round(px * 1.5);
}

// Convertit récursivement un <div> "texte support" (texte-support,
// texte-support-page-unique, texte-support-copie...) -- avec son éventuel
// <h3> de titre et ses sous-divs à taille de police réduite (cf.
// envelopperTexteSupportUnePage / la copie en Lecture méthodique) -- en
// paragraphes/tableaux docx, en respectant la taille de police voulue au lieu
// de l'aplatir en un seul bloc de texte brut sans mise en forme.
function elementsTexteSupportDepuisDiv($, $div, sizeHalfPtHerite) {
  const taillePx = fontSizeFromStyle($div.attr('style') || '');
  const sizeHalfPt = taillePx ? pxVersDemiPoints(taillePx) : sizeHalfPtHerite;
  const elements = [];

  $div.contents().each((_, enfant) => {
    if (enfant.type !== 'tag') return;
    const $enfant = $(enfant);
    const tagEnfant = enfant.name.toLowerCase();
    if (tagEnfant === 'div') {
      elements.push(...elementsTexteSupportDepuisDiv($, $enfant, sizeHalfPt));
    } else if (tagEnfant === 'h3' || tagEnfant === 'h2') {
      elements.push(new Paragraph({ children: [new TextRun({ text: $enfant.text().trim(), bold: true, size: sizeHalfPt })], spacing: { before: 120, after: 80 } }));
    } else if (tagEnfant === 'p') {
      const runs = collectRuns($, enfant, { size: sizeHalfPt });
      if (runs.length) elements.push(new Paragraph({ children: runs }));
    } else if (tagEnfant === 'table') {
      const table = buildDocxTable($, $enfant);
      if (table) elements.push(table);
    } else {
      const texte = $enfant.text().trim();
      if (texte) elements.push(new Paragraph({ children: [new TextRun({ text: texte, size: sizeHalfPt })] }));
    }
  });

  return elements;
}

function collectRuns($, el, fmt = {}) {
  let runs = [];
  $(el).contents().each((_, child) => {
    if (child.type === 'text') {
      const text = (child.data || '').replace(/\s+/g, ' ');
      if (text.trim() !== '' || text === ' ') {
        runs.push(new TextRun({ text, bold: fmt.bold, italics: fmt.italics, color: fmt.color, size: fmt.size }));
      }
    } else if (child.type === 'tag') {
      const tag = child.name.toLowerCase();
      if (tag === 'br') {
        runs.push(new TextRun({ text: '', break: 1 }));
      } else if (tag === 'strong' || tag === 'b') {
        runs = runs.concat(collectRuns($, child, { ...fmt, bold: true }));
      } else if (tag === 'em' || tag === 'i') {
        runs = runs.concat(collectRuns($, child, { ...fmt, italics: true }));
      } else {
        runs = runs.concat(collectRuns($, child, fmt));
      }
    }
  });
  return runs;
}

function blockChildrenToParagraphs($, el, fmt = {}) {
  const paragraphs = [];
  const directBlocks = $(el).children('p, ul, ol, div').toArray();

  if (directBlocks.length === 0) {
    const runs = collectRuns($, el, fmt);
    if (runs.length) paragraphs.push(new Paragraph({ children: runs }));
    return paragraphs;
  }

  directBlocks.forEach((node) => {
    const tag = node.name.toLowerCase();
    if (tag === 'ul' || tag === 'ol') {
      $(node).children('li').each((_, li) => {
        const runs = collectRuns($, li, fmt);
        paragraphs.push(new Paragraph({ children: [new TextRun({ text: '- ', bold: fmt.bold, color: fmt.color }), ...runs] }));
      });
    } else {
      const runs = collectRuns($, node, fmt);
      if (runs.length) paragraphs.push(new Paragraph({ children: runs }));
    }
  });
  return paragraphs;
}

function tableCellFromNode($, node, opts = {}) {
  const fmt = { bold: opts.forceBold, color: opts.forceColor };
  const paragraphs = blockChildrenToParagraphs($, node, fmt);
  const cellProps = {
    children: paragraphs.length ? paragraphs : [new Paragraph({ children: [] })],
    verticalAlign: VerticalAlign.TOP,
    margins: { top: 80, bottom: 80, left: 100, right: 100 }
  };
  if (opts.widthPct) cellProps.width = { size: opts.widthPct, type: WidthType.PERCENTAGE };
  else if (opts.widthDxa) cellProps.width = { size: opts.widthDxa, type: WidthType.DXA };
  if (opts.shadingFill) cellProps.shading = { fill: opts.shadingFill, type: ShadingType.CLEAR, color: 'auto' };
  if (opts.columnSpan) cellProps.columnSpan = opts.columnSpan;
  return new TableCell(cellProps);
}

function buildDocxTable($, $table) {
  const rows = [];
  $table.children('tr').each((_, tr) => {
    buildRow(tr);
  });
  $table.find('tbody, thead').each((_, group) => {
    $(group).children('tr').each((_, tr) => buildRow(tr));
  });

  function buildRow(tr) {
    const cells = [];
    $(tr).children('td, th').each((_, cellEl) => {
      const tag = cellEl.name.toLowerCase();
      const isHeader = tag === 'th';
      const style = $(cellEl).attr('style') || '';
      const widthPct = widthPctFromStyle(style);
      const colspanAttr = $(cellEl).attr('colspan');
      const columnSpan = colspanAttr ? parseInt(colspanAttr, 10) : undefined;
      cells.push(tableCellFromNode($, cellEl, {
        forceBold: isHeader || /font-weight\s*:\s*bold/i.test(style),
        forceColor: isHeader ? 'FFFFFF' : undefined,
        widthPct,
        shadingFill: isHeader ? '333333' : undefined,
        columnSpan
      }));
    });
    if (cells.length) rows.push(new TableRow({ children: cells, tableHeader: false }));
  }

  if (!rows.length) return null;
  return new Table({ rows, width: { size: 100, type: WidthType.PERCENTAGE }, borders: DOCX_BORDERS });
}

// Largeur fixe de la colonne "label" de l'entête, en twips (1/1440 de pouce).
// Alignée sur les 110px de la colonne "grid-template-columns:110px 1fr" utilisée
// dans l'aperçu HTML (110px ≈ 1650 twips), pour éviter qu'une largeur en
// pourcentage (calculée sur la largeur totale de la page, portrait OU paysage)
// ne laisse un grand espace vide après les libellés courts (ex. "Date :").
const ENTETE_LABEL_WIDTH_DXA = 1650;

// Un div "libellé" est soit vide (cellule de gauche volontairement blanche,
// ex. devant Leçon/Séance), soit un texte terminé par ":" (ex. "Discipline :").
// Sert à réparer par le contenu la ligne Leçon/Séance quand le modèle omet le
// <div> vide de gauche au lieu de le garder vide : sans cette détection, le
// texte de la leçon serait pris pour un libellé et celui de la séance
// basculerait à sa suite sur la même ligne (champs décalés/imbriqués).
function estDivLibelleEntete($, node) {
  const texte = $(node).text().replace(/ /g, ' ').trim();
  return texte === '' || /:\s*$/.test(texte);
}

function buildEnteteTable($, $entete) {
  const champs = $entete.children('div').toArray();
  const rows = [];
  let i = 0;
  while (i < champs.length) {
    const el = champs[i];
    if (estDivLibelleEntete($, el)) {
      const valueEl = champs[i + 1];
      const labelCell = tableCellFromNode($, el, { forceBold: true, widthDxa: ENTETE_LABEL_WIDTH_DXA });
      const valueCell = valueEl
        ? tableCellFromNode($, valueEl, {})
        : new TableCell({ children: [new Paragraph({})] });
      rows.push(new TableRow({ children: [labelCell, valueCell] }));
      i += 2;
    } else {
      const labelCell = new TableCell({ children: [new Paragraph({})], width: { size: ENTETE_LABEL_WIDTH_DXA, type: WidthType.DXA } });
      const valueCell = tableCellFromNode($, el, {});
      rows.push(new TableRow({ children: [labelCell, valueCell] }));
      i += 1;
    }
  }
  if (!rows.length) return null;
  return new Table({ rows, width: { size: 100, type: WidthType.PERCENTAGE }, borders: DOCX_NO_BORDERS });
}

function titrePar(text, taille) {
  return new Paragraph({ children: [new TextRun({ text, bold: true, size: taille })], spacing: { before: 200, after: 120 } });
}

function contenuToDocxChildren(html) {
  const $ = cheerio.load(html || '');
  const root = $('.fiche-cours').first().length ? $('.fiche-cours').first() : $('body');
  const elements = [];

  root.children().each((_, node) => {
    const tag = node.name.toLowerCase();
    const $node = $(node);
    const cls = $node.attr('class') || '';

    if (tag === 'div' && /entete-libre/.test(cls)) {
      const table = buildEnteteTable($, $node);
      if (table) { elements.push(table); elements.push(new Paragraph({ text: '' })); }
    } else if (tag === 'div' && /\bentete\b/.test(cls)) {
      $node.children().each((_, inner) => {
        const $inner = $(inner);
        const innerCls = $inner.attr('class') || '';
        if (inner.name === 'h2') {
          elements.push(titrePar($inner.text().trim(), 28));
        } else if (inner.name === 'div' && /entete-libre/.test(innerCls)) {
          const table = buildEnteteTable($, $inner);
          if (table) { elements.push(table); elements.push(new Paragraph({ text: '' })); }
        } else if (inner.name === 'table') {
          const table = buildDocxTable($, $inner);
          if (table) { elements.push(table); elements.push(new Paragraph({ text: '' })); }
        }
      });
    } else if (tag === 'div' && /deroulement/.test(cls)) {
      $node.children().each((_, inner) => {
        const $inner = $(inner);
        const innerCls = $inner.attr('class') || '';
        if (inner.name === 'h3') {
          elements.push(titrePar($inner.text().trim(), 24));
        } else if (inner.name === 'table') {
          const table = buildDocxTable($, $inner);
          if (table) { elements.push(table); elements.push(new Paragraph({ text: '' })); }
        } else if (inner.name === 'div' && /texte-support/.test(innerCls)) {
          elements.push(...elementsTexteSupportDepuisDiv($, $inner));
          elements.push(new Paragraph({ text: '' }));
        }
      });
    } else if (tag === 'div' && /texte-support/.test(cls)) {
      elements.push(...elementsTexteSupportDepuisDiv($, $node));
      elements.push(new Paragraph({ text: '' }));
    } else if (tag === 'p') {
      const runs = collectRuns($, $node);
      if (runs.length) elements.push(new Paragraph({ children: runs, spacing: { after: 120 } }));
    } else if (tag === 'table') {
      const table = buildDocxTable($, $node);
      if (table) { elements.push(table); elements.push(new Paragraph({ text: '' })); }
    } else if (tag === 'h2' || tag === 'h3') {
      elements.push(titrePar($node.text().trim(), tag === 'h2' ? 28 : 24));
    } else {
      const text = $node.text().trim();
      if (text) elements.push(new Paragraph({ text }));
    }
  });

  if (!elements.length) {
    const texteBrut = $('body').text().trim();
    elements.push(new Paragraph({ text: texteBrut }));
  }
  return elements;
}

async function genererDocxDepuisHtml(contenuHTML, landscape) {
  const doc = new Document({
    sections: [{
      properties: {
        page: {
          size: {
            orientation: landscape ? PageOrientation.LANDSCAPE : PageOrientation.PORTRAIT
          },
          margin: { top: 850, bottom: 850, left: 850, right: 850 }
        }
      },
      children: contenuToDocxChildren(contenuHTML)
    }]
  });
  return Packer.toBuffer(doc);
}

mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost/profci')
  .then(() => console.log('✅ MongoDB connecté'))
  .catch(e => console.error('❌ MongoDB:', e.message));

if (!process.env.ADMIN_SEED_KEY) {
  console.warn('⚠️  ADMIN_SEED_KEY non définie : /api/admin/progressions/seed refusera toutes les requêtes (fail closed).');
}

const ModeleSchema = new mongoose.Schema({
  enseignantId : String,
  niveau       : String,
  structure    : String,
  rubriques    : [String],
  createdAt    : { type: Date, default: Date.now }
});

const FicheSchema = new mongoose.Schema({
  enseignantId : String,
  discipline   : String,
  classe       : String,
  lecon        : String,
  seance       : String,
  duree        : String,
  niveau       : String,
  contenu      : String,
  approche     : String,
  createdAt    : { type: Date, default: Date.now }
});

const ProgressionLeconSchema = new mongoose.Schema({
  discipline       : String,
  classe           : String,
  lecon            : String,
  nombreSeances    : Number,
  ordre            : Number,
  // Numéro de la compétence DPFC (voir CompetenceDPFC) à laquelle cette leçon
  // appartient, quand plusieurs compétences existent pour la discipline/classe
  // et qu'il faut savoir laquelle s'applique à CETTE leçon précise.
  competenceNumero : Number,
  createdAt        : { type: Date, default: Date.now }
});

// Catalogue des compétences officielles DPFC : PLUSIEURS entrées possibles par
// (discipline, classe) (ex. Français 4ème a 5 compétences : oral, lecture,
// écrit, grammaire, orthographe), une entrée par (discipline, classe, numero).
// Histoire et Géographie sont deux disciplines distinctes avec leur propre numérotation.
const CompetenceDPFCSchema = new mongoose.Schema({
  discipline : String,
  classe     : String,
  numero     : Number,
  libelle    : String,
  createdAt  : { type: Date, default: Date.now }
});

// Compétences officielles qui ne se distinguent PAS par le seul (discipline,
// classe) mais par l'activité (ex. Français 6e : Expression orale = Compétence
// 1, Lecture = Compétence 2, Expression écrite = Compétence 3, Grammaire =
// Compétence 4, Orthographe = Compétence 5 — toutes différentes bien que même
// discipline/classe). Ces compétences viennent du Programme éducatif, un
// document distinct de la progression DPFC (LeconOfficielleDPFC) — collection
// dédiée, sans toucher à CompetenceDPFC ni à sa logique de résolution
// existante (SVT, Histoire, Géographie... une seule compétence par
// discipline/classe, pas besoin d'activité).
const CompetenceParActiviteSchema = new mongoose.Schema({
  discipline : String,
  classe     : String,
  activite   : String,
  numero     : Number,
  intitule   : String,
  createdAt  : { type: Date, default: Date.now }
});

// Catalogue des leçons officielles DPFC, une entrée par (discipline, classe,
// numeroLecon) avec ses séances imbriquées. discipline vaut toujours "Français"
// (la progression DPFC source est unique pour tout le Français, toutes activités
// confondues) ; chaque séance porte sa propre "activite" (Lecture méthodique,
// Expression écrite...) car une même leçon peut être partagée entre activités
// avec des séances différentes. Alimente le champ Leçon/Séance de l'entête
// (qui affichaient jusqu'ici un titre générique inventé) et l'UI de sélection
// Leçon -> Séance -> option de l'écran de génération.
const LeconOfficielleDPFCSchema = new mongoose.Schema({
  discipline  : String,
  classe      : String,
  // Le vrai discriminant d'une leçon : la progression DPFC numérote ses leçons
  // séparément PAR ACTIVITÉ (Grammaire a sa propre Leçon 1, Expression écrite
  // a sa propre Leçon 1 — sujets sans rapport), donc numeroLecon seul se répète
  // forcément entre activités. Sans ce champ, un seed Grammaire écraserait
  // silencieusement le document Expression écrite partageant le même numéro.
  activite    : String,
  numeroLecon : Number,   // peut se répéter dans l'année, y compris au sein d'une même activité — jamais utilisé seul comme identifiant
  titreLecon  : String,
  ordre       : Number,
  seances: [{
    numeroSeance    : Number,
    intitule        : String,    // intitulé officiel complet de la séance
    activite        : String,    // "Expression écrite" | "Lecture méthodique" | ...
    optionsChoix    : [String],  // non vide -> menu déroulant d'options pour l'enseignant
    // Les deux choix ci-dessous sont indépendants : une séance peut porter
    // UNIQUEMENT optionsChoix, UNIQUEMENT choixLibre, LES DEUX à la fois (ex.
    // "type de récit" en liste + "thème des contenus intégrés" en texte libre),
    // ou aucun des deux (séance sans choix enseignant).
    choixLibre      : Boolean,   // true -> champ texte libre supplémentaire
    choixLibreLabel : String     // libellé du champ texte libre (ex. "thème des contenus intégrés")
  }],
  createdAt   : { type: Date, default: Date.now }
});

const Modele = mongoose.model('Modele', ModeleSchema);
const Fiche  = mongoose.model('Fiche',  FicheSchema);
const ProgressionLecon = mongoose.model('ProgressionLecon', ProgressionLeconSchema);
const CompetenceDPFC = mongoose.model('CompetenceDPFC', CompetenceDPFCSchema);
const CompetenceParActivite = mongoose.model('CompetenceParActivite', CompetenceParActiviteSchema);
const LeconOfficielleDPFC = mongoose.model('LeconOfficielleDPFC', LeconOfficielleDPFCSchema);

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// --- Rappel de séance basé sur l'historique réel des fiches précédentes ---

function normaliserTexte(str) {
  return (str || '')
    .toString()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function regexExactInsensible(str) {
  const echappe = String(str || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp('^' + echappe + '$', 'i');
}

async function trouverFichesPrecedentes({ enseignantId, discipline, classe, lecon, niveau, seance }) {
  const seanceNum = parseInt(seance, 10);
  if (!enseignantId || !Number.isFinite(seanceNum) || seanceNum <= 1) return [];

  const candidates = await Fiche.find({
    enseignantId,
    niveau,
    discipline: regexExactInsensible(discipline),
    classe: regexExactInsensible(classe)
  }).sort({ createdAt: -1 }).limit(50);

  const leconCible = normaliserTexte(lecon);
  const correspondantes = candidates.filter((f) => {
    const leconStockee = normaliserTexte(f.lecon);
    if (!leconStockee || !leconCible) return false;
    if (leconStockee === leconCible) return true;
    // leçon "très proche" : l'une contient l'autre (variante courte/longue du même titre)
    return leconCible.length > 3 && (leconStockee.includes(leconCible) || leconCible.includes(leconStockee));
  });

  return correspondantes
    .map((f) => ({ fiche: f, seanceNum: parseInt(f.seance, 10) }))
    .filter((x) => Number.isFinite(x.seanceNum) && x.seanceNum >= 1 && x.seanceNum < seanceNum)
    .sort((a, b) => a.seanceNum - b.seanceNum)
    .map((x) => x.fiche);
}

async function trouverProgressionLecon({ discipline, classe, lecon }) {
  const candidates = await ProgressionLecon.find({
    discipline: regexExactInsensible(discipline),
    classe: regexExactInsensible(classe)
  });

  const leconCible = normaliserTexte(lecon);
  return candidates.find((p) => {
    const leconStockee = normaliserTexte(p.lecon);
    if (!leconStockee || !leconCible) return false;
    if (leconStockee === leconCible) return true;
    return leconCible.length > 3 && (leconStockee.includes(leconCible) || leconCible.includes(leconStockee));
  }) || null;
}

async function trouverCompetencesDPFC({ discipline, classe }) {
  return CompetenceDPFC.find({
    discipline: regexExactInsensible(discipline),
    classe: regexExactInsensible(classe)
  }).sort({ numero: 1 });
}

// Résolution par (discipline, classe, activité) — prioritaire sur
// trouverCompetencesDPFC quand une entrée existe (aujourd'hui : Français
// uniquement). Correspondance exacte normalisée sur l'activité, jamais de
// déduction/devinette : une activité non seedée retourne simplement null, et
// l'appelant retombe sur la logique CompetenceDPFC existante.
async function trouverCompetenceParActivite({ discipline, classe, activite }) {
  if (!activite) return null;
  const candidats = await CompetenceParActivite.find({
    discipline: regexExactInsensible(discipline),
    classe: regexExactInsensible(classe)
  });
  const activiteNorm = normaliserTexte(activite);
  return candidats.find((c) => normaliserTexte(c.activite) === activiteNorm) || null;
}

// Recherche floue (texte libre) : la séance officielle DPFC dont l'intitulé
// correspond au sous-thème du texte étudié (déduit de lecon+theme), parmi les
// séances de l'activité demandée. Correspondance insensible casse/accents,
// l'un des deux textes pouvant contenir l'autre — le catalogue lui-même
// définit les intitulés reconnus, aucune liste de mots-clés n'est codée en dur.
async function trouverLeconOfficielleDPFC({ discipline, classe, lecon, theme, activite }) {
  const cible = normaliserTexte(`${lecon || ''} ${theme || ''}`);
  if (!cible) return null;
  const lecons = await LeconOfficielleDPFC.find({
    discipline: regexExactInsensible(discipline),
    classe: regexExactInsensible(classe)
  });
  const activiteNorm = normaliserTexte(activite);
  for (const leconDoc of lecons) {
    for (const seanceDoc of (leconDoc.seances || [])) {
      if (activiteNorm && normaliserTexte(seanceDoc.activite) !== activiteNorm) continue;
      const intituleNorm = normaliserTexte(seanceDoc.intitule);
      if (intituleNorm && (cible.includes(intituleNorm) || intituleNorm.includes(cible))) {
        return { lecon: leconDoc, seance: seanceDoc };
      }
    }
  }
  return null;
}

// Résolution directe par ID (utilisée par l'UI de sélection Leçon -> Séance) :
// aucune ambiguïté, aucun risque de faux positif contrairement à la recherche floue.
async function trouverLeconEtSeanceParId(leconOfficielleId, seanceOfficielleId) {
  if (!leconOfficielleId || !seanceOfficielleId) return null;
  let leconDoc;
  try {
    leconDoc = await LeconOfficielleDPFC.findById(leconOfficielleId);
  } catch {
    return null; // ObjectId invalide
  }
  if (!leconDoc) return null;
  const seanceDoc = leconDoc.seances.id(seanceOfficielleId);
  if (!seanceDoc) return null;
  return { lecon: leconDoc, seance: seanceDoc };
}

function motsDe(texte) {
  return (texte || '').trim().split(/\s+/).filter(Boolean);
}

// Plus long k tel que les k derniers mots de motsA == les k premiers mots de motsB.
function chevauchementSuffixePrefixe(motsA, motsB) {
  const max = Math.min(motsA.length, motsB.length);
  for (let k = max; k > 0; k--) {
    if (motsA.slice(motsA.length - k).join(' ') === motsB.slice(0, k).join(' ')) return k;
  }
  return 0;
}

// Plus long k tel que les k premiers mots de motsA == les k derniers mots de motsB.
function chevauchementPrefixeSuffixe(motsA, motsB) {
  const max = Math.min(motsA.length, motsB.length);
  for (let k = max; k > 0; k--) {
    if (motsA.slice(0, k).join(' ') === motsB.slice(motsB.length - k).join(' ')) return k;
  }
  return 0;
}

// Résout l'intitulé "à barre oblique" d'une séance à choix enseignant (ex.
// "Rédaction d'un récit simple / complexe et complet...") en substituant
// l'alternance par l'option réellement choisie. Le contexte commun avant/après
// la barre est déduit par recouvrement de mots avec la 1ère et la dernière
// option du catalogue : ça marche aussi bien quand le contexte n'est écrit
// qu'une fois ("récit simple / complexe et complet", "récit" élidé après
// "simple") que quand chaque option répète le contexte en entier ("d'un objet
// familier / d'un lieu non animé"). Générique, aucun mot codé en dur — vaut
// pour toute leçon/activité/niveau présent ou futur du catalogue.
function resoudreIntituleAvecOption(intitule, optionsChoix, optionChoisie) {
  const texte = (intitule || '').trim();
  if (!optionsChoix || !optionsChoix.length) return texte;
  if (!texte.includes('/')) return optionChoisie ? `${texte} (${optionChoisie})` : texte;

  const idxPremier = texte.indexOf('/');
  const idxDernier = texte.lastIndexOf('/');
  const tete = texte.slice(0, idxPremier).trim();
  const queue = texte.slice(idxDernier + 1).trim();

  const motsTete = motsDe(tete);
  const kAvant = chevauchementSuffixePrefixe(motsTete, motsDe(optionsChoix[0]));
  const contexteAvant = motsTete.slice(0, motsTete.length - kAvant).join(' ');

  const motsQueue = motsDe(queue);
  const kApres = chevauchementPrefixeSuffixe(motsQueue, motsDe(optionsChoix[optionsChoix.length - 1]));
  const contexteApres = motsQueue.slice(kApres).join(' ');

  return [contexteAvant, optionChoisie, contexteApres].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
}

// Liste les leçons (avec, pour chacune, uniquement les séances de l'activité
// demandée) pour alimenter les menus déroulants Leçon -> Séance de l'écran de
// génération. Tableau vide = pas de catalogue pour cette combinaison = le
// frontend doit basculer sur le champ libre Leçon/Thème. Une séance à choix
// (optionsChoix non vide) est développée en une entrée par option, avec
// l'intitulé déjà résolu (plus de barre oblique) : c'est directement le menu
// Séance qui porte le choix, il n'y a plus de champ Option séparé.
async function listerLeconsOfficielles({ discipline, classe, activite }) {
  const lecons = await LeconOfficielleDPFC.find({
    discipline: regexExactInsensible(discipline),
    classe: regexExactInsensible(classe)
  }).sort({ ordre: 1, numeroLecon: 1 });
  const activiteNorm = normaliserTexte(activite);
  return lecons
    .map((l) => ({
      _id: l._id,
      numeroLecon: l.numeroLecon,
      titreLecon: l.titreLecon,
      seances: (l.seances || [])
        .filter((s) => normaliserTexte(s.activite) === activiteNorm)
        .flatMap((s) => {
          const base = { _id: s._id, numeroSeance: s.numeroSeance, choixLibre: !!s.choixLibre, choixLibreLabel: s.choixLibreLabel || '' };
          if (s.optionsChoix && s.optionsChoix.length) {
            return s.optionsChoix.map((option) => ({
              ...base,
              intitule: resoudreIntituleAvecOption(s.intitule, s.optionsChoix, option),
              optionChoisie: option
            }));
          }
          return [{ ...base, intitule: s.intitule, optionChoisie: '' }];
        })
    }))
    .filter((l) => l.seances.length > 0);
}

// Discipline/classe pour lesquelles la numérotation officielle DPFC n'a, à ce
// jour, jamais été publiée (aucun document source disponible sur dpfc-ci.net).
// Pour ces cas, on ne doit ni inventer une compétence, ni la laisser silencieusement
// absente : le champ Compétence doit afficher un message d'indisponibilité explicite.
const COMPETENCES_NON_DISPONIBLES = [
  { discipline: 'Histoire', classe: '2nde' },
  { discipline: 'Histoire', classe: '1ère' },
  { discipline: 'Géographie', classe: '2nde' },
  { discipline: 'Géographie', classe: '1ère' }
];

function competenceNonDisponible({ discipline, classe }) {
  const d = normaliserTexte(discipline);
  const c = normaliserTexte(classe);
  return COMPETENCES_NON_DISPONIBLES.some((x) => normaliserTexte(x.discipline) === d && normaliserTexte(x.classe) === c);
}

// --- Texte support fourni par l'enseignant : injecté par simple substitution
// de chaîne côté serveur, jamais régénéré par l'IA, pour garantir sa fidélité exacte ---

function echapperHtml(str) {
  return (str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function texteSupportVersHtml(texte) {
  const paragraphes = (texte || '')
    .split(/\r?\n\s*\r?\n/)
    .map((p) => p.trim())
    .filter(Boolean);

  if (!paragraphes.length) return '';

  return paragraphes
    .map((p) => `<p>${echapperHtml(p).replace(/\r?\n/g, '<br>')}</p>`)
    .join('\n');
}

function compterMots(texte) {
  return (texte || '').trim().split(/\s+/).filter(Boolean).length;
}

// Seuil de duplication du texte support (2ᵉ exemplaire en police réduite sur
// la même page, pour permettre à l'enseignant de photocopier une seule feuille
// et distribuer deux exemplaires — économie de papier avec des effectifs
// pléthoriques). Le corps de la fiche est rendu en 11px (voir genererPdfDepuisHtml),
// format A4 portrait avec marges de 15mm. Un texte support est déjà "garanti
// fidèle" jusqu'à 600 mots dans cette app (limite pratique d'un texte qui
// remplit une page entière en taille normale une fois entête + tableaux
// comptés) : la moitié de cette limite laisse une marge confortable pour que
// le texte, ET une seconde copie en police réduite, tiennent tous les deux
// sur la même page sans déborder.
const SEUIL_DUPLICATION_TEXTE_SUPPORT_MOTS = 250;

function texteSupportDoitEtreDuplique(texteSupport) {
  return compterMots(texteSupport) <= SEUIL_DUPLICATION_TEXTE_SUPPORT_MOTS;
}

// Pour l'Expression écrite : le texte support (lettre/écrit modèle que l'élève
// doit observer et reproduire) DOIT tenir sur une seule page, quelle que soit
// son origine (texte fourni par l'enseignant OU exemple généré par l'app) --
// contrairement à la duplication ci-dessus (2 exemplaires, propre à la
// photocopie), ici on réduit simplement la police en fonction de la longueur
// pour que le texte tienne sur une page A4 (corps de fiche en 11px par défaut,
// cf. genererPdfDepuisHtml). Seuils estimés empiriquement, pas une mesure exacte.
function taillePoliceTexteSupportUnePage(motsTexteSupport) {
  if (motsTexteSupport <= 300) return 11;
  if (motsTexteSupport <= 420) return 9.5;
  if (motsTexteSupport <= 550) return 8.5;
  if (motsTexteSupport <= 700) return 7.5;
  return 7;
}

// Au-delà de ce nombre de mots, même la police minimale encore lisible (7px)
// risque de déborder sur une deuxième page une fois l'entête et les marges
// comptés : on ne réduit pas davantage (illisible), on avertit l'enseignant
// à la place plutôt que de tronquer silencieusement son texte.
const SEUIL_DEBORDEMENT_TEXTE_SUPPORT_UNE_PAGE_MOTS = 750;

function texteSupportRisqueDeDeborder(motsTexteSupport) {
  return motsTexteSupport > SEUIL_DEBORDEMENT_TEXTE_SUPPORT_UNE_PAGE_MOTS;
}

function envelopperTexteSupportUnePage(texteHtml, motsTexteSupport) {
  const taille = taillePoliceTexteSupportUnePage(motsTexteSupport);
  // Taille normale (texte déjà assez court) : pas d'enveloppe, pour que le
  // texte support hérite exactement du même rendu que le reste du document
  // (Word comme PDF) au lieu de forcer une taille explicite inutile.
  if (taille >= 11) return texteHtml;
  return `<div class="texte-support-page-unique" style="font-size:${taille}px;line-height:1.25;page-break-inside:avoid;break-inside:avoid;">${texteHtml}</div>`;
}

function injecterTexteSupport(contenuHTML, texteSupport, options = {}) {
  if (!texteSupport) return contenuHTML;
  const texteHtml = texteSupportVersHtml(texteSupport);
  if (!texteHtml) return contenuHTML;

  const motsTexteSupport = compterMots(texteSupport);
  const texteAInserer = options.unePage
    ? envelopperTexteSupportUnePage(texteHtml, motsTexteSupport)
    : texteHtml;

  let resultat;
  if (contenuHTML.includes('{{TEXTE_SUPPORT}}')) {
    // Une seule insertion réelle même si le modèle a répété le marqueur par
    // erreur (ex. une deuxième fois entre les tableaux de vérification des 2
    // axes en Lecture méthodique) : seule la 1ère occurrence reçoit le texte,
    // les occurrences suivantes du marqueur sont simplement retirées.
    const morceaux = contenuHTML.split('{{TEXTE_SUPPORT}}');
    resultat = morceaux[0] + texteAInserer + morceaux.slice(1).join('');
  } else {
    // Le modèle a oublié le marqueur : insère une section dédiée juste avant le
    // tableau de déroulement (qui contient les questions), donc en fin de fiche
    // mais avant la partie questions.
    const section = `<div class="texte-support"><h3>Texte support</h3>${texteAInserer}</div>\n`;
    const derniereTable = contenuHTML.lastIndexOf('<table');
    resultat = derniereTable !== -1
      ? contenuHTML.slice(0, derniereTable) + section + contenuHTML.slice(derniereTable)
      : contenuHTML + section;
  }

  if (options.unePage) {
    // Pas de duplication en Expression écrite (contrainte : une seule page) --
    // si le modèle a quand même ajouté le marqueur par erreur, on le retire.
    resultat = resultat.split('{{TEXTE_SUPPORT_COPIE}}').join('');
  } else if (resultat.includes('{{TEXTE_SUPPORT_COPIE}}')) {
    // Duplication conditionnelle : décidée UNIQUEMENT côté serveur (nombre de
    // mots réel), jamais laissée au jugement du modèle — même si le modèle a
    // inclus le marqueur par erreur pour un texte long, il est retiré ici.
    const copieHtml = texteSupportDoitEtreDuplique(texteSupport)
      ? `<div class="texte-support-copie" style="font-size:8px;line-height:1.3;border-top:1px dashed #999;margin-top:10px;padding-top:6px;">
  <strong>Copie pour photocopie (2<sup>e</sup> exemplaire) :</strong>
  ${texteHtml}
</div>`
      : '';
    resultat = resultat.split('{{TEXTE_SUPPORT_COPIE}}').join(copieHtml);
  }

  return resultat;
}

// Filet de sécurité serveur : un tableau HTML imbriqué dans une cellule
// (<td>/<th>) d'un autre tableau rend mal en Word/PDF (colonnes écrasées,
// texte compressé illisible). Même si le prompt interdit explicitement cette
// imbrication (cas de la lecture méthodique : tableaux d'axes de lecture),
// on ne fait jamais confiance uniquement à l'obéissance du modèle : cette
// fonction extrait tout tableau imbriqué de sa cellule et le replace juste
// après le tableau qui le contenait, comme élément autonome du document.
function separerTableauxImbriques(contenuHTML) {
  if (!contenuHTML || !contenuHTML.includes('<table')) return contenuHTML;
  const $ = cheerio.load(contenuHTML);

  const tableauxImbriques = [];
  $('table').each((_, table) => {
    const $table = $(table);
    if ($table.closest('td, th').length) tableauxImbriques.push($table);
  });
  if (!tableauxImbriques.length) return contenuHTML;

  tableauxImbriques.reverse().forEach(($table) => {
    const $celluleParente = $table.closest('td, th');
    const $tableauExterne = $celluleParente.closest('table');
    $table.remove();
    if ($tableauExterne.length) {
      $tableauExterne.after($table);
    } else {
      $celluleParente.after($table);
    }
  });

  const $racine = $('.fiche-cours').first();
  return $racine.length ? $.html($racine) : $.html($('body').length ? $('body') : $.root());
}

// Détection stricte : uniquement "lecture méthodique" (ni "lecture" seule, ni
// "résumé de texte", ni "commentaire de texte", qui gardent la structure générique).
function estLectureMethodique({ discipline, lecon, theme, activite }) {
  const cible = normaliserTexte(`${discipline || ''} ${lecon || ''} ${theme || ''} ${activite || ''}`);
  return cible.includes('lecture methodique');
}

function estExpressionEcrite({ discipline, lecon, theme, activite }) {
  const cible = normaliserTexte(`${discipline || ''} ${lecon || ''} ${theme || ''} ${activite || ''}`);
  return cible.includes('expression ecrite');
}

// Palier de la classe pour l'adaptation par niveau de la Lecture méthodique
// (tonalité, figures de style) : 6e/5e retirent des notions de lycée que les
// élèves de début de collège n'ont pas encore. Toute classe non reconnue
// (2nde, 1ère, Tle...) retombe sur "lycee", le comportement le plus permissif
// et donc le plus sûr par défaut (celui d'avant ce correctif).
function niveauLectureMethodique(classe) {
  const c = normaliserTexte(classe);
  if (/^6/.test(c)) return '6e';
  if (/^5/.test(c)) return '5e';
  if (/^4/.test(c) || /^3/.test(c)) return '4e_3e';
  return 'lycee';
}

// Référentiel partagé des caractéristiques langagières par type de texte,
// utilisé à la fois pour les "entrées" du tableau de vérification en Lecture
// méthodique et pour la section III "Outils de la langue" du tableau 5
// colonnes en Expression écrite (JAMAIS un tableau séparé — voir
// construireInstructionsExpressionEcriture) — garantit que les deux activités
// restent cohérentes sur un même type de texte au lieu que chaque fiche
// invente librement ses propres entrées. À compléter progressivement (seuls
// 4 types couverts pour l'instant).
// Catégories grammaticales officielles de "types de phrases" -- TOUJOURS les
// 4 mêmes, partagées mot pour mot entre Lecture méthodique et Expression
// écrite : aucune des deux activités ne doit générer sa propre terminologie
// ou une liste partielle (ex. "phrases déclaratives" seules).
const TYPES_PHRASES_OFFICIELS = 'déclarative, interrogative, exclamative, impérative';

// Socle d'outils de base pour la Lecture méthodique en collège (6e/5e/4e/3e) :
// des notions de langue simples, communes à tout type de texte. FUSIONNÉ (pas
// substitué) aux catégories propres au genre -- voir fusionnerCaracteristiquesCollege
// -- pour que Lecture méthodique et Expression écrite restent alignées sur les
// mêmes catégories pour un même genre/niveau (jamais une liste générique qui
// remplacerait silencieusement les catégories du genre, ex. "présentation
// matérielle"/"registre de langue" pour une lettre personnelle).
const OUTILS_BASE_LECTURE_COLLEGE = [
  { categorie: 'structure_texte', description: 'organisation du texte (introduction / développement / conclusion, ou parties selon le type de texte)' },
  { categorie: 'indices_personne', description: 'pronoms personnels et marques de la personne (je/tu/il/elle...)' },
  { categorie: 'types_phrases', description: `types de phrases (${TYPES_PHRASES_OFFICIELS})` },
  { categorie: 'temps_verbaux', description: 'temps verbaux dominants et leur valeur' },
  { categorie: 'lexique', description: 'vocabulaire et champ lexical du thème' },
  { categorie: 'indices_spatiaux', description: 'indices de lieu (prépositions, adverbes de lieu)' },
  { categorie: 'verbes_etat', description: "verbes d'état (être, sembler, paraître, devenir...)" },
  { categorie: 'mode', description: 'mode verbal (indicatif, impératif...)' }
];

// Figures de style disponibles par palier collège, ajoutées progressivement.
// Le "UNIQUEMENT si..." est répété ici (pas seulement dans consigneEntrees) car
// cette liste peut être citée isolément par formaterCaracteristiquesReferentiel.
function figureStyleParNiveauCollege(niveau) {
  const listes = {
    '6e': 'comparaison, métaphore, énumération/gradation',
    '5e': 'comparaison, métaphore, énumération/gradation, hyperbole',
    '4e_3e': 'comparaison, métaphore, énumération/gradation, hyperbole, personnification'
  };
  return { categorie: 'figures_style', description: `${listes[niveau]} — UNIQUEMENT si réellement présentes dans le texte support, jamais de façon systématique` };
}

// Fusionne les catégories propres au genre (caracteristiquesGenre, celles
// utilisées telles quelles par Expression écrite) avec le socle collège --
// EN GARDANT en priorité celles du genre (ex. presentation_materielle,
// registre_langue pour une lettre personnelle) et en n'AJOUTANT que les
// catégories du socle collège absentes du genre (dédoublonnage par
// "categorie"). Garantit que Lecture méthodique dispose d'assez d'entrées
// pour ses 2 axes SANS jamais perdre ni contredire les catégories déjà
// utilisées pour ce même genre/niveau en Expression écrite.
function fusionnerCaracteristiquesCollege(caracteristiquesGenre, niveau) {
  const categoriesGenre = new Set(caracteristiquesGenre.map((c) => c.categorie));
  const baseCollegeManquante = OUTILS_BASE_LECTURE_COLLEGE.filter((c) => !categoriesGenre.has(c.categorie));
  return [...caracteristiquesGenre, ...baseCollegeManquante, figureStyleParNiveauCollege(niveau)];
}

const REFERENTIEL_TYPES_TEXTE = {
  'texte explicatif': {
    caracteristiques: [
      { categorie: 'lexique', description: 'vocabulaire technique/scientifique, champ lexical du phénomène expliqué' },
      { categorie: 'temps_verbaux', description: 'présent de vérité générale (valeur de permanence)' },
      { categorie: 'types_phrases', description: `types de phrases (${TYPES_PHRASES_OFFICIELS}) — dominante déclarative pour ce type de texte` },
      { categorie: 'donnees_chiffrees', description: "statistiques, mesures, proportions appuyant l'explication" },
      { categorie: 'connecteurs_logiques', description: "d'abord, ensuite, en effet, au final — articulation causale/chronologique" }
    ]
  },
  'lettre personnelle': {
    caracteristiques: [
      { categorie: 'presentation_materielle', description: "en-tête (lieu, date), formule d'appel, corps (introductive/développement/finale), signature" },
      { categorie: 'indices_personne', description: 'pronoms personnels je/tu selon relation expéditeur-destinataire' },
      { categorie: 'registre_langue', description: 'standard ou familier selon la relation' },
      { categorie: 'types_phrases', description: `types de phrases (${TYPES_PHRASES_OFFICIELS}) selon l'intention de l'auteur (ex. dominante déclarative pour donner des nouvelles)` }
    ]
  },
  'portrait': {
    caracteristiques: [
      { categorie: 'lexique', description: 'vocabulaire évaluatif (appréciatif/dépréciatif), champs lexicaux physiques/moraux' },
      { categorie: 'images', description: 'comparaisons' },
      { categorie: 'temps_verbaux', description: "imparfait et présent de l'indicatif (effet de réalisme)" },
      { categorie: 'adjectifs', description: 'adjectifs qualificatifs' },
      { categorie: 'verbes', description: "verbes d'état" },
      { categorie: 'structure', description: 'introduction / développement / conclusion' }
    ]
  },
  'texte descriptif (objet)': {
    caracteristiques: [
      { categorie: 'lexique', description: 'champ lexical du luxe/de la richesse ou du thème valorisé selon l\'objet' },
      { categorie: 'adjectifs', description: 'adjectifs qualificatifs valorisants' },
      { categorie: 'enumeration', description: 'énumération organisée (spatiale : extérieur→intérieur, haut→bas)' },
      { categorie: 'procedes_stylistiques', description: "exclamations, apostrophe, hyperbole selon l'effet recherché" }
    ]
  }
};

// Recherche insensible à la casse/accents : correspondance exacte d'abord,
// puis correspondance partielle (l'un des deux textes contient l'autre) —
// permet à un enseignant de taper juste "Portrait" ou "texte descriptif"
// sans connaître la clé exacte du référentiel.
// "classe" est optionnel : quand omis (cas Expression écrite), le comportement
// est EXACTEMENT celui d'avant ce correctif -- liste "caracteristiques" complète,
// non filtrée. Quand fourni (cas Lecture méthodique uniquement), la liste du
// genre est FUSIONNÉE avec le socle collège adapté au palier (6e/5e/4e_3e,
// cf. fusionnerCaracteristiquesCollege), sauf au lycée où "caracteristiques"
// (comportement historique, sans ajout) reste utilisée telle quelle.
function trouverReferentielTypeTexte(typeTexteDemande, classe) {
  const cible = normaliserTexte(typeTexteDemande);
  if (!cible) return null;
  const cles = Object.keys(REFERENTIEL_TYPES_TEXTE);
  const exact = cles.find((cle) => normaliserTexte(cle) === cible);
  const cleTrouvee = exact || cles.find((cle) => {
    const cleNorm = normaliserTexte(cle);
    // retire les qualificatifs entre parenthèses (ex. "texte descriptif (objet)" ->
    // "texte descriptif") pour matcher même quand l'enseignant ne les précise pas.
    const cleCoeur = cleNorm.replace(/\s*\([^)]*\)\s*/g, ' ').trim();
    return cleNorm.includes(cible) || cible.includes(cleNorm) || cible.includes(cleCoeur);
  });
  if (!cleTrouvee) return null;

  const entree = REFERENTIEL_TYPES_TEXTE[cleTrouvee];
  if (classe) {
    const niveau = niveauLectureMethodique(classe);
    const caracteristiquesNiveau = niveau === 'lycee' ? entree.caracteristiques : fusionnerCaracteristiquesCollege(entree.caracteristiques, niveau);
    return { typeTexte: cleTrouvee, caracteristiques: caracteristiquesNiveau };
  }
  return { typeTexte: cleTrouvee, caracteristiques: entree.caracteristiques };
}

function formaterCaracteristiquesReferentiel(caracteristiques) {
  return caracteristiques.map((c) => `- ${c.categorie} : ${c.description}`).join('\n');
}

// Figures citées dans la ligne "Analyser" du tableau Habiletés : même
// progression par palier que figureStyleParNiveauCollege ci-dessus, mais en
// une seule chaîne (pas un objet {categorie, description}) puisqu'elle
// s'insère directement dans le texte de la ligne. Au lycée, texte inchangé.
function figuresAnalyserParNiveau(niveau) {
  if (niveau === '6e') return 'comparaison, métaphore, énumération/gradation';
  if (niveau === '5e') return 'comparaison, métaphore, énumération/gradation, hyperbole';
  if (niveau === '4e_3e') return 'comparaison, métaphore, énumération/gradation, hyperbole, personnification';
  return 'figures de style';
}

function habiletesLectureMethodique(niveau) {
  return `  <tr><td style="border:1px solid #000;padding:6px;">Connaître</td><td style="border:1px solid #000;padding:6px;">le thème étudié</td></tr>
  <tr><td style="border:1px solid #000;padding:6px;">Identifier</td><td style="border:1px solid #000;padding:6px;">les outils de la langue pertinents / les champs lexicaux liés au thème</td></tr>
  <tr><td style="border:1px solid #000;padding:6px;">Analyser</td><td style="border:1px solid #000;padding:6px;">les procédés utilisés (choix lexicaux, temps verbaux, types de phrases, ${figuresAnalyserParNiveau(niveau)}...)</td></tr>
  <tr><td style="border:1px solid #000;padding:6px;">Interpréter</td><td style="border:1px solid #000;padding:6px;">les effets produits sur le lecteur par ces procédés</td></tr>
  <tr><td style="border:1px solid #000;padding:6px;">Appliquer</td><td style="border:1px solid #000;padding:6px;">la démarche de la lecture méthodique</td></tr>`;
}

function construireInstructionsLectureMethodique(referentiel, classe) {
  const niveau = niveauLectureMethodique(classe);
  const reglesFiguresReelles = ' Les figures de style éventuellement listées ci-dessus ne sont que des possibilités : n\'utilise QUE celles réellement présentes dans le texte support fourni, jamais de façon systématique — si aucune de ces figures n\'apparaît dans le texte, n\'en invente aucune et appuie-toi sur les autres catégories.';
  const consigneEntrees = referentiel
    ? `Les « entrées » possibles pour les 2 tableaux d'axes sont IMPOSÉES par le référentiel du type de texte « ${referentiel.typeTexte} » ci-dessous — pioche EXCLUSIVEMENT dans ces catégories (tu peux n'en utiliser qu'une partie selon les 2 axes retenus, mais n'en invente AUCUNE en dehors de cette liste) :\n${formaterCaracteristiquesReferentiel(referentiel.caracteristiques)}\n\nLes relevés précis (citations, exemples tirés du texte) restent bien sûr propres à CE texte : seules les catégories/étiquettes des « entrées » sont fixées par le référentiel.${reglesFiguresReelles}`
    : `Aucun référentiel de caractéristiques n'est disponible pour ce type de texte précis : détermine les « entrées » les plus pertinentes toi-même, à partir d'une analyse rigoureuse du texte, en respectant STRICTEMENT la contrainte ci-dessous sur la nature des entrées.${reglesFiguresReelles}`;

  // 6e/5e : les élèves de début de collège n'ont pas encore la notion de
  // tonalité littéraire -- retirée de la question de lecture ET de la phrase
  // qui en dérive l'hypothèse générale, pour rester cohérent avec ce qui a
  // réellement été établi en I. Inchangé à partir de 4e (comportement
  // historique).
  const questionTonalite = (niveau === '6e' || niveau === '5e') ? '' : ' Quelle est sa tonalité ?';
  const composantesHypothese = (niveau === '6e' || niveau === '5e') ? 'de la nature + le thème identifiés en I' : 'de la nature + la tonalité + le thème identifiés en I';

  // 6e/5e : même exigence de vocabulaire concret que dans les fiches
  // d'Expression écrite de ces niveaux -- pas de méta-langage dense
  // (« procédés d'expression de... », « organisation spatiale de... »).
  // Inchangé à partir de 4e (comportement historique, vocabulaire plus
  // technique déjà maîtrisé).
  const consigneNiveauLangage = (niveau === '6e' || niveau === '5e')
    ? `\n\nNIVEAU DE LANGUE (6e/5e) : le vocabulaire de l'hypothèse générale, des libellés des 2 axes et des colonnes Analyses/Interprétations doit rester CONCRET et ACCESSIBLE à des élèves de début de collège — au même niveau de langue que celui déjà utilisé dans les fiches d'Expression écrite pour ce niveau. INTERDITS car trop abstraits/savants pour ce niveau : des formulations comme « procédés d'expression de l'admiration », « organisation spatiale de la description », ou toute expression méta-linguistique dense. Préfère des formulations simples et directement descriptives (ex. « les mots qui montrent que [le personnage] va bien » plutôt que « les marqueurs lexicaux de l'état de santé »).`
    : '';

  return `

STRUCTURE OBLIGATOIRE SPÉCIFIQUE — LECTURE MÉTHODIQUE (cette fiche est une lecture méthodique : les instructions ci-dessous REMPLACENT intégralement, pour CETTE fiche uniquement, le tableau Habiletés/Contenus générique, la structure du DÉVELOPPEMENT et le contenu de l'ÉVALUATION décrits plus haut. L'entête et la Situation d'apprentissage restent inchangés. La ligne PRÉSENTATION rituelle du début de séance reste aussi inchangée dans sa structure, SAUF la contrainte suivante :) :

CONTRAINTE SUR LA LIGNE PRÉSENTATION RITUELLE (avant "I. Présentation du texte") : cette phase d'accueil ne doit JAMAIS révéler le thème précis du texte étudié, ni aucune conclusion, idée ou information tirée de son contenu. Reste strictement générique (ex. « un texte que nous allons découvrir ensemble », « la leçon du jour »). En particulier, les étapes (h) Identification de la notion à partir de la situation et (i) Annonce du titre officiel de la leçon ne doivent mentionner QUE le titre officiel de la leçon/l'activité (ex. « La description »), jamais le sujet précis du texte qui sera étudié (ex. jamais « nous allons étudier un texte sur un avion »). La découverte du thème se fait UNIQUEMENT via le questionnement guidé de la phase I ci-dessous.

RÈGLE ANTI-RÉPÉTITION (valable pour toute la fiche) : chaque moment (Présentation du texte, Hypothèse générale, Vérification, Bilan général) pose des questions propres à SON contenu précis. Ne reformule JAMAIS une question déjà posée à une étape antérieure à une étape suivante — chaque question doit faire progresser l'analyse, pas la répéter.${consigneNiveauLangage}

TEXTE SUPPORT — UNE SEULE INSERTION DANS TOUT LE DOCUMENT : utilise le marqueur {{TEXTE_SUPPORT}} UNE SEULE FOIS, à un seul endroit de la fiche. Ne le recopie, ne le mentionne et ne le réinsère JAMAIS une deuxième fois ailleurs — en particulier JAMAIS entre le tableau de vérification de l'Axe 1 et celui de l'Axe 2, ni entre aucun autre tableau. Une seule occurrence du marqueur, nulle part ailleurs dans le document.

SUPPORTS DIDACTIQUES/BIBLIOGRAPHIE — structure en tableau à deux colonnes inchangée, mais le contenu de la colonne Supports didactiques doit mentionner explicitement que le texte support est photocopié et distribué en un exemplaire par élève — JAMAIS recopié au tableau ni affiché.

TABLEAU HABILETÉS ET CONTENUS — formule FIXE ci-dessous, obligatoire pour toute lecture méthodique, NE JAMAIS la réinventer ni l'adapter au texte :
${habiletesLectureMethodique(niveau)}

DÉVELOPPEMENT — remplace la règle "ligne Développement unique" : utilise OBLIGATOIREMENT 4 lignes numérotées I à IV dans le tableau DÉROULEMENT (jamais moins, jamais plus), chacune avec les 5 colonnes standard (Moments didactiques/Durée | Stratégies pédagogiques/Plan du cours | Activités de l'enseignant | Activités des élèves | Traces écrites) :

I. PRÉSENTATION (du texte, distincte de la ligne PRÉSENTATION rituelle du début de séance) — uniquement sous forme de QUESTIONS-RÉPONSES, jamais de texte narratif :
   - Le professeur distribue le texte (un exemplaire par élève), puis questionne sur le paratexte : Quel est le titre du texte ? Quelle est la source/l'édition ? Qui est l'auteur (si applicable) ? → à partir de ces réponses, rédige la présentation en Traces écrites (1 à 2 phrases seulement).
   - Lecture silencieuse : question ouverte « De quoi peut-il s'agir ? »
   - Lecture magistrale, puis questions : Quelle est la nature du texte ?${questionTonalite} Quel est son thème ?

II. HYPOTHÈSE GÉNÉRALE — UNE SEULE phrase, dérivée EXPLICITEMENT ${composantesHypothese}. Ne la donne JAMAIS d'emblée : présente-la comme la synthèse/déduction des réponses précédentes (question du type « À partir de ce que nous venons d'identifier, quelle hypothèse pouvons-nous formuler sur ce texte ? »). Formule-la TOUJOURS en deux SEGMENTS explicites et juxtaposés, jamais fondus en une seule idée globale et jamais deux propositions accolées par « puis », « et exprime », « et décrit »... : SEGMENT 1 = caractérisation du texte/genre (ex. « Lettre familière », « Extrait de roman descriptif ») ; SEGMENT 2 = le contenu ou la fonction précise du texte (ex. « dans laquelle Konan Aurélie donne ses nouvelles à sa mère », « décrivant un objet merveilleux »). Patron : « [SEGMENT 1] [connecteur : dans laquelle / où / qui] [SEGMENT 2]. » Retiens ces deux segments tels quels : ce sont EXACTEMENT ce qui sera repris comme libellés des 2 axes en III ci-dessous.

III. VÉRIFICATION DE L'HYPOTHÈSE GÉNÉRALE :
   1. Détermination des axes de lecture : EXACTEMENT 2 axes (jamais 3, jamais 4). Axe 1 = SEGMENT 1 de l'hypothèse générale ci-dessus, repris QUASI MOT POUR MOT (ex. hypothèse « Lettre familière dans laquelle Konan Aurélie donne ses nouvelles à sa mère » → Axe 1 « Une lettre familière »). Axe 2 = SEGMENT 2, repris QUASI MOT POUR MOT (ex. Axe 2 « Les nouvelles d'Aurélie à sa mère »). INTERDICTION ABSOLUE d'introduire dans le libellé d'un axe une notion, un procédé ou une catégorie d'analyse ABSENTE des mots de l'hypothèse (interdits si l'hypothèse ne les mentionne pas, ex. : « organisation spatiale », « procédés d'expression de... ») : les axes ne sont JAMAIS le produit d'une analyse indépendante du texte, seulement une reformulation quasi identique des deux segments déjà écrits dans l'hypothèse.
   2. Dans la ligne III du tableau DÉROULEMENT, la colonne Traces écrites contient UNIQUEMENT du texte simple (jamais de tableau) : le libellé des 2 axes (ex. "Axe 1 : ... / Axe 2 : ..."). Les Activités de l'enseignant/des élèves de cette ligne portent le questionnement guidé qui permet de dégager ces axes.
   3. Pour CHAQUE axe, un tableau à 4 colonnes (Entrées | Indices textuels (Relevés/Repérage) | Analyses | Interprétations) rempli PAR QUESTIONNEMENT GUIDÉ (chaque ligne correspond à une « entrée » avec des relevés précis tirés du texte, l'analyse du procédé, et l'interprétation de son effet). Ce tableau COMMENCE par une ligne-titre fusionnée sur les 4 colonnes (<td colspan="4">) annonçant « Axe 1 : [libellé] » (ou « Axe 2 : ... »). Chaque cellule « Entrées » contient une question numérotée intégrée, reformulée SPÉCIFIQUEMENT pour ce que cette ligne observe dans CE texte — jamais un gabarit générique recopié tel quel d'une entrée à l'autre (style attendu : « 1- Relevez... », « 2- Nommez et justifiez... », « 4- Pourquoi/Que révèle... »). ${consigneEntrees} Dans tous les cas (référentiel disponible ou non), les entrées sont STRICTEMENT des catégories linguistiques/grammaticales/lexicales (temps verbaux, types et formes de phrase, indices spatiaux/temporels, lexique thématique/mélioratif/péjoratif, pronoms, comparaisons et autres figures de style, ponctuation...) — JAMAIS une entrée thématique ou psychologisante (interdits, ex. : « le regret », « l'attachement affectif », « les détails techniques », « l'irruption du sentiment »...). Si un tel aspect thématique/affectif apparaît dans le texte sans être couvert par les 2 axes, il devient la matière de l'extrait d'ÉVALUATION plus bas — jamais une entrée de ce tableau. CES 2 TABLEAUX SONT DES ÉLÉMENTS AUTONOMES DU DOCUMENT HTML, PLACÉS APRÈS LE TABLEAU DÉROULEMENT COMPLET (donc en dehors de toute balise <td>/<th>) — JAMAIS imbriqués à l'intérieur d'une cellule d'un autre tableau (rendu illisible en Word/PDF : colonnes écrasées, texte compressé). Un tableau HTML ne doit JAMAIS contenir un autre tableau HTML dans une de ses cellules, nulle part dans la fiche.

IV. BILAN GÉNÉRAL :
   - Question de synthèse : « Quels éléments de la langue/du texte ont permis d'étudier ce texte ? »
   - Confrontation EXPLICITE hypothèse/bilan, avec la formule EXACTE : « Notre hypothèse générale est donc vérifiée. »
   - Optionnel : une question d'ouverture ou d'avis personnel.

ÉVALUATION (ligne distincte du tableau DÉROULEMENT, différente et SÉPARÉE du Bilan général — ne jamais fusionner les deux) :
   - Fournis un relevé NEUF, non exploité dans le corps de la fiche (nouvelles citations du MÊME texte, non analysées plus haut dans les axes).
   - Demande à l'élève, SEUL : 1) d'identifier l'entrée correspondante, 2) d'analyser, 3) d'interpréter. Ce sont les SEULS moments de toute la fiche où ce registre de verbes taxonomiques (Identifier, Analyser, Interpréter, Appliquer) s'adresse directement à l'élève dans une consigne — partout ailleurs dans la fiche, langage naturel de classe.
   - Si un aspect thématique/affectif du texte n'a pas été traité dans les 2 axes (ex. un revirement de sentiment en fin de texte), c'est CET extrait d'évaluation qui doit le faire travailler.
   - INTERDICTION ABSOLUE de remplacer ceci par des questions de compréhension du texte (ex. « qui est le narrateur ? », « que ressent-il ? ») : l'évaluation teste la maîtrise de la MÉTHODE de lecture méthodique, pas la compréhension du contenu.`;
}

// Seuil arbitraire mais raisonnable pour distinguer un vrai plan de cours rédigé
// (plusieurs phrases, généralement structuré autour de ses propres repères
// I/II/III/IV) d'un champ vide ou d'un texte insignifiant tapé par erreur. Pas
// besoin d'exiger la présence des repères eux-mêmes ici : leur détection est
// laissée au modèle (voir construireInstructionsLectureMethodiqueAvecPlanEnseignant).
const SEUIL_PLAN_COURS_SUBSTANTIEL_CARACTERES = 60;

function planCoursEstSubstantiel(planCours) {
  return (planCours || '').toString().trim().length >= SEUIL_PLAN_COURS_SUBSTANTIEL_CARACTERES;
}

// --- Parseur déterministe du plan de l'enseignant (mode "plan fourni") ---
//
// Diagnostic (voir historique des échanges) : le tableau 5 colonnes n'est
// construit NULLE PART côté serveur -- ni pour la génération automatique, ni
// pour le mode plan-enseignant -- il est intégralement écrit en HTML libre par
// le modèle, à partir d'un exemple donné dans le prompt. Confier aussi la
// RÉPARTITION du plan de l'enseignant à ce mécanisme s'est révélé peu fiable en
// pratique (texte du plan collé tel quel dans une seule cellule). Les fonctions
// ci-dessous remplacent cette délégation par un découpage et une construction
// HTML 100% déterministes, côté code, pour le mode plan-enseignant -- seule la
// correction orthographique/grammaticale et la mise en page du reste de la
// fiche (entête, situation, habiletés, supports) restent confiées au modèle.

// Reconnaît un repère de section en tout début de ligne : "I", "II", "III",
// "IV" (romains MAJUSCULES uniquement -- une casse minuscule serait trop
// ambiguë avec de vrais mots comme "il" ou l'abréviation "iv") suivi d'un
// séparateur OBLIGATOIRE parmi . ) : - – — (espaces optionnels avant/après :
// "I.", "I )", "I -", "I:", "I.Présentation" sont tous acceptés). Reconnaît
// aussi "Évaluation"/"Evaluation" (insensible à la casse, séparateur
// optionnel). Le séparateur est OBLIGATOIRE pour les repères numérotés
// précisément pour ne jamais confondre "I" avec un mot qui commence par I.
const SEPARATEUR_REPERE_SRC = '[.):\\-–—]';

function detecterRepereLigne(ligne) {
  const mNumero = new RegExp(`^\\s*(IV|III|II|I)\\s*${SEPARATEUR_REPERE_SRC}\\s*(.*)$`).exec(ligne);
  if (mNumero) return { type: 'numero', numero: mNumero[1], resteDeLigne: mNumero[2].trim() };
  const mEval = new RegExp(`^\\s*[EÉ]valuation\\s*(?:${SEPARATEUR_REPERE_SRC})?\\s*(.*)$`, 'i').exec(ligne);
  if (mEval) return { type: 'evaluation', resteDeLigne: mEval[1].trim() };
  return null;
}

// Segmente le plan de l'enseignant en blocs I/II/III/IV/Évaluation. AUCUNE
// tolérance de contenu inventé : si les 4 repères I/II/III/IV ne sont pas TOUS
// trouvés, dans cet ordre, avec du contenu associé, le parsing échoue
// EXPLICITEMENT ({ ok: false, raison }) -- jamais de fallback silencieux qui
// ferait semblant d'avoir réussi (voir construireInstructionsLectureMethodiqueAvecPlanEnseignant
// pour le comportement de repli, toujours signalé à l'enseignant).
function parserPlanEnseignant(planCours) {
  const lignes = (planCours || '').replace(/\r\n/g, '\n').split('\n');
  const reperesAttendus = ['I', 'II', 'III', 'IV'];
  const positions = {};
  const resteDeLigneParRepere = {};

  lignes.forEach((ligne, index) => {
    const repere = detecterRepereLigne(ligne);
    if (!repere) return;
    if (repere.type === 'numero') {
      if (positions[repere.numero] !== undefined) return; // 1ère occurrence gardée, pas d'écrasement ambigu
      positions[repere.numero] = index;
      resteDeLigneParRepere[repere.numero] = repere.resteDeLigne;
    } else if (repere.type === 'evaluation' && positions.evaluation === undefined) {
      positions.evaluation = index;
      resteDeLigneParRepere.evaluation = repere.resteDeLigne;
    }
  });

  const manquants = reperesAttendus.filter((r) => positions[r] === undefined);
  if (manquants.length) {
    return { ok: false, raison: `repère(s) manquant(s) : ${manquants.join(', ')}` };
  }

  const ordreAVerifier = [...reperesAttendus, ...(positions.evaluation !== undefined ? ['evaluation'] : [])];
  for (let i = 1; i < ordreAVerifier.length; i++) {
    if (positions[ordreAVerifier[i]] <= positions[ordreAVerifier[i - 1]]) {
      return { ok: false, raison: `repères dans le désordre (${ordreAVerifier[i - 1]} après ${ordreAVerifier[i]})` };
    }
  }

  const texteEntre = (indexDebut, indexFin, resteEnTete) =>
    [resteEnTete, ...lignes.slice(indexDebut + 1, indexFin)].join('\n').trim();

  const segments = {
    presentation: texteEntre(positions.I, positions.II, resteDeLigneParRepere.I),
    hypothese: texteEntre(positions.II, positions.III, resteDeLigneParRepere.II),
    verification: texteEntre(positions.III, positions.IV, resteDeLigneParRepere.III),
    bilan: texteEntre(positions.IV, positions.evaluation !== undefined ? positions.evaluation : lignes.length, resteDeLigneParRepere.IV),
    evaluation: positions.evaluation !== undefined ? texteEntre(positions.evaluation, lignes.length, resteDeLigneParRepere.evaluation) : ''
  };

  if (!segments.presentation || !segments.hypothese || !segments.verification || !segments.bilan) {
    return { ok: false, raison: 'repère(s) trouvé(s) mais sans contenu associé' };
  }

  return { ok: true, segments };
}

// À l'intérieur de la partie III (Vérification), détecte les sous-titres
// "Axe 1"/"Axe 2" (tolérant : "Axe 1 :", "Axe 1)", "Axe 1 -"...), puis, pour
// chaque axe, tente de repérer des puces structurées par les étiquettes
// Entrée / Indices (ou Relevés) / Analyse / Interprétation. Si LES 4
// étiquettes d'une puce sont trouvées, elle devient une ligne propre à 4
// colonnes ; sinon son texte brut est conservé intégralement dans une ligne à
// cellule fusionnée -- jamais perdu, jamais réinventé.
const ETIQUETTES_ENTREE_AXE = [
  { cle: 'entree', regex: /entr[ée]e?s?\s*:\s*/i },
  { cle: 'indices', regex: /(?:indices?(?:\s+textuels?)?|relev[ée]s?)\s*:\s*/i },
  { cle: 'analyse', regex: /analyses?\s*:\s*/i },
  { cle: 'interpretation', regex: /interpr[ée]tations?\s*:\s*/i }
];

function decouperParEtiquettes(texte, etiquettes) {
  const positions = [];
  etiquettes.forEach(({ cle, regex }) => {
    const m = regex.exec(texte);
    if (m) positions.push({ cle, index: m.index, finEtiquette: m.index + m[0].length });
  });
  positions.sort((a, b) => a.index - b.index);
  const resultat = {};
  positions.forEach((pos, i) => {
    const fin = i + 1 < positions.length ? positions[i + 1].index : texte.length;
    resultat[pos.cle] = texte.slice(pos.finEtiquette, fin).trim().replace(/[\s.]+$/, '');
  });
  return resultat;
}

function parserEntreesAxe(texteAxe) {
  const blocs = (texteAxe || '')
    .split(/\n(?=\s*[-•])/)
    .map((b) => b.trim())
    .filter(Boolean);
  if (!blocs.length) return [];

  return blocs.map((bloc) => {
    const champs = decouperParEtiquettes(bloc, ETIQUETTES_ENTREE_AXE);
    const complet = champs.entree && champs.indices && champs.analyse && champs.interpretation;
    return complet
      ? { structure: true, entree: champs.entree, indices: champs.indices, analyse: champs.analyse, interpretation: champs.interpretation }
      : { structure: false, brut: bloc.replace(/^[-•]\s*/, '') };
  });
}

function parserAxesDepuisVerification(texteVerification) {
  const lignes = (texteVerification || '').split('\n');
  const regexAxe = /^\s*Axe\s*(\d+)\s*[.):\-–—]?\s*(.*)$/i;

  const blocs = [];
  let courant = null;
  lignes.forEach((ligne) => {
    const m = regexAxe.exec(ligne);
    if (m) {
      if (courant) blocs.push(courant);
      courant = { numero: m[1], titre: m[2].trim(), lignesBrutes: [] };
    } else if (courant) {
      courant.lignesBrutes.push(ligne);
    }
  });
  if (courant) blocs.push(courant);

  return blocs.map((axe) => ({
    numero: axe.numero,
    titre: axe.titre,
    entrees: parserEntreesAxe(axe.lignesBrutes.join('\n'))
  }));
}

// Construit UNE ligne <tr> du tableau déroulement 5 colonnes -- SEULE fonction
// qui construit une ligne de ce tableau pour le mode plan-enseignant (mêmes
// bordures/styles que le reste du gabarit, cf. construirePromptSecondaire).
function construireLigneDeroulementHTML({ moment, strategie, activiteEnseignant, activiteEleves, tracesEcrites }) {
  const cell = (contenu, extra = '') => `<td style="border:1px solid #000;padding:6px;vertical-align:top;${extra}">${contenu || ''}</td>`;
  return `  <tr>
${cell(moment, 'font-weight:bold;')}
${cell(strategie)}
${cell(activiteEnseignant)}
${cell(activiteEleves)}
${cell(tracesEcrites)}
  </tr>`;
}

// Construit le tableau autonome à 4 colonnes d'un axe (ligne-titre fusionnée +
// une ligne par entrée) -- SEULE fonction qui construit ce tableau pour le
// mode plan-enseignant.
function construireTableauAxeHTML(numero, titre, entrees) {
  const lignesHTML = entrees.length
    ? entrees.map((e) => e.structure
        ? `  <tr><td style="border:1px solid #000;padding:6px;">${e.entree}</td><td style="border:1px solid #000;padding:6px;">${e.indices}</td><td style="border:1px solid #000;padding:6px;">${e.analyse}</td><td style="border:1px solid #000;padding:6px;">${e.interpretation}</td></tr>`
        : `  <tr><td colspan="4" style="border:1px solid #000;padding:6px;">${e.brut}</td></tr>`
      ).join('\n')
    : '  <tr><td colspan="4" style="border:1px solid #000;padding:6px;"></td></tr>';

  return `<table style="width:100%;border-collapse:collapse;margin-bottom:12px;">
  <tr><td colspan="4" style="border:1px solid #000;padding:6px;background:#e4ede6;font-weight:bold;">Axe ${numero} : ${titre}</td></tr>
  <tr><th style="border:1px solid #000;padding:6px;background:#333;color:#fff;">Entrées</th><th style="border:1px solid #000;padding:6px;background:#333;color:#fff;">Indices textuels</th><th style="border:1px solid #000;padding:6px;background:#333;color:#fff;">Analyses</th><th style="border:1px solid #000;padding:6px;background:#333;color:#fff;">Interprétations</th></tr>
${lignesHTML}
</table>`;
}

// Orchestre les 2 fonctions ci-dessus à partir des segments déjà découpés par
// parserPlanEnseignant : construit les lignes I à IV (+ Évaluation) du
// tableau déroulement, et les tableaux d'axes détectés dans la partie III.
function construireDeroulementPlanEnseignantHTML(segments) {
  const axes = parserAxesDepuisVerification(segments.verification);
  const libelleAxes = axes.length
    ? axes.map((a) => `Axe ${a.numero} : ${a.titre}`).join(' / ')
    : texteSupportVersHtml(segments.verification).replace(/<\/?p>/g, ' ').trim();

  const lignesHTML = [
    construireLigneDeroulementHTML({
      moment: 'I. PRÉSENTATION DU TEXTE',
      strategie: 'Présentation du texte (paratexte)',
      activiteEnseignant: 'Présente le texte et questionne sur son paratexte.',
      activiteEleves: 'Relèvent les éléments du texte identifiés dans le plan.',
      tracesEcrites: texteSupportVersHtml(segments.presentation)
    }),
    construireLigneDeroulementHTML({
      moment: 'II. HYPOTHÈSE GÉNÉRALE',
      strategie: 'Question de synthèse',
      activiteEnseignant: "Invite les élèves à formuler une hypothèse de lecture.",
      activiteEleves: "Formulent l'hypothèse.",
      tracesEcrites: texteSupportVersHtml(segments.hypothese)
    }),
    construireLigneDeroulementHTML({
      moment: 'III. VÉRIFICATION',
      strategie: 'Annonce des axes de vérification',
      activiteEnseignant: 'Annonce les axes retenus.',
      activiteEleves: 'Notent les axes.',
      tracesEcrites: libelleAxes
    }),
    construireLigneDeroulementHTML({
      moment: 'IV. BILAN GÉNÉRAL',
      strategie: 'Synthèse',
      activiteEnseignant: 'Fait la synthèse avec les élèves.',
      activiteEleves: "Confirment la vérification de l'hypothèse.",
      tracesEcrites: texteSupportVersHtml(segments.bilan)
    }),
    construireLigneDeroulementHTML({
      moment: 'ÉVALUATION',
      strategie: segments.evaluation ? 'Travail individuel' : '',
      activiteEnseignant: segments.evaluation ? 'Donne le sujet.' : '',
      activiteEleves: segments.evaluation ? 'Travaillent seuls, à l\'écrit.' : '',
      // Ligne laissée VIDE si l'enseignant n'a pas rédigé d'Évaluation --
      // jamais d'exercice inventé pour la compléter.
      tracesEcrites: segments.evaluation ? texteSupportVersHtml(segments.evaluation) : ''
    })
  ].join('\n');

  const axesHTML = axes.length ? axes.map((a) => construireTableauAxeHTML(a.numero, a.titre, a.entrees)).join('\n\n') : '';

  return { lignesHTML, axesHTML };
}

// Mode "plan fourni par l'enseignant" -- ALTERNATIF à construireInstructionsLectureMethodique
// ci-dessus (qui reste utilisée telle quelle quand ce mode n'est pas déclenché,
// cf. planCoursEstSubstantiel) : l'enseignant a rédigé lui-même l'intégralité
// du contenu pédagogique (hypothèse, axes, analyses, interprétations) dans le
// champ Plan du cours. Le contenu est désormais découpé et mis en tableau de
// façon 100% déterministe côté code (parserPlanEnseignant +
// construireDeroulementPlanEnseignantHTML) -- le modèle ne fait plus que
// placer 3 marqueurs ({{TEXTE_SUPPORT}}, {{DEROULEMENT_PLAN_ENSEIGNANT}},
// {{AXES_PLAN_ENSEIGNANT}}) au bon endroit, il n'écrit plus lui-même le
// contenu pédagogique ni ne décide de sa répartition en cellules.
//
// Retourne { instructions, injectionDeroulement, injectionAxes, avertissement } :
// - injectionDeroulement/injectionAxes sont les blocs HTML déjà construits, à
//   injecter après génération (cf. injecterDeroulementPlanEnseignant) --
//   null si le parsing a échoué (voir bloc de repli ci-dessous).
// - avertissement, non-null uniquement si le parsing a échoué : à afficher
//   explicitement à l'enseignant (jamais un échec silencieux).
function construireInstructionsLectureMethodiqueAvecPlanEnseignant(classe, planCours) {
  const niveau = niveauLectureMethodique(classe);
  const resultatParsing = parserPlanEnseignant(planCours);

  // Portée de la restriction explicitement bornée au DÉVELOPPEMENT (tableau
  // de vérification) -- tout le reste de la fiche (entête, Compétence,
  // Situation d'apprentissage, Habiletés/Contenus, Supports/Bibliographie)
  // reste à rédiger NORMALEMENT, comme en mode automatique, à partir des
  // instructions données plus haut/plus bas dans ce message. Reformulé après
  // un test réel où une formulation trop générale ("REMPLACE... aucune ne
  // s'applique ici", "ta seule tâche") avait fait disparaître le champ
  // Compétence -- le modèle avait sur-généralisé la restriction à toute la
  // fiche au lieu de la seule partie développement/vérification.
  const enteteCommun = `

STRUCTURE OBLIGATOIRE SPÉCIFIQUE — LECTURE MÉTHODIQUE, MODE "PLAN FOURNI PAR L'ENSEIGNANT" (cette fiche est une lecture méthodique dont l'enseignant a rédigé lui-même l'intégralité du contenu pédagogique du développement -- hypothèse, axes, analyses, interprétations. Les instructions ci-dessous concernent UNIQUEMENT le tableau Habiletés/Contenus, la structure du DÉVELOPPEMENT et le contenu de l'ÉVALUATION : elles REMPLACENT, pour ces 3 éléments SEULEMENT, les règles du mode automatique de Lecture méthodique décrites par ailleurs dans ce message. TOUT LE RESTE DE LA FICHE N'EST PAS CONCERNÉ et reste à rédiger NORMALEMENT à partir des instructions générales données ailleurs dans ce message : entête (y compris le champ Compétence, à résoudre exactement comme d'habitude), Situation d'apprentissage, Supports didactiques/Bibliographie ci-dessous.) :

RÈGLE ABSOLUE, UNIQUEMENT POUR LE CONTENU PÉDAGOGIQUE DU DÉVELOPPEMENT (hypothèse, axes de lecture, entrées des tableaux de vérification, analyses, interprétations) : tu ne dois JAMAIS l'inventer, le compléter ou le reformuler substantiellement. Il vient à 100% du texte de l'enseignant. Cette règle ne concerne QUE ce contenu précis -- elle ne restreint rien d'autre dans la fiche.

CONTRAINTE SUR LA LIGNE PRÉSENTATION RITUELLE (avant "I. Présentation du texte", début de séance) : inchangée par rapport au mode automatique -- cette phase d'accueil ne doit JAMAIS révéler le thème précis du texte étudié. Reste strictement générique (ex. « un texte que nous allons découvrir ensemble »). Ne la rédige toi-même que si l'enseignant ne l'a pas incluse dans son plan.

SUPPORTS DIDACTIQUES/BIBLIOGRAPHIE — structure en tableau à deux colonnes inchangée ; le contenu de la colonne Supports didactiques doit mentionner explicitement que le texte support est photocopié et distribué en un exemplaire par élève -- JAMAIS recopié au tableau ni affiché.

TABLEAU HABILETÉS ET CONTENUS — formule FIXE ci-dessous, obligatoire pour toute lecture méthodique, NE JAMAIS la réinventer ni l'adapter au texte (élément mécanique, non concerné par le plan de l'enseignant) :
${habiletesLectureMethodique(niveau)}`;

  if (!resultatParsing.ok) {
    const instructions = enteteCommun + `

ÉCHEC DE LA DÉTECTION AUTOMATIQUE DES PARTIES (${resultatParsing.raison}) : le plan fourni par l'enseignant ne suit pas le format attendu (repères "I.", "II.", "III.", "IV." -- chacun en tout début de ligne, suivi d'un point, d'une parenthèse fermante, de deux-points ou d'un tiret -- manquants, mal placés ou dans le désordre). MODE DE REPLI, obligatoire dans ce cas, et UNIQUEMENT pour la partie DÉVELOPPEMENT : place l'INTÉGRALITÉ du texte de l'enseignant (reproduit à la toute fin de ce message, corrigé orthographiquement, jamais réécrit sur le fond) dans la ligne DÉVELOPPEMENT unique du tableau DÉROULEMENT, à l'intérieur d'un bloc commençant EXACTEMENT par : "<strong>⚠ Plan non structuré automatiquement (format des repères I./II./III./IV. non reconnu) :</strong>" suivi du texte de l'enseignant. N'essaie PAS de deviner ou de reconstituer la structure toi-même. Le reste de la fiche (entête, Compétence, Situation, etc.) n'est pas concerné par ce mode de repli.`;

    return {
      instructions,
      injectionDeroulement: null,
      injectionAxes: null,
      // Reproduit APRÈS toutes les autres instructions du message (Leçon/
      // Séance/Compétence officielles...), jamais juste avant -- pour ne pas
      // noyer ces instructions sous un pavé de texte brut potentiellement
      // long (cause probable du champ Compétence disparu constaté en test).
      planCoursPourPromptFinal: `\n\nPLAN DE COURS FOURNI PAR L'ENSEIGNANT (contenu à corriger orthographiquement, jamais à réinventer, pour la ligne DÉVELOPPEMENT UNIQUEMENT -- ne concerne aucun autre champ de la fiche) :\n${planCours}`,
      avertissement: `Le plan de cours fourni n'a pas pu être structuré automatiquement (${resultatParsing.raison}) : les repères "I.", "II.", "III.", "IV." sont attendus chacun en tout début de ligne. La fiche a été générée en mode de repli (texte non structuré, clairement signalé dans le document) -- corrigez le format des repères et régénérez pour obtenir un tableau correctement réparti.`
    };
  }

  const { lignesHTML, axesHTML } = construireDeroulementPlanEnseignantHTML(resultatParsing.segments);

  const instructions = enteteCommun + `

DÉTECTION RÉUSSIE — le plan de l'enseignant a déjà été segmenté et mis en tableau AUTOMATIQUEMENT, côté serveur (pas par toi), selon ses repères I/II/III/IV${resultatParsing.segments.evaluation ? '/Évaluation' : ''}. Le tableau DÉROULEMENT (lignes I à IV${resultatParsing.segments.evaluation ? ' et Évaluation' : ''}) et le ou les tableaux d'axes sont DÉJÀ CONSTRUITS. Concernant UNIQUEMENT cette partie développement/vérification (pas le reste de la fiche), ta tâche est de placer 3 marqueurs au bon endroit, sans rien écrire d'autre à leur place :
   1. Dans le tableau DÉROULEMENT (5 colonnes), juste après la ligne PRÉSENTATION rituelle (celle-ci, générique, reste à ta charge comme d'habitude), place EXACTEMENT le marqueur {{DEROULEMENT_PLAN_ENSEIGNANT}} comme SEUL contenu de cette position -- il sera remplacé par les lignes I à IV${resultatParsing.segments.evaluation ? ' et Évaluation' : ''} déjà construites. Referme normalement le tableau juste après (</table>).
   2. Juste APRÈS ce tableau DÉROULEMENT (donc après son </table>, au même niveau que les autres tableaux de la fiche, JAMAIS à l'intérieur d'une cellule), place EXACTEMENT le marqueur {{TEXTE_SUPPORT}} sur sa propre ligne, UNE SEULE FOIS dans tout le document -- il sera remplacé par le texte support fourni par l'enseignant.
   3. Juste après {{TEXTE_SUPPORT}}, place EXACTEMENT le marqueur {{AXES_PLAN_ENSEIGNANT}} sur sa propre ligne -- il sera remplacé par le ou les tableaux d'axes déjà construits.
N'invente, ne recopie, ne reformule et ne réordonne RIEN du contenu du plan toi-même pour cette partie : il est déjà entièrement construit. Le reste de la fiche (entête, Compétence, Situation d'apprentissage, Supports/Bibliographie...) n'est PAS concerné par cette restriction et se rédige normalement.`;

  // Le texte brut du plan n'a plus besoin d'être montré au modèle dans le cas
  // réussi : il ne sert plus qu'à la structuration, déjà faite côté code --
  // ne pas l'inclure supprime à la fois le risque de dilution des
  // instructions suivantes (Leçon/Séance/Compétence) et toute tentation du
  // modèle de réécrire lui-même ce contenu.
  return { instructions, injectionDeroulement: lignesHTML, injectionAxes: axesHTML, avertissement: null, planCoursPourPromptFinal: null };
}

// Injecte, comme injecterTexteSupport ci-dessus, le contenu déjà construit
// déterministiquement par construireDeroulementPlanEnseignantHTML à la place
// des 2 marqueurs dédiés. Même logique anti-duplication : seule la 1ère
// occurrence de chaque marqueur reçoit le contenu, les éventuelles occurrences
// suivantes (erreur du modèle) sont retirées, jamais dupliquées.
function injecterDeroulementPlanEnseignant(contenuHTML, injection) {
  if (!injection || (injection.injectionDeroulement === null && injection.injectionAxes === null)) return contenuHTML;
  let resultat = contenuHTML;

  const injecterMarqueurUneFois = (html, marqueur, contenu) => {
    if (contenu === null || !html.includes(marqueur)) return html;
    const morceaux = html.split(marqueur);
    return morceaux[0] + contenu + morceaux.slice(1).join('');
  };

  resultat = injecterMarqueurUneFois(resultat, '{{DEROULEMENT_PLAN_ENSEIGNANT}}', injection.injectionDeroulement);
  resultat = injecterMarqueurUneFois(resultat, '{{AXES_PLAN_ENSEIGNANT}}', injection.injectionAxes);
  return resultat;
}

function construireInstructionsExpressionEcriture(referentiel) {
  const consigneOutils = referentiel
    ? `Les catégories ci-dessous sont IMPOSÉES par le référentiel du type de texte « ${referentiel.typeTexte} » — reprends EXACTEMENT ces catégories (ni plus, ni moins, ne pas en inventer d'autres), chacune reformulée en une consigne concrète adaptée au thème précis de la leçon :\n${formaterCaracteristiquesReferentiel(referentiel.caracteristiques)}`
    : `Aucun référentiel de catégories n'est disponible pour ce type de texte précis : détermine toi-même les outils de la langue (grammaticaux et lexicaux) les plus pertinents, à partir d'une analyse rigoureuse du genre de texte demandé.`;

  return `

STRUCTURE OBLIGATOIRE SPÉCIFIQUE — EXPRESSION ÉCRITE (cette fiche est une expression écrite : les instructions ci-dessous REMPLACENT intégralement, pour CETTE fiche uniquement, l'ORDRE des tableaux, la structure du DÉVELOPPEMENT et le contenu de l'ÉVALUATION décrits plus haut. L'entête garde son format standard — libellés en gras à gauche, valeur à droite, jamais de répétition du mot "Leçon"/"Séance" déjà présent dans le libellé.) :

Ce squelette est IDENTIQUE quel que soit le niveau (6e à 3e) et quel que soit le genre de texte (lettre, portrait, texte explicatif, résumé, compte-rendu, dialogue argumentatif, description...) : seul le contenu injecté (habiletés, situation, textes, outils de langue) change, jamais la structure ni l'ordre des tableaux ci-dessous.

ORDRE OBLIGATOIRE DES ÉLÉMENTS (remplace l'ordre générique "Situation puis Habiletés" décrit plus haut) : Entête, PUIS Tableau Habiletés/Contenus, PUIS Situation d'apprentissage, PUIS Tableau Supports didactiques/Bibliographie, PUIS Tableau 5 colonnes. Le tableau Habiletés/Contenus vient TOUJOURS AVANT la Situation d'apprentissage pour cette activité (jamais après, contrairement à l'ordre par défaut).

TABLEAU HABILETÉS ET CONTENUS (2 colonnes : Habiletés | Contenus), placé avant la Situation d'apprentissage — généré DYNAMIQUEMENT à partir du genre de texte et de la leçon en cours, JAMAIS codé en dur pour un seul type de texte : colonne 1 = verbes taxonomiques pertinents pour CETTE leçon (le nombre et l'ordre varient librement selon la leçon — ex. Identifier, Définir, Utiliser, Organiser, Appliquer — ne fige jamais une liste unique valable pour tous les genres) ; colonne 2 = le contenu associé à chaque verbe, spécifique au genre de texte/à la séance en cours.

TABLEAU SUPPORTS DIDACTIQUES / BIBLIOGRAPHIE (2 colonnes, juste après la Situation d'apprentissage) : la colonne « Supports didactiques » indique la source du texte/support utilisé ; la colonne « Bibliographie » REPREND EXACTEMENT LE MÊME CONTENU que la colonne « Supports didactiques » (les deux colonnes doivent être identiques — ne jamais la laisser vide, ni y mettre autre chose que ce contenu dupliqué).

TABLEAU 5 COLONNES — la ligne d'en-tête (Moments didactiques/Durée | Stratégies | Activités de l'enseignant | Activités des élèves | Traces écrites) n'apparaît QU'UNE SEULE FOIS, en haut du tableau, jamais répétée sur les pages suivantes en cas de saut de page.

NE CRÉE JAMAIS de tableau séparé intitulé « Outils de la langue à utiliser » (ni aucun autre tableau annexe portant ce contenu) entre le tableau Supports didactiques/Bibliographie et le tableau 5 colonnes : les outils de la langue (grammaticaux et lexicaux) sont intégrés UNIQUEMENT dans la section III (« Outils de la langue ») du tableau 5 colonnes ci-dessous, jamais dupliqués ailleurs dans le document.

CONTRAINTE DE MISE EN PAGE DU TEXTE SUPPORT (modèle que les élèves doivent observer et reproduire) : il DOIT tenir sur une seule page, sans jamais déborder sur une deuxième, pour que sa mise en forme (en-tête, alinéas, disposition, espacement de la formule de politesse...) reste observable d'un coup d'œil — cette règle vaut à l'identique, que le texte support soit fourni par l'enseignant (collé ou importé) ou que tu doives en proposer un exemple toi-même faute de texte fourni. Utilise UNIQUEMENT le marqueur {{TEXTE_SUPPORT}} pour un texte fourni (une seule fois, jamais {{TEXTE_SUPPORT_COPIE}} : pas de duplication en Expression écrite, contrairement à la Lecture méthodique). Si tu dois rédiger toi-même l'exemple, reste sous les 250 mots et places-le dans une balise <div class="texte-support-page-unique">.

PHASE DE PRÉSENTATION (première ligne du tableau 5 colonnes, 5 à 10 mn) — rituel obligatoire, sous forme d'échanges questions/réponses alignés 1 pour 1 entre Activités de l'enseignant et Activités des élèves :
   - « Quelle activité avons-nous aujourd'hui ? »
   - Rappel des notions/moyens déjà vus par les élèves en lien avec la leçon du jour (ex. « quels types de textes/moyens de communication avez-vous déjà rencontrés ? »).
   - Annonce du thème du jour (« aujourd'hui nous allons étudier... »).
   - Le professeur écrit la situation d'apprentissage dans un coin du tableau.
   - SI la séance est la suite d'une leçon déjà entamée (Séance 2, 3...) : l'enseignant rappelle D'ABORD la leçon et la séance précédentes, AVANT d'annoncer la nouvelle séance — ne traite JAMAIS une séance 2/3 comme si c'était une nouvelle leçon.

DÉVELOPPEMENT — utilise OBLIGATOIREMENT les moments suivants, chacun dans sa propre ligne numérotée du tableau DÉROULEMENT (jamais fusionnés entre eux, jamais réordonnés) :
   I. DÉFINITION — définir le genre de texte étudié.
   II. STRUCTURE/CARACTÉRISTIQUES — selon le genre de texte (ex. présentation matérielle d'une lettre, plan d'un texte explicatif...).
   III. OUTILS DE LA LANGUE (grammaticaux et lexicaux) — ${consigneOutils}
   IV. RECHERCHE ET ORGANISATION DES IDÉES — un tableau à 3 colonnes Introduction | Développement | Conclusion, rempli en Traces écrites avec les idées dégagées collectivement par les élèves pour LE sujet/la situation du jour. CE TABLEAU EST UN ÉLÉMENT AUTONOME DU DOCUMENT HTML, placé juste après la ligne IV du tableau DÉROULEMENT — JAMAIS imbriqué à l'intérieur d'une cellule <td>/<th> d'un autre tableau (un tableau HTML ne doit jamais en contenir un autre dans une de ses cellules, nulle part dans la fiche).
   V. RÉDACTION COLLECTIVE — élaboration collective, à l'oral puis à l'écrit, d'un texte modèle à partir du plan Introduction/Développement/Conclusion ci-dessus.

ÉVALUATION (ligne distincte du tableau DÉROULEMENT) : propose une SITUATION NOUVELLE, non traitée en classe (sujet différent de celui exploité en développement), demandant à l'élève de rédiger SEUL un texte du même genre en réinvestissant la définition, la structure et les outils de la langue vus plus haut.`;
}

function leconNecessiteTexteSupport({ discipline, lecon, theme, activite }) {
  const cible = normaliserTexte(`${discipline || ''} ${lecon || ''} ${theme || ''} ${activite || ''}`);
  const motsClefs = [
    'lecture methodique', 'lecture', 'expression ecrite',
    'comprehension de texte', 'comprehension ecrite',
    'etude de texte', 'commentaire de texte', 'resume de texte'
  ];
  return motsClefs.some((m) => cible.includes(m));
}

function texteCelluleAvecEspaces($, cell) {
  $(cell).find('br').replaceWith(' ');
  return $(cell).text().replace(/\s+/g, ' ').trim();
}

function extraireTracesEcritesDeroulement(contenuHTML) {
  const $ = cheerio.load(contenuHTML || '');
  const traces = [];

  $('table').each((_, table) => {
    const $table = $(table);
    const entetes = $table.find('tr').first().find('th').map((_, th) => $(th).text().trim().toLowerCase()).get();
    if (!entetes.length) return;

    // colonne "Traces écrites" (secondaire) ou, à défaut, dernière colonne d'un tableau de déroulement (primaire : "Observations")
    let indexTraces = entetes.findIndex((t) => t.includes('trace'));
    const estDeroulement = entetes.some((t) => t.includes('moment') || t.includes('étape') || t.includes('etape') || t.includes('activité') || t.includes('activite'));
    if (indexTraces === -1 && estDeroulement) indexTraces = entetes.length - 1;
    if (indexTraces === -1) return;

    $table.find('tr').slice(1).each((_, tr) => {
      const cells = $(tr).find('td');
      if (!cells.length) return;
      const moment = texteCelluleAvecEspaces($, cells.get(0));
      const traceCell = cells.get(indexTraces);
      if (!traceCell) return;
      const trace = texteCelluleAvecEspaces($, traceCell);
      if (trace) traces.push(`${moment} : ${trace}`);
    });
  });

  return traces;
}

function resumerSeancesPrecedentes(fichesPrecedentes) {
  return fichesPrecedentes.map((f) => {
    const traces = extraireTracesEcritesDeroulement(f.contenu);
    const contenu = traces.length
      ? traces.join('\n')
      : '(traces écrites non détectées automatiquement — se référer au thème général de la séance)';
    return `Séance ${f.seance} (${f.lecon}) :\n${contenu}`;
  }).join('\n\n');
}

function construirePromptSecondaire(avecVerbesTaxonomiques) {
  const commentaireHabiletes = avecVerbesTaxonomiques
    ? '<!-- lignes avec verbes taxonomiques : Identifier, Reconnaître, Connaître, Analyser, Appliquer, Produire -->'
    : '<!-- lignes avec les habiletés/objectifs pertinents pour cette leçon -->';

  const reglesVerbesTaxonomiques = avecVerbesTaxonomiques
    ? `- Verbes taxonomiques de Bloom : Identifier, Reconnaître, Connaître, Analyser, Appliquer, Produire
- Pour chaque question posée par l'enseignant dans la colonne Activités de l'enseignant, formule-la EN PRIORITÉ avec un verbe taxonomique de Bloom (Identifie, Nomme, Cite, Définis, Explique, Compare, Analyse, Applique, Résous, Produis...). N'utilise des questions ouvertes ou situationnelles qu'en complément, après la question taxonomique principale.
- Les questions de la colonne Activités de l'enseignant doivent rester STRICTEMENT ouvertes : l'énoncé de la question ne doit JAMAIS contenir la réponse ni une reformulation de la réponse (ex. interdit : « Comment remplacer le deuxième « Aminata » par « Elle » ? La phrase deviendrait plus élégante. » — la fin de la phrase donne la réponse). La réponse attendue n'apparaît QUE dans la colonne Activités des élèves, jamais anticipée côté enseignant, pour respecter la logique de situation-problème où l'élève découvre la règle par lui-même.
- Le champ Compétence de l'entête doit reprendre EXACTEMENT ce qui est fourni plus bas dans ce message sous "COMPÉTENCE OFFICIELLE DPFC" — soit le numéro et le libellé officiels au format "Compétence N : libellé officiel", soit (si la compétence est signalée NON DISPONIBLE) le message d'indisponibilité fourni tel quel. N'INVENTE JAMAIS un numéro ou un libellé de compétence, même plausible ou approximatif, et ne reformule jamais le libellé fourni : ce champ ne doit contenir QUE ce qui t'est explicitement donné dans ce message.
`
    : '';

  const presentationActiviteEnseignant = avecVerbesTaxonomiques
    ? `- [Salutation : ex. « Bonjour les élèves, comment allez-vous ? »]
- [Appel : fait l'appel des élèves un à un]
- [Date du jour : « Quelle est la date d'aujourd'hui ? »]
- [Identification de l'activité du jour selon la répartition : « Quelle est notre activité aujourd'hui ? »]
- [Rappel de la séance précédente : « Que retenons-nous de la séance précédente ? » — UNIQUEMENT si Séance n° > 1 ; si Séance n° = 1, SUPPRIME entièrement cette ligne ainsi que la ligne correspondante côté élèves]
- [Annonce d'une nouvelle leçon/séance]
- [Lecture de la situation d'apprentissage et mise au tableau du corpus/support]
- [Identification de la notion à partir de la situation : « D'après cette situation, quelle notion allons-nous étudier aujourd'hui ? »]
- [Annonce du titre officiel de la leçon]
- [Transition vers la première notion de la séance du jour]`
    : '« Bonjour la classe » / « Bonjour les élèves », PUIS questions précises de rappel des prérequis';

  const presentationActiviteEleves = avecVerbesTaxonomiques
    ? `- [Réponse de salutation]
- [Réponse à l'appel : « Présent(e) »]
- [Élèves donnent la date du jour]
- [Élèves identifient la discipline/activité du jour]
- [Élèves rappellent le titre et l'essentiel de la leçon précédente — UNIQUEMENT si Séance n° > 1]
- [Élèves écoutent l'annonce de la nouvelle leçon/séance]
- [Élèves observent le corpus/support mis au tableau]
- [Élèves proposent/identifient la notion à étudier]
- [Élèves notent le titre officiel de la leçon]
- [Élèves suivent la transition vers la première notion]`
    : 'Réponse d\'accueil des élèves, PUIS réponses attendues aux questions de rappel';

  const presentationTraces = avecVerbesTaxonomiques
    ? '[Titre officiel de la leçon]'
    : '[activité/leçon/séance]';

  const commentairePresentation = avecVerbesTaxonomiques
    ? `<!-- PRÉSENTATION : ordre FIXE des étapes rituelles ci-dessous, chaque étape = un ÉCHANGE professeur/élèves aligné 1 pour 1 entre les colonnes Activités de l'enseignant et Activités des élèves (JAMAIS un monologue du professeur seul) : (a) Salutation (b) Appel (c) Date du jour (d) Identification de l'activité du jour selon la répartition (e) Rappel de la séance précédente [UNIQUEMENT si Séance n° > 1, sinon omets entièrement cette étape des deux colonnes] (f) Annonce d'une nouvelle leçon/séance (g) Lecture de la situation d'apprentissage et mise au tableau du corpus/support (h) Identification de la notion à partir de la situation (i) Annonce du titre officiel de la leçon (j) Transition vers la première notion de la séance du jour. -->`
    : '';

  return `Tu es un expert en pédagogie ivoirienne (APC/DPFC).
Tu génères des fiches de cours COMPLÈTES au format officiel des lycées et collèges de Côte d'Ivoire.

STRUCTURE OBLIGATOIRE EN HTML :

<div class="fiche-cours">

<!-- ENTÊTE VERTICAL -->
<!-- Les lignes Leçon et Séance ONT un libellé devant, comme tous les autres
     champs : {{lecon}} et {{seance}} ne contiennent QUE "N : Titre"/"N : Intitulé"
     (le numéro et le texte), JAMAIS le mot "Leçon"/"Séance" en toutes lettres,
     puisqu'il est déjà dans le libellé -- ce serait sinon une répétition. -->
<div class="entete-libre" style="display:grid;grid-template-columns:110px 1fr;column-gap:12px;row-gap:2px;margin-bottom:14px;">
  <div style="font-weight:bold;padding:2px 0;">Discipline :</div><div style="padding:2px 0;">{{discipline}}</div>
  <div style="font-weight:bold;padding:2px 0;">Date :</div><div style="padding:2px 0;"></div>
  <div style="font-weight:bold;padding:2px 0;">Classe :</div><div style="padding:2px 0;">{{classe}}</div>
  <div style="font-weight:bold;padding:2px 0;">Compétence :</div><div style="padding:2px 0;">{{competence}}</div>
  <div style="font-weight:bold;padding:2px 0;">Activité :</div><div style="padding:2px 0;">{{activite}}</div>
  <div style="font-weight:bold;padding:2px 0;">Durée :</div><div style="padding:2px 0;">{{duree}}</div>
  <div style="font-weight:bold;padding:2px 0;">Leçon :</div><div style="padding:2px 0;">{{lecon}}</div>
  <div style="font-weight:bold;padding:2px 0;">Séance :</div><div style="padding:2px 0;">{{seance}}</div>
</div>

<!-- SI GRAMMAIRE : corpus de phrases avant le tableau habiletés -->
<!-- SITUATION D'APPRENTISSAGE -->
<p><strong>Situation d'apprentissage :</strong> [Situation ancrée dans le quotidien ivoirien]</p>

<!-- TABLEAU HABILETÉS ET CONTENUS -->
<table style="width:100%;border-collapse:collapse;margin-bottom:12px;">
  <tr><th style="border:1px solid #000;padding:6px;background:#333;color:#fff;">Habiletés</th><th style="border:1px solid #000;padding:6px;background:#333;color:#fff;">Contenus</th></tr>
  ${commentaireHabiletes}
</table>

<!-- SUPPORTS DIDACTIQUES ET BIBLIOGRAPHIE CÔTE À CÔTE -->
<table style="width:100%;border-collapse:collapse;margin-bottom:12px;">
  <tr>
    <td style="border:1px solid #000;padding:8px;width:50%;vertical-align:top;"><strong>Supports didactiques</strong><br>- [support 1]<br>- [support 2]</td>
    <td style="border:1px solid #000;padding:8px;width:50%;vertical-align:top;"><strong>Bibliographie</strong><br>- [ref 1]<br>- [ref 2]</td>
  </tr>
</table>

<!-- DÉROULEMENT - 5 COLONNES OBLIGATOIRES -->
<table style="width:100%;border-collapse:collapse;">
  <tr>
    <th style="border:1px solid #000;padding:6px;background:#333;color:#fff;width:15%;">Moments didactiques / Durée</th>
    <th style="border:1px solid #000;padding:6px;background:#333;color:#fff;width:20%;">Stratégies pédagogiques / Plan du cours</th>
    <th style="border:1px solid #000;padding:6px;background:#333;color:#fff;width:25%;">Activités de l'enseignant</th>
    <th style="border:1px solid #000;padding:6px;background:#333;color:#fff;width:25%;">Activités des élèves</th>
    <th style="border:1px solid #000;padding:6px;background:#333;color:#fff;width:15%;">Traces écrites</th>
  </tr>
  ${commentairePresentation}
  <tr>
    <td style="border:1px solid #000;padding:6px;font-weight:bold;vertical-align:top;">PRÉSENTATION<br>(5 mn)</td>
    <td style="border:1px solid #000;padding:6px;vertical-align:top;">[stratégie : questions-réponses, procédé interrogatif...]</td>
    <td style="border:1px solid #000;padding:6px;vertical-align:top;">${presentationActiviteEnseignant}</td>
    <td style="border:1px solid #000;padding:6px;vertical-align:top;">${presentationActiviteEleves}</td>
    <td style="border:1px solid #000;padding:6px;vertical-align:top;">${presentationTraces}</td>
  </tr>
  <!-- DÉVELOPPEMENT : UNE SEULE LIGNE pour toute la phase (jamais une ligne par point). La numérotation I-1, I-2, II-1... n'apparaît QUE dans "Plan du cours" et "Traces écrites". Dans "Activités de l'enseignant" et "Activités des élèves", rédige chaque question/réponse avec un simple tiret "- ", SANS préfixe numéroté, mais en respectant STRICTEMENT le même ordre entre les deux colonnes : la 1ère question correspond à la 1ère réponse, la 2ème à la 2ème, etc., pour garder l'alignement question/réponse. -->
  <tr>
    <td style="border:1px solid #000;padding:6px;font-weight:bold;vertical-align:top;">DÉVELOPPEMENT<br>(35-40 mn)</td>
    <td style="border:1px solid #000;padding:6px;vertical-align:top;">[plan détaillé : I- ... II- ... III- ...]</td>
    <td style="border:1px solid #000;padding:6px;vertical-align:top;">- [question]<br>- [question]<br>- [question]<br>- [question]<br>...</td>
    <td style="border:1px solid #000;padding:6px;vertical-align:top;">- [réponse]<br>- [réponse]<br>- [réponse]<br>- [réponse]<br>...</td>
    <td style="border:1px solid #000;padding:6px;vertical-align:top;">I-1) [trace écrite]<br>I-2) [trace écrite]<br>II-1) [trace écrite]<br>II-2) [trace écrite]<br>...</td>
  </tr>
  <tr>
    <td style="border:1px solid #000;padding:6px;font-weight:bold;vertical-align:top;">ÉVALUATION<br>(10-15 mn)</td>
    <td style="border:1px solid #000;padding:6px;vertical-align:top;">[travail individuel]</td>
    <td style="border:1px solid #000;padding:6px;vertical-align:top;">[exercices d'application]</td>
    <td style="border:1px solid #000;padding:6px;vertical-align:top;">[élèves s'exécutent]</td>
    <td style="border:1px solid #000;padding:6px;vertical-align:top;">[correction]</td>
  </tr>
</table>

</div>

ADAPTATIONS PAR DISCIPLINE :
- GRAMMAIRE : ajoute un corpus de phrases numérotées P1 P2 P3... avant le tableau habiletés
- LECTURE MÉTHODIQUE : inclus présentation du texte, hypothèse générale, axes de lecture avec tableaux de vérification (Entrée | Relevés | Analyse | Interprétation)
- EXPRESSION ÉCRITE : inclus le texte support, questions de compréhension, vocabulaire, résumé
- MATHÉMATIQUES : inclus exercices d'application avec solutions détaillées
- SVT / PHYSIQUE-CHIMIE : inclus expériences, schémas descriptifs, observations, conclusions
- HISTOIRE-GÉO : inclus documents sources, cartes, questions d'exploitation
- ANGLAIS : inclus dialogue, compréhension, production orale et écrite
- EDHC : inclus situations civiques, valeurs, débat

RÈGLES ABSOLUES :
- Réponds UNIQUEMENT en HTML pur, JAMAIS de backticks, JAMAIS de markdown
- Situation d'apprentissage toujours ancrée dans le quotidien ivoirien (lycées, marchés, quartiers CI)
- Traces écrites = contenu réel complet du cours (définitions, règles, exemples concrets)
${reglesVerbesTaxonomiques}- Si le champ Séance n° est supérieur à 1 pour la même leçon, la PRÉSENTATION doit obligatoirement inclure un rappel explicite (question de l'enseignant + réponse attendue + trace écrite) du contenu vu à la ou les séance(s) précédente(s) de cette leçon, avant d'entamer le contenu nouveau.
- Toujours 3 phases = 3 lignes du tableau : Présentation / Développement / Évaluation. La ligne Développement est UNIQUE (jamais une ligne par point) : les paragraphes de questions/réponses sont alignés à la même position dans les colonnes Activités de l'enseignant / Activités des élèves (tirets simples "- ", SANS numérotation), la numérotation I-1, I-2, II-1... restant réservée aux colonnes Plan du cours et Traces écrites`;
}

const PROMPT_PRIMAIRE = `Tu es un expert en pédagogie ivoirienne pour l'enseignement primaire.
Tu génères des fiches de leçon COMPLÈTES au format utilisé dans les écoles primaires de Côte d'Ivoire.

FORMAT PRIMAIRE :

<div class="fiche-cours primaire">
  <div class="entete">
    <h2>FICHE DE LEÇON</h2>
    <div class="entete-libre" style="display:grid;grid-template-columns:110px 1fr;column-gap:12px;row-gap:2px;">
      <div style="font-weight:bold;padding:2px 0;">École :</div><div style="padding:2px 0;">{{ecole}}</div>
      <div style="font-weight:bold;padding:2px 0;">Classe :</div><div style="padding:2px 0;">{{classe}}</div>
      <div style="font-weight:bold;padding:2px 0;">Matière :</div><div style="padding:2px 0;">{{discipline}}</div>
      <div style="font-weight:bold;padding:2px 0;">Effectif :</div><div style="padding:2px 0;">{{effectif}}</div>
      <div style="font-weight:bold;padding:2px 0;">Thème :</div><div style="padding:2px 0;">{{theme}}</div>
      <div style="font-weight:bold;padding:2px 0;">Durée :</div><div style="padding:2px 0;">{{duree}}</div>
      <div style="font-weight:bold;padding:2px 0;">Leçon :</div><div style="padding:2px 0;">{{lecon}}</div>
      <div style="font-weight:bold;padding:2px 0;">Objectifs pédagogiques :</div><div style="padding:2px 0;"></div>
      <div style="font-weight:bold;padding:2px 0;">Matériel :</div><div style="padding:2px 0;"></div>
    </div>
  </div>

  <div class="deroulement">
    <h3>Déroulement de la leçon</h3>
    <table class="deroulement-table">
      <tr>
        <th>Étapes / Durée</th>
        <th>Activités du maître</th>
        <th>Activités des élèves</th>
        <th>Observations</th>
      </tr>
      <!-- PREMIÈRE LIGNE OBLIGATOIRE (Présentation / Mise en train) : le maître commence par « Bonjour les enfants », les élèves répondent, PUIS viennent les questions de rappel des prérequis -->
      <tr>
        <td>PRÉSENTATION<br>(5 mn)</td>
        <td>« Bonjour les enfants », PUIS questions précises de rappel des prérequis</td>
        <td>Réponse d'accueil des élèves, PUIS réponses attendues aux questions de rappel</td>
        <td>[observation ou trace écrite de cette étape]</td>
      </tr>
      <!-- DÉVELOPPEMENT : UNE SEULE LIGNE pour toute la phase (jamais une ligne par point). La numérotation I-1, I-2, II-1... n'apparaît QUE dans "Observations" (trace écrite). Dans "Activités du maître" et "Activités des élèves", rédige chaque question/réponse avec un simple tiret "- ", SANS préfixe numéroté, mais en respectant STRICTEMENT le même ordre entre les deux colonnes : la 1ère question correspond à la 1ère réponse, la 2ème à la 2ème, etc., pour garder l'alignement question/réponse. -->
      <tr>
        <td>DÉVELOPPEMENT<br>(X mn)</td>
        <td>- [question]<br>- [question]<br>- [question]<br>...</td>
        <td>- [réponse]<br>- [réponse]<br>- [réponse]<br>...</td>
        <td>I-1) [trace écrite]<br>I-2) [trace écrite]<br>II-1) [trace écrite]<br>...</td>
      </tr>
      <tr>
        <td>ÉVALUATION<br>(X mn)</td>
        <td>[travail individuel / exercice d'application]</td>
        <td>[élèves s'exécutent]</td>
        <td>[correction]</td>
      </tr>
    </table>
  </div>
</div>

RÈGLES :
- Langage simple, adapté à l'âge (primaire CP1-CM2)
- Objectifs avec verbes d'action : nommer, lire, écrire, calculer, tracer, colorier, distinguer...
- Activités concrètes, manipulatoires, ludiques
- Ancrage dans le quotidien ivoirien (marchés, villages, saisons, fruits locaux...)
- Si le champ Séance n° est supérieur à 1 pour la même leçon, l'étape de Présentation / Mise en train doit obligatoirement inclure un rappel explicite (question du maître + réponse attendue + observation/trace écrite) du contenu vu à la ou les séance(s) précédente(s) de cette leçon, avant d'entamer le contenu nouveau.
- Réponds UNIQUEMENT en HTML, sans markdown, sans explication`;

app.get('/ping', (_, res) => res.json({ status: 'ok', app: 'Prof CI' }));

function verifierCleAdmin(req, res, next) {
  if (!process.env.ADMIN_SEED_KEY) {
    return res.status(401).json({ error: 'Non autorisé' });
  }
  const cle = req.get('x-admin-key');
  if (!cle || cle !== process.env.ADMIN_SEED_KEY) {
    return res.status(401).json({ error: 'Non autorisé' });
  }
  next();
}

app.post('/api/admin/progressions/seed', verifierCleAdmin, async (req, res) => {
  try {
    const items = req.body;
    if (!Array.isArray(items)) {
      return res.status(400).json({ error: 'Le corps de la requête doit être un tableau JSON' });
    }

    let upserted = 0;
    let ignores = 0;

    for (const item of items) {
      const discipline = (item && item.discipline || '').toString().trim();
      const classe = (item && item.classe || '').toString().trim();
      const lecon = (item && item.lecon || '').toString().trim();
      if (!discipline || !classe || !lecon) { ignores++; continue; }

      const nombreSeances = item && item.nombreSeances != null ? parseInt(item.nombreSeances, 10) : undefined;
      const ordre = item && item.ordre != null ? parseInt(item.ordre, 10) : undefined;
      const competenceNumero = item && item.competenceNumero != null ? parseInt(item.competenceNumero, 10) : undefined;

      const donnees = { discipline, classe, lecon };
      if (Number.isFinite(nombreSeances)) donnees.nombreSeances = nombreSeances;
      if (Number.isFinite(ordre)) donnees.ordre = ordre;
      if (Number.isFinite(competenceNumero)) donnees.competenceNumero = competenceNumero;

      await ProgressionLecon.findOneAndUpdate(
        { discipline, classe, lecon },
        donnees,
        { upsert: true, new: true }
      );
      upserted++;
    }

    res.json({ success: true, upserted, ignores, total: items.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/admin/progressions/resume', async (req, res) => {
  try {
    const toutes = await ProgressionLecon.find({});
    const resume = {};
    for (const p of toutes) {
      const discipline = (p.discipline || '').toString().trim();
      const classe = (p.classe || '').toString().trim();
      if (!discipline || !classe) continue;
      if (!resume[discipline]) resume[discipline] = {};
      resume[discipline][classe] = (resume[discipline][classe] || 0) + 1;
    }
    res.json(resume);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/admin/competences/seed', verifierCleAdmin, async (req, res) => {
  try {
    const items = req.body;
    if (!Array.isArray(items)) {
      return res.status(400).json({ error: 'Le corps de la requête doit être un tableau JSON' });
    }

    let upserted = 0;
    let ignores = 0;

    for (const item of items) {
      const discipline = (item && item.discipline || '').toString().trim();
      const classe = (item && item.classe || '').toString().trim();
      const numero = item && item.numero != null ? parseInt(item.numero, 10) : NaN;
      const libelle = (item && item.libelle || '').toString().trim();
      if (!discipline || !classe || !Number.isFinite(numero) || !libelle) { ignores++; continue; }

      await CompetenceDPFC.findOneAndUpdate(
        { discipline, classe, numero },
        { discipline, classe, numero, libelle },
        { upsert: true, new: true }
      );
      upserted++;
    }

    res.json({ success: true, upserted, ignores, total: items.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/admin/competences-par-activite/seed', verifierCleAdmin, async (req, res) => {
  try {
    const items = req.body;
    if (!Array.isArray(items)) {
      return res.status(400).json({ error: 'Le corps de la requête doit être un tableau JSON' });
    }

    let upserted = 0;
    let ignores = 0;

    for (const item of items) {
      const discipline = (item && item.discipline || '').toString().trim();
      const classe = (item && item.classe || '').toString().trim();
      const activite = (item && item.activite || '').toString().trim();
      const numero = item && item.numero != null ? parseInt(item.numero, 10) : NaN;
      const intitule = (item && item.intitule || '').toString().trim();
      if (!discipline || !classe || !activite || !Number.isFinite(numero) || !intitule) { ignores++; continue; }

      await CompetenceParActivite.findOneAndUpdate(
        { discipline, classe, activite },
        { discipline, classe, activite, numero, intitule },
        { upsert: true, new: true }
      );
      upserted++;
    }

    res.json({ success: true, upserted, ignores, total: items.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/competences', async (req, res) => {
  try {
    const { discipline, classe } = req.query;
    if (!discipline || !classe) {
      return res.status(400).json({ error: 'discipline et classe requis' });
    }
    const competences = await trouverCompetencesDPFC({ discipline, classe });
    res.json(competences);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/competences-par-activite', async (req, res) => {
  try {
    const { discipline, classe } = req.query;
    if (!discipline || !classe) {
      return res.status(400).json({ error: 'discipline et classe requis' });
    }
    const competences = await CompetenceParActivite.find({
      discipline: regexExactInsensible(discipline),
      classe: regexExactInsensible(classe)
    }).sort({ numero: 1 });
    res.json(competences);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/admin/lecons-officielles/seed', verifierCleAdmin, async (req, res) => {
  try {
    const items = req.body;
    if (!Array.isArray(items)) {
      return res.status(400).json({ error: 'Le corps de la requête doit être un tableau JSON' });
    }

    let upserted = 0;
    let ignores = 0;

    for (const item of items) {
      const discipline = (item && item.discipline || '').toString().trim();
      const classe = (item && item.classe || '').toString().trim();
      const activiteLecon = (item && item.activite || '').toString().trim();
      const numeroLecon = item && item.numeroLecon != null ? parseInt(item.numeroLecon, 10) : NaN;
      const titreLecon = (item && item.titreLecon || '').toString().trim();
      const ordre = item && item.ordre != null ? parseInt(item.ordre, 10) : undefined;
      const seancesBrutes = Array.isArray(item && item.seances) ? item.seances : [];

      if (!discipline || !classe || !activiteLecon || !Number.isFinite(numeroLecon) || !titreLecon || !seancesBrutes.length) {
        ignores++; continue;
      }

      const seances = [];
      let seancesInvalides = false;
      for (const s of seancesBrutes) {
        const numeroSeance = s && s.numeroSeance != null ? parseInt(s.numeroSeance, 10) : NaN;
        const intitule = (s && s.intitule || '').toString().trim();
        const activite = (s && s.activite || '').toString().trim();
        if (!Number.isFinite(numeroSeance) || !intitule || !activite) { seancesInvalides = true; break; }
        seances.push({
          numeroSeance, intitule, activite,
          optionsChoix: Array.isArray(s.optionsChoix) ? s.optionsChoix.map((o) => String(o).trim()).filter(Boolean) : [],
          choixLibre: !!s.choixLibre,
          choixLibreLabel: (s.choixLibreLabel || '').toString().trim()
        });
      }
      if (seancesInvalides) { ignores++; continue; }

      const donnees = { discipline, classe, activite: activiteLecon, numeroLecon, titreLecon, seances };
      if (Number.isFinite(ordre)) donnees.ordre = ordre;

      // Clé d'upsert incluant l'activité : Grammaire Leçon 1 et Expression
      // écrite Leçon 1 sont des documents distincts, même numeroLecon, même
      // discipline/classe — sans "activite" dans le filtre, ce seed écraserait
      // silencieusement le document d'une autre activité partageant le numéro.
      await LeconOfficielleDPFC.findOneAndUpdate(
        { discipline, classe, activite: activiteLecon, numeroLecon },
        donnees,
        { upsert: true, new: true }
      );
      upserted++;
    }

    res.json({ success: true, upserted, ignores, total: items.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/lecons-officielles', async (req, res) => {
  try {
    const { discipline, classe, lecon, theme, activite } = req.query;
    if (!discipline || !classe) {
      return res.status(400).json({ error: 'discipline et classe requis' });
    }
    const resultat = await trouverLeconOfficielleDPFC({ discipline, classe, lecon, theme, activite });
    res.json(resultat);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/lecons-officielles/liste', async (req, res) => {
  try {
    const { discipline, classe, activite } = req.query;
    if (!discipline || !classe || !activite) {
      return res.status(400).json({ error: 'discipline, classe et activite requis' });
    }
    const lecons = await listerLeconsOfficielles({ discipline, classe, activite });
    res.json(lecons);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/progressions', async (req, res) => {
  try {
    const { discipline, classe } = req.query;
    if (!discipline || !classe) {
      return res.status(400).json({ error: 'discipline et classe requis' });
    }
    const progressions = await ProgressionLecon.find({
      discipline: regexExactInsensible(discipline),
      classe: regexExactInsensible(classe)
    }).sort({ ordre: 1, lecon: 1 });
    res.json(progressions);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/upload-modele', uploadModeleFichier, async (req, res) => {
  try {
    const { enseignantId, niveau } = req.body;
    let structureModele = req.body.structureModele;

    if (req.file) {
      structureModele = await extraireTexteFichier(req.file);
    }

    if (!structureModele || !structureModele.trim()) {
      return res.status(400).json({ error: 'Modèle vide' });
    }
    structureModele = structureModele.trim();

    const analyse = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 500,
      messages: [{
        role: 'user',
        content: `Voici une fiche de cours d'un enseignant ivoirien. Liste les rubriques/sections présentes. Réponds avec juste une liste JSON simple: ["rubrique1","rubrique2",...]\n\nFICHE:\n${structureModele.slice(0, 2000)}`
      }]
    });

    let rubriques = [];
    try {
      const text = analyse.content[0].text;
      rubriques = JSON.parse(text.match(/\[.*\]/s)?.[0] || '[]');
    } catch {}

    const modele = await Modele.findOneAndUpdate(
      { enseignantId, niveau },
      { enseignantId, niveau, structure: structureModele, rubriques },
      { upsert: true, new: true }
    );

    res.json({ success: true, rubriques, modeleId: modele._id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

 app.post('/api/generer-fiche', uploadTexteSupportFichier, async (req, res) => {
  console.log('📩 Requête reçue:', req.body.discipline, req.body.classe, req.body.lecon);
  try {
    const {
      enseignantId, niveau = 'secondaire', discipline,
      classe, lecon, seance = '1', duree = '1 heure',
      theme = '', planCours = '', approche = 'APC',
      leconOfficielleId = '', seanceOfficielleId = '', optionChoisie = '', optionLibre = '',
      activite = '', seanceIntitule = ''
    } = req.body;

    const approcheNormalisee = (approche || 'APC').toString().trim().toUpperCase() || 'APC';
    const avecVerbesTaxonomiques = !['PPO', 'FLEXIBLE'].includes(approcheNormalisee);

    let texteSupport = (req.body.texteSupport || '').toString().trim();
    if (req.file) {
      texteSupport = (await extraireTexteFichier(req.file)).trim();
    }

    let modelePersonnel = null;
    if (enseignantId) {
      modelePersonnel = await Modele.findOne({ enseignantId, niveau });
    }

    let systemPrompt = niveau === 'primaire' ? PROMPT_PRIMAIRE : construirePromptSecondaire(avecVerbesTaxonomiques);

    let avertissementRappel = null;
    // Blocs HTML déjà construits par construireDeroulementPlanEnseignantHTML,
    // à injecter après génération (cf. injecterDeroulementPlanEnseignant, appelé
    // dans stream.on('finalMessage', ...) plus bas) -- null si le mode plan-
    // enseignant n'est pas déclenché ou si son parsing a échoué.
    let planFourniInjection = null;

    if (niveau !== 'primaire') {
      const estLM = estLectureMethodique({ discipline, lecon, theme, activite });
      const estEE = estExpressionEcrite({ discipline, lecon, theme, activite });
      // Appel SANS classe : comportement inchangé (référentiel complet, non
      // filtré par niveau), utilisé par Expression écrite ci-dessous. Lecture
      // méthodique utilise son propre appel avec classe, isolé, juste après.
      const referentielTypeTexte = trouverReferentielTypeTexte(`${lecon || ''} ${theme || ''}`);

      if (estLM) {
        // Mode "plan fourni par l'enseignant" : quand l'enseignant a rédigé
        // lui-même le contenu pédagogique (hypothèse/axes/analyses), on ne
        // génère plus rien -- on structure et corrige uniquement. Ajout, pas
        // remplacement : le mode génération automatique (construireInstructionsLectureMethodique)
        // reste inchangé et s'applique dès que le plan n'est pas substantiel.
        if (planCoursEstSubstantiel(planCours)) {
          const resultatPlanFourni = construireInstructionsLectureMethodiqueAvecPlanEnseignant(classe, planCours);
          systemPrompt += resultatPlanFourni.instructions;
          planFourniInjection = resultatPlanFourni;
          if (resultatPlanFourni.avertissement) {
            avertissementRappel = avertissementRappel ? `${avertissementRappel} ${resultatPlanFourni.avertissement}` : resultatPlanFourni.avertissement;
          }
          // LOG TEMPORAIRE DE DIAGNOSTIC (à retirer une fois le bug du
          // tableau de vérification "fracturé" identifié) : imprime le HTML
          // déjà construit déterministiquement AVANT toute génération par le
          // modèle, pour distinguer un bug de construction (visible ici) d'un
          // bug de placement/mélange par le modèle (invisible ici, mais alors
          // absent du HTML final malgré sa présence ci-dessous).
          console.log('🔍 [DEBUG plan-enseignant] injectionDeroulement construit :\n' + resultatPlanFourni.injectionDeroulement);
          console.log('🔍 [DEBUG plan-enseignant] injectionAxes construit :\n' + resultatPlanFourni.injectionAxes);
        } else {
          const referentielTypeTexteLM = trouverReferentielTypeTexte(`${lecon || ''} ${theme || ''}`, classe);
          systemPrompt += construireInstructionsLectureMethodique(referentielTypeTexteLM, classe);
        }
      } else if (estEE) {
        systemPrompt += construireInstructionsExpressionEcriture(referentielTypeTexte);
        if (!referentielTypeTexte) {
          const avertissementReferentiel = `Aucun référentiel de type de texte disponible pour cette leçon d'Expression écrite ("${lecon}") — les outils de la langue proposés restent une estimation libre du modèle.`;
          avertissementRappel = avertissementRappel ? `${avertissementRappel} ${avertissementReferentiel}` : avertissementReferentiel;
        }
      }

      // Champ Leçon de l'entête : pour Lecture méthodique et Expression écrite
      // uniquement, remplace le titre générique que le modèle avait tendance à
      // inventer par le vrai intitulé du programme DPFC (ou le message
      // d'indisponibilité, jamais un titre inventé, si le catalogue ne couvre pas
      // encore cette discipline/classe/sous-thème).
      if (estLM || estEE) {
        // Le document source DPFC ("PROGRESSIONS DE FRANÇAIS") est une progression
        // UNIQUE couvrant toutes les activités de Français (lecture, expression
        // écrite, grammaire...) — la recherche se fait donc toujours sous la
        // discipline "Français", même si l'enseignant a tapé "Lecture méthodique"
        // ou "Expression écrite" comme discipline (convention déjà utilisée
        // ailleurs dans l'app pour déclencher le bon gabarit de fiche).
        const activiteRecherchee = estLM ? 'Lecture méthodique' : 'Expression écrite';

        // Sélection via l'UI de menus dépendants (identification par ID, jamais
        // par le seul numéro qui peut se répéter dans l'année) : prioritaire sur
        // la recherche floue par texte libre ci-dessous.
        const leconOfficielle = (leconOfficielleId && seanceOfficielleId)
          ? await trouverLeconEtSeanceParId(leconOfficielleId, seanceOfficielleId)
          : await trouverLeconOfficielleDPFC({ discipline: 'Français', classe, lecon, theme, activite: activiteRecherchee });

        if (leconOfficielle) {
          const { lecon: leconDoc, seance: seanceDoc } = leconOfficielle;
          systemPrompt += `\n\nLEÇON OFFICIELLE DPFC : Leçon ${leconDoc.numeroLecon} : ${leconDoc.titreLecon}\n\nDans le champ Leçon de l'entête (à droite du libellé "Leçon :" déjà présent), écris EXACTEMENT "${leconDoc.numeroLecon} : ${leconDoc.titreLecon}" -- le numéro et le titre SEULEMENT, SANS répéter le mot "Leçon" qui est déjà dans le libellé, sans reformulation ni titre alternatif inventé.`;

          // Une séance peut porter un choix en liste déroulante ET un choix en texte
          // libre en même temps (ex. type de récit + thème des contenus intégrés) :
          // les deux sont indépendants et injectés séparément quand fournis.
          const optionChoisieTexte = (optionChoisie || '').toString().trim();
          const seanceOptionsChoix = Array.isArray(seanceDoc.optionsChoix) ? seanceDoc.optionsChoix : [];
          // Le libellé "à barre oblique" ("simple / complexe...") n'est jamais celui
          // affiché à l'enseignant ni injecté dans la fiche : on recalcule ici, côté
          // serveur (jamais depuis un texte envoyé par le client), le même intitulé
          // résolu déjà utilisé par le menu déroulant Séance.
          const intituleSeanceResolu = (seanceOptionsChoix.length && seanceOptionsChoix.includes(optionChoisieTexte))
            ? resoudreIntituleAvecOption(seanceDoc.intitule, seanceOptionsChoix, optionChoisieTexte)
            : seanceDoc.intitule;
          systemPrompt += `\n\nSÉANCE OFFICIELLE DPFC : Séance ${seanceDoc.numeroSeance} : ${intituleSeanceResolu}\n\nDans le champ Séance de l'entête (à droite du libellé "Séance :" déjà présent), écris EXACTEMENT "${seanceDoc.numeroSeance} : ${intituleSeanceResolu}" -- le numéro et l'intitulé SEULEMENT, SANS répéter le mot "Séance" qui est déjà dans le libellé, sans reformulation ni troncature.`;

          if (optionChoisieTexte) {
            systemPrompt += `\n\nOPTION CHOISIE PAR L'ENSEIGNANT (séance à choix) : "${optionChoisieTexte}"\n\nReprends EXACTEMENT ce texte pour préciser le support/thème traité dans cette séance, sans reformulation.`;
          }
          const optionLibreTexte = (optionLibre || '').toString().trim();
          if (optionLibreTexte) {
            const libelleChoixLibre = (seanceDoc.choixLibreLabel || '').toString().trim() || 'précision complémentaire';
            systemPrompt += `\n\nOPTION LIBRE CHOISIE PAR L'ENSEIGNANT (${libelleChoixLibre}) : "${optionLibreTexte}"\n\nReprends EXACTEMENT ce texte, sans reformulation.`;
          }

          const seanceNumIndicatif = parseInt(seance, 10);
          if (Number.isFinite(seanceNumIndicatif) && seanceNumIndicatif !== seanceDoc.numeroSeance) {
            const avertissementSeance = `La séance officielle DPFC pour cette leçon est la séance ${seanceDoc.numeroSeance}, mais la séance ${seanceNumIndicatif} a été indiquée — vérifie le numéro de séance.`;
            avertissementRappel = avertissementRappel ? `${avertissementRappel} ${avertissementSeance}` : avertissementSeance;
          }
        } else {
          systemPrompt += `\n\nLEÇON OFFICIELLE DPFC : NON DISPONIBLE (aucune correspondance dans le catalogue pour cette discipline/classe/sous-thème). Dans le champ Leçon de l'entête, écris EXACTEMENT le texte suivant, sans inventer de titre, même plausible : "Titre de leçon officiel non disponible — vérifier avec la progression papier".`;
          const avertissementLecon = `Aucune leçon officielle DPFC trouvée dans le catalogue pour cette discipline/classe/sous-thème — le champ Leçon affiche un message à compléter manuellement avec la progression papier.`;
          avertissementRappel = avertissementRappel ? `${avertissementRappel} ${avertissementLecon}` : avertissementLecon;
        }
      }

      // Fallback (saisie libre, hors catalogue) : quand l'enseignant tape lui-même
      // l'intitulé de la séance, il doit être repris tel quel dans le champ Séance
      // de l'entête, exactement comme l'intitulé officiel du catalogue ci-dessus —
      // jamais reformulé ni complété par le modèle. N'est envoyé par le frontend
      // que lorsque le catalogue n'est pas actif pour cette combinaison.
      const seanceIntituleTexte = (seanceIntitule || '').toString().trim();
      const seanceNumPourIntitule = parseInt(seance, 10);
      if (seanceIntituleTexte && Number.isFinite(seanceNumPourIntitule)) {
        systemPrompt += `\n\nSÉANCE (saisie libre par l'enseignant) : Séance ${seanceNumPourIntitule} : ${seanceIntituleTexte}\n\nDans le champ Séance de l'entête (à droite du libellé "Séance :" déjà présent), écris EXACTEMENT "${seanceNumPourIntitule} : ${seanceIntituleTexte}" -- le numéro et l'intitulé SEULEMENT, SANS répéter le mot "Séance" qui est déjà dans le libellé, sans reformulation ni troncature.`;
      }
    }

    const seanceNum = parseInt(seance, 10);
    if (Number.isFinite(seanceNum) && seanceNum > 1) {
      const fichesPrecedentes = await trouverFichesPrecedentes({ enseignantId, discipline, classe, lecon, niveau, seance });
      if (fichesPrecedentes.length) {
        const resume = resumerSeancesPrecedentes(fichesPrecedentes);
        systemPrompt += `\n\nCONTENU RÉEL DES SÉANCES PRÉCÉDENTES DE CETTE LEÇON :\n${resume}\n\nBase le rappel de la PRÉSENTATION EXCLUSIVEMENT sur ce contenu réel ci-dessus (questions, réponses, traces écrites déjà vues), PAS sur une supposition.`;
      } else {
        const avertissementHistorique = "Aucune fiche de séance précédente trouvée pour cette leçon — le rappel généré est une estimation, vérifie-le.";
        avertissementRappel = avertissementRappel ? `${avertissementRappel} ${avertissementHistorique}` : avertissementHistorique;
      }
    }

    if (Number.isFinite(seanceNum)) {
      const progression = await trouverProgressionLecon({ discipline, classe, lecon });
      if (progression && Number.isFinite(progression.nombreSeances) && seanceNum > progression.nombreSeances) {
        const avertissementDepassement = `Cette leçon officielle compte normalement ${progression.nombreSeances} séances — vérifie ton numéro de séance.`;
        avertissementRappel = avertissementRappel ? `${avertissementRappel} ${avertissementDepassement}` : avertissementDepassement;
      }
    }

    if (niveau !== 'primaire' && avecVerbesTaxonomiques) {
      let competenceResolue = null;
      let raisonIndisponible = null;

      // Certaines disciplines ont plusieurs compétences qui ne se distinguent que
      // par l'activité (ex. Français : oral/lecture/écrit/grammaire/orthographe
      // n'ont pas le même numéro) — vérifié en priorité, sans toucher à la
      // logique CompetenceDPFC ci-dessous qui reste la source pour les
      // disciplines à une seule compétence par discipline/classe.
      const activiteEffective = (activite || '').toString().trim() || discipline;
      const competenceParActiviteTrouvee = await trouverCompetenceParActivite({ discipline: 'Français', classe, activite: activiteEffective });

      if (competenceParActiviteTrouvee) {
        competenceResolue = { numero: competenceParActiviteTrouvee.numero, libelle: competenceParActiviteTrouvee.intitule };
      } else if (competenceNonDisponible({ discipline, classe })) {
        raisonIndisponible = 'aucun document DPFC officiel publié à ce jour pour cette discipline/classe';
      } else {
        const competencesOfficielles = await trouverCompetencesDPFC({ discipline, classe });
        if (competencesOfficielles.length === 0) {
          raisonIndisponible = 'cette discipline/classe n\'est pas encore couverte par le catalogue de compétences officielles';
        } else if (competencesOfficielles.length === 1) {
          competenceResolue = competencesOfficielles[0];
        } else {
          // La compétence est déterminée par (discipline, classe, activité), JAMAIS
          // par la leçon en cours — plusieurs compétences pour cette discipline/classe
          // sans mapping par activité (CompetenceParActivite) signifient donc qu'on
          // ne peut pas les distinguer avec certitude. Laisser le modèle "deviner"
          // parmi la liste a déjà produit une compétence hallucinée (ni le bon
          // numéro, ni le bon libellé) : c'est donc interdit, pas de repli par leçon.
          raisonIndisponible = 'plusieurs compétences officielles existent pour cette discipline/classe et ne peuvent être distinguées sans mapping par activité';
        }
      }

      if (competenceResolue) {
        systemPrompt += `\n\nCOMPÉTENCE OFFICIELLE DPFC : Compétence ${competenceResolue.numero} : ${competenceResolue.libelle}\n\nUtilise EXACTEMENT ce numéro et ce libellé dans le champ Compétence de l'entête, sans reformulation.`;
      } else {
        systemPrompt += `\n\nCOMPÉTENCE OFFICIELLE DPFC : NON DISPONIBLE (${raisonIndisponible}). Dans le champ Compétence de l'entête, écris EXACTEMENT le texte suivant, sans numéro ni format "Compétence N", et SANS INVENTER un numéro ou un libellé, même plausible : "Numérotation officielle non disponible — vérifier avec le programme papier".`;
        const avertissementCompetence = `Compétence officielle DPFC non déterminée avec certitude (${raisonIndisponible}) — le champ Compétence affiche un message à compléter manuellement avec le programme papier.`;
        avertissementRappel = avertissementRappel ? `${avertissementRappel} ${avertissementCompetence}` : avertissementCompetence;
      }
    }

    if (!texteSupport && leconNecessiteTexteSupport({ discipline, lecon, theme })) {
      const avertissementTexte = 'Cette leçon semble nécessiter un texte support (lecture, expression écrite...) — fournis un texte collé ou un fichier Word/PDF pour une fiche fidèle au contenu étudié.';
      avertissementRappel = avertissementRappel ? `${avertissementRappel} ${avertissementTexte}` : avertissementTexte;
    }

    // Texte brut du plan de l'enseignant (mode plan-enseignant, cas d'échec du
    // parsing UNIQUEMENT -- cf. construireInstructionsLectureMethodiqueAvecPlanEnseignant)
    // ajouté ICI, APRÈS toutes les instructions Leçon/Séance/Compétence
    // ci-dessus, jamais avant : un pavé de texte libre potentiellement long
    // juste avant ces instructions risquait de noyer leur saillance pour le
    // modèle (cause probable constatée d'un champ Compétence resté vide).
    if (planFourniInjection && planFourniInjection.planCoursPourPromptFinal) {
      systemPrompt += planFourniInjection.planCoursPourPromptFinal;
    }

    let userMessage = '';
    if (modelePersonnel) {
      userMessage = `REPRODUIS exactement la STRUCTURE de ce modèle de fiche pour générer une nouvelle fiche.

MODÈLE DE RÉFÉRENCE DE L'ENSEIGNANT :
${modelePersonnel.structure}

NOUVELLE FICHE À GÉNÉRER :
- Discipline / Matière : ${discipline}
- Classe : ${classe}
- Leçon / Thème : ${lecon} ${theme}
- Séance n° : ${seance}
- Durée : ${duree}
${planCours ? `\nPLAN DE COURS FOURNI PAR L'ENSEIGNANT :\n${planCours}` : ''}

Génère la fiche COMPLÈTE en HTML en respectant EXACTEMENT la structure du modèle.`;
    } else {
      userMessage = `Génère une fiche de cours COMPLÈTE pour :
- Discipline / Matière : ${discipline}
- Classe : ${classe}
- Leçon / Thème : ${lecon} ${theme}
- Séance n° : ${seance}
- Durée : ${duree}
- Niveau : ${niveau}
${planCours ? `\nPLAN DE COURS FOURNI :\n${planCours}\n\nAdapte ce plan au format officiel de fiche de cours.` : ''}

Génère la fiche COMPLÈTE et DÉTAILLÉE en HTML.`;
    }

    const estFicheExpressionEcrite = estExpressionEcrite({ discipline, lecon, theme, activite });

    if (texteSupport) {
      const motsTexteSupport = compterMots(texteSupport);
      let instructionMiseEnPage;
      if (estFicheExpressionEcrite) {
        instructionMiseEnPage = texteSupportRisqueDeDeborder(motsTexteSupport)
          ? `Ce texte support fait environ ${motsTexteSupport} mots : même en réduisant la police, il risque de déborder sur une deuxième page. Utilise UNIQUEMENT le marqueur {{TEXTE_SUPPORT}}, une seule fois, sans {{TEXTE_SUPPORT_COPIE}} (pas de duplication en Expression écrite).`
          : `Ce texte support fait environ ${motsTexteSupport} mots : utilise UNIQUEMENT le marqueur {{TEXTE_SUPPORT}}, une seule fois (jamais {{TEXTE_SUPPORT_COPIE}}, pas de duplication en Expression écrite) — la police sera automatiquement ajustée côté serveur pour qu'il tienne sur une seule page.`;
        if (texteSupportRisqueDeDeborder(motsTexteSupport)) {
          const avertissementLongueur = `Le texte support fourni (~${motsTexteSupport} mots) risque de déborder sur une deuxième page malgré la réduction automatique de police — envisagez de le raccourcir pour préserver la lisibilité de sa mise en forme.`;
          avertissementRappel = avertissementRappel ? `${avertissementRappel} ${avertissementLongueur}` : avertissementLongueur;
        }
      } else {
        instructionMiseEnPage = texteSupportDoitEtreDuplique(texteSupport)
          ? `Ce texte support fait environ ${motsTexteSupport} mots : assez court pour tenir deux fois sur la même page. Immédiatement APRÈS le marqueur {{TEXTE_SUPPORT}}, ajoute le marqueur exact {{TEXTE_SUPPORT_COPIE}} pour insérer un second exemplaire en police réduite (permet à l'enseignant de photocopier une seule feuille et distribuer deux exemplaires, économie de papier).`
          : `Ce texte support fait environ ${motsTexteSupport} mots : trop long pour être dupliqué sur la même page. N'ajoute PAS de second exemplaire — utilise UNIQUEMENT le marqueur {{TEXTE_SUPPORT}}, une seule fois, sans {{TEXTE_SUPPORT_COPIE}}.`;
      }
      userMessage += `\n\nVoici le texte support fourni par l'enseignant. Construis le déroulement pédagogique (moments didactiques, questions de compréhension, schéma argumentatif ou axes de lecture selon la discipline) à partir de ce texte. NE RECOPIE PAS le texte dans ta réponse — utilise le marqueur exact {{TEXTE_SUPPORT}} UNE SEULE FOIS, à l'endroit où le texte doit apparaître dans le HTML (jamais une deuxième fois ailleurs dans le document, par exemple jamais entre deux tableaux d'analyse). ${instructionMiseEnPage}\n\nTEXTE SUPPORT (à lire, ne pas recopier) :\n${texteSupport}`;
    } else if (estFicheExpressionEcrite) {
      userMessage += `\n\nAucun texte support n'a été fourni par l'enseignant : si tu dois toi-même rédiger un exemple de texte (lettre, etc.) à titre de modèle, reste sous les 250 mots afin qu'il tienne sur une seule page (mise en forme observable d'un coup d'œil par les élèves), et places-le dans une balise <div class="texte-support-page-unique">...</div> pour qu'il bénéficie du même traitement de mise en page qu'un texte support fourni par l'enseignant.`;
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    if (avertissementRappel) {
      res.write(`data: ${JSON.stringify({ avertissement: avertissementRappel })}\n\n`);
    }

    const heartbeat = setInterval(() => {
      res.write(': keep-alive\n\n');
    }, 10000);

    let contenuHTML = '';

    const stream = anthropic.messages.stream({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 32000,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }]
    });

    stream.on('text', (text) => {
      contenuHTML += text;
      res.write(`data: ${JSON.stringify({ chunk: text })}\n\n`);
    });

    stream.on('finalMessage', async () => {
      clearInterval(heartbeat);
      contenuHTML = contenuHTML.replace(/^```html\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/g, '').trim();
      // LOG TEMPORAIRE DE DIAGNOSTIC (à retirer avec les logs ci-dessus) :
      // le HTML BRUT renvoyé par le modèle, AVANT toute injection -- permet
      // de voir si le modèle a bien placé les 3 marqueurs seuls, ou s'il a
      // écrit son propre contenu en plus (ce qui expliquerait un tableau
      // "fracturé"/mélangé après injection).
      if (planFourniInjection) {
        console.log('🔍 [DEBUG plan-enseignant] HTML brut du modèle AVANT injection :\n' + contenuHTML);
      }
      contenuHTML = injecterDeroulementPlanEnseignant(contenuHTML, planFourniInjection);
      if (planFourniInjection) {
        console.log('🔍 [DEBUG plan-enseignant] HTML APRÈS injection déroulement/axes :\n' + contenuHTML);
      }
      if (estLectureMethodique({ discipline, lecon, theme })) {
        contenuHTML = separerTableauxImbriques(contenuHTML);
      }
      contenuHTML = injecterTexteSupport(contenuHTML, texteSupport, { unePage: estFicheExpressionEcrite });
      const fiche = await Fiche.create({
        enseignantId: enseignantId || 'anonyme',
        discipline, classe, lecon, seance, duree, niveau,
        approche: approcheNormalisee,
        contenu: contenuHTML
      });
      res.write(`data: ${JSON.stringify({ done: true, ficheId: fiche._id, contenuFinal: contenuHTML })}\n\n`);
      res.end();
    });

    stream.on('error', (e) => {
      clearInterval(heartbeat);
      console.error('❌ Stream error:', e.message);
      res.write(`data: ${JSON.stringify({ error: e.message })}\n\n`);
      res.end();
    });

  } catch (e) {
    console.error('❌ ERREUR:', e.message);
    res.write(`data: ${JSON.stringify({ error: e.message })}\n\n`);
    res.end();
  }
});

app.get('/api/fiches/:enseignantId', async (req, res) => {
  try {
    const fiches = await Fiche.find(
      { enseignantId: req.params.enseignantId },
      { contenu: 0 }
    ).sort({ createdAt: -1 }).limit(50);
    res.json(fiches);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/fiche/:id', async (req, res) => {
  try {
    const fiche = await Fiche.findById(req.params.id);
    if (!fiche) return res.status(404).json({ error: 'Fiche introuvable' });
    res.json(fiche);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/fiche/:id/pdf', async (req, res) => {
  try {
    const fiche = await Fiche.findById(req.params.id);
    if (!fiche) return res.status(404).json({ error: 'Fiche introuvable' });

    const landscape = req.body.view === 'paysage';
    const pdfBuffer = await genererPdfDepuisHtml(fiche.contenu, landscape);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${slugFichier(fiche)}.pdf"`);
    res.send(pdfBuffer);
  } catch (e) {
    console.error('❌ Erreur génération PDF:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/fiche/:id/docx', async (req, res) => {
  try {
    const fiche = await Fiche.findById(req.params.id);
    if (!fiche) return res.status(404).json({ error: 'Fiche introuvable' });

    const landscape = req.body.view === 'paysage';
    const docxBuffer = await genererDocxDepuisHtml(fiche.contenu, landscape);

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="${slugFichier(fiche)}.docx"`);
    res.send(docxBuffer);
  } catch (e) {
    console.error('❌ Erreur génération DOCX:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('*', (_, res) => res.sendFile('index.html', { root: 'public' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🎓 Prof CI démarré sur le port ${PORT}`));
