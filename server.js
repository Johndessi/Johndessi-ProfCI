const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static('public'));

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

const Modele = mongoose.model('Modele', ModeleSchema);
const Fiche  = mongoose.model('Fiche',  FicheSchema);

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const PROMPT_SECONDAIRE = `Tu es un expert en pédagogie ivoirienne (APC - Approche Par Compétences, DPFC).
Tu génères des fiches de cours COMPLÈTES au format officiel utilisé dans les lycées et collèges de Côte d'Ivoire.

FORMAT OBLIGATOIRE D'UNE FICHE DE COURS SECONDAIRE (HTML) :

<div class="fiche-cours">
  <div class="entete">
    <h2>FICHE DE COURS</h2>
    <table class="entete-table">
      <tr><td>Discipline</td><td>{{discipline}}</td><td>Classe</td><td>{{classe}}</td></tr>
      <tr><td>Compétence</td><td colspan="3">{{competence}}</td></tr>
      <tr><td>Activité</td><td>{{activite}}</td><td>Durée</td><td>{{duree}}</td></tr>
      <tr><td>Leçon n°</td><td>{{lecon}}</td><td>Séance n°</td><td>{{seance}}</td></tr>
    </table>
  </div>

  <div class="habiletes">
    <h3>Tableau des habiletés et contenus</h3>
    <table class="habiletes-table">
      <tr><th>Habiletés</th><th>Contenus</th></tr>
    </table>
  </div>

  <div class="situation">
    <h3>Situation d'apprentissage</h3>
    <p></p>
  </div>

  <div class="supports">
    <h3>Supports didactiques</h3>
    <ul></ul>
    <h3>Bibliographie</h3>
    <ul></ul>
  </div>

  <div class="deroulement">
    <h3>Déroulement de la séance</h3>
    <table class="deroulement-table">
      <tr>
        <th>Moments didactiques / Durée</th>
        <th>Stratégies pédagogiques</th>
        <th>Activités de l'enseignant</th>
        <th>Activités des élèves</th>
        <th>Traces écrites</th>
      </tr>
    </table>
  </div>
</div>

RÈGLES :
- Utilise les verbes taxonomiques de Bloom adaptés CI : Identifier, Reconnaître, Connaître, Appliquer, Analyser, Produire, Évaluer
- La situation d'apprentissage doit être ancrée dans le quotidien ivoirien
- Le déroulement doit être DÉTAILLÉ : questions précises de l'enseignant + réponses attendues des élèves + traces écrites complètes
- Les traces écrites = le contenu réel du cours (définitions, règles, exemples)
- Réponds UNIQUEMENT en HTML, sans markdown, sans explication`;

const PROMPT_PRIMAIRE = `Tu es un expert en pédagogie ivoirienne pour l'enseignement primaire.
Tu génères des fiches de leçon COMPLÈTES au format utilisé dans les écoles primaires de Côte d'Ivoire.

FORMAT PRIMAIRE :

<div class="fiche-cours primaire">
  <div class="entete">
    <h2>FICHE DE LEÇON</h2>
    <table class="entete-table">
      <tr><td>École</td><td>{{ecole}}</td><td>Classe</td><td>{{classe}}</td></tr>
      <tr><td>Matière</td><td>{{discipline}}</td><td>Effectif</td><td>{{effectif}}</td></tr>
      <tr><td>Thème</td><td>{{theme}}</td><td>Durée</td><td>{{duree}}</td></tr>
      <tr><td>Leçon</td><td colspan="3">{{lecon}}</td></tr>
      <tr><td>Objectifs pédagogiques</td><td colspan="3"></td></tr>
      <tr><td>Matériel</td><td colspan="3"></td></tr>
    </table>
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
    </table>
  </div>
</div>

RÈGLES :
- Langage simple, adapté à l'âge (primaire CP1-CM2)
- Objectifs avec verbes d'action : nommer, lire, écrire, calculer, tracer, colorier, distinguer...
- Activités concrètes, manipulatoires, ludiques
- Ancrage dans le quotidien ivoirien (marchés, villages, saisons, fruits locaux...)
- Réponds UNIQUEMENT en HTML, sans markdown, sans explication`;

app.get('/ping', (_, res) => res.json({ status: 'ok', app: 'Prof CI' }));

app.post('/api/upload-modele', async (req, res) => {
  try {
    const { enseignantId, niveau, structureModele } = req.body;
    if (!structureModele) return res.status(400).json({ error: 'Modèle vide' });

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
      enseignantId,
      niveau = 'secondaire',
      discipline,
      classe,
      lecon,
      seance = '1',
      duree = '1 heure',
      theme = '',
      planCours = ''
    } = req.body;

    let modelePersonnel = null;
    if (enseignantId) {
      console.log('🔍 Recherche modèle pour:', enseignantId, niveau);
      modelePersonnel = await Modele.findOne({ enseignantId, niveau });
      console.log('🔍 Modèle trouvé:', !!modelePersonnel);
    }

    const systemPrompt = niveau === 'primaire' ? PROMPT_PRIMAIRE : PROMPT_SECONDAIRE;

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

    console.log('🤖 Appel Anthropic en cours...');
    const startTime = Date.now();

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 4000,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }]
    });

    console.log('✅ Réponse Anthropic reçue en', Date.now() - startTime, 'ms');

    const contenuHTML = response.content[0].text;
    console.log('📄 Longueur HTML généré:', contenuHTML.length);

    const fiche = await Fiche.create({
      enseignantId: enseignantId || 'anonyme',
      discipline, classe, lecon, seance, duree, niveau,
      contenu: contenuHTML
    });

    console.log('💾 Fiche sauvegardée:', fiche._id);

    res.json({ success: true, ficheId: fiche._id, contenu: contenuHTML });
  } catch (e) {
    console.error('❌ ERREUR COMPLETE:', e);
    console.error('❌ Message:', e.message);
    console.error('❌ Stack:', e.stack);
    res.status(500).json({ error: e.message, details: e.toString() });
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

app.get('*', (_, res) => res.sendFile('index.html', { root: 'public' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🎓 Prof CI démarré sur le port ${PORT}`));
