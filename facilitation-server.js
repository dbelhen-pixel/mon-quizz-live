const fs = require('fs');
const path = require('path');
const express = require('express');
const nodemailer = require('nodemailer');

const DATA_DIR = path.join(__dirname, 'data', 'facilitation');
const SEQ_DIR = path.join(DATA_DIR, 'sequences');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

function ensureDirs() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(SEQ_DIR)) fs.mkdirSync(SEQ_DIR, { recursive: true });
  if (!fs.existsSync(CONFIG_FILE)) {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify({ publics: [], lieux: [] }, null, 2));
  }
}

function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fallback; }
}
function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}
function seqPath(id) { return path.join(SEQ_DIR, `${id}.json`); }
function newId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

function sanitizeText(str, max) {
  if (!str) return '';
  return String(str).slice(0, max);
}

// --- Etapes: durées par défaut, types autorisés ---
const TYPES_ETAPE = ['individuel', 'mise_en_commun', 'temps_libre'];

function listSequencesMeta() {
  ensureDirs();
  return fs.readdirSync(SEQ_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      const seq = readJSON(path.join(SEQ_DIR, f), null);
      if (!seq) return null;
      return {
        id: seq.id, nom: seq.nom, descriptif: seq.descriptif, public: seq.public, lieu: seq.lieu,
        archived: !!seq.archived, nbEtapes: (seq.etapes || []).length,
        createdAt: seq.createdAt, heureDemarrage: seq.heureDemarrage
      };
    })
    .filter(Boolean)
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

function defaultSequence() {
  return {
    id: newId(),
    nom: 'Nouvelle séquence',
    descriptif: '',
    public: '',
    lieu: '',
    heureDemarrage: '',
    emailFrom: process.env.SMTP_FROM || '',
    emailTo: '',
    groupes: [],
    etapes: [],
    archived: false,
    createdAt: Date.now(),
    results: {}
  };
}

// ---------- SESSIONS EN DIRECT (mémoire) ----------
// sessions[sequenceId] = { participants: {participantId:{pseudo, groupId, socketId, connected}},
//                          currentEtapeId, timer: {timeLeft, total, running, interval} }
const sessions = {};

function getSession(sequenceId) {
  if (!sessions[sequenceId]) {
    sessions[sequenceId] = { participants: {}, currentEtapeId: null, timer: { timeLeft: 0, total: 0, running: false } };
  }
  return sessions[sequenceId];
}

function connectedCounts(session) {
  const total = Object.values(session.participants).filter(p => p.connected).length;
  const parGroupe = {};
  Object.values(session.participants).forEach(p => {
    if (!p.connected) return;
    parGroupe[p.groupId || '_sans_groupe'] = (parGroupe[p.groupId || '_sans_groupe'] || 0) + 1;
  });
  return { total, parGroupe };
}

function nonParticipants(session, seq, etapeId) {
  const res = (seq.results[etapeId] && seq.results[etapeId].submissions) || {};
  return Object.entries(session.participants)
    .filter(([pid, p]) => p.connected && !res[pid])
    .map(([pid, p]) => p.pseudo);
}

function buildExportRows(seq) {
  // renvoie un tableau de lignes {etape, type, participant, contenu, tempsPasse, statut}
  const rows = [];
  (seq.etapes || []).forEach(etape => {
    const r = seq.results[etape.id] || {};
    const subs = r.submissions || {};
    const tempsPasse = r.dureeReelle ? `${r.dureeReelle}s` : '';
    if (etape.type === 'individuel') {
      Object.values(subs).forEach(s => {
        rows.push({ etape: etape.titre, type: etape.type, participant: s.pseudo, contenu: s.text, tempsPasse, statut: 'saisi' });
      });
      const groupeIds = new Set(Object.keys(subs));
    } else if (etape.type === 'mise_en_commun') {
      (r.retenues || []).forEach(it => {
        rows.push({ etape: etape.titre, type: etape.type, participant: it.groupeNom || '', contenu: it.text, tempsPasse, statut: 'retenu' });
      });
    }
  });
  return rows;
}

function toCSV(rows) {
  const header = ['Etape', 'Type', 'Participant/Groupe', 'Contenu', 'Temps passé', 'Statut'];
  const esc = v => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
  const lines = [header.map(esc).join(';')];
  rows.forEach(r => {
    lines.push([r.etape, r.type, r.participant, r.contenu, r.tempsPasse, r.statut].map(esc).join(';'));
  });
  return lines.join('\n');
}

function getMailer() {
  if (!process.env.SMTP_HOST) return null;
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '465', 10),
    secure: String(process.env.SMTP_SECURE) === 'true',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
  });
}

module.exports = function registerFacilitation(app, io) {
  ensureDirs();
  const router = express.Router();
  router.use(express.json());

  // --- CONFIG (publics / lieux) ---
  router.get('/config', (req, res) => {
    res.json(readJSON(CONFIG_FILE, { publics: [], lieux: [] }));
  });
  router.post('/config', (req, res) => {
    const current = readJSON(CONFIG_FILE, { publics: [], lieux: [] });
    const { publics, lieux } = req.body || {};
    if (Array.isArray(publics)) current.publics = [...new Set(publics.map(p => String(p).trim()).filter(Boolean))];
    if (Array.isArray(lieux)) current.lieux = [...new Set(lieux.map(l => String(l).trim()).filter(Boolean))];
    writeJSON(CONFIG_FILE, current);
    res.json(current);
  });

  // --- SEQUENCES CRUD ---
  router.get('/sequences', (req, res) => res.json(listSequencesMeta()));

  router.get('/sequences/:id', (req, res) => {
    const seq = readJSON(seqPath(req.params.id), null);
    if (!seq) return res.status(404).json({ error: 'Séquence introuvable' });
    res.json(seq);
  });

  router.post('/sequences', (req, res) => {
    const seq = defaultSequence();
    Object.assign(seq, {
      nom: sanitizeText(req.body.nom, 120) || 'Nouvelle séquence',
      descriptif: sanitizeText(req.body.descriptif, 500),
      public: req.body.public || '',
      lieu: req.body.lieu || '',
      heureDemarrage: req.body.heureDemarrage || '',
      emailTo: req.body.emailTo || '',
      emailFrom: req.body.emailFrom || process.env.SMTP_FROM || ''
    });
    writeJSON(seqPath(seq.id), seq);
    res.json(seq);
  });

  router.put('/sequences/:id', (req, res) => {
    const seq = readJSON(seqPath(req.params.id), null);
    if (!seq) return res.status(404).json({ error: 'Séquence introuvable' });
    const b = req.body || {};
    ['nom', 'descriptif', 'public', 'lieu', 'heureDemarrage', 'emailTo', 'emailFrom'].forEach(k => {
      if (b[k] !== undefined) seq[k] = b[k];
    });
    if (Array.isArray(b.groupes)) seq.groupes = b.groupes;
    if (Array.isArray(b.etapes)) {
      seq.etapes = b.etapes.map(e => ({
        id: e.id || newId(),
        type: TYPES_ETAPE.includes(e.type) ? e.type : 'individuel',
        titre: sanitizeText(e.titre, 120),
        duree: parseInt(e.duree, 10) || 300,
        consignes: sanitizeText(e.consignes, 300),
        sourceEtapeId: e.sourceEtapeId || null,
        message: sanitizeText(e.message, 300)
      }));
    }
    writeJSON(seqPath(seq.id), seq);
    res.json(seq);
  });

  router.delete('/sequences/:id', (req, res) => {
    const p = seqPath(req.params.id);
    if (fs.existsSync(p)) fs.unlinkSync(p);
    res.json({ ok: true });
  });

  router.post('/sequences/:id/dupliquer', (req, res) => {
    const seq = readJSON(seqPath(req.params.id), null);
    if (!seq) return res.status(404).json({ error: 'Séquence introuvable' });
    const copy = JSON.parse(JSON.stringify(seq));
    copy.id = newId();
    copy.nom = seq.nom + ' (copie)';
    copy.archived = false;
    copy.createdAt = Date.now();
    copy.results = {};
    writeJSON(seqPath(copy.id), copy);
    res.json(copy);
  });

  router.post('/sequences/:id/archiver', (req, res) => {
    const seq = readJSON(seqPath(req.params.id), null);
    if (!seq) return res.status(404).json({ error: 'Séquence introuvable' });
    seq.archived = !seq.archived;
    writeJSON(seqPath(seq.id), seq);
    res.json(seq);
  });

  // --- IMPACT CHECK avant suppression d'une étape ---
  router.get('/sequences/:id/impact/:etapeId', (req, res) => {
    const seq = readJSON(seqPath(req.params.id), null);
    if (!seq) return res.status(404).json({ error: 'Séquence introuvable' });
    const liees = (seq.etapes || []).filter(e => e.sourceEtapeId === req.params.etapeId);
    res.json({ impact: liees.length > 0, etapesLiees: liees.map(e => e.titre) });
  });

  // --- EXPORT CSV ---
  router.get('/sequences/:id/export.csv', (req, res) => {
    const seq = readJSON(seqPath(req.params.id), null);
    if (!seq) return res.status(404).send('Séquence introuvable');
    const rows = buildExportRows(seq);
    const csv = toCSV(rows);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="export-${seq.nom.replace(/[^a-z0-9]/gi, '_')}.csv"`);
    res.send('\uFEFF' + csv);
  });

  // --- ENVOI EMAIL ---
  router.post('/sequences/:id/envoyer-email', async (req, res) => {
    const seq = readJSON(seqPath(req.params.id), null);
    if (!seq) return res.status(404).json({ error: 'Séquence introuvable' });
    const transporter = getMailer();
    if (!transporter) return res.status(400).json({ error: "Aucun service SMTP configuré (fichier .env)" });
    const dest = req.body.emailTo || seq.emailTo;
    const from = req.body.emailFrom || seq.emailFrom || process.env.SMTP_FROM;
    if (!dest) return res.status(400).json({ error: "Aucun destinataire défini pour cette séquence" });
    const rows = buildExportRows(seq);
    const csv = toCSV(rows);
    try {
      await transporter.sendMail({
        from,
        to: dest,
        subject: `Extraction facilitation - ${seq.nom}`,
        text: `Vous trouverez ci-joint l'extraction des travaux de la séquence "${seq.nom}".`,
        attachments: [{ filename: `export-${seq.nom.replace(/[^a-z0-9]/gi, '_')}.csv`, content: '\uFEFF' + csv }]
      });
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: 'Échec envoi email: ' + e.message });
    }
  });

  app.use('/facilitation/api', router);

  // ---------------- SOCKET.IO ----------------
  const nsp = io.of('/facilitation');

  nsp.on('connection', (socket) => {
    let currentSeqId = null;
    let currentParticipantId = null;
    let role = null; // 'admin' | 'participant'

    function seq() { return readJSON(seqPath(currentSeqId), null); }
    function saveSeq(s) { writeJSON(seqPath(currentSeqId), s); }

    function broadcastState() {
      const s = seq();
      if (!s) return;
      const session = getSession(currentSeqId);
      const counts = connectedCounts(session);
      nsp.to(currentSeqId).emit('etat:maj', {
        currentEtapeId: session.currentEtapeId,
        timer: { timeLeft: session.timer.timeLeft, total: session.timer.total, running: session.timer.running },
        connectes: counts,
        participants: Object.entries(session.participants).map(([pid, p]) => ({ id: pid, pseudo: p.pseudo, groupId: p.groupId, connected: p.connected })),
        nonParticipants: session.currentEtapeId ? nonParticipants(session, s, session.currentEtapeId) : []
      });
    }

    socket.on('admin:join', ({ sequenceId }) => {
      currentSeqId = sequenceId;
      role = 'admin';
      socket.join(sequenceId);
      const s = seq();
      if (!s) return socket.emit('erreur', 'Séquence introuvable');
      socket.emit('sequence:donnees', s);
      broadcastState();
    });

    socket.on('participant:join', ({ sequenceId, pseudo, participantId }) => {
      currentSeqId = sequenceId;
      role = 'participant';
      currentParticipantId = participantId || newId();
      socket.join(sequenceId);
      const s = seq();
      if (!s) return socket.emit('erreur', 'Séquence introuvable');
      const session = getSession(sequenceId);
      const existing = session.participants[currentParticipantId];
      session.participants[currentParticipantId] = {
        pseudo: sanitizeText(pseudo, 60) || (existing && existing.pseudo) || 'Participant',
        groupId: existing ? existing.groupId : null,
        socketId: socket.id,
        connected: true
      };
      socket.emit('participant:bienvenue', { participantId: currentParticipantId, sequence: s });
      const session2 = getSession(sequenceId);
      const etape = (s.etapes || []).find(e => e.id === session2.currentEtapeId);
      if (etape) socket.emit('etape:courante', { etape, results: s.results[etape.id] || {} });
      broadcastState();
    });

    socket.on('admin:demarrerEtape', ({ etapeId, duree }) => {
      const s = seq(); if (!s) return;
      const etape = (s.etapes || []).find(e => e.id === etapeId);
      if (!etape) return;
      const session = getSession(currentSeqId);
      session.currentEtapeId = etapeId;
      const d = parseInt(duree, 10) || etape.duree || 300;
      session.timer = { timeLeft: d, total: d, running: true, startedAt: Date.now() };
      s.results[etapeId] = s.results[etapeId] || { submissions: {}, retenues: [] };
      saveSeq(s);
      nsp.to(currentSeqId).emit('etape:courante', { etape, results: s.results[etapeId] });
      runTimer(currentSeqId);
      broadcastState();
    });

    socket.on('admin:timer', ({ action, seconds }) => {
      const session = getSession(currentSeqId);
      if (action === 'pause') session.timer.running = false;
      if (action === 'reprendre') session.timer.running = true;
      if (action === 'reinitialiser') session.timer.timeLeft = session.timer.total;
      if (action === 'modifier' && seconds != null) { session.timer.timeLeft = parseInt(seconds, 10); session.timer.total = Math.max(session.timer.total, session.timer.timeLeft); }
      broadcastState();
    });

    socket.on('participant:saisie', ({ etapeId, text }) => {
      const s = seq(); if (!s || !currentParticipantId) return;
      const session = getSession(currentSeqId);
      const p = session.participants[currentParticipantId];
      s.results[etapeId] = s.results[etapeId] || { submissions: {}, retenues: [] };
      s.results[etapeId].submissions[currentParticipantId] = {
        pseudo: p ? p.pseudo : 'Participant',
        groupId: p ? p.groupId : null,
        text: sanitizeText(text, 1000),
        submittedAt: Date.now()
      };
      saveSeq(s);
      broadcastState();
      nsp.to(currentSeqId).emit('miseEnCommun:maj', { etapeId, submissions: s.results[etapeId].submissions });
    });

    socket.on('admin:groupes:autoAssign', () => {
      const s = seq(); if (!s) return;
      const session = getSession(currentSeqId);
      const groupes = s.groupes || [];
      if (!groupes.length) return;
      const ids = Object.keys(session.participants).filter(pid => session.participants[pid].connected);
      ids.forEach((pid, i) => { session.participants[pid].groupId = groupes[i % groupes.length].id; });
      broadcastState();
      nsp.to(currentSeqId).emit('groupes:maj', { participants: session.participants });
    });

    socket.on('admin:groupes:assigner', ({ participantId, groupId }) => {
      const session = getSession(currentSeqId);
      if (session.participants[participantId]) {
        session.participants[participantId].groupId = groupId || null;
        broadcastState();
        nsp.to(currentSeqId).emit('groupes:maj', { participants: session.participants });
      }
    });

    socket.on('admin:miseEnCommun:ajouter', ({ etapeId, text, groupeNom }) => {
      const s = seq(); if (!s) return;
      s.results[etapeId] = s.results[etapeId] || { submissions: {}, retenues: [] };
      s.results[etapeId].retenues.push({ id: newId(), text: sanitizeText(text, 500), groupeNom: groupeNom || '', origine: 'ajout' });
      saveSeq(s);
      nsp.to(currentSeqId).emit('retenues:maj', { etapeId, retenues: s.results[etapeId].retenues });
    });

    socket.on('admin:miseEnCommun:retenir', ({ etapeId, text, groupeNom }) => {
      const s = seq(); if (!s) return;
      s.results[etapeId] = s.results[etapeId] || { submissions: {}, retenues: [] };
      s.results[etapeId].retenues.push({ id: newId(), text: sanitizeText(text, 500), groupeNom: groupeNom || '', origine: 'retenu' });
      saveSeq(s);
      nsp.to(currentSeqId).emit('retenues:maj', { etapeId, retenues: s.results[etapeId].retenues });
    });

    socket.on('admin:miseEnCommun:supprimer', ({ etapeId, itemId }) => {
      const s = seq(); if (!s || !s.results[etapeId]) return;
      s.results[etapeId].retenues = s.results[etapeId].retenues.filter(it => it.id !== itemId);
      saveSeq(s);
      nsp.to(currentSeqId).emit('retenues:maj', { etapeId, retenues: s.results[etapeId].retenues });
    });

    socket.on('admin:miseEnCommun:reordonner', ({ etapeId, itemId, direction }) => {
      const s = seq(); if (!s || !s.results[etapeId]) return;
      const arr = s.results[etapeId].retenues;
      const idx = arr.findIndex(it => it.id === itemId);
      if (idx < 0) return;
      const swapWith = direction === 'up' ? idx - 1 : idx + 1;
      if (swapWith < 0 || swapWith >= arr.length) return;
      [arr[idx], arr[swapWith]] = [arr[swapWith], arr[idx]];
      saveSeq(s);
      nsp.to(currentSeqId).emit('retenues:maj', { etapeId, retenues: arr });
    });

    socket.on('disconnect', () => {
      if (role === 'participant' && currentSeqId && currentParticipantId) {
        const session = getSession(currentSeqId);
        if (session.participants[currentParticipantId]) {
          session.participants[currentParticipantId].connected = false;
          broadcastState();
        }
      }
    });
  });

  function runTimer(sequenceId) {
    const session = getSession(sequenceId);
    if (session.interval) clearInterval(session.interval);
    session.interval = setInterval(() => {
      if (!session.timer.running) return;
      if (session.timer.timeLeft <= 0) return;
      session.timer.timeLeft -= 1;
      const pct = session.timer.total > 0 ? session.timer.timeLeft / session.timer.total : 0;
      let alerte = null;
      if (Math.abs(session.timer.timeLeft - Math.round(session.timer.total / 2)) === 0) alerte = 'moitie';
      else if (Math.abs(session.timer.timeLeft - Math.round(session.timer.total / 3)) === 0) alerte = 'tiers';
      else if (session.timer.timeLeft === 300) alerte = '5min';
      else if (session.timer.timeLeft === 120) alerte = '2min';
      nsp.to(sequenceId).emit('timer:tick', { timeLeft: session.timer.timeLeft, total: session.timer.total, alerte });
      if (session.timer.timeLeft <= 0) {
        session.timer.running = false;
        // enregistre la durée réelle passée sur l'étape en cours
        const s = readJSON(seqPath(sequenceId), null);
        if (s && session.currentEtapeId) {
          s.results[session.currentEtapeId] = s.results[session.currentEtapeId] || { submissions: {}, retenues: [] };
          s.results[session.currentEtapeId].dureeReelle = session.timer.total;
          writeJSON(seqPath(sequenceId), s);
        }
        nsp.to(sequenceId).emit('timer:fin', {});
      }
    }, 1000);
  }
};
