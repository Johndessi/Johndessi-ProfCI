# Johndessi-ProfCI

## Bibliothèque de fiches (lot 11)

`fiche_bibliotheque.schema.json` décrit le JSON attendu par `POST /api/admin/fiche-bibliotheque`
(protégé par l'en-tête `x-admin-key` = `ADMIN_SEED_KEY`) ; `fiche_bibliotheque.exemple.json` est un
exemple complet et valide (séance 1, 2nde/Français/Étude de l'œuvre intégrale). `GET
/api/admin/fiche-bibliotheque/liste` (même protection) liste les séances déjà en bibliothèque.
## Catalogue 3e (matrice de progression)

`lecons_officielles_3e.json` remplace les entrées 3e des anciens fichiers de leçons
(`lecons_officielles_5e_4e_3e.json` ne contient plus que la 5e). Même format que
les autres catalogues (importé par `POST /api/admin/lecons-officielles/seed`), avec, par séance :

- `typeSupport` : ce que la séance exige de l'enseignant. `texte_obligatoire` (lecture méthodique) :
  génération refusée sans texte collé/importé, sauf bouton « Faire rédiger un texte par ProfCI (à vérifier) »
  (réservé, selon la classe, aux textes non littéraires : 3ème = texte argumentatif et article de journal ; 4ème = texte explicatif
  et dialogue argumentatif ; mention « à vérifier » dans la fiche) ;
  `texte_a_resumer_obligatoire` (résumés : texte officiel du catalogue ou texte fourni) ; les autres valeurs
  ne bloquent pas.
- `typeTexte` : famille de texte quand elle est univoque (sinon vide ; le détail étayer/réfuter est dans `progression`).
- `themeIntegre` : vide, `liste_10_themes` (menu des 10 thèmes, `catalogue/themes_integres_3e.json`,
  route `GET /api/themes-integres?classe=3ème`) ou identifiant d'un thème imposé.
- `progression` : occurrences de la séance dans la progression annuelle (trimestre, semaine, `S.n`, intitulé,
  variantes). Quand toutes les séances d'une leçon en ont une, le menu Séance est trié par `S.n`
  (sans effet quand les numéros suivent déjà la progression, comme Grammaire 3e L5 : 1 adverbe, 2 groupe adverbial, 3 comparatif).

Les devoirs, comptes rendus de devoir et remédiations ne sont pas des entrées du catalogue : la génération est
refusée avec un message explicite (le programme ne définit aucune structure).
La classe « 3e » / « 3eme » est normalisée en « 3ème » à l'import. `GET /api/admin/classes-3e` (en-tête
`x-admin-key`, lecture seule) compte, par collection, les documents dont la classe commence par 3.

## Catalogue 4e (matrice de progression)

`lecons_officielles_4e.json` regroupe toute la 4ème (Grammaire, Orthographe, Expression orale, Lecture méthodique,
Expression écrite) et remplace `lecons_officielles_4e_grammaire_orthographe_oral.json` ainsi que les entrées 4ème de
`lecons_officielles_5e_4e_3e.json`. Même format et mêmes champs que la 3ème. La liste « liste_10_themes » de la 4ème est
celle de la 3ème (`catalogue/themes_integres_3e.json`), à confirmer. Les devoirs, comptes rendus de devoir et
évaluations d'orthographe/orales de la matrice ne sont pas des entrées du catalogue. L'œuvre intégrale n'est pas concernée
(parcours fixe de 11 séances).

## Service d'aperçu : import des catalogues au démarrage

Sur un service d'essai (base MongoDB **distincte** de la production), définir
`IMPORT_CATALOGUES_AU_DEMARRAGE=1` (valeur exacte) ainsi que `ADMIN_SEED_KEY` : au démarrage, les fichiers
`lecons_officielles_*.json`, `competences_dpfc_*.json` et `competences_par_activite_*.json` du dépôt sont importés
dans la base de `MONGODB_URI` par les routes d'import existantes (upserts par leçon ; pour une leçon réimportée, la liste de ses séances est remplacée, donc une séance retirée du fichier disparaît de la base). Sans la variable,
aucun effet. Ne jamais la définir en production : elle réécrirait les catalogues de la base avec ceux du dépôt.
