# MassUp V2

Application web 16+ pour organiser une prise de masse / prise de poids progressive avec suivi nutrition, entraînement, progression et coach IA.

## V2

- Authentification email/mot de passe
- PostgreSQL via `DATABASE_URL`
- Profil 16+
- Mode croissance 16–17 ans
- Dashboard
- Journal alimentaire
- Catalogue d'aliments intégré
- Suivi calories/macros pour adultes
- Suivi de poids
- Programmes d'entraînement
- Journal de séances
- Coach IA avec endpoint serveur
- Données persistantes en PostgreSQL
- Responsive mobile

## Déploiement Render

Créer un Web Service depuis ce dépôt.

Dockerfile : détecté automatiquement.

Variables d'environnement :
- `DATABASE_URL` : URL PostgreSQL Render
- `JWT_SECRET` : une longue chaîne aléatoire
- `OPENAI_API_KEY` : optionnel pour activer une vraie IA
- `OPENAI_MODEL` : optionnel, selon le modèle disponible sur ton compte

Le service écoute sur `PORT` fourni par Render.

### Base de données

Le serveur crée automatiquement les tables au démarrage.

## Sécurité

- Les mots de passe sont hashés avec bcrypt.
- Le JWT est signé côté serveur.
- La clé IA n'est jamais envoyée au navigateur.
- Ne mets jamais `OPENAI_API_KEY` dans `public/`.

## Produit / santé

MassUp est un outil d'organisation et de suivi, pas un dispositif médical.
Pour les 16–17 ans, l'application n'impose volontairement pas de cible calorique agressive ni de poids cible. Les recommandations doivent rester compatibles avec la croissance et l'utilisateur doit pouvoir demander conseil à un professionnel de santé.
