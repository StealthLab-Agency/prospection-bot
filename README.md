# 🤖 ProspectBot — Bot de Prospection

Trouve des vrais clients, compose des emails avec l'IA, envoie via Gmail, log tout.

---

## ⚡ Installation (5 minutes)

### 1. Installe Node.js
Télécharge sur https://nodejs.org (version LTS)

### 2. Installe les dépendances
Ouvre un terminal dans ce dossier et tape :
```
npm install
```

### 3. Lance l'app
```
npm start
```

### 4. Ouvre dans ton navigateur
```
http://localhost:3000
```

---

## 🔑 Configuration (dans l'app → Paramètres)

### Clé API Anthropic (Claude)
1. Va sur https://console.anthropic.com
2. Crée un compte si besoin
3. Va dans "API Keys" → "Create Key"
4. Copie la clé (commence par `sk-ant-`)
5. Colle-la dans Paramètres → Clé API Anthropic

### Gmail
1. Va sur https://myaccount.google.com/apppasswords
2. Connecte-toi à ton compte Google
3. Crée un "Mot de passe d'application" pour "Mail"
4. Copie le mot de passe à 16 caractères
5. Colle dans Paramètres → Mot de passe d'application

⚠️ N'utilise PAS ton vrai mot de passe Gmail, seulement le mot de passe d'application.

---

## 📁 Structure des fichiers

```
prospection-app/
├── server.js          ← Serveur Node.js
├── package.json       ← Dépendances
├── public/
│   └── index.html     ← Interface web
└── data/
    ├── config.json    ← Tes clés API (créé automatiquement)
    └── emails.json    ← Journal des emails (créé automatiquement)
```

---

## 🚀 Utilisation

1. **Trouver des clients** : Tape un type de business + ville → l'IA cherche sur le web
2. **Contacter** : Clique "Contacter →" sur une carte → prérempli automatiquement
3. **Générer l'email** : Choisis le service + ton → l'IA rédige un email personnalisé
4. **Envoyer** : Clique "Envoyer via Gmail" → envoyé et loggé
5. **Journal** : Voir tous tes envois, dates, contenus, statuts → exporter en CSV
