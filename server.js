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

// Depuis le changement d'architecture du 07/08 : CHAQUE catégorie porte
// désormais, en plus de "categorie" (slug interne) et "description" (texte
// long d'appui pour le prompt), 2 champs supplémentaires :
// - "axe" (1 ou 2) -- classe la catégorie selon son rôle méthodologique
//   (cf. skill lecture méthodique section 3) : axe 1 = catégories qui
//   justifient la NATURE/le TYPE de texte (ex. présentation matérielle
//   d'une lettre, structure narrative d'un récit), axe 2 = catégories qui
//   justifient le THÈME précis traité par CE texte (ex. lexique du sujet,
//   types de phrases selon l'intention). Seule source utilisée par
//   caracteristiquesParAxe/determinerSlotsAxe pour choisir, de façon
//   déterministe, le nom d'une entrée que ni l'enseignant ni le modèle ne
//   fournissent -- jamais une invention libre du modèle.
// - "libelle" -- nom court et présentable de l'entrée (ex. "Le lexique du
//   thème"), tel qu'il doit apparaître dans la colonne "Entrées" du
//   tableau -- distinct du slug interne "categorie" et de la description
//   longue.
// Chaque type ci-dessous garantit AU MOINS 2 catégories taguées axe 1 et
// AU MOINS 2 taguées axe 2 (jamais moins), pour que determinerSlotsAxe
// puisse toujours nommer les 2 entrées de chaque axe sans jamais retomber
// sur une invention libre par le modèle. 8 types couverts (validés contre
// le corpus Anicet du 04/08, 6e à 3e) -- tout type de texte demandé en
// dehors de cette liste (ex. "résumé", absent du corpus comme du
// programme DPFC consulté) doit être BLOQUÉ, jamais généré en mode libre
// (cf. construireMessageBlocageTypeTexteNonCouvert).
const REFERENTIEL_TYPES_TEXTE = {
  'texte explicatif': {
    caracteristiques: [
      { categorie: 'temps_verbaux', axe: 1, libelle: 'Les temps verbaux', description: 'présent de vérité générale (valeur de permanence)' },
      { categorie: 'types_phrases', axe: 1, libelle: 'Les types de phrases', description: `types de phrases (${TYPES_PHRASES_OFFICIELS}) — dominante déclarative pour ce type de texte` },
      { categorie: 'lexique', axe: 2, libelle: 'Le lexique thématique', description: 'vocabulaire technique/scientifique, champ lexical du phénomène expliqué' },
      { categorie: 'connecteurs_logiques', axe: 2, libelle: 'Les connecteurs logiques', description: "d'abord, ensuite, en effet, au final — articulation causale/chronologique" },
      { categorie: 'donnees_chiffrees', axe: 2, libelle: 'Les données chiffrées', description: "statistiques, mesures, proportions appuyant l'explication" }
    ]
  },
  'lettre personnelle': {
    caracteristiques: [
      { categorie: 'presentation_materielle', axe: 1, libelle: 'La présentation matérielle', description: "en-tête (lieu, date), formule d'appel, corps (introductive/développement/finale), signature" },
      { categorie: 'indices_personne', axe: 1, libelle: 'Les indices de personne', description: 'pronoms personnels je/tu selon relation expéditeur-destinataire' },
      { categorie: 'registre_langue', axe: 1, libelle: 'Le registre de langue', description: 'standard ou familier selon la relation' },
      { categorie: 'types_phrases', axe: 2, libelle: 'Les types de phrases', description: `types de phrases (${TYPES_PHRASES_OFFICIELS}) selon l'intention de l'auteur (ex. dominante déclarative pour donner des nouvelles)` },
      { categorie: 'lexique', axe: 2, libelle: 'Le lexique', description: 'vocabulaire du thème précis abordé dans la lettre (nouvelles données, salutations, motif du courrier)' }
    ]
  },
  'portrait': {
    caracteristiques: [
      { categorie: 'structure', axe: 1, libelle: 'La structure du texte', description: 'introduction / développement / conclusion' },
      { categorie: 'verbes', axe: 1, libelle: "Les verbes d'état", description: "verbes d'état" },
      { categorie: 'temps_verbaux', axe: 1, libelle: 'Les temps verbaux', description: "imparfait et présent de l'indicatif (effet de réalisme)" },
      { categorie: 'lexique', axe: 2, libelle: 'Le lexique évaluatif', description: 'vocabulaire évaluatif (appréciatif/dépréciatif), champs lexicaux physiques/moraux' },
      { categorie: 'adjectifs', axe: 2, libelle: 'Les adjectifs qualificatifs', description: 'adjectifs qualificatifs' },
      { categorie: 'images', axe: 2, libelle: 'Les comparaisons', description: 'comparaisons' }
    ]
  },
  'texte descriptif (objet)': {
    caracteristiques: [
      { categorie: 'enumeration', axe: 1, libelle: "L'énumération", description: 'énumération organisée (spatiale : extérieur→intérieur, haut→bas)' },
      { categorie: 'procedes_stylistiques', axe: 1, libelle: 'Les procédés stylistiques', description: "exclamations, apostrophe, hyperbole selon l'effet recherché" },
      { categorie: 'lexique', axe: 2, libelle: 'Le lexique valorisant', description: 'champ lexical du luxe/de la richesse ou du thème valorisé selon l\'objet' },
      { categorie: 'adjectifs', axe: 2, libelle: 'Les adjectifs qualificatifs', description: 'adjectifs qualificatifs valorisants' }
    ]
  },
  'récit': {
    caracteristiques: [
      { categorie: 'structure', axe: 1, libelle: 'La structure du récit', description: 'schéma narratif (situation initiale, élément perturbateur, péripéties, dénouement)' },
      { categorie: 'temps_verbaux', axe: 1, libelle: 'Les temps verbaux', description: 'passé simple/imparfait (premier plan/arrière-plan) ou présent de narration selon le texte' },
      { categorie: 'indices_personne', axe: 1, libelle: 'Les indices de personne', description: 'marques du narrateur (1re personne, récit à la 3e personne...)' },
      { categorie: 'lexique', axe: 2, libelle: 'Le lexique thématique', description: "vocabulaire lié à l'action et au thème précis du récit" },
      { categorie: 'types_phrases', axe: 2, libelle: 'Les types de phrases', description: `types de phrases (${TYPES_PHRASES_OFFICIELS}) selon les moments du récit (ex. exclamative dans un passage vif)` }
    ]
  },
  'poème': {
    caracteristiques: [
      { categorie: 'structure_poeme', axe: 1, libelle: 'La structure du poème', description: 'organisation en vers/strophes, disposition, éventuelle rime ou vers libres' },
      { categorie: 'indices_personne', axe: 1, libelle: 'Les indices de personne', description: 'marques du "je" poétique ou du destinataire ("tu")' },
      { categorie: 'lexique', axe: 2, libelle: 'Le lexique thématique', description: 'champ lexical du thème chanté par le poème' },
      { categorie: 'figures_style', axe: 2, libelle: 'Les figures de style', description: 'comparaison, métaphore, personnification, énumération/gradation — UNIQUEMENT celles réellement présentes' },
      { categorie: 'types_phrases', axe: 2, libelle: 'Les types de phrases', description: `types de phrases (${TYPES_PHRASES_OFFICIELS}) selon l'intention (ex. exclamative pour l'émotion)` }
    ]
  },
  'dialogue argumentatif': {
    caracteristiques: [
      { categorie: 'ponctuation', axe: 1, libelle: 'La ponctuation du dialogue', description: 'marques du dialogue (tirets, guillemets, verbes introducteurs de parole)' },
      { categorie: 'indices_personne', axe: 1, libelle: 'Les indices de personne', description: 'alternance je/tu entre les 2 interlocuteurs' },
      { categorie: 'lexique', axe: 2, libelle: 'Le lexique du débat', description: 'vocabulaire du sujet débattu par les 2 interlocuteurs' },
      { categorie: 'types_phrases', axe: 2, libelle: 'Les types de phrases', description: `types de phrases (${TYPES_PHRASES_OFFICIELS}) — interrogatives/exclamatives fréquentes dans l'échange argumentatif` }
    ]
  },
  'texte argumentatif': {
    caracteristiques: [
      { categorie: 'connecteurs_logiques', axe: 1, libelle: 'Les connecteurs logiques', description: "liens d'articulation (d'abord, cependant, en effet, donc...) organisant l'argumentation" },
      { categorie: 'types_phrases', axe: 1, libelle: 'Les types de phrases', description: `types de phrases (${TYPES_PHRASES_OFFICIELS}) — dominante déclarative/interrogative selon la stratégie argumentative` },
      { categorie: 'lexique', axe: 2, libelle: 'Le lexique thématique', description: 'vocabulaire du sujet précis débattu' },
      { categorie: 'temps_verbaux', axe: 2, libelle: 'Les temps verbaux', description: 'présent de vérité générale, valeurs modales (devoir, falloir...)' }
    ]
  }
};

// Message explicite (jamais un échec silencieux ni une génération libre en
// repli) affiché à l'enseignant quand le type de texte demandé n'est
// couvert par AUCUNE entrée de REFERENTIEL_TYPES_TEXTE ci-dessus (ex.
// "résumé", absent du corpus consulté) -- cf. construireInstructionsLectureMethodique,
// construireDeroulementPlanEnseignantHTML (via determinerSlotsAxe) et le
// branchement Expression écrite dans la route /api/generer-fiche.
function construireMessageBlocageTypeTexteNonCouvert() {
  return `Ce type de texte n'est pas encore couvert par le référentiel structurel — génération suspendue. Types actuellement disponibles : ${Object.keys(REFERENTIEL_TYPES_TEXTE).join(', ')}. Complétez le référentiel ou reformulez la leçon/le thème pour qu'il corresponde clairement à l'un de ces types avant de régénérer.`;
}

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

// Filtre les catégories du référentiel appartenant à UN axe précis (1 =
// justifie le TYPE de texte, 2 = justifie le THÈME précis, cf. commentaire
// sur REFERENTIEL_TYPES_TEXTE) -- seule source utilisée par determinerSlotsAxe
// pour choisir, de façon déterministe, le nom d'une entrée que ni
// l'enseignant ni le modèle ne fournissent : jamais une catégorie hors
// référentiel, jamais une invention du modèle. Les catégories ajoutées par
// fusionnerCaracteristiquesCollege (socle collège, figures de style par
// palier) n'ont pas de champ "axe" : elles sont donc naturellement
// exclues ici (undefined !== 1/2) -- seules les catégories propres au
// genre, taguées à la main dans REFERENTIEL_TYPES_TEXTE, peuvent nommer une
// entrée par ce mécanisme.
function caracteristiquesParAxe(referentiel, axeNumero) {
  if (!referentiel) return [];
  return referentiel.caracteristiques.filter((c) => c.axe === Number(axeNumero));
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

// Mode automatique (Mode 1) -- même niveau de garantie que le mode
// plan-enseignant (règles A/B/C/D), via construireAxesAInventerHTML qui
// réutilise EXACTEMENT le même mécanisme (determinerSlotsAxe,
// construireTableauAxeHTML, construireEntreeReserveeEvaluation,
// construireConsigneCompletionEntrees). Retourne désormais
// { instructions, injectionDeroulement: null, injectionAxes, tachesCompletion,
// avertissement: null } -- même forme que construireInstructionsLectureMethodiqueAvecPlanEnseignant,
// pour que le reste du pipeline (verifierMarqueursPlanEnseignant,
// extraireCompletionsEntrees, resoudreCompletionsEntrees,
// injecterDeroulementPlanEnseignant) fonctionne à l'identique sans
// modification, quel que soit le mode.
function construireInstructionsLectureMethodique(referentiel, classe) {
  const niveau = niveauLectureMethodique(classe);

  // Mode 1 (automatique) : AUCUNE entrée n'est fournie par un enseignant --
  // les 4 entrées des 2 tableaux de vérification doivent TOUTES être
  // choisies dans le référentiel (cf. determinerSlotsAxe). Un référentiel
  // manquant bloque donc systématiquement ce mode, avant même d'appeler le
  // modèle -- jamais une génération libre en repli (cf. verdict du 07/08).
  if (!referentiel) {
    return {
      instructions: '',
      injectionDeroulement: null,
      injectionAxes: null,
      avertissement: null,
      tachesCompletion: [],
      bloque: true,
      messageBlocage: construireMessageBlocageTypeTexteNonCouvert()
    };
  }

  const reglesFiguresReelles = ' Les figures de style éventuellement listées ci-dessus ne sont que des possibilités : n\'utilise QUE celles réellement présentes dans le texte support fourni, jamais de façon systématique — si aucune de ces figures n\'apparaît dans le texte, n\'en invente aucune et appuie-toi sur les autres catégories.';
  const consigneEntrees = referentiel
    ? `Les « entrées » possibles pour les 2 tableaux d'axes sont IMPOSÉES par le référentiel du type de texte « ${referentiel.typeTexte} » ci-dessous — pioche EXCLUSIVEMENT dans ces catégories (tu peux n'en utiliser qu'une partie selon les axes retenus, mais n'en invente AUCUNE en dehors de cette liste) :\n${formaterCaracteristiquesReferentiel(referentiel.caracteristiques)}\n\nLes relevés précis (citations, exemples tirés du texte) restent bien sûr propres à CE texte : seules les catégories/étiquettes des « entrées » sont fixées par le référentiel.${reglesFiguresReelles}`
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

  const resultatAxes = construireAxesAInventerHTML(niveau, referentiel);
  if (resultatAxes.bloque) {
    return {
      instructions: '',
      injectionDeroulement: null,
      injectionAxes: null,
      avertissement: null,
      tachesCompletion: [],
      bloque: true,
      messageBlocage: resultatAxes.messageBlocage
    };
  }
  const { axesHTML, tachesCompletion } = resultatAxes;

  const instructions = `

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
   2. Dans la ligne III du tableau DÉROULEMENT, la colonne Traces écrites contient UNIQUEMENT du texte simple (jamais de tableau) : le libellé des 2 axes (ex. "Axe 1 : ... / Axe 2 : ..."), avec le MÊME texte que celui placé entre les marqueurs de titre d'axe décrits ci-dessous. Les Activités de l'enseignant/des élèves de cette ligne portent le questionnement guidé qui permet de dégager ces axes.
   3. Les 2 tableaux détaillés des axes (4 colonnes : Entrées | Indices textuels | Analyses | Interprétations) sont DÉJÀ CONSTRUITS côté serveur (structure, en-têtes et bordures fixes) -- tu ne les écris PLUS toi-même. Juste APRÈS le tableau DÉROULEMENT complet (donc après son </table>, jamais à l'intérieur d'une cellule), place EXACTEMENT le marqueur {{AXES_PLAN_ENSEIGNANT}} sur sa propre ligne, UNE SEULE FOIS -- il sera remplacé par les 2 tableaux déjà construits. Pour CHAQUE axe, place aussi le titre déterminé au point 1 ci-dessus entre ses 2 marqueurs dédiés, N'IMPORTE OÙ dans ta réponse : {{AXE1_TITRE}}...{{FIN_AXE1_TITRE}} pour l'Axe 1, {{AXE2_TITRE}}...{{FIN_AXE2_TITRE}} pour l'Axe 2 (texte IDENTIQUE à celui écrit dans la ligne III du tableau déroulement, point 2 ci-dessus) -- ces marqueurs seront extraits puis retirés du document final, ils ne doivent apparaître nulle part ailleurs.${construireConsigneCompletionEntrees(tachesCompletion)}

${consigneEntrees} Dans tous les cas (référentiel disponible ou non), les entrées des 2 tableaux d'axes sont STRICTEMENT des catégories linguistiques/grammaticales/lexicales (temps verbaux, types et formes de phrase, indices spatiaux/temporels, lexique thématique/mélioratif/péjoratif, pronoms, comparaisons et autres figures de style, ponctuation...) — JAMAIS une entrée thématique ou psychologisante (interdits, ex. : « le regret », « l'attachement affectif », « les détails techniques », « l'irruption du sentiment »...).

IV. BILAN GÉNÉRAL :
   - Question de synthèse : « Quels éléments de la langue/du texte ont permis d'étudier ce texte ? »
   - Confrontation EXPLICITE hypothèse/bilan, avec la formule EXACTE : « Notre hypothèse générale est donc vérifiée. »
   - Optionnel : une question d'ouverture ou d'avis personnel.

ÉVALUATION (ligne distincte du tableau DÉROULEMENT, différente et SÉPARÉE du Bilan général — ne jamais fusionner les deux) : cette ligne est ELLE AUSSI déjà construite côté serveur, à partir de la 2e entrée de l'Axe 2 (déjà décrite plus haut parmi les entrées à compléter -- jamais travaillée dans le tableau de l'Axe 2, qui n'affiche que sa 1ère entrée). Ne rédige RIEN toi-même pour cette ligne, ni relevé neuf ni consigne : contente-toi de fournir, pour cette entrée, ce qui est demandé plus haut via ses marqueurs dédiés.`;

  return {
    instructions,
    injectionDeroulement: null,
    injectionAxes: axesHTML,
    avertissement: null,
    tachesCompletion,
    bloque: false,
    messageBlocage: null
  };
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
  // Occurrences d'un repère déjà utilisé (doublon), conservées pour le repli
  // ciblé ci-dessous -- jamais silencieusement ignorées.
  const doublonsParRepere = {};

  lignes.forEach((ligne, index) => {
    const repere = detecterRepereLigne(ligne);
    if (!repere) return;
    if (repere.type === 'numero') {
      if (positions[repere.numero] !== undefined) {
        (doublonsParRepere[repere.numero] = doublonsParRepere[repere.numero] || []).push({ index, resteDeLigne: repere.resteDeLigne });
        return;
      }
      positions[repere.numero] = index;
      resteDeLigneParRepere[repere.numero] = repere.resteDeLigne;
    } else if (repere.type === 'evaluation' && positions.evaluation === undefined) {
      positions.evaluation = index;
      resteDeLigneParRepere.evaluation = repere.resteDeLigne;
    }
  });

  // Repli ciblé, UNIQUEMENT si "IV" est introuvable : coquille fréquente où
  // l'enseignant recopie par erreur le chiffre romain d'un repère déjà
  // utilisé (typiquement "I.") devant "BILAN" au lieu de "IV." -- un tel
  // doublon, s'il mentionne "bilan" dans le reste de sa ligne, est traité
  // comme le repère IV plutôt que de faire échouer toute la structuration
  // pour une simple coquille de frappe.
  if (positions.IV === undefined) {
    for (const numeroDuplique of Object.keys(doublonsParRepere)) {
      const candidat = doublonsParRepere[numeroDuplique].find((occ) => /bilan/i.test(occ.resteDeLigne));
      if (candidat) {
        positions.IV = candidat.index;
        resteDeLigneParRepere.IV = candidat.resteDeLigne;
        break;
      }
    }
  }

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
// Le numéro d'entrée est toléré COLLÉ à l'étiquette elle-même (ex. "Entrée 1:",
// "Entrée n°2 :"), en plus de la puce/numérotation en tête de ligne déjà gérée
// par ailleurs -- certains enseignants numérotent ainsi sans aucune puce.
const ETIQUETTES_ENTREE_AXE = [
  { cle: 'entree', regex: /entr[ée]e?s?\s*(?:n°\s*)?\d*\s*:\s*/i },
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

// Frontière fiable entre 2 entrées : la réapparition de l'étiquette "Entrée"
// elle-même (1ère des 4 dans l'ordre méthodologique Entrées/Indices/Analyses/
// Interprétations), plutôt qu'une puce "-"/"•" par entrée -- certains
// enseignants regroupent plusieurs entrées complètes sous UNE SEULE puce (ou
// les numérotent "1.", "2." sans tiret du tout). Avec un découpage par puce
// uniquement, ces entrées surnuméraires étaient absorbées silencieusement
// dans le champ Interprétation de l'entrée précédente : le nombre d'entrées
// calculé pouvait alors coïncider avec 2 par pur hasard, masquant à la fois
// le contenu réel (entrées suivantes invisibles, fondues en prose dans une
// seule cellule) ET l'avertissement de verifierNombreEntreesParAxe (qui se
// fie à ce même compte). Se rabat sur l'ancien découpage par puce UNIQUEMENT
// si aucune étiquette "Entrée" n'est trouvée du tout (axe non structuré selon
// la méthodologie -- contenu conservé intégralement, jamais perdu).
const REGEX_ENTREE_GLOBAL = /entr[ée]e?s?\s*(?:n°\s*)?\d*\s*:\s*/ig;

function parserEntreesAxe(texteAxe) {
  const texte = texteAxe || '';
  const positionsEntree = [];
  REGEX_ENTREE_GLOBAL.lastIndex = 0;
  let m;
  while ((m = REGEX_ENTREE_GLOBAL.exec(texte))) {
    positionsEntree.push(m.index);
  }

  if (!positionsEntree.length) {
    const blocs = texte.split(/\n(?=\s*[-•])/).map((b) => b.trim()).filter(Boolean);
    return blocs.map((bloc) => ({ structure: false, brut: bloc.replace(/^[-•]\s*/, '') }));
  }

  // Marqueur de tête d'entrée toléré avant l'étiquette "Entrée" elle-même :
  // puce ("-"/"•") OU numérotation ("1.", "2)"...).
  const MARQUEUR_PUCE = '(?:[-•]|\\d+\\s*[.)])';

  const segments = [];
  // Le texte avant la 1ère étiquette "Entrée" n'est en pratique qu'une puce de
  // tête sans contenu réel avant elle -- on la retire avant de juger s'il
  // reste un vrai préambule à conserver (jamais perdu s'il y en a un).
  const preambule = texte.slice(0, positionsEntree[0]).replace(new RegExp('^\\s*' + MARQUEUR_PUCE + '?\\s*'), '').trim();
  if (preambule) segments.push({ structure: false, brut: preambule });

  const regexPuceFinale = new RegExp('\\n\\s*' + MARQUEUR_PUCE + '\\s*$');
  positionsEntree.forEach((debut, i) => {
    const fin = i + 1 < positionsEntree.length ? positionsEntree[i + 1] : texte.length;
    // Retire, en fin de segment, la puce de tête de l'entrée SUIVANTE (elle
    // se retrouve incluse ici puisque la frontière est la position de son
    // étiquette "Entrée", pas le début de sa ligne/puce) -- sinon elle
    // pollue le dernier champ trouvé (Interprétation) d'un résidu ("-" ou "2.").
    const segment = texte.slice(debut, fin).trim().replace(regexPuceFinale, '').trim();
    const champs = decouperParEtiquettes(segment, ETIQUETTES_ENTREE_AXE);
    const complet = champs.entree && champs.indices && champs.analyse && champs.interpretation;
    segments.push(complet
      ? { structure: true, entree: champs.entree, indices: champs.indices, analyse: champs.analyse, interpretation: champs.interpretation }
      // champsPartiels conservé (jamais juste "brut") -- permet de signaler
      // précisément à l'enseignant QUELLES colonnes manquent quand le nom de
      // l'entrée est fourni mais pas son détail (cf. verifierEntreesCompletude).
      : { structure: false, brut: segment.replace(new RegExp('^' + MARQUEUR_PUCE + '\\s*'), ''), champsPartiels: champs });
  });

  return segments;
}

// Repère un en-tête d'axe : "Axe 1", "Axe de lecture 1", "-Axe 2 :",
// "•Axe 2)"... -- une puce de tête (tiret ou point) est tolérée, et
// N'IMPORTE QUELS MOTS peuvent séparer "Axe" du chiffre (ex. "de lecture") :
// seul le mot "Axe" en tout début de ligne (après puce/espaces éventuels) et
// un chiffre plus loin sur la même ligne sont exigés.
const REGEX_AXE = /^\s*[-•]?\s*Axe\b[^\d]*?(\d+)\s*[.):\-–—]?\s*(.*)$/i;

// Frontière "Situation d'évaluation" (ou variantes : avec/sans puce de tête,
// apostrophe droite/courbe, avec/sans accent) que certains enseignants
// placent APRÈS les axes mais AVANT "IV." plutôt qu'après -- separe la fin
// du contenu du dernier axe de cet extrait d'évaluation, fusionné ensuite
// avec segments.evaluation (même case du tableau ÉVALUATION, quel que soit
// l'endroit où l'enseignant l'a placé dans son plan).
const REGEX_SITUATION_EVALUATION = /^\s*[-•]?\s*Situation\s+d[’']?\s*[ée]valuation\b\s*[.):\-–—]?\s*(.*)$/i;

function parserAxesDepuisVerification(texteVerification) {
  const lignes = (texteVerification || '').split('\n');

  const blocs = [];
  let courant = null;
  const situationEvaluationLignes = [];
  let dansSituationEvaluation = false;

  lignes.forEach((ligne) => {
    if (dansSituationEvaluation) {
      situationEvaluationLignes.push(ligne);
      return;
    }
    const mEval = REGEX_SITUATION_EVALUATION.exec(ligne);
    if (mEval) {
      dansSituationEvaluation = true;
      if (mEval[1].trim()) situationEvaluationLignes.push(mEval[1].trim());
      return;
    }
    const m = REGEX_AXE.exec(ligne);
    if (m) {
      if (courant) blocs.push(courant);
      courant = { numero: m[1], titre: m[2].trim(), lignesBrutes: [] };
    } else if (courant) {
      courant.lignesBrutes.push(ligne);
    }
  });
  if (courant) blocs.push(courant);

  const axes = blocs.map((axe) => ({
    numero: axe.numero,
    titre: axe.titre,
    entrees: parserEntreesAxe(axe.lignesBrutes.join('\n'))
  }));

  const situationEvaluation = situationEvaluationLignes.join('\n').trim();
  return { axes, situationEvaluation: situationEvaluation || null };
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

// Détermine, pour UN axe, EXACTEMENT 2 entrées "réelles" -- garanti par le
// code (règle B), pas seulement signalé : au-delà de 2 entrées fournies par
// l'enseignant, les suivantes sont explicitement écartées (jamais tronquées
// en silence -- avertissement listant précisément ce qui est écarté) ; en
// dessous de 2, les entrées manquantes sont réservées à la complétion
// automatique (cf. construireLigneEntreeAvecCompletion). Chaque slot retourné
// porte son rendu HTML de ligne (déterministe, à compléter, ou brut) et,
// s'il y en a une, la tâche de complétion associée -- jamais de perte
// silencieuse d'une entrée fournie par l'enseignant : la ligne brute
// (structure:false sans nom reconnu) reste intacte, jamais promue.
//
// Depuis le changement d'architecture du 07/08 : quand une entrée doit être
// entièrement inventée (aucun nom fourni par l'enseignant, ou mode
// automatique), son NOM n'est plus laissé au modèle -- il est choisi ici de
// façon déterministe dans caracteristiquesParAxe(referentiel, numero), au
// même titre qu'une entrée nommée par l'enseignant (même fonction
// construireLigneEntreeAvecCompletion, seuls indices/analyse/interprétation
// restent à compléter par le modèle à partir du texte support). Si le
// référentiel ne fournit pas assez de catégories pour cet axe (référentiel
// absent, ou type de texte non encore couvert), l'entrée n'est PLUS inventée
// librement : le slot est marqué `bloque: true` et un message de blocage
// explicite est renvoyé -- jamais un repli silencieux vers une invention
// libre par le modèle.
function determinerSlotsAxe(numero, titre, entrees, niveau, referentiel) {
  const avertissements = [];
  let entreesRetenues = entrees;
  if (entrees.length > 2) {
    const excedent = entrees.slice(2);
    const noms = excedent.map((e) => {
      const nom = e.structure ? e.entree : (e.champsPartiels && e.champsPartiels.entree);
      return nom ? `« ${nom} »` : 'une entrée non nommée';
    });
    avertissements.push(`Axe ${numero} (« ${titre} ») fournissait ${entrees.length} entrées : seules les 2 premières sont retenues dans la fiche (méthodologie DPFC, 2 entrées par axe, jamais plus) -- ${noms.join(', ')} ${excedent.length > 1 ? 'ne sont pas utilisées' : "n'est pas utilisée"}. Retirez-la du plan si elle est superflue, ou fusionnez-la avec une entrée déjà retenue.`);
    entreesRetenues = entrees.slice(0, 2);
  }

  const categoriesAxe = caracteristiquesParAxe(referentiel, numero);
  let messageBlocage = null;

  const slots = [];
  entreesRetenues.forEach((e, i) => {
    const slot = i + 1;
    if (e.structure) {
      const html = `  <tr><td style="border:1px solid #000;padding:6px;">${e.entree}</td><td style="border:1px solid #000;padding:6px;">${e.indices}</td><td style="border:1px solid #000;padding:6px;">${e.analyse}</td><td style="border:1px solid #000;padding:6px;">${e.interpretation}</td></tr>`;
      slots.push({ slot, html, indicesConnues: e.indices, brut: null, tache: null });
      return;
    }
    const champs = e.champsPartiels || {};
    if (!champs.entree) {
      const html = `  <tr><td colspan="4" style="border:1px solid #000;padding:6px;">${e.brut}</td></tr>`;
      slots.push({ slot, html, indicesConnues: null, brut: e.brut, tache: null });
      return;
    }
    const { html, tache } = construireLigneEntreeAvecCompletion(`A${numero}E${slot}`, champs.entree, ['indices', 'analyse', 'interpretation']);
    const t = { ...tache, axeNumero: numero, axeTitre: titre, niveau };
    slots.push({ slot, html, indicesConnues: null, brut: null, tache: t });
  });
  for (let slot = entreesRetenues.length + 1; slot <= 2; slot++) {
    const categorie = categoriesAxe[slot - 1];
    if (!categorie) {
      messageBlocage = messageBlocage || construireMessageBlocageTypeTexteNonCouvert();
      slots.push({ slot, html: null, indicesConnues: null, brut: null, tache: null, bloque: true });
      continue;
    }
    const { html, tache } = construireLigneEntreeAvecCompletion(`A${numero}E${slot}`, categorie.libelle, ['indices', 'analyse', 'interpretation']);
    const t = { ...tache, axeNumero: numero, axeTitre: titre, niveau };
    slots.push({ slot, html, indicesConnues: null, brut: null, tache: t });
  }

  return { slots, avertissements, bloque: !!messageBlocage, messageBlocage };
}

// Construit le tableau autonome à 4 colonnes d'un axe (ligne-titre fusionnée +
// une ligne par entrée AFFICHÉE) -- SEULE fonction qui construit ce tableau
// pour le mode plan-enseignant. N'affiche que les `slots` reçus (cf.
// determinerSlotsAxe et construireDeroulementPlanEnseignantHTML : l'Axe 2
// n'en reçoit qu'1 -- règle C, sa 2e entrée est réservée à l'évaluation,
// jamais affichée ici).
function construireTableauAxeHTML(numero, titre, slots) {
  const lignesHTML = slots.length
    ? slots.map((s) => s.html).join('\n')
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
// Méthodologie DPFC (6e à Terminale, sans exception) : chaque axe doit
// contenir EXACTEMENT 2 entrées. Axe 1 justifie le type de texte de
// l'hypothèse (+ la tonalité à partir de la 4e, la tonalité n'étant pas
// étudiée en 6e/5e). Axe 2 justifie le thème de l'hypothèse (justification
// thématique, jamais une énumération libre). En mode plan-enseignant, le
// contenu vient à 100% de l'enseignant : on ne coupe ni ne complète jamais
// ses entrées pour forcer ce compte à 2 -- on se contente de l'avertir
// explicitement si son plan s'en écarte (option choisie explicitement,
// plutôt que de tronquer ou d'inventer une entrée manquante).
function verifierNombreEntreesParAxe(axes, niveau) {
  const attenduAxe1 = (niveau === '6e' || niveau === '5e')
    ? '1 entrée justifiant le type de texte (pas de tonalité à ce niveau)'
    : '1 entrée justifiant le type de texte + 1 entrée justifiant la tonalité';

  return axes
    .filter((axe) => axe.entrees.length !== 2)
    .map((axe) => {
      const attendu = axe.numero === '1' ? attenduAxe1 : '2 entrées de justification thématique (jamais une énumération libre)';
      return `Axe ${axe.numero} (« ${axe.titre} ») contient ${axe.entrees.length} entrée(s) au lieu des 2 attendues par la méthodologie (${attendu}) -- le contenu de l'enseignant a été conservé tel quel dans la fiche, sans rien couper ni ajouter ; vérifiez la conformité méthodologique de cet axe dans le plan fourni.`;
    });
}

const LIBELLES_COLONNES_ENTREE = {
  indices: 'Indices textuels',
  analyse: 'Analyses',
  interpretation: 'Interprétations'
};

// Vérifie, indépendamment du COMPTE d'entrées ci-dessus, que chaque entrée
// individuellement fournit les 4 colonnes. Cas réel qui a motivé cet ajout :
// un plan qui ne donne QUE le nom de chaque entrée ("Entrée 1: La structure
// du texte") sans citations/analyse/interprétation -- le compte peut alors
// être conforme (2/axe) tout en laissant les colonnes Indices
// textuels/Analyses/Interprétations vides, sans que rien ne le signale.
// SUPERSEDÉE depuis l'auto-complétion (cf. preparerLigneAxeAvecCompletion
// ci-dessous) pour le pipeline principal : ce cas précis n'est plus
// seulement signalé, il est activement complété par le modèle -- la fonction
// reste définie (comportement inchangé, toujours testée) pour un usage
// éventuel hors de ce pipeline, mais n'est plus appelée par
// construireDeroulementPlanEnseignantHTML.
function verifierEntreesCompletude(axes) {
  const avertissements = [];
  axes.forEach((axe) => {
    axe.entrees.forEach((entree, i) => {
      if (entree.structure) return;
      const champs = entree.champsPartiels || {};
      if (!champs.entree) return;
      const manquantes = ['indices', 'analyse', 'interpretation']
        .filter((cle) => !champs[cle])
        .map((cle) => LIBELLES_COLONNES_ENTREE[cle]);
      if (manquantes.length) {
        avertissements.push(`Axe ${axe.numero} (« ${axe.titre} »), entrée ${i + 1} (« ${champs.entree} ») : colonne(s) ${manquantes.join(', ')} vide(s) -- seul le nom de l'entrée est fourni dans le plan, rien n'a été inventé pour compléter le tableau ; complétez le plan si vous voulez ce détail dans la fiche.`);
      }
    });
  });
  return avertissements;
}

// --- Auto-complétion des entrées du tableau de vérification ---
//
// Décision de conception explicite (04/08) : en mode plan-enseignant,
// l'enseignant ne doit JAMAIS avoir à taper lui-même les Indices
// textuels/Analyses/Interprétations -- il fournit seulement la structure
// (axes + noms d'entrées, partiellement ou totalement), voire rien de plus
// que le squelette I/II/III/IV. Tout ce qu'il n'a pas détaillé est généré
// par le modèle, exactement comme le mode automatique le fait déjà --
// SEULE différence entre les 2 modes : qui choisit les axes/noms d'entrées
// (le modèle en mode automatique, l'enseignant partiellement ou totalement
// ici). Génération strictement bornée à 3 éléments : le texte support (seule
// source des citations), le nom de l'entrée (fixé par l'enseignant, ou à
// déterminer par le modèle en respectant le rôle de l'axe), et le rôle de
// l'axe + le niveau (cf. skill lecture méthodique, section 3) -- jamais
// autre chose, pour ne jamais halluciner de contenu hors-sujet.
// "titre" (titre d'un axe) ajouté pour le mode automatique (cf.
// construireAxesAInventerHTML) -- même mécanique générique de jeton/marqueur
// que pour les champs d'une entrée, réutilisée telle quelle.
const ABREV_CHAMP_ENTREE = { nom: 'NOM', indices: 'IND', analyse: 'ANA', interpretation: 'INT', titre: 'TITRE' };
const LIBELLES_CHAMP_ENTREE_LONG = {
  nom: "le nom de l'entrée",
  indices: 'les indices textuels',
  analyse: "l'analyse",
  interpretation: "l'interprétation",
  titre: "le titre de l'axe"
};

// Texte du rôle méthodologique d'un axe (cf. skill section 3) : Axe 1
// justifie le type de texte (+ tonalité à partir de la 4e), Axe 2 justifie
// toujours le thème -- jamais une énumération libre de contenu.
function roleAxeTexte(axeNumero, niveau) {
  if (axeNumero === '1') {
    return (niveau === '6e' || niveau === '5e')
      ? 'doit justifier le TYPE DE TEXTE de l\'hypothèse générale (pas de tonalité à ce niveau)'
      : 'doit justifier le TYPE DE TEXTE ET LA TONALITÉ de l\'hypothèse générale';
  }
  return 'doit justifier le THÈME de l\'hypothèse générale par une catégorie linguistique précise (jamais une énumération libre d\'arguments ou d\'éléments de contenu)';
}

// Construit la ligne <tr> d'UNE entrée d'axe, en insérant des jetons internes
// (@@ID_CHAMP@@, jamais montrés au modèle ni visibles dans le document final)
// pour chaque champ que le modèle doit compléter -- même mécanique que
// JETON_PRESENTATION_RECOMPOSEE, généralisée à une liste de champs variable.
// Enregistre une "tâche" par entrée à compléter (nomFixe = null si le modèle
// doit aussi déterminer le nom lui-même), utilisée ensuite pour construire la
// consigne de prompt et pour l'extraction post-génération.
function construireLigneEntreeAvecCompletion(id, nomFixe, champsAGenerer) {
  const cell = (contenu) => `<td style="border:1px solid #000;padding:6px;">${contenu}</td>`;
  const jeton = (champ) => `@@${id}_${ABREV_CHAMP_ENTREE[champ]}@@`;
  const html = `  <tr>${cell(nomFixe !== null ? nomFixe : jeton('nom'))}${cell(jeton('indices'))}${cell(jeton('analyse'))}${cell(jeton('interpretation'))}</tr>`;
  return { html, tache: { id, nomFixe, champsAGenerer } };
}

// "I. Présentation du texte" -- l'enseignant fournit généralement ces
// informations sous forme de champs séparés (comme avant). Réutilise
// decouperParEtiquettes (même mécanique que pour les entrées d'axe) pour les
// détecter, en vue d'une recomposition en phrase(s) -- exception étroite
// décrite plus bas, à partir de la 4e uniquement.
const ETIQUETTES_PRESENTATION_TEXTE = [
  { cle: 'titre', regex: /titre\s*:\s*/i },
  { cle: 'auteur', regex: /auteur\s*:\s*/i },
  { cle: 'source', regex: /(?:source|[ée]dition)\s*:\s*/i },
  { cle: 'nature', regex: /nature\s*:\s*/i },
  { cle: 'tonalite', regex: /tonalit[ée]\s*:\s*/i },
  { cle: 'theme', regex: /th[èe]me\s*:\s*/i }
];

// En dessous de ce nombre de champs reconnus, le texte de l'enseignant n'a
// probablement pas été écrit comme une liste de champs (déjà de la prose,
// ou format non reconnu) : rien à recomposer, reproduction verbatim comme
// pour tout le reste du plan.
const SEUIL_CHAMPS_PRESENTATION_POUR_RECOMPOSITION = 2;

function extraireChampsPresentation(texteI) {
  const champs = decouperParEtiquettes(texteI, ETIQUETTES_PRESENTATION_TEXTE);
  return Object.keys(champs).length >= SEUIL_CHAMPS_PRESENTATION_POUR_RECOMPOSITION ? champs : null;
}

// Jeton interne (jamais montré au modèle, jamais visible dans le document
// final) utilisé UNIQUEMENT pour réserver, à l'intérieur du HTML déjà
// construit de la ligne I, la place où la phrase recomposée par le modèle
// viendra s'insérer après génération -- cf. extraireEtRetirerRecompositionPresentation
// et son utilisation dans stream.on('finalMessage', ...).
const JETON_PRESENTATION_RECOMPOSEE = '@@PRESENTATION_RECOMPOSEE@@';

// Construit la consigne d'évaluation à partir de l'entrée réservée (TOUJOURS
// Axe 2/Entrée 2, jamais une autre -- règle D, cf. skill section 6, confirmé
// dans le corpus Lect_meth_7_Le_spect_Koteba). Ne révèle QUE les indices
// textuels (citations, le "repérage") -- jamais le nom, l'analyse ni
// l'interprétation, que l'élève doit retrouver SEUL. Repli explicite (jamais
// silencieux) si le contenu fourni par l'enseignant pour cette entrée n'est
// pas structuré (aucune citation sûre à réutiliser).
function construireEntreeReserveeEvaluation(numero, titre, niveau, slotReserve) {
  if (slotReserve.indicesConnues !== null) {
    return { indicesTexteOuJeton: slotReserve.indicesConnues, tache: null, avertissement: null };
  }
  if (slotReserve.tache) {
    return { indicesTexteOuJeton: `@@${slotReserve.tache.id}_IND@@`, tache: slotReserve.tache, avertissement: null };
  }
  const t = { id: `A${numero}E${slotReserve.slot}RES`, nomFixe: null, champsAGenerer: ['indices'], axeNumero: numero, axeTitre: titre, niveau };
  const brut = slotReserve.brut || '';
  const brutTronque = brut.length > 100 ? brut.slice(0, 100) + '...' : brut;
  return {
    indicesTexteOuJeton: `@@${t.id}_IND@@`,
    tache: t,
    avertissement: `Axe ${numero} (« ${titre} »), entrée réservée à l'évaluation : le contenu fourni ("${brutTronque}") n'a pas pu être reconnu comme une entrée structurée -- un repérage a été généré automatiquement à la place pour l'évaluation. Vérifiez si ce contenu doit être réintégré ailleurs dans le plan.`
  };
}

function construireConsigneEvaluationReservee(indicesTexteOuJeton) {
  return `<p>Le professeur propose aux élèves de retrouver seuls, sur le même texte support, la dernière entrée de vérification (non travaillée en classe). Il leur soumet le repérage suivant : ${indicesTexteOuJeton}</p><p>Consignes : 1) Nomme et justifie l'emploi de ce procédé. 2) Interprète-le : quel effet produit-il ? 3) Détermine l'entrée correspondante.</p>`;
}

// Mode automatique (Mode 1, titre seul, sans plan enseignant) -- amène ce
// mode au MÊME niveau de garantie que le mode plan-enseignant (règles A/B/C/D),
// en réutilisant EXACTEMENT le même mécanisme, jamais une réécriture séparée :
// determinerSlotsAxe (appelé avec une liste d'entrées VIDE -- ici, rien n'est
// fourni par un enseignant, tout doit être inventé -- produit exactement le
// même repli "2 entrées à compléter" que le cas "squelette minimal" du mode
// plan-enseignant), construireTableauAxeHTML (le titre de l'axe, inconnu tant
// que le modèle n'a pas répondu, est simplement un jeton interne de plus,
// résolu par le même resoudreCompletionsEntrees générique), et
// construireEntreeReserveeEvaluation (Axe 2/Entrée 2 réservée, identique).
// Seule différence avec le mode plan-enseignant : aucun titre d'axe n'est
// connu à l'avance (jeton systématique), et aucune entrée fournie par
// l'enseignant n'existe (donc aucun excédent possible, aucun contenu brut).
function construireAxesAInventerHTML(niveau, referentiel) {
  let tachesCompletion = [];
  let entreeReservee = null;
  let messageBlocage = null;
  const axesHTML = ['1', '2'].map((numero) => {
    if (messageBlocage) return '';
    const titreLabel = `Axe ${numero}`; // libellé générique pour les messages -- le vrai titre est un jeton, résolu après génération
    const jetonTitre = `@@AXE${numero}_TITRE@@`;
    const tacheTitre = { id: `AXE${numero}`, nomFixe: null, champsAGenerer: ['titre'], axeNumero: numero, axeTitre: titreLabel, niveau };

    const { slots, bloque, messageBlocage: messageBlocageAxe } = determinerSlotsAxe(numero, titreLabel, [], niveau, referentiel);
    if (bloque) { messageBlocage = messageBlocageAxe; return ''; }

    tachesCompletion.push(tacheTitre);
    const slotsAffiches = numero === '2' ? slots.filter((s) => s.slot === 1) : slots;
    slotsAffiches.forEach((s) => { if (s.tache) tachesCompletion.push(s.tache); });

    if (numero === '2') {
      const slotReserve = slots.find((s) => s.slot === 2);
      entreeReservee = construireEntreeReserveeEvaluation(numero, titreLabel, niveau, slotReserve);
      if (entreeReservee.tache) tachesCompletion.push(entreeReservee.tache);
    }

    return construireTableauAxeHTML(numero, jetonTitre, slotsAffiches);
  }).join('\n\n');

  if (messageBlocage) {
    return { bloque: true, messageBlocage, axesHTML: null, tachesCompletion: [], entreeReservee: null };
  }
  return { bloque: false, messageBlocage: null, axesHTML, tachesCompletion, entreeReservee };
}

function construireDeroulementPlanEnseignantHTML(segments, niveau, referentiel) {
  const { axes, situationEvaluation } = parserAxesDepuisVerification(segments.verification);

  // Détermine et rend chaque tableau d'axe -- règle B (2 entrées par axe,
  // garanti par le code, cf. determinerSlotsAxe) + règle C (Axe 2 : seule sa
  // 1ère entrée est affichée ici, la 2e est réservée à l'évaluation
  // ci-dessous, cf. construireEntreeReserveeEvaluation). Un axe où
  // l'enseignant a fourni MOINS de 2 entrées a besoin du référentiel pour
  // nommer les entrées manquantes (cf. determinerSlotsAxe) -- si celui-ci ne
  // le permet pas, tout le mode plan-enseignant est bloqué ici (jamais un
  // repli silencieux vers une invention libre par le modèle).
  let tachesCompletion = [];
  let avertissementsEntrees = [];
  let entreeReservee = null;
  let messageBlocage = null;
  const axesHTML = axes.length
    ? axes.map((a) => {
        if (messageBlocage) return '';
        const { slots, avertissements, bloque, messageBlocage: messageBlocageAxe } = determinerSlotsAxe(a.numero, a.titre, a.entrees, niveau, referentiel);
        if (bloque) { messageBlocage = messageBlocageAxe; return ''; }
        avertissementsEntrees = avertissementsEntrees.concat(avertissements);

        const slotsAffiches = a.numero === '2' ? slots.filter((s) => s.slot === 1) : slots;
        slotsAffiches.forEach((s) => { if (s.tache) tachesCompletion.push(s.tache); });

        if (a.numero === '2') {
          const slotReserve = slots.find((s) => s.slot === 2);
          if (slotReserve) {
            entreeReservee = construireEntreeReserveeEvaluation(a.numero, a.titre, niveau, slotReserve);
            if (entreeReservee.tache) tachesCompletion.push(entreeReservee.tache);
            if (entreeReservee.avertissement) avertissementsEntrees.push(entreeReservee.avertissement);
          }
        }

        return construireTableauAxeHTML(a.numero, a.titre, slotsAffiches);
      }).join('\n\n')
    : '';

  if (messageBlocage) {
    return { bloque: true, messageBlocage };
  }

  const libelleAxes = axes.length
    ? axes.map((a) => `Axe ${a.numero} : ${a.titre}`).join(' / ')
    : texteSupportVersHtml(segments.verification).replace(/<\/?p>/g, ' ').trim();

  // "Situation d'évaluation" placée par l'enseignant APRÈS les axes mais
  // AVANT "IV." (plutôt qu'après, comme le prévoit le format par défaut) :
  // fusionnée ici avec segments.evaluation -- même case ÉVALUATION du
  // tableau, quel que soit l'endroit où l'enseignant l'a écrite. Le repère
  // "IV." explicite reste prioritaire s'il existe (cas où l'enseignant aurait
  // rédigé les deux, peu probable mais on ne veut jamais en perdre un).
  // Règle D : la consigne réservée (ci-dessus) est TOUJOURS présente en tête
  // -- garantie par le code, jamais laissée à la discrétion de l'enseignant
  // -- tout contenu d'évaluation qu'il a lui-même rédigé vient s'y AJOUTER,
  // jamais à sa place (aucun contenu de l'enseignant n'est perdu).
  const consigneEnseignant = segments.evaluation || situationEvaluation || '';
  const evaluationEffective = [
    entreeReservee ? construireConsigneEvaluationReservee(entreeReservee.indicesTexteOuJeton) : '',
    consigneEnseignant ? texteSupportVersHtml(consigneEnseignant) : ''
  ].filter(Boolean).join('\n');

  // Exception étroite (à partir de la 4e SEULEMENT) : si l'enseignant a
  // fourni la présentation du texte sous forme de champs séparés, le
  // modèle est autorisé à les recomposer en phrase(s) correcte(s) -- pure
  // recomposition syntaxique des informations déjà données, jamais un ajout
  // ni une correction de fond. En 6e/5e, ou si le texte ne ressemble pas à
  // une liste de champs (moins de 2 champs reconnus), AUCUN changement :
  // reproduction verbatim, exactement comme pour tout le reste du plan.
  const niveauAutoriseRecomposition = niveau !== '6e' && niveau !== '5e';
  const champsPresentation = niveauAutoriseRecomposition ? extraireChampsPresentation(segments.presentation) : null;

  const tracesEcritesLigneI = champsPresentation ? JETON_PRESENTATION_RECOMPOSEE : texteSupportVersHtml(segments.presentation);

  const lignesHTML = [
    construireLigneDeroulementHTML({
      moment: 'I. PRÉSENTATION DU TEXTE',
      strategie: 'Présentation du texte (paratexte)',
      activiteEnseignant: 'Présente le texte et questionne sur son paratexte.',
      activiteEleves: 'Relèvent les éléments du texte identifiés dans le plan.',
      tracesEcrites: tracesEcritesLigneI
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
      strategie: evaluationEffective ? 'Travail individuel' : '',
      activiteEnseignant: evaluationEffective ? 'Donne le sujet.' : '',
      activiteEleves: evaluationEffective ? 'Travaillent seuls, à l\'écrit.' : '',
      // evaluationEffective contient déjà du HTML pré-construit (consigne
      // réservée + éventuel contenu enseignant déjà passé par
      // texteSupportVersHtml ci-dessus) -- ne jamais le repasser dans
      // texteSupportVersHtml ici (double échappement/encapsulation). Ne peut
      // plus être vide dès qu'un Axe 2 existe (règle D, garantie par le code).
      tracesEcrites: evaluationEffective
    })
  ].join('\n');

  return {
    lignesHTML,
    axesHTML,
    avertissementsEntrees,
    champsPresentationARecomposer: champsPresentation,
    // Repli sûr si le modèle ne produit pas la recomposition demandée --
    // jamais de jeton laissé visible dans le document final.
    presentationVerbatimFallbackHTML: texteSupportVersHtml(segments.presentation),
    // Pour le texte du prompt (mention "/Évaluation" détectée) -- reflète la
    // fusion ci-dessus, pas seulement le repère "IV." explicite.
    evaluationDetectee: !!evaluationEffective,
    // Entrées à compléter automatiquement par le modèle (nom fixé ou à
    // déterminer + colonnes manquantes) -- cf. construireConsigneCompletionEntrees
    // et extraireCompletionsEntrees/resoudreCompletionsEntrees plus bas.
    tachesCompletion,
    bloque: false,
    messageBlocage: null
  };
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

// Construit la consigne de prompt pour les entrées à compléter (cf.
// construireLigneEntreeAvecCompletion) -- absente (chaîne vide) si aucune
// tâche, jamais de génération demandée hors de ce cadre strict : texte
// support + nom de l'entrée (fixé ou à déterminer) + rôle de l'axe/niveau,
// rien d'autre.
function construireConsigneCompletionEntrees(taches) {
  if (!taches.length) return '';

  const rolesParAxe = {};
  taches.forEach((t) => { rolesParAxe[t.axeNumero] = { titre: t.axeTitre, role: roleAxeTexte(t.axeNumero, t.niveau) }; });
  const consigneNiveauLangage = (taches[0].niveau === '6e' || taches[0].niveau === '5e')
    ? ' Niveau 6e/5e : vocabulaire CONCRET et accessible, jamais de méta-langage dense (interdits : « procédés d\'expression de... », « organisation spatiale de... »).'
    : '';

  const rolesTexte = Object.entries(rolesParAxe)
    .map(([numero, { titre, role }]) => `Axe ${numero} (« ${titre} ») ${role}.`)
    .join(' ');

  const consignesEntrees = taches.map((t) => {
    const marqueur = (champ) => {
      const id = `${t.id}_${ABREV_CHAMP_ENTREE[champ]}`;
      return `{{${id}}}...{{FIN_${id}}}`;
    };
    const partieNom = t.nomFixe === null
      ? `nom à déterminer toi-même (une SEULE catégorie linguistique/grammaticale/lexicale précise, cohérente avec le rôle de l'axe ci-dessus -- JAMAIS une entrée thématique ou psychologisante), à placer entre ${marqueur('nom')}, puis `
      : `entrée « ${t.nomFixe} » (nom fixé, ne le modifie pas) : `;
    return `   - Axe ${t.axeNumero}, ${partieNom}Indices textuels (citations EXACTES du texte support, entre guillemets, jamais inventées) entre ${marqueur('indices')} ; Analyses (nomme et justifie le procédé) entre ${marqueur('analyse')} ; Interprétations (l'effet produit sur le lecteur/le sens dégagé) entre ${marqueur('interpretation')}.`;
  }).join('\n');

  return `

COMPLÉTION AUTOMATIQUE D'ENTRÉES DU TABLEAU DE VÉRIFICATION (exception étroite à la règle "jamais inventer" ci-dessus, limitée STRICTEMENT à ce qui suit) : l'enseignant n'a pas détaillé certaines entrées de son plan. Pour CHACUNE listées ci-dessous, génère UNIQUEMENT à partir du texte support fourni (jamais d'autre source, jamais de connaissance générale sur le genre, jamais de fait inventé) le contenu demandé. ${rolesTexte}${consigneNiveauLangage}
${consignesEntrees}
Place chaque élément, et UNIQUEMENT lui, entre ses 2 marqueurs dédiés, N'IMPORTE OÙ dans ta réponse (par exemple juste avant {{AXES_PLAN_ENSEIGNANT}}) -- ces marqueurs et leur contenu seront extraits puis retirés du document final, ils ne doivent apparaître nulle part ailleurs. N'écris PAS toi-même les lignes du tableau d'axes concernées : elles sont déjà construites, seuls ces éléments précis sont attendus de toi, un élément par marqueur, jamais une énumération libre ni un tableau complet.`;
}
function construireInstructionsLectureMethodiqueAvecPlanEnseignant(classe, planCours, referentiel) {
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

RÈGLE ABSOLUE, UNIQUEMENT POUR LE CONTENU PÉDAGOGIQUE DU DÉVELOPPEMENT (hypothèse, axes de lecture, entrées des tableaux de vérification, analyses, interprétations) : tu ne dois JAMAIS l'inventer, le compléter ou le reformuler substantiellement -- SAUF pour les entrées explicitement listées plus bas dans une section dédiée "COMPLÉTION AUTOMATIQUE D'ENTRÉES", SI ELLE EST PRÉSENTE dans ce message (absente si l'enseignant a déjà tout détaillé), où tu es exceptionnellement autorisé à générer le détail manquant, dans le cadre strict qui y est décrit. En dehors de cette section précise, tout le reste vient à 100% du texte de l'enseignant.

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
      avertissement: `Le plan de cours fourni n'a pas pu être structuré automatiquement (${resultatParsing.raison}) : les repères "I.", "II.", "III.", "IV." sont attendus chacun en tout début de ligne. La fiche a été générée en mode de repli (texte non structuré, clairement signalé dans le document) -- corrigez le format des repères et régénérez pour obtenir un tableau correctement réparti.`,
      tachesCompletion: [],
      bloque: false,
      messageBlocage: null
    };
  }

  const resultatDeroulement = construireDeroulementPlanEnseignantHTML(resultatParsing.segments, niveau, referentiel);
  if (resultatDeroulement.bloque) {
    return {
      instructions: '',
      injectionDeroulement: null,
      injectionAxes: null,
      avertissement: null,
      planCoursPourPromptFinal: null,
      tachesCompletion: [],
      bloque: true,
      messageBlocage: resultatDeroulement.messageBlocage
    };
  }
  const { lignesHTML, axesHTML, avertissementsEntrees, champsPresentationARecomposer, presentationVerbatimFallbackHTML, evaluationDetectee, tachesCompletion } =
    resultatDeroulement;

  // Exception étroite accordée pour la ligne I UNIQUEMENT (à partir de la 4e,
  // quand l'enseignant a fourni Titre/Auteur/Source/Nature/Tonalité/Thème en
  // champs séparés) : consigne de recomposition SYNTAXIQUE seulement, jamais
  // un ajout/retrait d'information. Absente (chaîne vide) si non applicable
  // (6e/5e, ou texte déjà en prose) -- la ligne I reste alors verbatim,
  // aucun changement par rapport au comportement précédent.
  const consigneRecompositionPresentation = champsPresentationARecomposer ? `

CONTENU DE LA LIGNE "I. PRÉSENTATION DU TEXTE" (exception étroite, niveau ${niveau === '4e_3e' ? '4e/3e' : 'lycée'} uniquement) : cette ligne est déjà entièrement construite par le code, comme les autres -- SAUF le texte de sa colonne Traces écrites, qui te revient. L'enseignant a fourni ces informations séparément :
${Object.entries(champsPresentationARecomposer).map(([cle, valeur]) => `- ${cle} : ${valeur}`).join('\n')}
(UNIQUEMENT les champs listés ci-dessus -- n'en ajoute, n'en devine et n'en invente AUCUN autre.) Rédige 1 à 2 phrases SYNTAXIQUEMENT CORRECTES qui recomposent EXACTEMENT ces informations -- aucune information nouvelle, aucune supprimée, aucun changement de sens : seule la syntaxe est reformulée pour en faire des phrases, jamais le fond. Place CE TEXTE, et UNIQUEMENT ce texte, entre les marqueurs {{PRESENTATION_RECOMPOSEE}} et {{FIN_PRESENTATION_RECOMPOSEE}}, N'IMPORTE OÙ dans ta réponse (par exemple juste avant {{DEROULEMENT_PLAN_ENSEIGNANT}}) -- ces 2 marqueurs et le texte entre eux seront extraits puis retirés du document final, ils ne doivent apparaître nulle part ailleurs. N'écris PAS toi-même la ligne I du tableau (moment, stratégies, activités) : elle est déjà construite, seule sa colonne Traces écrites attend ce texte, via ces 2 marqueurs.`
    : '';

  const instructions = enteteCommun + `

DÉTECTION RÉUSSIE — le plan de l'enseignant a déjà été segmenté et mis en tableau AUTOMATIQUEMENT, côté serveur (pas par toi), selon ses repères I/II/III/IV${evaluationDetectee ? '/Évaluation' : ''}. Le tableau DÉROULEMENT (lignes I à IV${evaluationDetectee ? ' et Évaluation' : ''}) et le ou les tableaux d'axes sont DÉJÀ CONSTRUITS. Concernant UNIQUEMENT cette partie développement/vérification (pas le reste de la fiche), ta tâche est de placer 3 marqueurs au bon endroit, sans rien écrire d'autre à leur place :
   1. Dans le tableau DÉROULEMENT (5 colonnes), juste après la ligne PRÉSENTATION rituelle (celle-ci, générique, reste à ta charge comme d'habitude), place EXACTEMENT le marqueur {{DEROULEMENT_PLAN_ENSEIGNANT}} comme SEUL contenu de cette position -- il sera remplacé par les lignes I à IV${evaluationDetectee ? ' et Évaluation' : ''} déjà construites. Referme normalement le tableau juste après (</table>).
   2. Juste APRÈS ce tableau DÉROULEMENT (donc après son </table>, au même niveau que les autres tableaux de la fiche, JAMAIS à l'intérieur d'une cellule), place EXACTEMENT le marqueur {{TEXTE_SUPPORT}} sur sa propre ligne, UNE SEULE FOIS dans tout le document -- il sera remplacé par le texte support fourni par l'enseignant.
   3. Juste après {{TEXTE_SUPPORT}}, place EXACTEMENT le marqueur {{AXES_PLAN_ENSEIGNANT}} sur sa propre ligne -- il sera remplacé par le ou les tableaux d'axes déjà construits.
N'invente, ne recopie, ne reformule et ne réordonne RIEN du contenu du plan toi-même pour cette partie : il est déjà entièrement construit. Le reste de la fiche (entête, Compétence, Situation d'apprentissage, Supports/Bibliographie...) n'est PAS concerné par cette restriction et se rédige normalement.${consigneRecompositionPresentation}${construireConsigneCompletionEntrees(tachesCompletion)}`;

  // Le texte brut du plan n'a plus besoin d'être montré au modèle dans le cas
  // réussi : il ne sert plus qu'à la structuration, déjà faite côté code --
  // ne pas l'inclure supprime à la fois le risque de dilution des
  // instructions suivantes (Leçon/Séance/Compétence) et toute tentation du
  // modèle de réécrire lui-même ce contenu.
  return {
    instructions,
    injectionDeroulement: lignesHTML,
    injectionAxes: axesHTML,
    // Option B : avertissement explicite si un axe n'a pas exactement 2
    // entrées -- jamais un échec silencieux, jamais un contenu tronqué/complété.
    avertissement: avertissementsEntrees.length ? avertissementsEntrees.join(' ') : null,
    planCoursPourPromptFinal: null,
    presentationARecomposer: !!champsPresentationARecomposer,
    presentationVerbatimFallbackHTML,
    tachesCompletion,
    bloque: false,
    messageBlocage: null
  };
}

// Vérifie, dans le HTML brut renvoyé par le modèle (AVANT toute injection),
// que les marqueurs attendus sont bien présents -- valable pour les 2 modes
// (plan-enseignant ET automatique, cf. construireInstructionsLectureMethodique) :
// {{DEROULEMENT_PLAN_ENSEIGNANT}} n'est vérifié que si injectionDeroulement
// est réellement attendu (jamais en mode automatique, où le déroulement
// reste rédigé librement par le modèle -- seuls les tableaux d'axes sont
// pré-construits). Sans ce contrôle, un marqueur omis par le modèle
// (réponse tronquée, ou modèle "estimant avoir fini" après avoir mentionné
// les axes en texte libre dans la ligne III) provoque soit une perte de
// contenu totalement silencieuse (tableau d'axes, via injecterMarqueurUneFois
// qui ne fait rien si le marqueur est absent), soit un repli mal positionné
// (texte support, dont le repli dans injecterTexteSupport suppose un autre
// tableau de référence qui peut ne pas exister) -- jamais sans avertissement
// explicite à l'enseignant.
function verifierMarqueursPlanEnseignant(contenuHTMLBrut, injection) {
  if (!injection || (injection.injectionDeroulement === null && injection.injectionAxes === null)) return [];
  const avertissements = [];
  if (injection.injectionDeroulement !== null && !contenuHTMLBrut.includes('{{DEROULEMENT_PLAN_ENSEIGNANT}}')) {
    avertissements.push("Le modèle n'a pas placé le marqueur attendu pour le tableau déroulement (lignes I à IV) : ce tableau n'a pas pu être inséré automatiquement à l'emplacement prévu. Vérifiez la fiche générée.");
  }
  if (!contenuHTMLBrut.includes('{{TEXTE_SUPPORT}}')) {
    avertissements.push("Le modèle n'a pas placé le marqueur attendu pour le texte support : il a été réinséré automatiquement à un emplacement par défaut, qui peut ne pas correspondre à l'emplacement prévu (juste après le tableau déroulement). Vérifiez son positionnement dans la fiche générée.");
  }
  if (injection.injectionAxes !== null && !contenuHTMLBrut.includes('{{AXES_PLAN_ENSEIGNANT}}')) {
    avertissements.push("Le modèle n'a pas placé le marqueur attendu pour le tableau détaillé des axes (Entrées/Indices textuels/Analyses/Interprétations) : ce tableau n'a pas pu être inséré automatiquement. Vérifiez la fiche générée.");
  }
  return avertissements;
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

// Extrait la phrase recomposée par le modèle pour la ligne I (exception
// étroite, cf. construireInstructionsLectureMethodiqueAvecPlanEnseignant),
// placée par le modèle entre 2 marqueurs dédiés QUELQUE PART dans sa
// réponse -- puis retire ce bloc du HTML : il ne doit JAMAIS apparaître tel
// quel dans le document final, seul le texte extrait doit s'y retrouver (à
// la place du jeton interne réservé dans injectionDeroulement).
function extraireEtRetirerRecompositionPresentation(contenuHTML) {
  const m = /\{\{PRESENTATION_RECOMPOSEE\}\}([\s\S]*?)\{\{FIN_PRESENTATION_RECOMPOSEE\}\}/.exec(contenuHTML);
  if (!m) return { texte: null, contenuHTML };
  const texte = m[1].trim();
  const nettoye = contenuHTML.slice(0, m.index) + contenuHTML.slice(m.index + m[0].length);
  return { texte: texte || null, contenuHTML: nettoye };
}

// Même mécanique qu'extraireEtRetirerRecompositionPresentation ci-dessus,
// pour le texte support rédigé par le modèle en Mode 1 (Lecture méthodique
// automatique) quand l'enseignant n'en a fourni aucun (cf. userMessage plus
// bas). Le texte extrait devient ensuite la valeur de `texteSupport`,
// injectée par injecterTexteSupport EXACTEMENT comme un texte fourni par
// l'enseignant -- imprimée en entier dans la fiche, et seule source des
// citations pour le tableau de vérification ET pour l'entrée réservée à
// l'Évaluation (jamais un extrait différent, règle verrouillée du 04/08).
function extraireEtRetirerTexteSupportGenere(contenuHTML) {
  const m = /\{\{TEXTE_SUPPORT_GENERE\}\}([\s\S]*?)\{\{FIN_TEXTE_SUPPORT_GENERE\}\}/.exec(contenuHTML);
  if (!m) return { texte: null, contenuHTML };
  const texte = m[1].trim();
  const nettoye = contenuHTML.slice(0, m.index) + contenuHTML.slice(m.index + m[0].length);
  return { texte: texte || null, contenuHTML: nettoye };
}

// Résout, dans le HTML déjà construit de la ligne I, le jeton interne
// réservé à la phrase recomposée par le modèle. Repli sûr si le modèle ne
// l'a pas fournie (texte de l'enseignant reproduit tel quel, jamais un
// jeton laissé visible dans le document final) -- jamais un échec silencieux :
// le champ repliUtilise signale à l'appelant qu'un avertissement est dû.
function resoudrePresentationRecomposee(injection, texteRecompose) {
  if (!injection || !injection.presentationARecomposer) return { injection, repliUtilise: false };
  const repliUtilise = !texteRecompose;
  const remplacement = repliUtilise ? injection.presentationVerbatimFallbackHTML : texteSupportVersHtml(texteRecompose);
  return {
    injection: {
      ...injection,
      injectionDeroulement: injection.injectionDeroulement.split(JETON_PRESENTATION_RECOMPOSEE).join(remplacement)
    },
    repliUtilise
  };
}

// Extrait, pour CHAQUE tâche de complétion (cf. construireLigneEntreeAvecCompletion),
// le contenu que le modèle a placé entre ses marqueurs dédiés {{ID_CHAMP}}...
// {{FIN_ID_CHAMP}} -- puis retire ces marqueurs du HTML, même mécanique que
// extraireEtRetirerRecompositionPresentation, généralisée à une liste
// variable de champs. Ne modifie QUE ce qui est extrait ici -- le reste du
// document (y compris tout marqueur non concerné) reste intact.
function extraireCompletionsEntrees(contenuHTML, taches) {
  let html = contenuHTML;
  const valeurs = {};
  taches.forEach((t) => {
    t.champsAGenerer.forEach((champ) => {
      const id = `${t.id}_${ABREV_CHAMP_ENTREE[champ]}`;
      const regex = new RegExp(`\\{\\{${id}\\}\\}([\\s\\S]*?)\\{\\{FIN_${id}\\}\\}`);
      const m = regex.exec(html);
      if (!m) { valeurs[`${t.id}_${champ}`] = null; return; }
      valeurs[`${t.id}_${champ}`] = m[1].trim() || null;
      html = html.slice(0, m.index) + html.slice(m.index + m[0].length);
    });
  });
  return { contenuHTML: html, valeurs };
}

// Résout, dans UN bloc HTML déjà construit (tableaux d'axes OU tableau
// déroulement -- un jeton donné ne vit jamais que dans un seul des deux, cf.
// construireEntreeReserveeEvaluation pour le cas de la ligne ÉVALUATION), les
// jetons internes réservés à chaque champ à compléter -- repli sûr et
// avertissement explicite si le modèle n'a pas fourni un élément (jamais un
// jeton laissé visible, jamais un échec silencieux) : le nom manquant devient
// un libellé générique, les autres colonnes une mention explicite d'absence,
// jamais une case vide sans explication ni un contenu inventé pour la
// combler. Générique (un simple bloc HTML en entrée) pour être appelée sur
// chaque bloc concerné, plutôt qu'une fonction dédiée par bloc. `html` peut
// être null (mode automatique : aucun injectionDeroulement pré-construit,
// le déroulement restant rédigé librement par le modèle) -- no-op sûr.
function resoudreCompletionsEntrees(html, taches, valeurs) {
  if (html === null) return { html: null, avertissements: [] };
  let resultat = html;
  const avertissements = [];
  taches.forEach((t) => {
    t.champsAGenerer.forEach((champ) => {
      const jeton = `@@${t.id}_${ABREV_CHAMP_ENTREE[champ]}@@`;
      if (!resultat.includes(jeton)) return;
      const valeur = valeurs[`${t.id}_${champ}`];
      const repli = champ === 'nom' ? 'Entrée à préciser' : champ === 'titre' ? 'Titre à préciser' : '(non complété automatiquement -- régénérez la fiche)';
      resultat = resultat.split(jeton).join(valeur || repli);
      if (!valeur) {
        avertissements.push(`Axe ${t.axeNumero} (« ${t.axeTitre} ») : le modèle n'a pas fourni ${LIBELLES_CHAMP_ENTREE_LONG[champ]} pour une entrée à compléter automatiquement -- vérifiez cette entrée dans la fiche générée.`);
      }
    });
  });
  return { html: resultat, avertissements };
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

// Blocage explicite AVANT tout appel au modèle (jamais un échec silencieux
// ni une génération libre en repli) -- réutilise le MÊME canal SSE que les
// erreurs de stream (cf. stream.on('error', ...) plus bas) pour que le
// client affiche le message réel (celui-ci lit `json.error`, cf.
// public/index.html) plutôt que le message générique "Erreur serveur" d'une
// réponse HTTP non-ok classique.
function envoyerBlocageSSE(res, message) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  res.write(`data: ${JSON.stringify({ error: message })}\n\n`);
  res.end();
}

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
    // Mode 1 (automatique, Lecture méthodique) sans texte support fourni par
    // l'enseignant : le modèle doit rédiger lui-même le texte support (cf.
    // section "texteSupport" plus bas) -- utilisé aussi pour retrouver le
    // référentiel du type de texte demandé (conformité structurelle exigée).
    let modeAutoLM = false;
    let referentielTypeTexteLM = null;

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
        // reste inchangé et s'applique dès que le plan n'est pas substantiel --
        // et repose désormais sur EXACTEMENT le même mécanisme d'injection
        // (planFourniInjection, quel que soit le mode -- cf. verifierMarqueursPlanEnseignant,
        // extraireCompletionsEntrees, resoudreCompletionsEntrees, injecterDeroulementPlanEnseignant,
        // aucun n'est spécifique à un mode). Référentiel toujours cherché AVEC
        // classe (fusion socle collège) pour les 2 sous-modes -- seul lui
        // permet de nommer, de façon déterministe, les entrées non fournies
        // par l'enseignant (cf. determinerSlotsAxe) ; s'il est absent, la
        // génération est bloquée AVANT tout appel au modèle (changement
        // d'architecture du 07/08, cf. construireMessageBlocageTypeTexteNonCouvert)
        // -- jamais un repli silencieux vers une invention libre.
        referentielTypeTexteLM = trouverReferentielTypeTexte(`${lecon || ''} ${theme || ''}`, classe);
        if (planCoursEstSubstantiel(planCours)) {
          const resultatPlanFourni = construireInstructionsLectureMethodiqueAvecPlanEnseignant(classe, planCours, referentielTypeTexteLM);
          if (resultatPlanFourni.bloque) {
            return envoyerBlocageSSE(res, resultatPlanFourni.messageBlocage);
          }
          systemPrompt += resultatPlanFourni.instructions;
          planFourniInjection = resultatPlanFourni;
          if (resultatPlanFourni.avertissement) {
            avertissementRappel = avertissementRappel ? `${avertissementRappel} ${resultatPlanFourni.avertissement}` : resultatPlanFourni.avertissement;
          }
        } else {
          const resultatAuto = construireInstructionsLectureMethodique(referentielTypeTexteLM, classe);
          if (resultatAuto.bloque) {
            return envoyerBlocageSSE(res, resultatAuto.messageBlocage);
          }
          systemPrompt += resultatAuto.instructions;
          planFourniInjection = resultatAuto;
          modeAutoLM = true;
        }
      } else if (estEE) {
        // Même principe de blocage (07/08) que pour Lecture méthodique : la
        // section "Caractéristiques du texte"/outils de la langue ne doit
        // JAMAIS être une estimation libre du modèle quand le type de texte
        // n'est pas sourcé -- remplace l'ancien avertissement doux par un
        // blocage explicite AVANT tout appel au modèle.
        if (!referentielTypeTexte) {
          return envoyerBlocageSSE(res, construireMessageBlocageTypeTexteNonCouvert());
        }
        systemPrompt += construireInstructionsExpressionEcriture(referentielTypeTexte);
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
    } else if (modeAutoLM) {
      // Mode 1 (Lecture méthodique automatique) sans texte support fourni :
      // le modèle doit en rédiger un lui-même, mais ne le recopie JAMAIS
      // directement à l'endroit du marqueur {{TEXTE_SUPPORT}} (déjà demandé
      // plus haut, résolu automatiquement côté serveur comme pour un texte
      // fourni par l'enseignant) -- il le place dans un bloc d'extraction
      // dédié, pour que la fiche ÉVALUATION (construireConsigneEvaluationReservee,
      // toujours "sur le même texte support") s'appuie garantie sur EXACTEMENT
      // ce même texte, jamais un extrait différent (règle verrouillée du
      // 04/08). referentielTypeTexteLM est non-null ici : bloqué en amont sinon
      // (cf. construireInstructionsLectureMethodique).
      userMessage += `\n\nAucun texte support n'a été fourni par l'enseignant : tu dois toi-même rédiger un texte support ORIGINAL, adapté au niveau ${niveau}, dont la NATURE correspond EXACTEMENT au type de texte « ${referentielTypeTexteLM.typeTexte} » demandé par la leçon (structure et caractéristiques conformes au référentiel déjà utilisé plus haut pour construire les entrées du tableau de vérification -- jamais un autre type de texte). Longueur raisonnable pour occuper une bonne partie d'une page (environ 100 à 220 mots selon le niveau). Place ce texte, et UNIQUEMENT lui (sans titre répété ni commentaire), entre les marqueurs {{TEXTE_SUPPORT_GENERE}} et {{FIN_TEXTE_SUPPORT_GENERE}}, N'IMPORTE OÙ dans ta réponse -- ce bloc sera extrait puis retiré du document final, il ne doit apparaître nulle part ailleurs. NE RECOPIE PAS ce texte à l'endroit du marqueur {{TEXTE_SUPPORT}} (déjà demandé plus haut) : le serveur l'y insérera automatiquement, intégralement, à partir de ce que tu places entre {{TEXTE_SUPPORT_GENERE}} et {{FIN_TEXTE_SUPPORT_GENERE}}.`;
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
      // Contrôle des 3 marqueurs attendus du mode plan-enseignant, AVANT toute
      // injection -- un marqueur omis par le modèle ne doit jamais provoquer
      // une perte de contenu silencieuse (cf. verifierMarqueursPlanEnseignant).
      if (planFourniInjection) {
        for (const avertissementMarqueur of verifierMarqueursPlanEnseignant(contenuHTML, planFourniInjection)) {
          res.write(`data: ${JSON.stringify({ avertissement: avertissementMarqueur })}\n\n`);
        }
      }
      // Exception étroite ligne I (recomposition en phrase, à partir de la
      // 4e) : extrait la phrase rédigée par le modèle AVANT l'injection des
      // marqueurs déterministes, avec repli sûr (texte verbatim) si absente
      // -- jamais un jeton laissé visible, jamais un échec silencieux.
      if (planFourniInjection && planFourniInjection.presentationARecomposer) {
        const { texte: texteRecompose, contenuHTML: contenuNettoye } = extraireEtRetirerRecompositionPresentation(contenuHTML);
        contenuHTML = contenuNettoye;
        const { injection, repliUtilise } = resoudrePresentationRecomposee(planFourniInjection, texteRecompose);
        planFourniInjection = injection;
        if (repliUtilise) {
          res.write(`data: ${JSON.stringify({ avertissement: "La recomposition en phrase(s) de la présentation du texte (ligne I) n'a pas pu être appliquée -- les informations fournies (Titre/Auteur/Source/Nature/Tonalité/Thème) sont affichées telles quelles, sous forme de champs." })}\n\n`);
        }
      }
      // Auto-complétion des entrées du tableau de vérification (axes/entrées
      // non détaillés par l'enseignant, y compris la consigne d'évaluation de
      // l'entrée réservée Axe 2/Entrée 2) : extrait ce que le modèle a rédigé
      // entre les marqueurs dédiés, AVANT l'injection des tableaux déjà
      // construits -- repli sûr + avertissement explicite si le modèle n'a
      // pas fourni un élément (jamais un jeton laissé visible). Un jeton donné
      // ne vivant que dans UN SEUL des 2 blocs (déroulement OU axes, jamais
      // les deux), résoudre séparément chaque bloc ne double jamais un
      // avertissement.
      if (planFourniInjection && planFourniInjection.tachesCompletion && planFourniInjection.tachesCompletion.length) {
        const { contenuHTML: contenuNettoyeCompletion, valeurs } = extraireCompletionsEntrees(contenuHTML, planFourniInjection.tachesCompletion);
        contenuHTML = contenuNettoyeCompletion;
        const resDeroulement = resoudreCompletionsEntrees(planFourniInjection.injectionDeroulement, planFourniInjection.tachesCompletion, valeurs);
        const resAxes = resoudreCompletionsEntrees(planFourniInjection.injectionAxes, planFourniInjection.tachesCompletion, valeurs);
        planFourniInjection = { ...planFourniInjection, injectionDeroulement: resDeroulement.html, injectionAxes: resAxes.html };
        for (const avertissementCompletion of resDeroulement.avertissements.concat(resAxes.avertissements)) {
          res.write(`data: ${JSON.stringify({ avertissement: avertissementCompletion })}\n\n`);
        }
      }
      contenuHTML = injecterDeroulementPlanEnseignant(contenuHTML, planFourniInjection);
      if (estLectureMethodique({ discipline, lecon, theme })) {
        contenuHTML = separerTableauxImbriques(contenuHTML);
      }
      // Mode 1 (Lecture méthodique automatique) sans texte support fourni :
      // extrait le texte rédigé par le modèle (cf. userMessage plus haut)
      // AVANT injecterTexteSupport ci-dessous, pour qu'il soit imprimé en
      // entier dans la fiche exactement comme un texte fourni par
      // l'enseignant -- jamais absent (bug corrigé le 07/08 : auparavant,
      // {{TEXTE_SUPPORT}} n'était résolu par RIEN dans ce cas, cf. `if
      // (!texteSupport) return contenuHTML;` dans injecterTexteSupport).
      if (modeAutoLM && !texteSupport) {
        const { texte: texteSupportGenere, contenuHTML: contenuNettoyeTexteSupport } = extraireEtRetirerTexteSupportGenere(contenuHTML);
        contenuHTML = contenuNettoyeTexteSupport;
        if (texteSupportGenere) {
          texteSupport = texteSupportGenere;
        } else {
          res.write(`data: ${JSON.stringify({ avertissement: "Le modèle n'a pas fourni de texte support généré automatiquement (marqueur {{TEXTE_SUPPORT_GENERE}} absent ou vide) -- aucun texte support n'a pu être imprimé dans la fiche. Régénérez la fiche, ou fournissez vous-même un texte support." })}\n\n`);
        }
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
