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

async function syncQuizToGitHub(name, data) {
  try {
    fs.writeFileSync(quizFilePath(name), JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    console.error("Erreur d'écriture locale :", err);
  }

  if (!GITHUB_TOKEN || !GITHUB_OWNER || !GITHUB_REPO) {
    console.warn("⚠️ Configuration GitHub manquante. Sauvegarde uniquement locale.");
    return;
  }

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
}

async function deleteQuizOnGitHub(name) {
  if (!GITHUB_TOKEN || !GITHUB_OWNER || !GITHUB_REPO) return;
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
  }

  io.emit('updateLeaderboard', Object.values(players));
  io.emit('answerTallyUpdate', { answered: 0, total: Object.keys(players).length });
  io.emit('quizReset');
}

io.on('connection', (socket) => {
  console.log('Utilisateur connecté :', socket.id);

  // Envoi de la liste des quizz disponibles dès la connexion
  socket.emit('quizList', { quizzes: quizList, active: currentQuizName });

  socket.on('joinGame', (pseudo) => {
    players[socket.id] = { pseudo: pseudo, score: 0, hasAnswered: false };
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
        for (let id in players) players[id].score = 0;
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
      if (answer === q.correctIndex) {
        // Règle de rapidité : Base de 50% des points + bonus dégressif selon le temps restant
        let maxPoints = q.points || 10;
        let timeRatio = timeLeft / totalTimeForQuestion;
        let earnedPoints = Math.round(maxPoints * (0.5 + 0.5 * timeRatio));
        player.score += (earnedPoints > 0 ? earnedPoints : 1);
      }
    } else if (qType === 'multiple') {
      // Scoring "tout ou rien" : la sélection doit correspondre EXACTEMENT aux bonnes réponses
      const correct = (q.correctIndexes || []).slice().sort((a, b) => a - b);
      const given = Array.isArray(answer) ? answer.slice().sort((a, b) => a - b) : [];
      const isCorrect = correct.length > 0 && correct.length === given.length && correct.every((v, i) => v === given[i]);
      if (isCorrect) {
        let maxPoints = q.points || 10;
        let timeRatio = timeLeft / totalTimeForQuestion;
        let earnedPoints = Math.round(maxPoints * (0.5 + 0.5 * timeRatio));
        player.score += (earnedPoints > 0 ? earnedPoints : 1);
      }
    } else if (qType === 'open') {
      // Question ouverte : pas de score, collecte pour le nuage de mots
      const text = String(answer || '').trim().slice(0, 40);
      if (text) {
        const key = text.toLowerCase();
        if (!wordCloudData[key]) wordCloudData[key] = { display: text, count: 0 };
        wordCloudData[key].count++;
      }

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

  socket.on('createQuiz', async (rawName) => {
    const name = sanitizeQuizName(rawName);
    if (!name || quizList.includes(name)) return;
    await syncQuizToGitHub(name, []);
    refreshQuizList();
    broadcastQuizList();
  });

  socket.on('duplicateQuiz', async ({ source, newName }) => {
    const name = sanitizeQuizName(newName);
    if (!name || quizList.includes(name) || !quizList.includes(source)) return;
    let data = [];
    try { data = JSON.parse(fs.readFileSync(quizFilePath(source), 'utf8')); } catch (err) {}
    await syncQuizToGitHub(name, data);
    refreshQuizList();
    broadcastQuizList();
  });

  socket.on('renameQuiz', async ({ oldName, newName }) => {
    const name = sanitizeQuizName(newName);
    if (!name || quizList.includes(name) || !quizList.includes(oldName)) return;
    let data = [];
    try { data = JSON.parse(fs.readFileSync(quizFilePath(oldName), 'utf8')); } catch (err) {}
    await syncQuizToGitHub(name, data);
    try { fs.unlinkSync(quizFilePath(oldName)); } catch (err) {}
    await deleteQuizOnGitHub(oldName);
    if (currentQuizName === oldName) {
      currentQuizName = name;
      questions = data;
    }
    refreshQuizList();
    broadcastQuizList();
  });

  socket.on('deleteQuiz', async (name) => {
    if (!quizList.includes(name) || quizList.length <= 1) return;
    try { fs.unlinkSync(quizFilePath(name)); } catch (err) {}
    await deleteQuizOnGitHub(name);
    refreshQuizList();

    if (currentQuizName === name) {
      loadQuiz(quizList[0]);
      resetGameState();
    }
    broadcastQuizList();
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

  socket.on('saveQuestion', async ({ quizName, index, question }) => {
    const name = quizList.includes(quizName) ? quizName : currentQuizName;
    let data = [];
    try { data = JSON.parse(fs.readFileSync(quizFilePath(name), 'utf8')); } catch (err) {}

    if (index >= 0) data[index] = question; else data.push(question);
    await syncQuizToGitHub(name, data);

    if (name === currentQuizName) questions = data;
    io.emit('questionsList', { quizName: name, questions: data });
  });

  socket.on('deleteQuestion', async ({ quizName, index }) => {
    const name = quizList.includes(quizName) ? quizName : currentQuizName;
    let data = [];
    try { data = JSON.parse(fs.readFileSync(quizFilePath(name), 'utf8')); } catch (err) {}

    data.splice(index, 1);
    await syncQuizToGitHub(name, data);

    if (name === currentQuizName) questions = data;
    io.emit('questionsList', { quizName: name, questions: data });
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
