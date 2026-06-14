const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const fs = require('fs');

app.use(express.static('public'));

let questions = JSON.parse(fs.readFileSync('questions.json', 'utf8'));
let currentQuestionIndex = -1;
let players = {}; 
let timerInterval;
let timeLeft = 10;
let isPaused = false;

io.on('connection', (socket) => {
  
  // Le joueur rejoint
  socket.on('joinGame', (pseudo) => {
    players[socket.id] = { pseudo: pseudo, score: 0, hasAnswered: false };
    io.emit('updateLeaderboard', Object.values(players));
  });

  // L'animateur lance ou avance la question
  socket.on('nextQuestion', () => {
    currentQuestionIndex++;
    if (currentQuestionIndex < questions.length) {
      timeLeft = 10;
      isPaused = false;
      // Réinitialiser le statut de réponse des joueurs
      for(let id in players) players[id].hasAnswered = false;
      
      io.emit('newQuestion', {
        question: questions[currentQuestionIndex].question,
        options: questions[currentQuestionIndex].options,
        timeLeft: timeLeft
      });
      startTimer();
    } else {
      io.emit('gameOver', Object.values(players));
    }
  });

  // Gestion du Chronomètre par l'animateur
  socket.on('pauseTimer', () => { isPaused = true; });
  socket.on('resumeTimer', () => { isPaused = false; });
  socket.on('stopTimer', () => { 
    clearInterval(timerInterval);
    io.emit('timeStopped');
  });

  // Le joueur répond
  socket.on('submitAnswer', (answerIndex) => {
    let player = players[socket.id];
    if (player && !player.hasAnswered && currentQuestionIndex >= 0) {
      player.hasAnswered = true;
      if (answerIndex === questions[currentQuestionIndex].correctIndex) {
        // Ajoute les points
        player.score += questions[currentQuestionIndex].points; 
      }
      io.emit('updateLeaderboard', Object.values(players));
    }
  });

  socket.on('disconnect', () => {
    delete players[socket.id];
    io.emit('updateLeaderboard', Object.values(players));
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
        // On envoie un objet contenant l'index ET le commentaire
        io.emit('timeUp', {
          correctIndex: questions[currentQuestionIndex].correctIndex,
          comment: questions[currentQuestionIndex].comment
        });
      }
    }
  }, 1000);
}

http.listen(process.env.PORT || 3000, () => {
  console.log('Serveur Quizz démarré');
});