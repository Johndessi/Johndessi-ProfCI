# Skill : Lecture méthodique (ProfCI)

Ce skill fixe les règles structurelles de la fiche de lecture méthodique, établies à partir de deux corpus réels : **24 fiches Anicet_LM** (6e à 3e, 10 types de textes, référence pour la variété des types de texte) et **3 fiches Lect_meth** (4e, texte explicatif, référence pour la structure de tableau optimale et le niveau de détail du dialogue de classe). Ces règles sont vérifiées sur des fiches réelles utilisées en classe — elles priment sur toute génération libre du modèle.

## 1. Squelette général de la fiche

```
Discipline / Classe / Compétence / Activité / Durée / Leçon / Séance
Situation d'apprentissage (contexte narratif amenant le texte)

Tableau Habiletés/Contenus (Connaître, Identifier, Analyser, Interpréter, Appliquer)
Tableau Supports didactiques / Bibliographie

Tableau principal (5 colonnes : Moments didactiques/Durée | Stratégies pédagogiques | Activités enseignant | Activités élèves | Traces écrites)
  I. PRÉSENTATION DU TEXTE
  II. HYPOTHÈSE GÉNÉRALE
  III. VÉRIFICATION (annonce des axes uniquement dans ce tableau)
  IV. BILAN GÉNÉRAL
  ÉVALUATION (10-15 min, sur extrait NEUF, jamais le texte déjà étudié)

Tableaux de vérification séparés (un bloc par axe, APRÈS le tableau principal)
```

## 2. Règle non négociable : 4 entrées, 2 par axe

**Vérifié sans exception sur 24 fiches, 10 types de textes.** Chaque axe de lecture contient **exactement 2 entrées**, jamais plus, jamais moins. Total : 4 entrées pour toute la vérification.

Dans les documents sources (corpus Anicet), cette structure apparaît fragmentée en 3 blocs de tableau consécutifs (artefact probable de mise en page Word, pas une exigence structurelle) :
- Bloc 1 (3 lignes) : en-tête + 2 entrées → correspond à l'**Axe 1** en entier
- Bloc 2 (2 lignes) : en-tête + 1 entrée → 1ère entrée de l'**Axe 2**
- Bloc 3 (1 ligne) : pas d'en-tête, 1 entrée → 2e entrée de l'**Axe 2**

**Structure cible recommandée pour ProfCI (corpus Lect_meth_3/5/7, format plus propre à générer)** : un seul tableau continu à 5 colonnes, l'axe répété en 1ère colonne pour ses 2 lignes :

| Axes de lecture | Entrées | Indices textuels | Analyse | Interprétation |
|---|---|---|---|---|
| Axe 1 : [nom] | Entrée 1 | ... | ... | ... |
| Axe 1 : [nom] | Entrée 2 | ... | ... | ... |
| Axe 2 : [nom] | Entrée 1 | ... | ... | ... |
| Axe 2 : [nom] | Entrée 2 | ... | ... | ... |

Peu importe le format final choisi (fragmenté ou continu) — ce qui compte est le compte final : **2 lignes de contenu sous Axe 1, 2 lignes de contenu sous Axe 2**. Toute génération produisant 0, 1, 3, 4+ entrées sur un axe est une erreur à signaler explicitement (pas à corriger silencieusement en tronquant ou en complétant).

### Colonnes du tableau de vérification

| ENTRÉES | INDICES TEXTUELS | ANALYSES | INTERPRÉTATIONS |
|---|---|---|---|

Chaque entrée suit une séquence de 4 sous-questions, dans cet ordre logique (l'ordre d'affichage dans les docs sources est parfois 3→1→2→4, mais la logique pédagogique est toujours 1→2→3→4) :

1. **Relevé** ("Relevez dans le texte...", "Identifie quelques...") → alimente la colonne INDICES TEXTUELS (citations exactes du texte, entre guillemets)
2. **Nommage/justification du procédé** ("Nommes et justifie leur emploi", "Donnez leur temps/mode et la valeur d'emploi") → alimente la colonne ANALYSES
3. **Nom de l'entrée elle-même** ("De quelle entrée s'agit-il ?", "Nommez l'entrée", "Déterminez l'entrée correspondant à ce procédé") → alimente la colonne ENTRÉES (ex. "Le lexique", "Temps verbaux", "Figure de style", "Type de phrases", "Mode", "Les données chiffrées", "Les adverbes")
4. **Interprétation** ("Interprète-les", "Pourquoi l'auteur utilise-t-il...", "Que traduisent ces indices ?", "Quelles informations nous apportent...") → alimente la colonne INTERPRÉTATIONS (effet produit sur le lecteur, sens dégagé)

## 3. Ce que couvre chaque axe (logique de l'hypothèse générale)

L'hypothèse générale se compose de deux parties : **[nature/type de texte]** + **[thème]**.
- **Axe 1** justifie toujours la nature/le type de texte
- **Axe 2** justifie toujours le thème

### En 6e / 5e (pas de tonalité étudiée à ce niveau)
Axe 1 = 2 caractéristiques textuelles/linguistiques distinctes qui, ensemble, justifient le type de texte. Exemples réels du corpus :
- Lettre : entrée 1 = *la structure du texte* (en-tête, adresse, formule d'appel), entrée 2 = *les indices de personne* (pronoms, adjectifs possessifs)
- Description (poupée) : entrée 1 = *temps verbaux* (présent de vérité générale), entrée 2 = *le lexique* (champ lexical du corps)
- Récit : entrée 1 = *la structure du texte* (situation initiale/péripéties/situation finale), entrée 2 = *temps verbaux* (présent narratif) ou *ponctuation* (marques de dialogue)
- Poème : entrée 1 = deux caractéristiques formelles/linguistiques du poème

### À partir de la 4e (tonalité étudiée)
L'hypothèse s'enrichit : **[type de texte + tonalité]** + **[thème]**. Axe 1 se scinde alors logiquement en 1 entrée type de texte + 1 entrée tonalité — mais **le corpus réel montre que ce n'est pas systématique** : parfois les 2 entrées de l'axe 1 restent 2 procédés linguistiques distincts (ex. texte explicatif : *données chiffrées* + *temps verbaux* ; texte argumentatif : *liens logiques* + *temps verbaux/mode*). Ne pas forcer un split type/tonalité artificiel si le texte ne s'y prête pas — respecter ce que le corpus montre : 2 entrées qui, ensemble, permettent de nommer/justifier la catégorie du texte.

Axe 2 (thème) : toujours 2 entrées linguistiques distinctes qui, ensemble, développent/justifient le thème de l'hypothèse. Jamais une énumération libre d'arguments ou d'éléments de contenu — toujours 2 procédés d'analyse (vocabulaire, figures de style, types de phrases, etc.).

## 4. I. Présentation du texte — règle par niveau

- **6e / 5e** : présentation en pêle-mêle acceptée (Auteur / Source / Édition listés séparément, sans phrase rédigée)
- **À partir de la 4e** : présentation rédigée en phrase(s) complète(s). Exemple corpus (6e, mais déjà en phrase) : *"Le texte que nous allons étudier s'intitule « Une amitié extraordinaire ». Il est extrait de l'œuvre La légende de Sadjo d'Isaïe Biton Coulibaly. Cette œuvre a été publiée aux éditions CEDA."*

## 5. Types de textes couverts par ce corpus (référence de nommage)

| Niveau | Types de textes | Exemples de titre de leçon |
|---|---|---|
| 6e | Lettre personnelle (familière / non familière), Description (objet / lieu), Récit (simple / complexe) | "La lettre personnelle", "La description", "Le récit" |
| 5e | Portrait (simple / complexe), Poème (simple / complexe, vers libres) | "Le portrait simple", "Le portrait complexe", "Poèmes simples en vers libres" |
| 4e | Texte explicatif (phénomène naturel / pratiques socioculturelles), Dialogue argumentatif (à tonalité polémique) | "Le texte explicatif", "Le dialogue argumentatif" |
| 3e | Texte argumentatif (à tonalité réaliste) | "Le texte argumentatif" |

## 6. Situation d'évaluation (fin de fiche)

**Correction (04/08, précision de l'utilisateur) : ce n'est PAS un extrait neuf.** C'est le même texte support, avec une nouvelle situation/question amenant l'élève à retrouver par lui-même une entrée non travaillée en classe avec l'enseignant. Logique pédagogique : sur les 4 entrées totales de la vérification (2 par axe), l'enseignant en travaille généralement 3 avec les élèves à l'oral pendant la séance ; la dernière entrée est volontairement laissée à l'évaluation individuelle, reformulée sous forme de situation + consignes numérotées, toujours sur le même texte :
1. Relève les indices/phrases qui montrent [élément à vérifier, reformulé via une nouvelle situation]
2. Nomme et justifie leur emploi
3. Interprète-les
4. Détermine l'entrée

**Confirmé (04/08, précision utilisateur, et prouvé textuellement dans le corpus Lect_meth_7_Le_spect_Koteba) : cette entrée réservée à l'évaluation est toujours la 2e entrée de l'Axe 2, jamais une autre.** Les 3 autres entrées (Axe 1 entrées 1 et 2, Axe 2 entrée 1) sont travaillées à l'oral en classe avec l'enseignant ; seule Axe 2 / entrée 2 est laissée à l'évaluation individuelle sur le même texte support.

Citation exacte du corpus (Koteba, 4e, texte explicatif) — l'enseignant l'annonce littéralement en classe avant l'évaluation :
> *"La deuxième entrée vous est donnée en situation d'évaluation, soyez attentifs, je vais lire la situation."*
> *"Pour vérifier la deuxième entrée de l'axe de lecture 2, le professeur de français... propose le repérage suivant : [...] 1- Analyse ce relevé. 2- Trouve l'entrée correspondant à ce repérage."*

## 7. Ce qui déclenche un avertissement explicite (jamais une correction silencieuse)

- Un axe avec ≠ 2 entrées (0, 1, 3, 4+)
- Une colonne vide alors que les autres colonnes de la même ligne sont remplies
- Format d'axe non reconnu (variantes possibles à accepter : "Axe 1 :", "Axe de lecture n°1 :", avec ou sans "L'axe de lecture")
- Présentation en pêle-mêle demandée/détectée à partir de la 4e (devrait être en phrase)

Dans tous ces cas, l'application doit avertir clairement l'enseignant (comme le fait déjà `verifierNombreEntreesParAxe`) plutôt que de générer un résultat incomplet sans signal.

## 8. Niveau de détail du dialogue enseignant/élève (mode génération automatique — titre seul, sans plan fourni)

Quand l'enseignant ne fournit que le titre de la leçon (pas de plan détaillé), la fiche générée doit reproduire un **script de classe complet**, question par question, dans le style du corpus Lect_meth_3/5/7 (plus riche que le corpus Anicet). Chaque étape du déroulement (Présentation, Développement, Évaluation) est un **dialogue scénarisé**, pas un résumé.

### Structure du dialogue, par étape

**Phase de présentation (5 min)** : salutations, appel, rappel de la date/activité/leçon précédente, annonce du nouveau texte — toujours en questions-réponses directes.

**I. Présentation du texte** : questions successives (titre ? auteur ? source ? année ?) → réponses courtes des élèves → phrase de présentation rédigée en synthèse (à partir de la 4e, cf. règle section 4).

**Formulation des hypothèses (en 2 temps)** :
1. Hypothèse 1 (avant lecture) : à partir du titre/paratexte seul, l'enseignant demande "de quoi pourrait-il s'agir ?" → hypothèses notées au tableau, non validées
2. Lecture silencieuse, puis Hypothèse 2 : "de quoi est-il question maintenant ?" → comparaison avec l'hypothèse 1
3. Lecture magistrale (l'enseignant lit à voix haute)
4. Détermination de la nature du texte, de la tonalité (si applicable), du thème → formulation de l'hypothèse générale par les élèves, guidés par l'enseignant

**III. Vérification** : pour chaque entrée (dans l'ordre 1→2→3→4 de la section 2), une séquence de questions dirigées :
- "Relevez dans le texte..." → élèves citent
- "Analysez-les / Donnez leur valeur d'emploi" → élèves nomment le procédé
- "Déterminez/Nommez l'entrée" → élèves nomment la catégorie
- "Pourquoi l'auteur utilise-t-il... / Interprétez" → élèves interprètent l'effet

**Évaluation** : l'enseignant annonce explicitement que la dernière entrée (Axe 2/entrée 2) est laissée à l'évaluation (cf. section 6), lit la situation, les élèves travaillent individuellement.

**IV. Bilan** : rappel des entrées utilisées → synthèse → confrontation avec l'hypothèse générale → validation ("l'hypothèse générale est vérifiée").

**Clôture** : jugement critique (question ouverte de débat) + consigne de relecture du texte.

### Exemple réel de séquence courte (corpus Le_soleil, entrée "ponctuation")

> **Enseignant** : "Relevez dans ce texte les signes qui permettent d'introduire des explications."
> **Élèves** : « L6, L7, L13 " : " »
> **Enseignant** : "Donnez la nature de ces signes. Indiquez leur valeur."
> **Élèves** : "Les deux points à valeur explicative."
> **Enseignant** : "Donnez l'entrée."
> **Élèves** : "La ponctuation."
> **Enseignant** : "Dites pourquoi l'auteur utilise ces signes de ponctuation."
> **Élèves** : "L'auteur utilise ces signes de ponctuation pour donner des explications."

Ce niveau de granularité (une question par sous-étape, jamais une question composite) est la référence à reproduire quand le modèle doit générer le dialogue complet sans plan fourni par l'enseignant. En mode plan-enseignant, ce dialogue n'est pas à générer — seul le contenu du tableau de vérification (structure section 2) doit être complété à partir du plan fourni.
