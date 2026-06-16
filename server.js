const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_OWNER = process.env.GITHUB_REPO_OWNER;
const GITHUB_REPO = process.env.GITHUB_REPO_NAME;

const QUIZ_DIR = path.join(__dirname, 'quizzes');

app.use(express.static('public'));

let quizList = [];          // Liste des noms de quizz disponibles (sans extension .json)
let currentQuizName = null; // Nom du quizz actuellement chargé pour la partie en direct
let questions = [];         // Questions du quizz actif

let players = {};
let currentQuestionIndex = -1;
let timeLeft = 10;
let totalTimeForQuestion = 10; // Stocke le temps initial de la question en cours
let timerInterval;
let isPaused = false;
let currentAnswers = {}; // Réponses des joueurs pour la question en cours ({ socketId: réponse })
let wordCloudData = {};   // Pour les questions ouvertes : { motNormalisé: { display, count } }

// --- GESTION DES FICHIERS DE QUIZZ ---

function quizFilePath(name) {
  return path.join(QUIZ_DIR, `${name}.json`);
}

function sanitizeQuizName(name) {
  if (!name) return "";
  return String(name).trim().replace(/[\/\\:*?"<>|]/g, '').slice(0, 60);
}

function refreshQuizList() {
  if (!fs.existsSync(QUIZ_DIR)) fs.mkdirSync(QUIZ_DIR, { recursive: true });
  quizList = fs.readdirSync(QUIZ_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => f.replace(/\.json$/, ''))
    .sort();
}

function initQuizzes() {
  if (!fs.existsSync(QUIZ_DIR)) fs.mkdirSync(QUIZ_DIR, { recursive: true });
  refreshQuizList();

  if (quizList.length === 0) {
    // Migration depuis l'ancien fichier unique questions.json (si présent)
    let initialData = [];
    const legacyPath = path.join(__dirname, 'questions.json');
    if (fs.existsSync(legacyPath)) {
      try {
        initialData = JSON.parse(fs.readFileSync(legacyPath, 'utf8'));
        console.log("📦 Migration de l'ancien questions.json vers quizzes/Quiz par défaut.json");
      } catch (err) {
        console.error("Erreur de lecture de l'ancien questions.json :", err);
      }
    }
    fs.writeFileSync(quizFilePath('Quiz par défaut'), JSON.stringify(initialData, null, 2), 'utf8');
    refreshQuizList();
  }

  loadQuiz(quizList[0]);
}

function loadQuiz(name) {
  try {
    questions = JSON.parse(fs.readFileSync(quizFilePath(name), 'utf8'));
  } catch (err) {
    console.error(`Erreur de chargement du quizz "${name}" :`, err);
    questions = [];
  }
  currentQuizName = name;
}

function saveQuizLocally(name, data) {
  fs.writeFileSync(quizFilePath(name), JSON.stringify(data, null, 2), 'utf8');
}

function syncQuizToGitHubAsync(name, data) {
  // Lancée "en arrière-plan" : ne bloque jamais le client en attendant la réponse de GitHub.
  if (!GITHUB_TOKEN || !GITHUB_OWNER || !GITHUB_REPO) {
    console.warn("⚠️ Configuration GitHub manquante. Sauvegarde uniquement locale.");
    return;
  }

  (async () => {
    try {
      const remotePath = `quizzes/${encodeURIComponent(name)}.json`;
      const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${remotePath}`;
      const getRes = await fetch(url, { headers: { 'Authorization': `token ${GITHUB_TOKEN}` } });

      let sha = "";
      if (getRes.ok) {
        const fileData = await getRes.json();
        sha = fileData.sha;
      }

      const contentBase64 = Buffer.from(JSON.stringify(data, null, 2)).toString('base64');

      const putRes = await fetch(url, {
        method: 'PUT',
        headers: {
          'Authorization': `token ${GITHUB_TOKEN}`,
          'Content-Type': 'application/json',
          'User-Agent': 'Node-JS-Quizz-Server'
        },
        body: JSON.stringify({
          message: `📝 Mise à jour du quizz "${name}" depuis le panneau admin`,
          content: contentBase64,
          sha: sha
        })
      });

      if (putRes.ok) {
        console.log(`🚀 Quizz "${name}" synchronisé sur GitHub !`);
      } else {
        const errData = await putRes.json();
        console.error("❌ Erreur API GitHub :", errData);
      }
    } catch (err) {
      console.error("❌ Échec de la connexion à l'API GitHub :", err);
    }
  })();
}

function deleteQuizOnGitHubAsync(name) {
  if (!GITHUB_TOKEN || !GITHUB_OWNER || !GITHUB_REPO) return;
  (async () => {
    try {
      const remotePath = `quizzes/${encodeURIComponent(name)}.json`;
      const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${remotePath}`;
      const getRes = await fetch(url, { headers: { 'Authorization': `token ${GITHUB_TOKEN}` } });
      if (!getRes.ok) return;
      const fileData = await getRes.json();

      await fetch(url, {
        method: 'DELETE',
        headers: {
          'Authorization': `token ${GITHUB_TOKEN}`,
          'Content-Type': 'application/json',
          'User-Agent': 'Node-JS-Quizz-Server'
        },
        body: JSON.stringify({
          message: `🗑️ Suppression du quizz "${name}" depuis le panneau admin`,
          sha: fileData.sha
        })
      });
      console.log(`🗑️ Quizz "${name}" supprimé sur GitHub.`);
    } catch (err) {
      console.error("❌ Échec de la suppression GitHub :", err);
    }
  })();
}

initQuizzes();

function broadcastQuizList() {
  io.emit('quizList', { quizzes: quizList, active: currentQuizName });
}

function resetGameState() {
  clearInterval(timerInterval);
  currentQuestionIndex = -1;
  isPaused = false;
  currentAnswers = {};
  wordCloudData = {};
  timeLeft = 10;
  totalTimeForQuestion = 10;

  for (let id in players) {
    players[id].score = 0;
    players[id].hasAnswered = false;
    players[id].history = [];
  }

  io.emit('updateLeaderboard', Object.values(players));
  io.emit('answerTallyUpdate', { answered: 0, total: Object.keys(players).length });
  io.emit('quizReset');
}

function sanitizeQuestion(q) {
  if (!q || typeof q !== 'object') return null;
  const type = ['single', 'multiple', 'open'].includes(q.type) ? q.type : 'single';
  const question = String(q.question || '').trim();
  if (!question) return null;

  const sanitized = {
    type: type,
    question: question.slice(0, 500),
    image: String(q.image || '').slice(0, 500),
    timer: (Number.isInteger(q.timer) && q.timer > 0) ? q.timer : 10,
    comment: String(q.comment || '').slice(0, 1000)
  };

  if (type !== 'open') {
    const options = Array.isArray(q.options) ? q.options.map(o => String(o).trim()).filter(o => o !== '').slice(0, 8) : [];
    if (options.length < 2) return null;
    sanitized.options = options;
    sanitized.points = (Number.isInteger(q.points) && q.points > 0) ? q.points : 10;

    if (type === 'multiple') {
      const idx = Array.isArray(q.correctIndexes) ? [...new Set(q.correctIndexes.filter(n => Number.isInteger(n) && n >= 0 && n < options.length))].sort((a, b) => a - b) : [];
      if (idx.length === 0) return null;
      sanitized.correctIndexes = idx;
    } else {
      const idx = Number.isInteger(q.correctIndex) ? q.correctIndex : -1;
      if (idx < 0 || idx >= options.length) return null;
      sanitized.correctIndex = idx;
    }
  }

  return sanitized;
}

io.on('connection', (socket) => {
  console.log('Utilisateur connecté :', socket.id);

  // Envoi de la liste des quizz disponibles dès la connexion
  socket.emit('quizList', { quizzes: quizList, active: currentQuizName });

  socket.on('joinGame', (pseudo) => {
    players[socket.id] = { pseudo: pseudo, score: 0, hasAnswered: false, history: [] };
    io.emit('updateLeaderboard', Object.values(players));
    io.emit('answerTallyUpdate', { answered: Object.values(players).filter(p => p.hasAnswered).length, total: Object.keys(players).length });
  });

  socket.on('nextQuestion', () => {
    currentQuestionIndex++;

    if (currentQuestionIndex < questions.length) {
      const q = questions[currentQuestionIndex];

      // Configuration du temps personnalisé par question (par défaut 10s si non défini)
      totalTimeForQuestion = q.timer || 10;
      timeLeft = totalTimeForQuestion;
      isPaused = false;
      currentAnswers = {}; // Réinitialisation des statistiques de réponses
      wordCloudData = {};  // Réinitialisation du nuage de mots

      if (currentQuestionIndex === 0) {
        for (let id in players) {
          players[id].score = 0;
          players[id].history = [];
        }
        io.emit('updateLeaderboard', Object.values(players));
      }

      for (let id in players) players[id].hasAnswered = false;

      io.emit('answerTallyUpdate', { answered: 0, total: Object.keys(players).length });

      io.emit('newQuestion', {
        questionNumber: currentQuestionIndex + 1,
        totalQuestions: questions.length,
        question: q.question,
        type: q.type || 'single',
        options: q.options || [],
        image: q.image || "",
        timeLeft: timeLeft
      });
      startTimer();
    } else {
      clearInterval(timerInterval); // Stoppe le minuteur de la dernière question s'il tournait encore
      io.emit('gameOver', Object.values(players));
      currentQuestionIndex = -1; // Réinitialisation pour permettre de relancer un nouveau quizz
    }
  });

  socket.on('submitAnswer', (answer) => {
    let player = players[socket.id];
    if (!player || player.hasAnswered || currentQuestionIndex < 0 || currentQuestionIndex >= questions.length) return;

    const q = questions[currentQuestionIndex];
    const qType = q.type || 'single';

    player.hasAnswered = true;
    currentAnswers[socket.id] = answer;

    if (qType === 'single') {
      let isCorrect = (answer === q.correctIndex);
      let earnedPoints = 0;
      if (isCorrect) {
        // Règle de rapidité : Base de 50% des points + bonus dégressif selon le temps restant
        let maxPoints = q.points || 10;
        let timeRatio = timeLeft / totalTimeForQuestion;
        earnedPoints = Math.round(maxPoints * (0.5 + 0.5 * timeRatio));
        if (earnedPoints <= 0) earnedPoints = 1;
        player.score += earnedPoints;
      }
      player.history.push({
        questionIndex: currentQuestionIndex,
        question: q.question,
        type: qType,
        givenAnswerText: (typeof answer === 'number' && q.options[answer] !== undefined) ? q.options[answer] : '(aucune réponse)',
        correctAnswerText: q.options[q.correctIndex],
        isCorrect: isCorrect,
        points: earnedPoints
      });
    } else if (qType === 'multiple') {
      // Scoring "tout ou rien" : la sélection doit correspondre EXACTEMENT aux bonnes réponses
      const correct = (q.correctIndexes || []).slice().sort((a, b) => a - b);
      const given = Array.isArray(answer) ? answer.slice().sort((a, b) => a - b) : [];
      const isCorrect = correct.length > 0 && correct.length === given.length && correct.every((v, i) => v === given[i]);
      let earnedPoints = 0;
      if (isCorrect) {
        let maxPoints = q.points || 10;
        let timeRatio = timeLeft / totalTimeForQuestion;
        earnedPoints = Math.round(maxPoints * (0.5 + 0.5 * timeRatio));
        if (earnedPoints <= 0) earnedPoints = 1;
        player.score += earnedPoints;
      }
      player.history.push({
        questionIndex: currentQuestionIndex,
        question: q.question,
        type: qType,
        givenAnswerText: given.length > 0 ? given.map(i => q.options[i]).join(' + ') : '(aucune réponse)',
        correctAnswerText: correct.map(i => q.options[i]).join(' + '),
        isCorrect: isCorrect,
        points: earnedPoints
      });
    } else if (qType === 'open') {
      // Question ouverte : pas de score, collecte pour le nuage de mots
      const text = String(answer || '').trim().slice(0, 40);
      if (text) {
        const key = text.toLowerCase();
        if (!wordCloudData[key]) wordCloudData[key] = { display: text, count: 0 };
        wordCloudData[key].count++;
      }

      player.history.push({
        questionIndex: currentQuestionIndex,
        question: q.question,
        type: qType,
        givenAnswerText: text || '(aucune réponse)',
        correctAnswerText: '(question ouverte, pas de bonne réponse)',
        isCorrect: null,
        points: 0
      });

      // Mise à jour en direct du nuage de mots pour tout le monde
      io.emit('wordCloudUpdate', {
        words: Object.values(wordCloudData).map(w => ({ text: w.display, count: w.count })),
        responses: Object.entries(currentAnswers).map(([sid, txt]) => ({
          pseudo: players[sid] ? players[sid].pseudo : '?',
          text: String(txt || '')
        }))
      });
    }

    let answeredCount = Object.values(players).filter(p => p.hasAnswered).length;
    let totalPlayers = Object.keys(players).length;
    io.emit('answerTallyUpdate', { answered: answeredCount, total: totalPlayers });
  });

  socket.on('pauseTimer', () => { isPaused = true; });
  socket.on('resumeTimer', () => { isPaused = false; });

  // Réinitialisation complète du quizz à tout moment (remise à zéro des scores et retour à l'écran d'attente)
  socket.on('resetQuiz', () => {
    resetGameState();
  });

  // --- BIBLIOTHÈQUE DE QUIZZ ---

  socket.on('getQuizList', () => {
    socket.emit('quizList', { quizzes: quizList, active: currentQuizName });
  });

  socket.on('createQuiz', (rawName) => {
    const name = sanitizeQuizName(rawName);
    if (!name || quizList.includes(name)) return;
    saveQuizLocally(name, []);
    refreshQuizList();
    broadcastQuizList();
    syncQuizToGitHubAsync(name, []);
  });

  // Création d'un nouveau quizz directement à partir de questions importées (ex: depuis un fichier Excel)
  socket.on('createQuizWithQuestions', ({ name: rawName, questions: rawQuestions }) => {
    let name = sanitizeQuizName(rawName);
    if (!name) return;

    // Si le nom existe déjà, on en propose un disponible automatiquement plutôt que d'échouer silencieusement
    let finalName = name;
    let suffix = 2;
    while (quizList.includes(finalName)) {
      finalName = `${name} (${suffix})`;
      suffix++;
    }

    const data = (Array.isArray(rawQuestions) ? rawQuestions : []).map(sanitizeQuestion).filter(q => q !== null);

    saveQuizLocally(finalName, data);
    refreshQuizList();
    broadcastQuizList();
    syncQuizToGitHubAsync(finalName, data);

    socket.emit('importResult', { success: true, quizName: finalName, count: data.length });
  });

  socket.on('duplicateQuiz', ({ source, newName }) => {
    const name = sanitizeQuizName(newName);
    if (!name || quizList.includes(name) || !quizList.includes(source)) return;
    let data = [];
    try { data = JSON.parse(fs.readFileSync(quizFilePath(source), 'utf8')); } catch (err) {}
    saveQuizLocally(name, data);
    refreshQuizList();
    broadcastQuizList();
    syncQuizToGitHubAsync(name, data);
  });

  socket.on('renameQuiz', ({ oldName, newName }) => {
    const name = sanitizeQuizName(newName);
    if (!name || quizList.includes(name) || !quizList.includes(oldName)) return;
    let data = [];
    try { data = JSON.parse(fs.readFileSync(quizFilePath(oldName), 'utf8')); } catch (err) {}
    saveQuizLocally(name, data);
    try { fs.unlinkSync(quizFilePath(oldName)); } catch (err) {}
    if (currentQuizName === oldName) {
      currentQuizName = name;
      questions = data;
    }
    refreshQuizList();
    broadcastQuizList();
    syncQuizToGitHubAsync(name, data);
    deleteQuizOnGitHubAsync(oldName);
  });

  socket.on('deleteQuiz', (name) => {
    if (!quizList.includes(name) || quizList.length <= 1) return;
    try { fs.unlinkSync(quizFilePath(name)); } catch (err) {}
    refreshQuizList();

    if (currentQuizName === name) {
      loadQuiz(quizList[0]);
      resetGameState();
    }
    broadcastQuizList();
    deleteQuizOnGitHubAsync(name);
  });

  socket.on('selectQuizForGame', (name) => {
    if (!quizList.includes(name)) return;
    loadQuiz(name);
    resetGameState();
    broadcastQuizList();
  });

  // --- GESTION DES QUESTIONS D'UN QUIZZ ---

  socket.on('getQuestions', (quizName) => {
    const name = quizList.includes(quizName) ? quizName : currentQuizName;
    let data = [];
    try { data = JSON.parse(fs.readFileSync(quizFilePath(name), 'utf8')); } catch (err) {}
    socket.emit('questionsList', { quizName: name, questions: data });
  });

  socket.on('saveQuestion', ({ quizName, index, question }) => {
    const name = quizList.includes(quizName) ? quizName : currentQuizName;
    let data = [];
    try { data = JSON.parse(fs.readFileSync(quizFilePath(name), 'utf8')); } catch (err) {}

    if (index >= 0) data[index] = question; else data.push(question);
    saveQuizLocally(name, data);

    if (name === currentQuizName) questions = data;
    io.emit('questionsList', { quizName: name, questions: data });

    syncQuizToGitHubAsync(name, data);
  });

  socket.on('deleteQuestion', ({ quizName, index }) => {
    const name = quizList.includes(quizName) ? quizName : currentQuizName;
    let data = [];
    try { data = JSON.parse(fs.readFileSync(quizFilePath(name), 'utf8')); } catch (err) {}

    data.splice(index, 1);
    saveQuizLocally(name, data);

    if (name === currentQuizName) questions = data;
    io.emit('questionsList', { quizName: name, questions: data });

    syncQuizToGitHubAsync(name, data);
  });

  // Import de questions (ex: depuis un fichier Excel) dans un quizz existant : ajout ou remplacement complet
  socket.on('importQuestions', ({ quizName, questions: rawQuestions, mode }) => {
    const name = quizList.includes(quizName) ? quizName : currentQuizName;
    if (!name) return;

    const imported = (Array.isArray(rawQuestions) ? rawQuestions : []).map(sanitizeQuestion).filter(q => q !== null);
    if (imported.length === 0) return;

    let data = [];
    if (mode !== 'replace') {
      try { data = JSON.parse(fs.readFileSync(quizFilePath(name), 'utf8')); } catch (err) {}
    }
    data = data.concat(imported);

    saveQuizLocally(name, data);

    if (name === currentQuizName) questions = data;
    io.emit('questionsList', { quizName: name, questions: data });

    syncQuizToGitHubAsync(name, data);
  });

  socket.on('disconnect', () => {
    delete players[socket.id];
    delete currentAnswers[socket.id];
    io.emit('updateLeaderboard', Object.values(players));
    io.emit('answerTallyUpdate', { answered: Object.values(players).filter(p => p.hasAnswered).length, total: Object.keys(players).length });
  });
});

function startTimer() {
  clearInterval(timerInterval);
  timerInterval = setInterval(() => {
    if (!isPaused) {
      timeLeft--;
      io.emit('timerUpdate', timeLeft);
      
      if (timeLeft <= 0) {
        clearInterval(timerInterval);

        // Sécurité : si l'index de question n'est plus valide (ex: quizz terminé), on ne fait rien
        if (currentQuestionIndex < 0 || currentQuestionIndex >= questions.length) return;

        const q = questions[currentQuestionIndex];
        const qType = q.type || 'single';
        const options = q.options || [];

        // Pour les joueurs n'ayant pas répondu à temps, on enregistre une entrée "aucune réponse" dans leur historique
        for (let id in players) {
          if (!(id in currentAnswers)) {
            let correctAnswerText;
            if (qType === 'single') correctAnswerText = options[q.correctIndex];
            else if (qType === 'multiple') correctAnswerText = (q.correctIndexes || []).map(i => options[i]).join(' + ');
            else correctAnswerText = '(question ouverte, pas de bonne réponse)';

            players[id].history.push({
              questionIndex: currentQuestionIndex,
              question: q.question,
              type: qType,
              givenAnswerText: '(aucune réponse)',
              correctAnswerText: correctAnswerText,
              isCorrect: qType === 'open' ? null : false,
              points: 0
            });
          }
        }

        // Compilation des statistiques de vote pour cette question
        let stats = new Array(options.length).fill(0);
        for (let sId in currentAnswers) {
          let ans = currentAnswers[sId];
          if (qType === 'multiple' && Array.isArray(ans)) {
            ans.forEach(idx => { if (idx >= 0 && idx < stats.length) stats[idx]++; });
          } else if (qType === 'single' && typeof ans === 'number') {
            if (ans >= 0 && ans < stats.length) stats[ans]++;
          }
        }

        io.emit('updateLeaderboard', Object.values(players));
        io.emit('timeUp', {
          type: qType,
          correctIndex: q.correctIndex,
          correctIndexes: q.correctIndexes || [],
          correctText: qType === 'single' ? options[q.correctIndex] : null,
          options: options,
          comment: q.comment,
          isLastQuestion: currentQuestionIndex === questions.length - 1,
          stats: stats,
          answeredCount: Object.keys(currentAnswers).length,
          wordCloud: qType === 'open' ? Object.values(wordCloudData).map(w => ({ text: w.display, count: w.count })) : [],
          responses: qType === 'open' ? Object.entries(currentAnswers).map(([sid, txt]) => ({
            pseudo: players[sid] ? players[sid].pseudo : '?',
            text: String(txt || '')
          })) : []
        });
      }
    }
  }, 1000);
}

http.listen(PORT, () => { console.log(`Serveur démarré sur le port ${PORT}`); });
