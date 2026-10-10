# Johndessi-ProfCI

## Bibliothèque de fiches (lot 11)

`fiche_bibliotheque.schema.json` décrit le JSON attendu par `POST /api/admin/fiche-bibliotheque`
(protégé par l'en-tête `x-admin-key` = `ADMIN_SEED_KEY`) ; `fiche_bibliotheque.exemple.json` est un
exemple complet et valide (séance 1, 2nde/Français/Étude de l'œuvre intégrale). `GET
/api/admin/fiche-bibliotheque/liste` (même protection) liste les séances déjà en bibliothèque.