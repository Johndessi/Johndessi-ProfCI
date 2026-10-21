# Johndessi-ProfCI

## Bibliothèque de fiches (lot 11)

`fiche_bibliotheque.schema.json` décrit le JSON attendu par `POST /api/admin/fiche-bibliotheque`
(protégé par l'en-tête `x-admin-key` = `ADMIN_SEED_KEY`) ; `fiche_bibliotheque.exemple.json` est un
exemple complet et valide (séance 1, 2nde/Français/Étude de l'œuvre intégrale). `GET
/api/admin/fiche-bibliotheque/liste` (même protection) liste les séances déjà en bibliothèque.
## Catalogue 3e (matrice de progression)

`lecons_officielles_3e.json` remplace les entrées 3e des anciens fichiers de leçons
(`lecons_officielles_5e_4e_3e.json` ne contient plus que la 4e et la 5e). Même format que
les autres catalogues (importé par `POST /api/admin/lecons-officielles/seed`), avec, par séance :

- `typeSupport` : ce que la séance exige de l'enseignant. `texte_obligatoire` (lecture méthodique) :
  génération refusée sans texte collé/importé, sauf bouton « Faire rédiger un texte par ProfCI (à vérifier) »
  (réservé aux textes argumentatifs et articles de journal, mention « à vérifier » dans la fiche) ;
  `texte_a_resumer_obligatoire` (résumés : texte officiel du catalogue ou texte fourni) ; les autres valeurs
  ne bloquent pas.
- `typeTexte` : famille de texte quand elle est univoque (sinon vide ; le détail étayer/réfuter est dans `progression`).
- `themeIntegre` : vide, `liste_10_themes` (menu des 10 thèmes, `catalogue/themes_integres_3e.json`,
  route `GET /api/themes-integres?classe=3ème`) ou identifiant d'un thème imposé.
- `progression` : occurrences de la séance dans la progression annuelle (trimestre, semaine, `S.n`, intitulé,
  variantes). Quand toutes les séances d'une leçon en ont une, le menu Séance est trié par `S.n`
  (ex. Grammaire L5 : S1, S3, S2) ; les numéros `numeroSeance` ne changent jamais.

Les devoirs, comptes rendus de devoir et remédiations ne sont pas des entrées du catalogue : la génération est
refusée avec un message explicite (le programme ne définit aucune structure).
La classe « 3e » / « 3eme » est normalisée en « 3ème » à l'import. `GET /api/admin/classes-3e` (en-tête
`x-admin-key`, lecture seule) compte, par collection, les documents dont la classe commence par 3.

## Service d'aperçu : import des catalogues au démarrage

Sur un service d'essai (base MongoDB **distincte** de la production), définir
`IMPORT_CATALOGUES_AU_DEMARRAGE=1` (valeur exacte) ainsi que `ADMIN_SEED_KEY` : au démarrage, les fichiers
`lecons_officielles_*.json`, `competences_dpfc_*.json` et `competences_par_activite_*.json` du dépôt sont importés
dans la base de `MONGODB_URI` par les routes d'import existantes (upserts, rien n'est supprimé). Sans la variable,
aucun effet. Ne jamais la définir en production : elle réécrirait les catalogues de la base avec ceux du dépôt.
