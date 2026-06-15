const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const fs = require('fs');

const PORT = process.env.PORT || 3000;

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_OWNER = process.env.GITHUB_REPO_OWNER;
const GITHUB_REPO = process.env.GITHUB_REPO_NAME;
const FILE_PATH = 'questions.json';

app.use(express.static('public'));

let questions = [];
let players = {};
let currentQuestionIndex = -1;
let timeLeft = 10;
let totalTimeForQuestion = 10; // Stocke le temps initial de la question en cours
let timerInterval;
let isPaused = false;
let currentAnswers = {}; // Stocke les réponses des joueurs pour la question en cours ({ socketId: answerIndex })

function loadQuestions() {
  try {
    const data = fs.readFileSync('questions.json', 'utf8');
    questions = JSON.parse(data);
  } catch (err) {
    console.error("Erreur de lecture locale de questions.json", err);
    questions = [];
  }
}

async function saveQuestionsToGitHub() {
  try {
    fs.writeFileSync('questions.json', JSON.stringify(questions, null, 2), 'utf8');
  } catch (err) {
    console.error("Erreur d'écriture locale :", err);
  }

  if (!GITHUB_TOKEN || !GITHUB_OWNER || !GITHUB_REPO) {
    console.warn("⚠️ Configuration GitHub manquante. Sauvegarde uniquement locale.");
    return;
  }

  try {
    const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${FILE_PATH}`;
    const getRes = await fetch(url, { headers: { 'Authorization': `token ${GITHUB_TOKEN}` } });
    
    let sha = "";
    if (getRes.ok) {
      const fileData = await getRes.json();
      sha = fileData.sha;
    }

    const contentBase64 = Buffer.from(JSON.stringify(questions, null, 2)).toString('base64');

    const putRes = await fetch(url, {
      method: 'PUT',
      headers: {
        'Authorization': `token ${GITHUB_TOKEN}`,
        'Content-Type': 'application/json',
        'User-Agent': 'Node-JS-Quizz-Server'
      },
      body: JSON.stringify({
        message: '📝 Mise à jour des questions depuis le panneau admin du Quizz',
        content: contentBase64,
        sha: sha
      })
    });

    if (putRes.ok) {
      console.log("🚀 File questions.json synchronisé sur GitHub !");
    } else {
      const errData = await putRes.json();
      console.error("❌ Erreur API GitHub :", errData);
    }
  } catch (err) {
    console.error("❌ Échec de la connexion à l'API GitHub :", err);
  }
}

loadQuestions();

io.on('connection', (socket) => {
  console.log('Utilisateur connecté :', socket.id);

  socket.on('joinGame', (pseudo) => {
    players[socket.id] = { pseudo: pseudo, score: 0, hasAnswered: false };
    io.emit('updateLeaderboard', Object.values(players));
    io.emit('answerTallyUpdate', { answered: Object.values(players).filter(p => p.hasAnswered).length, total: Object.keys(players).length });
  });

  socket.on('nextQuestion', () => {
    currentQuestionIndex++;

    if (currentQuestionIndex < questions.length) {
      // Configuration du temps personnalisé par question (par défaut 10s si non défini)
      totalTimeForQuestion = questions[currentQuestionIndex].timer || 10;
      timeLeft = totalTimeForQuestion;
      isPaused = false;
      currentAnswers = {}; // Réinitialisation des statistiques de réponses
      
      if (currentQuestionIndex === 0) {
        for (let id in players) players[id].score = 0;
        io.emit('updateLeaderboard', Object.values(players));
      }

      for(let id in players) players[id].hasAnswered = false;
      
      io.emit('answerTallyUpdate', { answered: 0, total: Object.keys(players).length });
      
      io.emit('newQuestion', {
        questionNumber: currentQuestionIndex + 1,
        totalQuestions: questions.length,
        question: questions[currentQuestionIndex].question,
        options: questions[currentQuestionIndex].options,
        image: questions[currentQuestionIndex].image || "",
        timeLeft: timeLeft
      });
      startTimer();
    } else {
      clearInterval(timerInterval); // Stoppe le minuteur de la dernière question s'il tournait encore
      io.emit('gameOver', Object.values(players));
      currentQuestionIndex = -1; // Réinitialisation pour permettre de relancer un nouveau quizz
    }
  });

  socket.on('submitAnswer', (answerIndex) => {
    let player = players[socket.id];
    if (player && !player.hasAnswered && currentQuestionIndex >= 0) {
      player.hasAnswered = true; 
      currentAnswers[socket.id] = answerIndex; // Enregistrement du choix pour les stats
      
      if (answerIndex === questions[currentQuestionIndex].correctIndex) {
        // Règle de rapidité : Base de 50% des points + bonus dégressif selon le temps restant
        let maxPoints = questions[currentQuestionIndex].points || 10;
        let timeRatio = timeLeft / totalTimeForQuestion;
        let earnedPoints = Math.round(maxPoints * (0.5 + 0.5 * timeRatio));
        player.score += (earnedPoints > 0 ? earnedPoints : 1);
      }
      
      let answeredCount = Object.values(players).filter(p => p.hasAnswered).length;
      let totalPlayers = Object.keys(players).length;
      io.emit('answerTallyUpdate', { answered: answeredCount, total: totalPlayers });
    }
  });

  socket.on('pauseTimer', () => { isPaused = true; });
  socket.on('resumeTimer', () => { isPaused = false; });

  // Réinitialisation complète du quizz à tout moment (remise à zéro des scores et retour à l'écran d'attente)
  socket.on('resetQuiz', () => {
    clearInterval(timerInterval);
    currentQuestionIndex = -1;
    isPaused = false;
    currentAnswers = {};
    timeLeft = 10;
    totalTimeForQuestion = 10;

    for (let id in players) {
      players[id].score = 0;
      players[id].hasAnswered = false;
    }

    io.emit('updateLeaderboard', Object.values(players));
    io.emit('answerTallyUpdate', { answered: 0, total: Object.keys(players).length });
    io.emit('quizReset');
  });

  // --- INTERFACE ADMIN ---
  socket.on('getQuestions', () => { socket.emit('questionsList', questions); });

  socket.on('saveQuestion', async (data) => {
    if (data.index >= 0) {
      questions[data.index] = data.question;
    } else {
      questions.push(data.question);
    }
    await saveQuestionsToGitHub();
    io.emit('questionsList', questions); 
  });

  socket.on('deleteQuestion', async (index) => {
    questions.splice(index, 1);
    await saveQuestionsToGitHub();
    io.emit('questionsList', questions);
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

        // Compilation des statistiques de vote pour cette question
        let stats = new Array(questions[currentQuestionIndex].options.length).fill(0);
        for (let sId in currentAnswers) {
          let ansIdx = currentAnswers[sId];
          if (ansIdx >= 0 && ansIdx < stats.length) stats[ansIdx]++;
        }

        io.emit('updateLeaderboard', Object.values(players));
        io.emit('timeUp', {
          correctIndex: questions[currentQuestionIndex].correctIndex,
          correctText: questions[currentQuestionIndex].options[questions[currentQuestionIndex].correctIndex],
          options: questions[currentQuestionIndex].options,
          comment: questions[currentQuestionIndex].comment,
          isLastQuestion: currentQuestionIndex === questions.length - 1,
          stats: stats
        });
      }
    }
  }, 1000);
}

http.listen(PORT, () => { console.log(`Serveur démarré sur le port ${PORT}`); });
