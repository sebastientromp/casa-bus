# Les bus du 06

Une relecture de tous les horaires de bus et de tram des Alpes-Maritimes. Les véhicules se déplacent sur la carte à la vitesse de votre choix, et les routes et les zones s'éclairent en fonction du nombre de passages.

C'est un site statique : tout s'exécute dans le navigateur du visiteur, sans serveur. Une étape de construction transforme les horaires publiés en fichiers de données.

## Lancer le projet sur votre PC

Nécessite Node 22 ou plus récent.

```bash
npm install
```

```bash
npm run build
```

```bash
npm start
```

Ouvrez ensuite <http://localhost:5177>.

La construction réutilise les horaires téléchargés depuis moins de 24 heures. Elle s'arrête sur une erreur si un réseau n'a aucun horaire, pour ne jamais publier un site auquel il manquerait un réseau.

Le serveur d'Envibus ne répond pas aux machines de GitHub. Quand il est injoignable, la construction utilise la copie la plus récente conservée par transport.data.gouv.fr.

## Publier gratuitement

Le site correspond au contenu de `dist/` après `npm run build`, n'importe quel hébergeur statique convient donc.

`.github/workflows/deploy.yml` le publie sur GitHub Pages à chaque envoi sur `master`, et le reconstruit chaque lundi pour récupérer les nouveaux horaires. La carte ne connaît que les horaires de sa dernière construction, et affiche cette date dans le panneau.

## Comment lire la carte

- Chaque véhicule est placé d'après les horaires publiés. Ce n'est pas sa position réelle, et les retards ne sont pas pris en compte.
- Les véhicules avancent en continu : les arrêts tombant sur la même minute arrondie sont fusionnés et le temps d'arrêt est ignoré, ils ne marquent donc pas de pause aux arrêts.
- La carte s'ouvre sur le moment présent et défile à 5 minutes par seconde. Le panneau permet de régler la date, l'heure et la vitesse, jusqu'à 1 heure par seconde (une semaine en moins de 3 minutes).
- **Skip times with nothing running**, activé par défaut, saute au prochain départ quand rien ne circulerait sur la carte pendant au moins 15 minutes. Cette option tient compte des lignes sélectionnées.

**Couleurs**

Plus c'est clair, plus il y a de passages. Un passage est compté dès qu'un véhicule a franchi le tronçon de route.

- *Day so far* compte depuis le début de la journée de service, qui change à 3 h du matin.
- *Last hour* et *Full day* couvrent la dernière heure et la journée entière. *Last hour* a sa propre échelle, car les nombres y sont bien plus petits.
- Les lignes qui partagent une route s'additionnent, dans les deux sens.
- Le score d'une zone additionne les passages aux arrêts situés à moins de 400 m, les arrêts les plus proches comptant davantage.

## Ce qui est inclus

Tous les réseaux de bus du 06 qui publient des données ouvertes :

| Réseau | Secteur |
|---|---|
| Lignes d'Azur, bus et tramways (L1, L2, L3, B) | Métropole Nice Côte d'Azur |
| Palmbus | Cannes |
| Envibus | Sophia Antipolis |
| Sillages, urbain et scolaire | Pays de Grasse |
| Zest | Menton |
| ZOU! Proximité, Express et Scolaire, trajets avec au moins un arrêt dans le 06 | Région |

Les trajets sont conservés en entier : un bus ZOU! venant du Var reste donc sur la carte après avoir quitté le 06.

Quand un trajet n'a pas de tracé publié, comme la plupart de ceux de Sillages, le véhicule se déplace en ligne droite entre les arrêts. Il n'est pas pris en compte dans la coloration des routes, mais compte pour celle des zones.

Non inclus : les services à la demande, les trains, les services scolaires d'Envibus (absents des horaires publiés) et les bus de Monaco (hors du 06).

Pour ajouter un réseau, ajoutez son entrée dans `NETWORKS`, dans `build/gtfs.js`.

## Organisation du projet

- `build/` : télécharge les horaires et écrit les fichiers de données. `npm start` s'y trouve aussi, sous la forme d'un petit serveur de prévisualisation.
- `public/` : la page elle-même. `schedule.js` place les véhicules, et `colouring.js`, lancé depuis `colour-worker.js`, calcule les couleurs.

## Développement

```bash
npm test
```

`PORT` change le port de prévisualisation.

Données : Envibus / CASA (ODbL) ; ZOU! / Région Sud, Lignes d'Azur, Palmbus, Zest et Sillages (Licence Ouverte 2.0) ; limites du département issues de france-geojson. Fond de carte : OpenFreeMap, OpenMapTiles, contributeurs OpenStreetMap.
