const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const fs = require('fs');

const PORT = process.env.PORT || 3000;

// Variables d'environnement pour GitHub
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_OWNER = process.env.GITHUB_REPO_OWNER;
const GITHUB_REPO = process.env.GITHUB_REPO_NAME;
const FILE_PATH = 'questions.json';

app.use(express.static('public'));

let questions = [];

// Chargement initial local au démarrage
function loadQuestions() {
  try {
    const data = fs.readFileSync('questions.json', 'utf8');
    questions = JSON.parse(data);
  } catch (err) {
    console.error("Erreur de lecture locale de questions.json", err);
    questions = [];
  }
}

// Sauvegarde locale ET envoi immédiat sur GitHub
async function saveQuestionsToGitHub() {
  // 1. Sauvegarde locale de sécurité
  try {
    fs.writeFileSync('questions.json', JSON.stringify(questions, null, 2), 'utf8');
  } catch (err) {
    console.error("Erreur d'écriture locale :", err);
  }

  // 2. Vérification des identifiants GitHub
  if (!GITHUB_TOKEN || !GITHUB_OWNER || !GITHUB_REPO) {
    console.warn("⚠️ Configuration GitHub manquante sur Render. Sauvegarde uniquement locale.");
    return;
  }

  try {
    const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${FILE_PATH}`;
    
    // Récupérer le SHA du fichier existant (requis par l'API GitHub pour modifier un fichier)
    const getRes = await fetch(url, {
      headers: { 'Authorization': `token ${GITHUB_TOKEN}` }
    });
    
    let sha = "";
    if (getRes.ok) {
      const fileData = await getRes.json();
      sha = fileData.sha;
    }

    // Encoder le nouveau contenu JSON en Base64
    const contentBase64 = Buffer.from(JSON.stringify(questions, null, 2)).toString('base64');

    // Envoyer le commit sur GitHub
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
      console.log("🚀 questions.json mis à jour avec succès sur GitHub !");
    } else {
      const errData = await putRes.json();
      console.error("❌ Erreur de l'API GitHub :", errData);
    }
  } catch (err) {
    console.error("❌ Échec de la connexion à l'API GitHub :", err);
  }
}

loadQuestions();

let players = {};
let currentQuestionIndex = -1;
let timeLeft = 10;
let timerInterval;
let isPaused = false;

io.on('connection', (socket) => {
  console.log('Un utilisateur s\'est connecté :', socket.id);

  socket.on('joinGame', (pseudo) => {
    players[socket.id] = { pseudo: pseudo, score: 0, hasAnswered: false };
    io.emit('updateLeaderboard', Object.values(players));
    
    let answeredCount = Object.values(players).filter(p => p.hasAnswered).length;
    let totalPlayers = Object.keys(players).length;
    io.emit('answerTallyUpdate', { answered: answeredCount, total: totalPlayers });
  });

  socket.on('nextQuestion', () => {
    if (currentQuestionIndex >= questions.length - 1) {
      currentQuestionIndex = -1;
    }

    currentQuestionIndex++;

    if (currentQuestionIndex < questions.length) {
      timeLeft = 10;
      isPaused = false;
      
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
        timeLeft: timeLeft
      });
      startTimer();
    } else {
      io.emit('gameOver', Object.values(players));
    }
  });

  socket.on('submitAnswer', (answerIndex) => {
    let player = players[socket.id];
    if (player && !player.hasAnswered && currentQuestionIndex >= 0) {
      player.hasAnswered = true; 
      if (answerIndex === questions[currentQuestionIndex].correctIndex) {
        player.score += questions[currentQuestionIndex].points || 10; 
      }
      let answeredCount = Object.values(players).filter(p => p.hasAnswered).length;
      let totalPlayers = Object.keys(players).length;
      io.emit('answerTallyUpdate', { answered: answeredCount, total: totalPlayers });
    }
  });

  socket.on('pauseTimer', () => { isPaused = true; });
  socket.on('resumeTimer', () => { isPaused = false; });

  // --- ADMINISTRATION SYNCHRONISÉE GITHUB ---

  socket.on('getQuestions', () => {
    socket.emit('questionsList', questions);
  });

  socket.on('saveQuestion', async (data) => {
    if (data.index >= 0) {
      questions[data.index] = data.question;
    } else {
      questions.push(data.question);
    }
    // Appel de la fonction de synchronisation avec GitHub
    await saveQuestionsToGitHub();
    io.emit('questionsList', questions); 
  });

  socket.on('deleteQuestion', async (index) => {
    questions.splice(index, 1);
    // Appel de la fonction de synchronisation avec GitHub
    await saveQuestionsToGitHub();
    io.emit('questionsList', questions);
  });

  socket.on('disconnect', () => {
    delete players[socket.id];
    io.emit('updateLeaderboard', Object.values(players));
    let answeredCount = Object.values(players).filter(p => p.hasAnswered).length;
    let totalPlayers = Object.keys(players).length;
    io.emit('answerTallyUpdate', { answered: answeredCount, total: totalPlayers });
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
        io.emit('updateLeaderboard', Object.values(players));
io.emit('timeUp', {
          correctIndex: questions[currentQuestionIndex].correctIndex,
          correctText: questions[currentQuestionIndex].options[questions[currentQuestionIndex].correctIndex],
          comment: questions[currentQuestionIndex].comment,
          isLastQuestion: currentQuestionIndex === questions.length - 1
        });
      }
    }
  }, 1000);
}

http.listen(PORT, () => {
  console.log(`Serveur Quizz démarré sur le port ${PORT}`);
});
