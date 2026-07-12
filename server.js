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
    if (['pdf', 'doc', 'docx'].includes(ext)) return cb(null, true);
    cb(new Error('Format non supporté (PDF, DOC, DOCX uniquement)'));
  }
});

function uploadModeleFichier(req, res, next) {
  upload.single('fichier')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    next();
  });
}

async function extraireTexteFichier(file) {
  const ext = file.originalname.split('.').pop().toLowerCase();
  if (ext === 'pdf') {
    const data = await pdfParse(file.buffer);
    return data.text;
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
    if (cells.length) rows.push(new TableRow({ children: cells, tableHeader: $(tr).children('th').length > 0 }));
  }

  if (!rows.length) return null;
  return new Table({ rows, width: { size: 100, type: WidthType.PERCENTAGE }, borders: DOCX_BORDERS });
}

function buildEnteteTable($, $entete) {
  const champs = $entete.children('div').toArray();
  const rows = [];
  for (let i = 0; i < champs.length; i += 2) {
    const labelEl = champs[i];
    const valueEl = champs[i + 1];
    if (!labelEl) break;
    const labelCell = tableCellFromNode($, labelEl, { forceBold: true, widthPct: 30 });
    const valueCell = valueEl
      ? tableCellFromNode($, valueEl, { widthPct: 70 })
      : new TableCell({ children: [new Paragraph({})], width: { size: 70, type: WidthType.PERCENTAGE } });
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
  createdAt    : { type: Date, default: Date.now }
});

const ProgressionLeconSchema = new mongoose.Schema({
  discipline    : String,
  classe        : String,
  lecon         : String,
  nombreSeances : Number,
  ordre         : Number,
  createdAt     : { type: Date, default: Date.now }
});

const Modele = mongoose.model('Modele', ModeleSchema);
const Fiche  = mongoose.model('Fiche',  FicheSchema);
const ProgressionLecon = mongoose.model('ProgressionLecon', ProgressionLeconSchema);

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

const PROMPT_SECONDAIRE = `Tu es un expert en pédagogie ivoirienne (APC/DPFC).
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
  <!-- lignes avec verbes taxonomiques : Identifier, Reconnaître, Connaître, Analyser, Appliquer, Produire -->
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
  <tr>
    <td style="border:1px solid #000;padding:6px;font-weight:bold;vertical-align:top;">PRÉSENTATION<br>(5 mn)</td>
    <td style="border:1px solid #000;padding:6px;vertical-align:top;">[stratégie : questions-réponses, procédé interrogatif...]</td>
    <td style="border:1px solid #000;padding:6px;vertical-align:top;">« Bonjour la classe » / « Bonjour les élèves », PUIS questions précises de rappel des prérequis</td>
    <td style="border:1px solid #000;padding:6px;vertical-align:top;">Réponse d'accueil des élèves, PUIS réponses attendues aux questions de rappel</td>
    <td style="border:1px solid #000;padding:6px;vertical-align:top;">[activité/leçon/séance]</td>
  </tr>
  <!-- DÉVELOPPEMENT : UNE SEULE LIGNE pour toute la phase (jamais une ligne par point). À l'intérieur de cette ligne, numérote chaque question de la colonne "Activités de l'enseignant" par sous-point du plan : I-1, I-2, II-1, II-2, III-1... Dans "Activités des élèves", fais suivre les réponses EXACTEMENT dans le même ordre et avec la même numérotation, une réponse par paragraphe, à la même position que sa question. Dans "Traces écrites", même numérotation, même ordre : chaque sous-point y a sa trace écrite. Le numéro (I-1, I-2...) permet de relier question / réponse / trace écrite à la même position dans les trois colonnes, sans lignes séparées. -->
  <tr>
    <td style="border:1px solid #000;padding:6px;font-weight:bold;vertical-align:top;">DÉVELOPPEMENT<br>(35-40 mn)</td>
    <td style="border:1px solid #000;padding:6px;vertical-align:top;">[plan détaillé : I- ... II- ... III- ...]</td>
    <td style="border:1px solid #000;padding:6px;vertical-align:top;">I-1) [question]<br>I-2) [question]<br>II-1) [question]<br>II-2) [question]<br>...</td>
    <td style="border:1px solid #000;padding:6px;vertical-align:top;">I-1) [réponse]<br>I-2) [réponse]<br>II-1) [réponse]<br>II-2) [réponse]<br>...</td>
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
- Verbes taxonomiques de Bloom : Identifier, Reconnaître, Connaître, Analyser, Appliquer, Produire
- Pour chaque question posée par l'enseignant dans la colonne Activités de l'enseignant, formule-la EN PRIORITÉ avec un verbe taxonomique de Bloom (Identifie, Nomme, Cite, Définis, Explique, Compare, Analyse, Applique, Résous, Produis...). N'utilise des questions ouvertes ou situationnelles qu'en complément, après la question taxonomique principale.
- Si le champ Séance n° est supérieur à 1 pour la même leçon, la PRÉSENTATION doit obligatoirement inclure un rappel explicite (question de l'enseignant + réponse attendue + trace écrite) du contenu vu à la ou les séance(s) précédente(s) de cette leçon, avant d'entamer le contenu nouveau.
- Toujours 3 phases = 3 lignes du tableau : Présentation / Développement / Évaluation. La ligne Développement est UNIQUE (jamais une ligne par point) : les sous-points I-1, I-2, II-1... sont des paragraphes à l'intérieur de la même ligne, alignés à la même position dans les colonnes Activités de l'enseignant / Activités des élèves / Traces écrites`;

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
      <!-- DÉVELOPPEMENT : UNE SEULE LIGNE pour toute la phase (jamais une ligne par point). À l'intérieur de cette ligne, numérote chaque question de "Activités du maître" par sous-point : I-1, I-2, II-1, II-2... Dans "Activités des élèves", fais suivre les réponses EXACTEMENT dans le même ordre et la même numérotation, une réponse par paragraphe, à la même position que sa question. Dans "Observations", même numérotation pour la trace écrite de chaque sous-point. -->
      <tr>
        <td>DÉVELOPPEMENT<br>(X mn)</td>
        <td>I-1) [question]<br>I-2) [question]<br>II-1) [question]<br>...</td>
        <td>I-1) [réponse]<br>I-2) [réponse]<br>II-1) [réponse]<br>...</td>
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

app.post('/api/admin/progressions/seed', async (req, res) => {
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

      const donnees = { discipline, classe, lecon };
      if (Number.isFinite(nombreSeances)) donnees.nombreSeances = nombreSeances;
      if (Number.isFinite(ordre)) donnees.ordre = ordre;

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

 app.post('/api/generer-fiche', async (req, res) => {
  console.log('📩 Requête reçue:', req.body.discipline, req.body.classe, req.body.lecon);
  try {
    const {
      enseignantId, niveau = 'secondaire', discipline,
      classe, lecon, seance = '1', duree = '1 heure',
      theme = '', planCours = ''
    } = req.body;

    let modelePersonnel = null;
    if (enseignantId) {
      modelePersonnel = await Modele.findOne({ enseignantId, niveau });
    }

    let systemPrompt = niveau === 'primaire' ? PROMPT_PRIMAIRE : PROMPT_SECONDAIRE;

    let avertissementRappel = null;
    const seanceNum = parseInt(seance, 10);
    if (Number.isFinite(seanceNum) && seanceNum > 1) {
      const fichesPrecedentes = await trouverFichesPrecedentes({ enseignantId, discipline, classe, lecon, niveau, seance });
      if (fichesPrecedentes.length) {
        const resume = resumerSeancesPrecedentes(fichesPrecedentes);
        systemPrompt += `\n\nCONTENU RÉEL DES SÉANCES PRÉCÉDENTES DE CETTE LEÇON :\n${resume}\n\nBase le rappel de la PRÉSENTATION EXCLUSIVEMENT sur ce contenu réel ci-dessus (questions, réponses, traces écrites déjà vues), PAS sur une supposition.`;
      } else {
        avertissementRappel = "Aucune fiche de séance précédente trouvée pour cette leçon — le rappel généré est une estimation, vérifie-le.";
      }
    }

    if (Number.isFinite(seanceNum)) {
      const progression = await trouverProgressionLecon({ discipline, classe, lecon });
      if (progression && Number.isFinite(progression.nombreSeances) && seanceNum > progression.nombreSeances) {
        const avertissementDepassement = `Cette leçon officielle compte normalement ${progression.nombreSeances} séances — vérifie ton numéro de séance.`;
        avertissementRappel = avertissementRappel ? `${avertissementRappel} ${avertissementDepassement}` : avertissementDepassement;
      }
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
      const fiche = await Fiche.create({
        enseignantId: enseignantId || 'anonyme',
        discipline, classe, lecon, seance, duree, niveau,
        contenu: contenuHTML
      });
      res.write(`data: ${JSON.stringify({ done: true, ficheId: fiche._id })}\n\n`);
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
