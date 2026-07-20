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

async function genererPdfDepuisHtml(contenuHTML, landscape) {
  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8">
<style>
  @page { size: A4 ${landscape ? 'landscape' : 'portrait'}; margin: 15mm; }
  * { box-sizing: border-box; }
  body { font-family: Arial, sans-serif; font-size: 11px; color: #000; margin: 0; }
  table { width: 100%; border-collapse: collapse; }
  td, th { border: 1px solid #000; padding: 5px; }
  tr { page-break-inside: avoid; }
</style>
</head><body>${contenuHTML}</body></html>`;

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

function collectRuns($, el, fmt = {}) {
  let runs = [];
  $(el).contents().each((_, child) => {
    if (child.type === 'text') {
      const text = (child.data || '').replace(/\s+/g, ' ');
      if (text.trim() !== '' || text === ' ') {
        runs.push(new TextRun({ text, bold: fmt.bold, italics: fmt.italics, color: fmt.color }));
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
// Alignée sur les 180px de la colonne "grid-template-columns:180px 1fr" utilisée
// dans l'aperçu HTML (180px ≈ 2700 twips), pour éviter qu'une largeur en
// pourcentage (calculée sur la largeur totale de la page, portrait OU paysage)
// ne laisse un grand espace vide après les libellés courts (ex. "Date :").
const ENTETE_LABEL_WIDTH_DXA = 2700;

function buildEnteteTable($, $entete) {
  const champs = $entete.children('div').toArray();
  const rows = [];
  for (let i = 0; i < champs.length; i += 2) {
    const labelEl = champs[i];
    const valueEl = champs[i + 1];
    if (!labelEl) break;
    const labelCell = tableCellFromNode($, labelEl, { forceBold: true, widthDxa: ENTETE_LABEL_WIDTH_DXA });
    const valueCell = valueEl
      ? tableCellFromNode($, valueEl, {})
      : new TableCell({ children: [new Paragraph({})] });
    rows.push(new TableRow({ children: [labelCell, valueCell] }));
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
        if (inner.name === 'h3') {
          elements.push(titrePar($inner.text().trim(), 24));
        } else if (inner.name === 'table') {
          const table = buildDocxTable($, $inner);
          if (table) { elements.push(table); elements.push(new Paragraph({ text: '' })); }
        }
      });
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

// Catalogue des leçons officielles DPFC (numéro + titre + séance officiels),
// keyé par (discipline, classe, sousTheme) — ex. Français/6ème/"objet familier"
// -> Leçon 2 "La description", séance 1. Alimente le champ Leçon de l'entête
// pour Lecture méthodique et Expression écrite, qui affichaient jusqu'ici un
// titre générique inventé au lieu du vrai intitulé du programme.
const LeconOfficielleDPFCSchema = new mongoose.Schema({
  discipline   : String,
  classe       : String,
  sousTheme    : String,
  numeroLecon  : Number,
  titreLecon   : String,
  numeroSeance : Number,
  createdAt    : { type: Date, default: Date.now }
});

const Modele = mongoose.model('Modele', ModeleSchema);
const Fiche  = mongoose.model('Fiche',  FicheSchema);
const ProgressionLecon = mongoose.model('ProgressionLecon', ProgressionLeconSchema);
const CompetenceDPFC = mongoose.model('CompetenceDPFC', CompetenceDPFCSchema);
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

// Recherche la leçon officielle DPFC correspondant à cette discipline/classe
// à partir du sous-thème du texte étudié (déduit de lecon+theme) : correspondance
// insensible casse/accents, l'un des deux textes pouvant contenir l'autre —
// le catalogue lui-même définit les sous-thèmes reconnus, aucune liste de
// mots-clés n'est codée en dur ici.
async function trouverLeconOfficielleDPFC({ discipline, classe, lecon, theme }) {
  const cible = normaliserTexte(`${lecon || ''} ${theme || ''}`);
  if (!cible) return null;
  const candidates = await LeconOfficielleDPFC.find({
    discipline: regexExactInsensible(discipline),
    classe: regexExactInsensible(classe)
  });
  return candidates.find((l) => {
    const sousThemeNorm = normaliserTexte(l.sousTheme);
    return sousThemeNorm && (cible.includes(sousThemeNorm) || sousThemeNorm.includes(cible));
  }) || null;
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

function injecterTexteSupport(contenuHTML, texteSupport) {
  if (!texteSupport) return contenuHTML;
  const texteHtml = texteSupportVersHtml(texteSupport);
  if (!texteHtml) return contenuHTML;

  let resultat;
  if (contenuHTML.includes('{{TEXTE_SUPPORT}}')) {
    resultat = contenuHTML.split('{{TEXTE_SUPPORT}}').join(texteHtml);
  } else {
    // Le modèle a oublié le marqueur : insère une section dédiée juste avant le
    // tableau de déroulement (qui contient les questions), donc en fin de fiche
    // mais avant la partie questions.
    const section = `<div class="texte-support"><h3>Texte support</h3>${texteHtml}</div>\n`;
    const derniereTable = contenuHTML.lastIndexOf('<table');
    resultat = derniereTable !== -1
      ? contenuHTML.slice(0, derniereTable) + section + contenuHTML.slice(derniereTable)
      : contenuHTML + section;
  }

  // Duplication conditionnelle : décidée UNIQUEMENT côté serveur (nombre de mots
  // réel), jamais laissée au jugement du modèle — même si le modèle a inclus le
  // marqueur {{TEXTE_SUPPORT_COPIE}} par erreur pour un texte long, il est retiré ici.
  if (resultat.includes('{{TEXTE_SUPPORT_COPIE}}')) {
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

// Référentiel partagé des caractéristiques langagières par type de texte,
// utilisé à la fois pour les "entrées" du tableau de vérification en Lecture
// méthodique et pour les "Outils de la langue à utiliser" en Expression
// écrite — garantit que les deux activités restent cohérentes sur un même
// type de texte au lieu que chaque fiche invente librement ses propres
// entrées. À compléter progressivement (seuls 4 types couverts pour l'instant).
const REFERENTIEL_TYPES_TEXTE = {
  'texte explicatif': [
    { categorie: 'lexique', description: 'vocabulaire technique/scientifique, champ lexical du phénomène expliqué' },
    { categorie: 'temps_verbaux', description: 'présent de vérité générale (valeur de permanence)' },
    { categorie: 'types_phrases', description: 'phrases déclaratives' },
    { categorie: 'donnees_chiffrees', description: "statistiques, mesures, proportions appuyant l'explication" },
    { categorie: 'connecteurs_logiques', description: "d'abord, ensuite, en effet, au final — articulation causale/chronologique" }
  ],
  'lettre personnelle': [
    { categorie: 'presentation_materielle', description: "en-tête (lieu, date), formule d'appel, corps (introductive/développement/finale), signature" },
    { categorie: 'indices_personne', description: 'pronoms personnels je/tu selon relation expéditeur-destinataire' },
    { categorie: 'registre_langue', description: 'standard ou familier selon la relation' },
    { categorie: 'types_phrases', description: 'déclaratives pour exprimer une certitude/intention' }
  ],
  'portrait': [
    { categorie: 'lexique', description: 'vocabulaire évaluatif (appréciatif/dépréciatif), champs lexicaux physiques/moraux' },
    { categorie: 'images', description: 'comparaisons' },
    { categorie: 'temps_verbaux', description: "imparfait et présent de l'indicatif (effet de réalisme)" },
    { categorie: 'adjectifs', description: 'adjectifs qualificatifs' },
    { categorie: 'verbes', description: "verbes d'état" },
    { categorie: 'structure', description: 'introduction / développement / conclusion' }
  ],
  'texte descriptif (objet)': [
    { categorie: 'lexique', description: 'champ lexical du luxe/de la richesse ou du thème valorisé selon l\'objet' },
    { categorie: 'adjectifs', description: 'adjectifs qualificatifs valorisants' },
    { categorie: 'enumeration', description: 'énumération organisée (spatiale : extérieur→intérieur, haut→bas)' },
    { categorie: 'procedes_stylistiques', description: "exclamations, apostrophe, hyperbole selon l'effet recherché" }
  ]
};

// Recherche insensible à la casse/accents : correspondance exacte d'abord,
// puis correspondance partielle (l'un des deux textes contient l'autre) —
// permet à un enseignant de taper juste "Portrait" ou "texte descriptif"
// sans connaître la clé exacte du référentiel.
function trouverReferentielTypeTexte(typeTexteDemande) {
  const cible = normaliserTexte(typeTexteDemande);
  if (!cible) return null;
  const cles = Object.keys(REFERENTIEL_TYPES_TEXTE);
  const exact = cles.find((cle) => normaliserTexte(cle) === cible);
  if (exact) return { typeTexte: exact, caracteristiques: REFERENTIEL_TYPES_TEXTE[exact] };
  const partiel = cles.find((cle) => {
    const cleNorm = normaliserTexte(cle);
    // retire les qualificatifs entre parenthèses (ex. "texte descriptif (objet)" ->
    // "texte descriptif") pour matcher même quand l'enseignant ne les précise pas.
    const cleCoeur = cleNorm.replace(/\s*\([^)]*\)\s*/g, ' ').trim();
    return cleNorm.includes(cible) || cible.includes(cleNorm) || cible.includes(cleCoeur);
  });
  return partiel ? { typeTexte: partiel, caracteristiques: REFERENTIEL_TYPES_TEXTE[partiel] } : null;
}

function formaterCaracteristiquesReferentiel(caracteristiques) {
  return caracteristiques.map((c) => `- ${c.categorie} : ${c.description}`).join('\n');
}

const HABILETES_LECTURE_METHODIQUE = `  <tr><td style="border:1px solid #000;padding:6px;">Connaître</td><td style="border:1px solid #000;padding:6px;">le thème étudié</td></tr>
  <tr><td style="border:1px solid #000;padding:6px;">Identifier</td><td style="border:1px solid #000;padding:6px;">les outils de la langue pertinents / les champs lexicaux liés au thème</td></tr>
  <tr><td style="border:1px solid #000;padding:6px;">Analyser</td><td style="border:1px solid #000;padding:6px;">les procédés utilisés (choix lexicaux, temps verbaux, types de phrases, figures de style...)</td></tr>
  <tr><td style="border:1px solid #000;padding:6px;">Interpréter</td><td style="border:1px solid #000;padding:6px;">les effets produits sur le lecteur par ces procédés</td></tr>
  <tr><td style="border:1px solid #000;padding:6px;">Appliquer</td><td style="border:1px solid #000;padding:6px;">la démarche de la lecture méthodique</td></tr>`;

function construireInstructionsLectureMethodique(referentiel) {
  const consigneEntrees = referentiel
    ? `Les « entrées » possibles pour les 2 tableaux d'axes sont IMPOSÉES par le référentiel du type de texte « ${referentiel.typeTexte} » ci-dessous — pioche EXCLUSIVEMENT dans ces catégories (tu peux n'en utiliser qu'une partie selon les 2 axes retenus, mais n'en invente AUCUNE en dehors de cette liste) :\n${formaterCaracteristiquesReferentiel(referentiel.caracteristiques)}\n\nLes relevés précis (citations, exemples tirés du texte) restent bien sûr propres à CE texte : seules les catégories/étiquettes des « entrées » sont fixées par le référentiel.`
    : `Aucun référentiel de caractéristiques n'est disponible pour ce type de texte précis : détermine les « entrées » les plus pertinentes toi-même, à partir d'une analyse rigoureuse du texte.`;

  return `

STRUCTURE OBLIGATOIRE SPÉCIFIQUE — LECTURE MÉTHODIQUE (cette fiche est une lecture méthodique : les instructions ci-dessous REMPLACENT intégralement, pour CETTE fiche uniquement, le tableau Habiletés/Contenus générique, la structure du DÉVELOPPEMENT et le contenu de l'ÉVALUATION décrits plus haut. L'entête, la Situation d'apprentissage et les Supports didactiques/Bibliographie restent inchangés. La ligne PRÉSENTATION rituelle du début de séance reste aussi inchangée dans sa structure, SAUF la contrainte suivante :) :

CONTRAINTE SUR LA LIGNE PRÉSENTATION RITUELLE (avant "I. Présentation du texte") : cette phase d'accueil ne doit JAMAIS révéler le thème précis du texte étudié, ni aucune conclusion, idée ou information tirée de son contenu. Reste strictement générique (ex. « un texte que nous allons découvrir ensemble », « la leçon du jour »). En particulier, les étapes (h) Identification de la notion à partir de la situation et (i) Annonce du titre officiel de la leçon ne doivent mentionner QUE le titre officiel de la leçon/l'activité (ex. « La description »), jamais le sujet précis du texte qui sera étudié (ex. jamais « nous allons étudier un texte sur un avion »). La découverte du thème se fait UNIQUEMENT via le questionnement guidé de la phase I ci-dessous.

TABLEAU HABILETÉS ET CONTENUS — formule FIXE ci-dessous, obligatoire pour toute lecture méthodique, NE JAMAIS la réinventer ni l'adapter au texte :
${HABILETES_LECTURE_METHODIQUE}

DÉVELOPPEMENT — remplace la règle "ligne Développement unique" : utilise OBLIGATOIREMENT 4 lignes numérotées I à IV dans le tableau DÉROULEMENT (jamais moins, jamais plus), chacune avec les 5 colonnes standard (Moments didactiques/Durée | Stratégies pédagogiques/Plan du cours | Activités de l'enseignant | Activités des élèves | Traces écrites) :

I. PRÉSENTATION (du texte, distincte de la ligne PRÉSENTATION rituelle du début de séance) — uniquement sous forme de QUESTIONS-RÉPONSES, jamais de texte narratif :
   - Quel est le titre du texte ? Quelle est la source/l'édition ? Qui est l'auteur (si applicable) ? → à partir de ces réponses, rédige la présentation en Traces écrites (1 à 2 phrases seulement).
   - Lecture silencieuse : question ouverte « De quoi peut-il s'agir ? »
   - Lecture magistrale, puis questions : Quelle est la nature du texte ? Quelle est sa tonalité ? Quel est son thème ?

II. HYPOTHÈSE GÉNÉRALE — UNE SEULE phrase, dérivée EXPLICITEMENT de la nature + la tonalité + le thème identifiés en I. Ne la donne JAMAIS d'emblée : présente-la comme la synthèse/déduction des réponses précédentes (question du type « À partir de ce que nous venons d'identifier, quelle hypothèse pouvons-nous formuler sur ce texte ? »).

III. VÉRIFICATION DE L'HYPOTHÈSE GÉNÉRALE :
   1. Détermination des axes de lecture : EXACTEMENT 2 axes (jamais 3, jamais 4), obtenus en décomposant l'hypothèse générale en ses deux composantes.
   2. Dans la ligne III du tableau DÉROULEMENT, la colonne Traces écrites contient UNIQUEMENT du texte simple (jamais de tableau) : le libellé des 2 axes (ex. "Axe 1 : ... / Axe 2 : ..."). Les Activités de l'enseignant/des élèves de cette ligne portent le questionnement guidé qui permet de dégager ces axes.
   3. Pour CHAQUE axe, un tableau à 4 colonnes (Entrées | Indices textuels (Relevés/Repérage) | Analyses | Interprétations) rempli PAR QUESTIONNEMENT GUIDÉ (chaque ligne correspond à une « entrée » avec des relevés précis tirés du texte, l'analyse du procédé, et l'interprétation de son effet). ${consigneEntrees} CES 2 TABLEAUX SONT DES ÉLÉMENTS AUTONOMES DU DOCUMENT HTML, PLACÉS APRÈS LE TABLEAU DÉROULEMENT COMPLET (donc en dehors de toute balise <td>/<th>) — JAMAIS imbriqués à l'intérieur d'une cellule d'un autre tableau (rendu illisible en Word/PDF : colonnes écrasées, texte compressé). Un tableau HTML ne doit JAMAIS contenir un autre tableau HTML dans une de ses cellules, nulle part dans la fiche.

IV. BILAN GÉNÉRAL :
   - Question de synthèse : « Quels éléments de la langue/du texte ont permis d'étudier ce texte ? »
   - Confrontation EXPLICITE hypothèse/bilan, avec la formule EXACTE : « Notre hypothèse générale est donc vérifiée. »
   - Optionnel : une question d'ouverture ou d'avis personnel.

ÉVALUATION (ligne distincte du tableau DÉROULEMENT, différente et SÉPARÉE du Bilan général — ne jamais fusionner les deux) :
   - Fournis un relevé NEUF, non exploité dans le corps de la fiche (nouvelles citations du MÊME texte, non analysées plus haut dans les axes).
   - Demande à l'élève, SEUL : 1) d'identifier l'entrée correspondante, 2) d'analyser, 3) d'interpréter.
   - INTERDICTION ABSOLUE de remplacer ceci par des questions de compréhension du texte (ex. « qui est le narrateur ? », « que ressent-il ? ») : l'évaluation teste la maîtrise de la MÉTHODE de lecture méthodique, pas la compréhension du contenu.`;
}

function construireInstructionsExpressionEcriture(referentiel) {
  if (!referentiel) return '';
  return `

OUTILS DE LA LANGUE À UTILISER — section obligatoire pour cette fiche d'Expression écrite (type de texte détecté : « ${referentiel.typeTexte} »). Insère dans la fiche une section/tableau intitulé « Outils de la langue à utiliser » qui liste EXACTEMENT les catégories suivantes (ni plus, ni moins, ne pas en inventer d'autres), chacune reformulée en une consigne concrète adaptée au thème précis de la leçon :
${formaterCaracteristiquesReferentiel(referentiel.caracteristiques)}`;
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
<div class="entete-libre" style="display:grid;grid-template-columns:180px 1fr;column-gap:16px;row-gap:2px;margin-bottom:14px;">
  <div style="font-weight:bold;padding:2px 0;">Discipline :</div><div style="padding:2px 0;">{{discipline}}</div>
  <div style="font-weight:bold;padding:2px 0;">Date :</div><div style="padding:2px 0;"></div>
  <div style="font-weight:bold;padding:2px 0;">Classe :</div><div style="padding:2px 0;">{{classe}}</div>
  <div style="font-weight:bold;padding:2px 0;">Compétence :</div><div style="padding:2px 0;">{{competence}}</div>
  <div style="font-weight:bold;padding:2px 0;">Activité :</div><div style="padding:2px 0;">{{activite}}</div>
  <div style="font-weight:bold;padding:2px 0;">Durée :</div><div style="padding:2px 0;">{{duree}}</div>
  <div style="font-weight:bold;padding:2px 0;">Leçon :</div><div style="padding:2px 0;">{{lecon}}</div>
  <div style="font-weight:bold;padding:2px 0;">Séance n° :</div><div style="padding:2px 0;">{{seance}}</div>
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
    <div class="entete-libre" style="display:grid;grid-template-columns:180px 1fr;column-gap:16px;row-gap:2px;">
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
      const sousTheme = (item && item.sousTheme || '').toString().trim();
      const numeroLecon = item && item.numeroLecon != null ? parseInt(item.numeroLecon, 10) : NaN;
      const titreLecon = (item && item.titreLecon || '').toString().trim();
      const numeroSeance = item && item.numeroSeance != null ? parseInt(item.numeroSeance, 10) : NaN;
      if (!discipline || !classe || !sousTheme || !Number.isFinite(numeroLecon) || !titreLecon || !Number.isFinite(numeroSeance)) {
        ignores++; continue;
      }

      await LeconOfficielleDPFC.findOneAndUpdate(
        { discipline, classe, sousTheme },
        { discipline, classe, sousTheme, numeroLecon, titreLecon, numeroSeance },
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
    const { discipline, classe, lecon, theme } = req.query;
    if (!discipline || !classe) {
      return res.status(400).json({ error: 'discipline et classe requis' });
    }
    const resultat = await trouverLeconOfficielleDPFC({ discipline, classe, lecon, theme });
    res.json(resultat);
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
      theme = '', planCours = '', approche = 'APC'
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

    if (niveau !== 'primaire') {
      const estLM = estLectureMethodique({ discipline, lecon, theme });
      const estEE = estExpressionEcrite({ discipline, lecon, theme });
      const referentielTypeTexte = trouverReferentielTypeTexte(`${lecon || ''} ${theme || ''}`);

      if (estLM) {
        systemPrompt += construireInstructionsLectureMethodique(referentielTypeTexte);
      } else if (estEE) {
        if (referentielTypeTexte) {
          systemPrompt += construireInstructionsExpressionEcriture(referentielTypeTexte);
        } else {
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
        const leconOfficielle = await trouverLeconOfficielleDPFC({ discipline: 'Français', classe, lecon, theme });
        if (leconOfficielle) {
          systemPrompt += `\n\nLEÇON OFFICIELLE DPFC : Leçon ${leconOfficielle.numeroLecon} : ${leconOfficielle.titreLecon}\n\nUtilise EXACTEMENT ce texte dans le champ Leçon de l'entête (format "Leçon N : Titre"), sans reformulation ni titre alternatif inventé.`;
          const seanceNumIndicatif = parseInt(seance, 10);
          if (Number.isFinite(seanceNumIndicatif) && seanceNumIndicatif !== leconOfficielle.numeroSeance) {
            const avertissementSeance = `La séance officielle DPFC pour ce sous-thème est la séance ${leconOfficielle.numeroSeance}, mais la séance ${seanceNumIndicatif} a été indiquée — vérifie le numéro de séance.`;
            avertissementRappel = avertissementRappel ? `${avertissementRappel} ${avertissementSeance}` : avertissementSeance;
          }
        } else {
          systemPrompt += `\n\nLEÇON OFFICIELLE DPFC : NON DISPONIBLE (aucune correspondance dans le catalogue pour cette discipline/classe/sous-thème). Dans le champ Leçon de l'entête, écris EXACTEMENT le texte suivant, sans inventer de titre, même plausible : "Titre de leçon officiel non disponible — vérifier avec la progression papier".`;
          const avertissementLecon = `Aucune leçon officielle DPFC trouvée dans le catalogue pour cette discipline/classe/sous-thème — le champ Leçon affiche un message à compléter manuellement avec la progression papier.`;
          avertissementRappel = avertissementRappel ? `${avertissementRappel} ${avertissementLecon}` : avertissementLecon;
        }
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

      if (competenceNonDisponible({ discipline, classe })) {
        raisonIndisponible = 'aucun document DPFC officiel publié à ce jour pour cette discipline/classe';
      } else {
        const competencesOfficielles = await trouverCompetencesDPFC({ discipline, classe });
        if (competencesOfficielles.length === 0) {
          raisonIndisponible = 'cette discipline/classe n\'est pas encore couverte par le catalogue de compétences officielles';
        } else if (competencesOfficielles.length === 1) {
          competenceResolue = competencesOfficielles[0];
        } else {
          // Plusieurs compétences existent pour cette discipline/classe : on ne peut
          // choisir la bonne QUE si le catalogue de leçons indique explicitement à
          // quelle compétence cette leçon précise appartient (ProgressionLecon.competenceNumero).
          // Laisser le modèle "deviner" parmi la liste a déjà produit une compétence
          // hallucinée (ni le bon numéro, ni le bon libellé) : c'est donc interdit.
          const progressionPourCompetence = await trouverProgressionLecon({ discipline, classe, lecon });
          const numeroCible = progressionPourCompetence && Number.isFinite(progressionPourCompetence.competenceNumero)
            ? progressionPourCompetence.competenceNumero
            : null;
          const match = numeroCible != null ? competencesOfficielles.find((c) => c.numero === numeroCible) : null;
          if (match) {
            competenceResolue = match;
          } else {
            raisonIndisponible = 'plusieurs compétences officielles existent pour cette discipline/classe mais aucune n\'est reliée à cette leçon précise dans le catalogue';
          }
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

    if (texteSupport) {
      const motsTexteSupport = compterMots(texteSupport);
      const instructionDuplication = texteSupportDoitEtreDuplique(texteSupport)
        ? `Ce texte support fait environ ${motsTexteSupport} mots : assez court pour tenir deux fois sur la même page. Immédiatement APRÈS le marqueur {{TEXTE_SUPPORT}}, ajoute le marqueur exact {{TEXTE_SUPPORT_COPIE}} pour insérer un second exemplaire en police réduite (permet à l'enseignant de photocopier une seule feuille et distribuer deux exemplaires, économie de papier).`
        : `Ce texte support fait environ ${motsTexteSupport} mots : trop long pour être dupliqué sur la même page. N'ajoute PAS de second exemplaire — utilise UNIQUEMENT le marqueur {{TEXTE_SUPPORT}}, une seule fois, sans {{TEXTE_SUPPORT_COPIE}}.`;
      userMessage += `\n\nVoici le texte support fourni par l'enseignant. Construis le déroulement pédagogique (moments didactiques, questions de compréhension, schéma argumentatif ou axes de lecture selon la discipline) à partir de ce texte. NE RECOPIE PAS le texte dans ta réponse — utilise le marqueur exact {{TEXTE_SUPPORT}} à l'endroit où le texte doit apparaître dans le HTML. ${instructionDuplication}\n\nTEXTE SUPPORT (à lire, ne pas recopier) :\n${texteSupport}`;
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
      if (estLectureMethodique({ discipline, lecon, theme })) {
        contenuHTML = separerTableauxImbriques(contenuHTML);
      }
      contenuHTML = injecterTexteSupport(contenuHTML, texteSupport);
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
