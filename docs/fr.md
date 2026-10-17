# Edilkamin

Intégration non officielle, sans lien avec Edilkamin. Elle amène dans Gladys
les poêles à granulés **Edilkamin** reliés à l'application **The Mind** (module
Wi-Fi « The Mind »), par le cloud Edilkamin, celui qu'utilise l'application.

> **Attention : API non officielle, cette intégration n'a jamais été testée
> avec un vrai poêle ni un vrai compte.** Elle a été écrite à partir de la
> bibliothèque edilkamin.py et testée contre un faux cloud Edilkamin
> seulement. Edilkamin peut changer son API à tout moment. Les retours sont
> les bienvenus.

## Ce que vous obtenez

Pour chaque poêle :

| Fonctionnalité       | Détail                                                                                                         |
| -------------------- | -------------------------------------------------------------------------------------------------------------- |
| Allumé               | Lecture seule : 1 allumé (ou en cours d'allumage), 0 éteint.                                                   |
| Allumer le poêle     | Bouton. Désactivé par défaut (voir Sécurité).                                                                  |
| Éteindre le poêle    | Bouton. Toujours permis.                                                                                       |
| Température ambiante | En °C, la sonde du poêle.                                                                                      |
| Consigne             | En °C, de 12 à 30 par pas de 0,5. Modifiable seulement si vous l'autorisez.                                    |
| Puissance            | Choix P1 à P5 (puissance manuelle). Modifiable seulement si vous l'autorisez.                                  |
| Ventilation 1 à 3    | Niveau de chaque ventilateur (lecture seule), selon le nombre de ventilateurs du poêle.                        |
| Granulés en réserve  | 1 quand le réservoir de granulés est en réserve.                                                               |
| Dernière alarme      | Texte, par exemple « Alarme 7 (2026-10-17 21:04 UTC) », si le document du poêle contient un journal d'alarmes. |

Déclencheur de scène **Alarme d'un poêle Edilkamin** : quand une lecture
montre plus d'alarmes dans le journal du poêle que la lecture précédente.
Variables : `stove` (le nom du poêle) et `code` (le code de l'alarme, vide
s'il est inconnu). Jamais à la première lecture après un démarrage.

Le niveau de granulés n'est donné par le cloud que sous la forme « en
réserve » ; l'autonomie qu'il annonce n'est pas encore publiée (son unité
reste à vérifier sur un vrai poêle).

Le badge de chaque poêle affiche « cloud », « injoignable » (avec un point
orange) quand ce poêle ne peut pas être lu (adresse MAC inconnue ou absente
du compte), et « injoignable » pour tous quand le cloud ne répond pas ou que
le compte est à l'arrêt.

## Installation

1. Vos poêles doivent fonctionner dans l'application **The Mind**.
2. Relevez l'**adresse MAC** de chaque poêle : l'application The Mind
   l'affiche, l'étiquette du module Wi-Fi aussi. Le cloud Edilkamin ne donne
   pas la liste des poêles d'un compte : elle doit être saisie.
3. Dans Gladys, installez l'intégration Edilkamin, saisissez l'**identifiant**
   (e-mail) et le **mot de passe** de l'application The Mind, et les adresses
   MAC séparées par des virgules (`A8:03:2A:12:34:56, A8:03:2A:65:43:21`).
   Enregistrez.
4. Ajoutez les poêles depuis l'onglet **Découverte**.

## Sécurité

Un poêle à granulés est un appareil à flamme :

- **L'extinction est toujours permise**, sans option. Elle n'attend jamais
  derrière une autre commande du même poêle, et elle part aussi pendant une
  pause demandée par Edilkamin, tant que la session est valable.
- **L'allumage** est désactivé par défaut : activez **Autoriser l'allumage des
  poêles depuis Gladys** pour le permettre. Une scène ou un tableau de bord
  peut alors allumer une flamme chez vous en votre absence : vérifiez d'abord
  le poêle, sa vitre et ses abords.
- **Il n'y a pas d'interrupteur** : l'état « Allumé » est en lecture seule, et
  l'allumage comme l'extinction sont des boutons. Un « allume tout » d'un
  assistant vocal (Google Home, Alexa, HomeKit) ou d'une scène ne peut donc
  jamais allumer le poêle.
- **La consigne et la puissance** sont désactivées par défaut (**Autoriser la
  consigne et la puissance depuis Gladys**). Elles n'allument jamais le poêle.
- Avant chaque commande, l'intégration **relit le poêle** dans le cloud. Pour
  l'allumage, la consigne et la puissance, la commande est refusée si cette
  lecture échoue ou ne donne pas la valeur. Pour l'extinction, une lecture
  ratée n'empêche rien : le poêle est éteint quand même.
- Les commandes d'un même poêle passent **une à la fois** (sauf l'extinction).
- Une commande qui ne peut pas être envoyée dans les **3,5 secondes** suivant
  son arrivée est refusée : Gladys affiche un échec au bout de 5 secondes, et
  rien ne doit se passer après cet échec.
- Après une commande de marche, un nouvel allumage est refusé (« encore en
  cours ») jusqu'à ce qu'une lecture montre l'état attendu, 60 secondes au
  plus.
- Si Edilkamin ne répond pas à temps à une commande, Gladys affiche un échec,
  mais la commande a pu partir : vérifiez l'état du poêle.

## Mot de passe, jetons et vie privée

- Le mot de passe est **gardé par Gladys dans sa base, jamais réaffiché, et
  envoyé seulement à Edilkamin**, ou plutôt à son service de connexion AWS
  Cognito, sous forme de preuve SRP : le mot de passe lui-même ne circule
  jamais.
- La connexion donne des jetons : le jeton (environ une heure) est renouvelé
  avec le jeton de rafraîchissement, sans le mot de passe ; l'intégration ne
  se reconnecte donc pas à chaque lecture. Les jetons sont gardés dans le
  volume `/data` de l'intégration pour qu'un redémarrage ne se reconnecte
  pas. Sur l'hôte de Gladys, ce volume est le dossier
  `<dossier de base de Gladys>/external-integrations/<sélecteur>` : lisible par
  root et par l'uid 1000 (l'utilisateur du conteneur), **absent des
  sauvegardes de Gladys**, supprimé à la désinstallation de l'intégration.
  **Le jeton de rafraîchissement donne le contrôle des poêles** tant qu'il est
  valable, sans le mot de passe : protégez cet hôte. L'identifiant et le mot
  de passe n'y sont jamais écrits ; changer d'identifiant efface les jetons.
- Rien n'apparaît dans les journaux : ni mot de passe, ni jeton, ni
  identifiant, ni adresse MAC complète (seulement ses 4 derniers caractères).
- Tout passe en HTTPS vers `cognito-idp.eu-central-1.amazonaws.com` (la
  connexion) et `the-mind-api.edilkamin.com` (les poêles).

## Rafraîchissement

Les poêles sont lus toutes les 60 secondes par défaut (60 à 900), une requête
par poêle, plus trois lectures dans la minute qui suit une commande.

## Erreurs

- **Mot de passe refusé** (ou compte non confirmé, réinitialisation demandée) :
  l'intégration s'arrête ; un nouvel essai après 1 h, 6 h, puis toutes les
  24 h, ou aussitôt quand vous enregistrez la configuration ou cliquez sur
  **Tester la connexion**.
- **Code de vérification demandé** : non géré. L'intégration s'arrête et ne
  se reconnecte jamais d'elle-même (chaque connexion enverrait un code).
- **Session refusée juste après une nouvelle connexion** : nouvel essai après
  1 h, 6 h, puis toutes les 24 h.
- **Edilkamin demande de ralentir** (429, ou trop de connexions) : une pause
  d'au moins 1 minute (Retry-After s'il est donné, 6 h au plus), pour tous les
  chemins sauf l'extinction, gardée aux redémarrages.
- **HTTP 403 sur tous les poêles** : une pause de 30 minutes. Un 403 ou un 404
  sur un seul poêle ne marque que lui (badge « injoignable »).
- **Edilkamin injoignable** : nouvel essai après 1, 2, 5, 10 puis toutes les
  15 minutes, jamais plus vite que l'intervalle de rafraîchissement.

## Limites

- Jamais testée avec un vrai poêle : la forme des réponses vient de
  edilkamin.py ; le journal d'alarmes, la plage de la consigne et les niveaux
  de ventilation restent à vérifier.
- Les adresses MAC sont à saisir (10 poêles au plus) : la découverte par
  Bluetooth d'edilkamin.py n'est pas possible dans le conteneur.
- Les modes chrono, relax, veille, Airkare et la minuterie ne sont pas gérés.
- L'ancienne API d'Edilkamin (« legacy ») n'est pas utilisée.

## Crédits

- [edilkamin.py](https://github.com/AndreMiras/edilkamin.py) d'Andre Miras
  (MIT) : l'API du cloud, la connexion et le document du poêle sont portés en
  JavaScript.
- [pycognito](https://github.com/pvizeli/pycognito) (Apache-2.0) : le calcul
  SRP.
- Voir `THIRD_PARTY_NOTICES.md`.

Edilkamin et The Mind sont des marques d'Edilkamin ; ce projet est sans lien
avec Edilkamin.
