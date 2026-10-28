# Entrée des catalogues 3ème à 6ème en production (PR #84)

Deux scripts Node (Node 18 ou plus, aucune dépendance) : `importer-catalogues.js` et
`retour-arriere-catalogues.js`. Ils se lancent **depuis le dossier du dépôt** (branche à jour, PR #84 fusionnée),
dans un terminal normal : PowerShell, cmd ou bash. L'URL du serveur est **toujours demandée en argument**
(aucune valeur par défaut, pour ne jamais viser la production par accident).

## Prérequis côté serveur

- La PR #85 (route `classes-catalogue`) **et** la PR #84 (routes `export`, nouveau code d'import) sont déployées.
  Le code doit passer **avant** les données : l'ancienne route d'import ignore les nouveaux champs.
- Faites l'import hors des heures de classe : certains numéros de séance changent de sens (3ème Grammaire L5,
  4ème dialogue argumentatif, 6ème récit, titre de 6ème Grammaire L3).

## Importer (un niveau à la fois)

```powershell
node scripts\importer-catalogues.js https://URL-DU-SERVEUR
```

La clé admin est demandée à l'écran, **saisie masquée** (rien ne s'affiche, pas même des étoiles). Elle n'est
jamais écrite dans un fichier, jamais affichée, jamais mise dans l'URL, et ne peut pas être passée en argument
ni par variable d'environnement. Si le terminal n'est pas interactif (entrée redirigée), le script refuse.

Déroulement :

1. **Contrôle des classes** (`GET /api/admin/classes-catalogue`, lecture seule). **Arrêt, sans rien importer,** si
   `aNormaliser` est supérieur à 0 ou si `conflits` n'est pas vide (le détail est affiché).
2. **Sauvegarde** : `GET /api/admin/lecons-officielles/export` (lecture seule, même clé), enregistré dans le dossier
   courant sous `sauvegarde-lecons-officielles-AAAA-MM-JJTHH-MM-SS.json` (ou `--dossier-sauvegarde <dossier>`).
   **Conservez ce fichier.**
3. **Pour chaque niveau**, dans l'ordre 3ème, 4ème, 5ème, 6ème : confirmation (tapez `oui`), import, affichage de
   `upserted` et `ignores` (attendus : 16 / 14 / 15 / 15 et 0), nouveau contrôle des classes, comparaison du contenu en
   base avec le fichier (séances attendues : 74 / 74 / 58 / 59), puis **arrêt et nouvelle confirmation** avant le
   niveau suivant. Tout écart arrête le script (code de sortie 3) sans passer au niveau suivant.

Pour reprendre après un arrêt (nouvelle sauvegarde, à côté de la première) : `--niveaux 5,6`.

## Mode à blanc : `--simuler` (à lancer en premier)

```bat
node scripts\importer-catalogues.js https://URL-DU-SERVEUR --simuler
```

Aucune écriture, ni en base ni sur le poste (aucun fichier créé, aucune confirmation demandée). Le script appelle
`classes-catalogue` et `export` (lecture seule), puis compare chaque leçon du fichier de chaque niveau avec la base et
affiche : `=` identique, `~` modifiée (titre, nombre de séances, intitulés modifiés, séances ajoutées/retirées, champs
ajoutés/modifiés/retirés), `+` créée, `?` en base mais absente du fichier (non touchée), `!` clé en doublon.

Surtout, il signale par `⚠ VALEURS DE PRODUCTION ABSENTES DE MAIN` toute valeur de la base qui n'est pas dans les
fichiers de `main` du 28/10/2026 (`scripts/catalogue-avant-pr84/`) et que l'import supprimerait ou remplacerait :
correction manuelle d'un intitulé, vocabulaire ajouté, séance ajoutée à la main... Une valeur déjà identique au nouveau
fichier n'est pas signalée (l'import ne l'efface pas). `ordre` et `genreOeuvre` absents du fichier sont conservés par
l'import (signalés en « note »). Un service déjà importé (aperçu) apparaît donc entièrement « identique ».
`--niveaux 4` limite la comparaison à un niveau. `--rapport simulation.txt` enregistre en plus le rapport dans un fichier
(il refuse d'écraser un fichier existant ; la clé n'y figure jamais) : pratique sous cmd, qui ne sait pas dupliquer la sortie.

## Retour arrière

```powershell
node scripts\retour-arriere-catalogues.js https://URL-DU-SERVEUR --export sauvegarde-lecons-officielles-....json
node scripts\retour-arriere-catalogues.js https://URL-DU-SERVEUR --depuis-main
```

- **`--export <fichier>` (recommandé)** : restaure l'état exact de la base tel qu'il était dans la sauvegarde, quel
  qu'il fût (y compris des corrections faites à la main en production). C'est la seule source qui garantit le retour
  à l'état d'avant.
- **`--depuis-main`** : ré-importe les fichiers de `main` du 28/10/2026 (copie dans `scripts/catalogue-avant-pr84/`).
  Ne ramène l'état d'avant **que si la base d'avant était identique à ces fichiers**, ce que rien ne permet de
  vérifier ; à réserver au cas où la sauvegarde est perdue.

Dans les deux cas : confirmation en tapant `RESTAURER`, puis comparaison de la base à la source. Limites : l'import
**ne supprime aucun document** (une leçon créée par l'import qui n'existait pas avant resterait : le script la
signale ; `DELETE /api/admin/lecons-officielles` permet de la retirer après vérification) ; la restauration refuse
une source contenant des classes non normalisées (« 4e »...), qu'elle écrirait dans d'autres documents.

## Ce qui a été testé, et ce qui ne l'a pas été

Testé hors production, sur le vrai `server.js` avec une base simulée en mémoire et le script lancé dans un
pseudo-terminal (Linux) : arrêts de contrôle, parcours des quatre niveaux, confirmations, saisie masquée (la clé
n'apparaît ni à l'écran, ni dans la sauvegarde, ni dans le dépôt), mauvaise clé, retour arrière dans les deux modes.
**Non testé** : la saisie masquée dans une console Windows réelle (PowerShell, cmd) et une vraie base MongoDB.
