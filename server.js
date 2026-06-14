const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const fs = require('fs');

// Port d'écoute (Render utilise process.env.PORT)
const PORT = process.env.PORT || 3000;

app.use(express.static('public'));

// Chargement des questions depuis questions.json
let questions = [];
try {
  const data = fs.readFileSync('questions.json', 'utf8');
  questions = JSON.parse(data);
} catch (err) {
  console.error("Erreur de lecture de questions.json", err);
}

let players = {};
let currentQuestionIndex = -1;
let timeLeft = 10;
let timerInterval;
let isPaused = false;

io.on('connection', (socket) => {
  console.log('Un utilisateur s\'est connecté :', socket.id);

  // Le joueur rejoint la partie
  socket.on('joinGame', (pseudo) => {
    players[socket.id] = { pseudo: pseudo, score: 0, hasAnswered: false };
    io.emit('updateLeaderboard', Object.values(players));
    
    // Mise à jour du compteur pour l'animateur si un joueur rejoint
    let answeredCount = Object.values(players).filter(p => p.hasAnswered).length;
    let totalPlayers = Object.keys(players).length;
    io.emit('answerTallyUpdate', { answered: answeredCount, total: totalPlayers });
  });

  // L'animateur lance ou avance la question
  socket.on('nextQuestion', () => {
    // Si le quizz était arrivé à la fin et qu'on le relance, on revient au début
    if (currentQuestionIndex >= questions.length - 1) {
      currentQuestionIndex = -1;
    }

    currentQuestionIndex++;

    if (currentQuestionIndex < questions.length) {
      timeLeft = 10;
      isPaused = false;
      
      // Au tout premier lancement (première question), on remet les scores à 0
      if (currentQuestionIndex === 0) {
        for (let id in players) {
          players[id].score = 0;
        }
        io.emit('updateLeaderboard', Object.values(players));
      }

      // Réinitialiser le statut de réponse des joueurs pour la nouvelle question
      for(let id in players) players[id].hasAnswered = false;
      
      // On informe l'animateur que le compteur repart à 0 pour cette question
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

  // Le joueur répond
  socket.on('submitAnswer', (answerIndex) => {
    let player = players[socket.id];
    
    if (player && !player.hasAnswered && currentQuestionIndex >= 0) {
      player.hasAnswered = true; // On marque que le joueur a voté
      
      if (answerIndex === questions[currentQuestionIndex].correctIndex) {
        player.score += questions[currentQuestionIndex].points; 
      }
      
      // On compte combien de joueurs ont répondu et on met à jour l'animateur
      let answeredCount = Object.values(players).filter(p => p.hasAnswered).length;
      let totalPlayers = Object.keys(players).length;
      io.emit('answerTallyUpdate', { answered: answeredCount, total: totalPlayers });
    }
  });

  // Contrôles de l'animateur
  socket.on('pauseTimer', () => { isPaused = true; });
  socket.on('resumeTimer', () => { isPaused = false; });
  socket.on('stopTimer', () => {
    clearInterval(timerInterval);
    io.emit('timeStopped');
  });

  // Déconnexion
  socket.on('disconnect', () => {
    console.log('Utilisateur déconnecté :', socket.id);
    delete players[socket.id];
    io.emit('updateLeaderboard', Object.values(players));
    
    // Si un joueur quitte brutalement, on corrige le compteur de l'animateur
    let answeredCount = Object.values(players).filter(p => p.hasAnswered).length;
    let totalPlayers = Object.keys(players).length;
    io.emit('answerTallyUpdate', { answered: answeredCount, total: totalPlayers });
  });
});

// Fonction du chronomètre
function startTimer() {
  clearInterval(timerInterval);
  timerInterval = setInterval(() => {
    if (!isPaused) {
      timeLeft--;
      io.emit('timerUpdate', timeLeft);
      
      if (timeLeft <= 0) {
        clearInterval(timerInterval);
        
        // On révèle le classement mis à jour uniquement à la fin du temps
        io.emit('updateLeaderboard', Object.values(players));

        // On envoie la bonne réponse, le commentaire ET on vérifie si c'est la dernière question
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
