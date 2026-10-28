# Johndessi-ProfCI

## Bibliothèque de fiches (lot 11)

`fiche_bibliotheque.schema.json` décrit le JSON attendu par `POST /api/admin/fiche-bibliotheque`
(protégé par l'en-tête `x-admin-key` = `ADMIN_SEED_KEY`) ; `fiche_bibliotheque.exemple.json` est un
exemple complet et valide (séance 1, 2nde/Français/Étude de l'œuvre intégrale). `GET
/api/admin/fiche-bibliotheque/liste` (même protection) liste les séances déjà en bibliothèque.
## Catalogue 3e (matrice de progression)

`lecons_officielles_3e.json` remplace les entrées 3e des anciens fichiers de leçons
(`lecons_officielles_5e_4e_3e.json` a disparu : la 4e et la 5e ont leur propre fichier). Même format que
les autres catalogues (importé par `POST /api/admin/lecons-officielles/seed`), avec, par séance :

- `typeSupport` : ce que la séance exige de l'enseignant. `texte_obligatoire` (lecture méthodique) :
  génération refusée sans texte collé/importé, sauf bouton « Faire rédiger un texte par ProfCI (à vérifier) »
  (réservé, selon la classe, aux textes non littéraires : 3ème = texte argumentatif et article de journal ; 4ème = texte explicatif
  et dialogue argumentatif ; 5ème = description d'un lieu animé seulement (ni portrait ni poème) ;
  6ème = lettre personnelle et description (objet familier, lieu non animé), jamais le récit ; mention « à vérifier » dans la fiche) ;
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

## Catalogue 5e (matrice de progression)

`lecons_officielles_5e.json` regroupe toute la 5ème et remplace `lecons_officielles_5e_grammaire_orthographe_oral.json`
et `lecons_officielles_5e_4e_3e.json` (supprimés). Même format que la 3ème/4ème ; la liste « liste_10_themes » est celle de la 3ème.
La séance « Le compte rendu de lecture » porte `typeSupport` = `oeuvre_lue_titre_auteur_obligatoires` : le formulaire demande le
titre et l'auteur de l'œuvre lue (pas de texte à coller) et la fiche suit la structure du Programme éducatif 5ème (pp. 16 et
41-42) ; sans titre ni auteur, la génération est refusée avant tout appel au modèle.

## Catalogue 6e (matrice de progression)

`lecons_officielles_6e.json` regroupe toute la 6ème et remplace `lecons_officielles_6e_grammaire_orthographe_oral.json` et
`lecons_officielles_6e_lecture_exploitation_expression_ecrite.json` (supprimés). Mêmes champs que les autres niveaux ; liste des
10 thèmes = celle de la 3ème. Restent volontairement inchangés, en attente de vérification dans le PDF de la progression :
Orthographe lexicale (toute la leçon), Orthographe grammaticale S3 et Lecture méthodique « La description » S4.

## Contrôle des valeurs de classe en base (lecture seule)

`GET /api/admin/classes-catalogue?niveaux=4,5,6` (en-tête `x-admin-key`, aucune écriture) compte, pour les leçons officielles
et les autres collections, les documents par valeur du champ `classe` (« 4e », « 4ème »...), et liste pour les leçons
officielles les clés d'import (discipline, classe normalisée, activité, numéro de leçon) portées par plusieurs documents :
ce qu'un ré-import dupliquerait. Sans paramètre : niveaux 3 à 6. `GET /api/admin/classes-3e` ne couvre que la 3ème.

## Entrée en production

Voir `scripts/README-catalogues.md` : `scripts/importer-catalogues.js` (contrôle des classes, sauvegarde, import un niveau à la
fois avec confirmation) et `scripts/retour-arriere-catalogues.js`. `GET /api/admin/lecons-officielles/export` (clé admin,
lecture seule) exporte la collection des leçons officielles dans un format ré-importable par la route d'import.

## Service d'aperçu : import des catalogues au démarrage

Sur un service d'essai (base MongoDB **distincte** de la production), définir
`IMPORT_CATALOGUES_AU_DEMARRAGE=1` (valeur exacte) ainsi que `ADMIN_SEED_KEY` : au démarrage, les fichiers
`lecons_officielles_*.json`, `competences_dpfc_*.json` et `competences_par_activite_*.json` du dépôt sont importés
dans la base de `MONGODB_URI` par les routes d'import existantes (upserts par leçon ; pour une leçon réimportée, la liste de ses séances est remplacée, donc une séance retirée du fichier disparaît de la base). Sans la variable,
aucun effet. Ne jamais la définir en production : elle réécrirait les catalogues de la base avec ceux du dépôt.
