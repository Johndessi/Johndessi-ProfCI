# Import de la bibliothèque de fiches (lot 12)

`scripts/import-bibliotheque.js` importe des fichiers JSON vers
`POST /api/admin/fiche-bibliotheque` (lot 11) sans écrire de `curl` à la main.
Node natif uniquement (`fetch`/`AbortController` globaux depuis Node 18) --
aucune dépendance ajoutée au projet.

Chaque fichier `*.json` du dossier doit avoir la forme :

```json
{ "niveau": "2nde", "discipline": "Français", "activite": "Étude de l'œuvre intégrale", "lecon": 1, "seance": 1, "fiche": { ... } }
```

(`fiche` suit le schéma décrit par `fiche_bibliotheque.schema.json` à la racine
du dépôt -- voir aussi `fiche_bibliotheque.exemple.json`.)

**Le dossier contenant vos fiches reste HORS du dépôt** (cf. `.gitignore` :
`fiches-bibliotheque/` et `*.fiche.json` sont ignorés) -- rangez-le où vous
voulez sur votre poste, par exemple `C:\fiches-bibliotheque`.

## Windows (cmd)

Vérifier les fichiers en local (aucun réseau, aucune clé nécessaire) :

```bat
cd C:\chemin\vers\Johndessi-ProfCI
node scripts\import-bibliotheque.js C:\chemin\dossier --verifier
```

Importer réellement (nécessite la clé d'administration du serveur) :

```bat
set ADMIN_SEED_KEY=votre_cle_admin
node scripts\import-bibliotheque.js C:\chemin\dossier
```

Contre un autre serveur que celui par défaut :

```bat
set ADMIN_SEED_KEY=votre_cle_admin
node scripts\import-bibliotheque.js C:\chemin\dossier --url https://johndessi-profci.onrender.com
```

`set ADMIN_SEED_KEY=...` ne garde la variable que pour la session `cmd`
ouverte -- fermez la fenêtre après usage plutôt que de la stocker de façon
permanente. La clé n'est jamais affichée par le script, ni en cas de succès
ni en cas d'erreur (y compris une erreur réseau).

## macOS / Linux (bash)

```bash
export ADMIN_SEED_KEY=votre_cle_admin
node scripts/import-bibliotheque.js /chemin/dossier --verifier   # validation locale
node scripts/import-bibliotheque.js /chemin/dossier              # import réel
```

## Comportement

- Lit tous les `*.json` du dossier, triés par nom.
- Sans `--verifier` : POST de chaque fichier, en-tête `x-admin-key` lu dans
  `ADMIN_SEED_KEY` (variable absente => arrêt immédiat, message clair, aucune
  tentative réseau).
- Avec `--verifier` : exécute le même validateur que le lot 10, en local,
  sans réseau et sans clé -- utile pour corriger les défauts avant d'importer
  pour de vrai.
- Une ligne de résultat par fichier (nom, séance, `créé` / `mis à jour vN` /
  `refusé` ou `invalide` + défauts). Un fichier en échec n'interrompt jamais
  les suivants.
- Code de sortie non nul si au moins un fichier est refusé/invalide.
- Timeout réseau de 60 s par requête, avec une seule reprise automatique en
  cas d'erreur réseau (utile si le serveur Render est endormi et met du temps
  à se réveiller) -- jamais de reprise sur un refus HTTP (400/401), qui est
  une réponse réelle du serveur, pas une panne réseau.

## Séance 3

La bibliothèque (lot 11) ne prend pas en charge la Séance 3 (Introduction,
structure libre) -- un fichier qui la cible sera refusé par la route elle-même
(400), ce script ne fait rien de particulier à ce sujet.
