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
  io.emit('newQuestion', {
        questionNumber: currentQuestionIndex + 1, // Le numéro de la question actuelle
        totalQuestions: questions.length,         // Le nombre total de questions
        question: questions[currentQuestionIndex].question,
        options: questions[currentQuestionIndex].options,
        timeLeft: timeLeft
      });

    currentQuestionIndex++;

    if (currentQuestionIndex < questions.length) {
      timeLeft = 10;
      isPaused = false;
      
      // CRUCIAL : Au tout premier lancement (première question), on remet les scores à 0
      if (currentQuestionIndex === 0) {
        for (let id in players) {
          players[id].score = 0;
        }
        // On envoie immédiatement le classement mis à jour (tous à 0) aux écrans
        io.emit('updateLeaderboard', Object.values(players));
      }

      // Réinitialiser le statut de réponse des joueurs pour la nouvelle question
      for(let id in players) players[id].hasAnswered = false;
      
      io.emit('newQuestion', {
        question: questions[currentQuestionIndex].question,
        options: questions[currentQuestionIndex].options,
        timeLeft: timeLeft
      });
// On envoie la bonne réponse, le commentaire ET on vérifie si c'est la dernière question
        io.emit('timeUp', {
          correctIndex: questions[currentQuestionIndex].correctIndex,
          comment: questions[currentQuestionIndex].comment,
          isLastQuestion: currentQuestionIndex === questions.length - 1
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
        // Les points sont calculés en secret sur le serveur
        player.score += questions[currentQuestionIndex].points; 
      }
      // LA LIGNE io.emit('updateLeaderboard') A ÉTÉ RETIRÉE D'ICI
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
        
        // CHANGEMENT : On révèle le classement mis à jour uniquement maintenant
        io.emit('updateLeaderboard', Object.values(players));

        // On envoie la bonne réponse et le commentaire
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
