# LG Horizon pour Gladys

Cette intégration amène dans Gladys les décodeurs **LG Horizon** (Mediabox
Next, Next Mini, TV Box, 360 Box…) de votre compte d'opérateur, par le cloud de
l'opérateur : la même API (REST et MQTT) que l'application et le site TV web.

> **Attention : cette intégration n'a jamais été testée avec un vrai compte.**
> Elle a été écrite d'après la bibliothèque lghorizon et testée seulement avec
> des réponses simulées. Vos retours sont les bienvenus sur le forum de Gladys.

Non officielle, sans lien avec LG, Liberty Global ni les opérateurs cités.

## Opérateurs

| Opérateur        | Pays        | Connexion                   |
| ---------------- | ----------- | --------------------------- |
| Ziggo            | Pays-Bas    | identifiant et mot de passe |
| Telenet          | Belgique    | jeton de rafraîchissement   |
| BASE TV          | Belgique    | jeton de rafraîchissement   |
| Sunrise (ex-UPC) | Suisse      | jeton de rafraîchissement   |
| Virgin Media     | Royaume-Uni | jeton de rafraîchissement   |
| Virgin Media     | Irlande     | identifiant et mot de passe |
| UPC              | Pologne     | identifiant et mot de passe |

Ce que dit la bibliothèque de référence (lghorizon 0.12.2, octobre 2026) :

- **Ziggo** et **Telenet** sont les plus suivis : des correctifs récents
  (juillet 2026 pour Ziggo) et des tickets ouverts en 2026. Un ticket Telenet
  de septembre 2026 signale une connexion qui reste bloquée avec un jeton de
  rafraîchissement, sans solution à ce jour.
- **Sunrise** et **Virgin Media (UK et Irlande)** ont connu des refus de
  connexion début 2026, réglés depuis selon les tickets fermés.
- **BASE TV** et **UPC Pologne** figurent dans le code sans retour récent.
- **Magenta TV (Autriche) n'est pas pris en charge** : il n'a jamais figuré
  dans lghorizon (aucune adresse d'API connue pour lui), et aucun ticket ne
  le mentionne.

## Configuration

1. Choisissez votre **opérateur**.
2. Selon l'opérateur :
   - **Ziggo, Virgin Media Irlande, UPC** : saisissez l'**identifiant**
     (souvent l'adresse e-mail) et le **mot de passe** du compte.
   - **Telenet, BASE, Sunrise, Virgin Media UK** : collez un **jeton de
     rafraîchissement** (refresh token), voir ci-dessous.
3. Enregistrez. Les décodeurs du compte apparaissent dans l'onglet
   **Découverte** : ajoutez ceux que vous voulez.

Le mot de passe et le jeton sont gardés par Gladys dans sa base, jamais
réaffichés, et envoyés seulement au service de connexion de votre opérateur.

### Obtenir un jeton de rafraîchissement

1. Sur un ordinateur, ouvrez le site TV web de votre opérateur (par exemple
   telenet.tv, sunrisetv.ch, virgintvgo.virginmedia.com) et connectez-vous.
2. Ouvrez les outils de développement du navigateur (F12), onglet
   **Application** (Chrome, Edge) ou **Stockage** (Firefox), puis **Stockage
   local** du site.
3. Copiez la valeur de la clé qui contient `refreshToken` (par exemple
   `flutter._WEB_SECURE_STORAGE_refreshToken` sur certains sites).
4. Collez-la dans le champ **Jeton de rafraîchissement** et enregistrez.

Le jeton change à chaque usage : l'intégration garde le plus récent dans son
volume `/data` (fichier lisible seulement par l'intégration) et s'en sert aux
redémarrages. Si vous vous déconnectez du site web, le jeton peut cesser de
fonctionner : collez-en un nouveau.

## Ce que montre chaque décodeur

| Fonctionnalité                     | Type          | Valeurs                                                                             |
| ---------------------------------- | ------------- | ----------------------------------------------------------------------------------- |
| Allumé                             | lecture seule | 1 en marche, 0 en veille ou hors ligne                                              |
| Joignable                          | lecture seule | 1 joignable par le cloud (marche ou veille), 0 hors ligne                           |
| Chaîne                             | texte         | nom de la chaîne en cours, « — » sinon                                              |
| Programme                          | texte         | titre (et épisode) du programme, de la VOD, de l'enregistrement ou de l'application |
| En lecture                         | lecture seule | 1 en lecture, 0 en pause ou éteint                                                  |
| Allumer                            | bouton        | sort de veille                                                                      |
| Mettre en veille                   | bouton        | met en veille                                                                       |
| Lecture, Pause                     | boutons       | reprend, met en pause                                                               |
| Chaîne suivante, Chaîne précédente | boutons       | change de chaîne                                                                    |

Pas de **volume** : le cloud de l'opérateur n'a pas de touche de volume (le
volume se règle sur le téléviseur).

Les noms des fonctionnalités sont en français ou en anglais selon l'option
« Langue des noms des fonctionnalités ».

## Commandes

Le décodeur ne connaît qu'une touche marche/veille (bascule) et une touche
lecture/pause (bascule). Pour éviter qu'un appui fasse l'inverse de ce qui est
demandé :

- la touche part seulement si l'état reçu en direct du décodeur est l'inverse
  de ce qui est demandé (« Allumer » sur un décodeur déjà allumé ne fait rien) ;
- si l'état est inconnu (décodeur hors ligne, liaison en direct coupée ou pas
  encore d'état reçu), rien n'est envoyé et Gladys affiche une erreur ;
- après un appui, toute autre commande marche/veille est ignorée jusqu'à ce
  que le décodeur annonce le nouvel état (45 s au plus), de même pour
  lecture/pause (10 s au plus).

Marche et veille sont des **boutons**, pas un interrupteur : un « tout
éteindre » d'un assistant vocal ou d'une scène ne peut pas les déclencher.

## Statut et erreurs

- **Identifiants refusés** : l'intégration s'arrête et ne réessaie pas toute
  seule (un mot de passe essayé encore et encore peut bloquer le compte). Cet
  arrêt est gardé après un redémarrage. Corrigez la configuration (de nouveaux
  identifiants sont essayés aussitôt) ou cliquez sur **Se reconnecter** (un
  seul essai).
- **Trop de requêtes (429)** : une pause de 1 minute à 6 heures, gardée après
  un redémarrage.
- **Cloud injoignable** : nouvel essai après 1, 2, 5, 15 puis 30 minutes.
- **Liaison en direct coupée** : nouvel essai après 30 s, 1, 2, 5, 10 puis 15
  minutes ; une liaison qui s'ouvre puis se coupe aussitôt ne fait pas de
  boucle.

La session est renouvelée par un minuteur, un jour avant l'expiration du
jeton de rafraîchissement (toutes les 12 heures au plus).

## Confidentialité

L'intégration parle seulement au cloud de votre opérateur : en HTTPS pour l'API
et par une WebSocket sécurisée (TLS) pour le MQTT. Elle lit la liste des
décodeurs, la liste des chaînes et le titre de ce qui est regardé ; elle
n'envoie rien d'autre que les touches demandées.

## Remerciements

Port en JavaScript de [lghorizon](https://github.com/Sholofly/lghorizon-python)
(MIT), la bibliothèque de l'intégration Home Assistant.
