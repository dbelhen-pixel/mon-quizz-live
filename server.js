const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const fs = require('fs');

const PORT = process.env.PORT || 3000;

app.use(express.static('public'));

let questions = [];

// Fonction pour charger les questions
function loadQuestions() {
  try {
    const data = fs.readFileSync('questions.json', 'utf8');
    questions = JSON.parse(data);
  } catch (err) {
    console.error("Erreur de lecture de questions.json", err);
    questions = [];
  }
}

// Fonction pour sauvegarder les questions dans le fichier
function saveQuestionsToFile() {
  try {
    fs.writeFileSync('questions.json', JSON.stringify(questions, null, 2), 'utf8');
  } catch (err) {
    console.error("Erreur d'écriture dans questions.json", err);
  }
}

// Chargement initial
loadQuestions();

let players = {};
let currentQuestionIndex = -1;
let timeLeft = 10;
let timerInterval;
let isPaused = false;

io.on('connection', (socket) => {
  console.log('Un utilisateur s\'est connecté :', socket.id);

  // --- PARTIE JOUEUR & ANIMATEUR ---

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

  // --- PARTIE ADMINISTRATION DES QUESTIONS ---

  socket.on('getQuestions', () => {
    socket.emit('questionsList', questions);
  });

  socket.on('saveQuestion', (data) => {
    if (data.index >= 0) {
      // Modification d'une question existante
      questions[data.index] = data.question;
    } else {
      // Ajout d'une nouvelle question
      questions.push(data.question);
    }
    saveQuestionsToFile();
    io.emit('questionsList', questions); // Met à jour l'affichage admin
  });

  socket.on('deleteQuestion', (index) => {
    questions.splice(index, 1);
    saveQuestionsToFile();
    io.emit('questionsList', questions);
  });

  // Déconnexion
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
