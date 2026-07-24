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
function readJSON(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fallback; } }
function writeJSON(file, data) { fs.writeFileSync(file, JSON.stringify(data, null, 2)); }
function seqPath(id) { return path.join(SEQ_DIR, `${id}.json`); }
function newId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
function sanitizeText(str, max) { if (!str) return ''; return String(str).slice(0, max); }
function triAlpha(arr) { return [...arr].sort((a, b) => a.localeCompare(b, 'fr', { sensitivity: 'base' })); }

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
    id: newId(), nom: 'Nouvelle séquence', descriptif: '', public: '', lieu: '', heureDemarrage: '',
    emailFrom: process.env.SMTP_FROM || '', emailTo: '', groupes: [], etapes: [], archived: false,
    createdAt: Date.now(), results: {}
  };
}
function emptyResultsEntry() { return { submissions: {}, retenues: [] }; }

// ---------- ÉTAT DE LA SESSION EN DIRECT (une seule session globale, comme le Quizz) ----------
let currentSequenceId = null; // id de la séquence actuellement "activée" pour la session en direct
let liveSession = { participants: {}, currentEtapeId: null, timer: { timeLeft: 0, total: 0, running: false }, interval: null };

function connectedCounts() {
  const total = Object.values(liveSession.participants).filter(p => p.connected).length;
  const parGroupe = {};
  Object.values(liveSession.participants).forEach(p => {
    if (!p.connected) return;
    parGroupe[p.groupId || '_sans_groupe'] = (parGroupe[p.groupId || '_sans_groupe'] || 0) + 1;
  });
  return { total, parGroupe };
}
function nonParticipants(seq, etapeId) {
  const res = (seq.results[etapeId] && seq.results[etapeId].submissions) || {};
  return Object.entries(liveSession.participants)
    .filter(([pid, p]) => p.connected && (!res[pid] || !res[pid].items || res[pid].items.length === 0))
    .map(([pid, p]) => p.pseudo);
}

function buildExportRows(seq) {
  const rows = [];
  (seq.etapes || []).forEach(etape => {
    const r = seq.results[etape.id] || {};
    const subs = r.submissions || {};
    const tempsPasse = r.dureeReelle ? `${r.dureeReelle}s` : '';
    if (etape.type === 'individuel') {
      Object.values(subs).forEach(s => {
        (s.items || []).forEach(item => rows.push({ etape: etape.titre, type: etape.type, participant: s.pseudo, contenu: item.text, tempsPasse, statut: 'saisi' }));
      });
    } else if (etape.type === 'mise_en_commun') {
      (r.retenues || []).forEach(it => rows.push({ etape: etape.titre, type: etape.type, participant: it.groupeNom || '', contenu: it.text, tempsPasse, statut: 'retenu' }));
    }
  });
  return rows;
}
function toCSV(rows) {
  const header = ['Etape', 'Type', 'Participant/Groupe', 'Contenu', 'Temps passé', 'Statut'];
  const esc = v => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
  const lines = [header.map(esc).join(';')];
  rows.forEach(r => lines.push([r.etape, r.type, r.participant, r.contenu, r.tempsPasse, r.statut].map(esc).join(';')));
  return lines.join('\n');
}
function getMailer() {
  if (!process.env.SMTP_HOST) return null;
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST, port: parseInt(process.env.SMTP_PORT || '465', 10),
    secure: String(process.env.SMTP_SECURE) === 'true', auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
  });
}

// ---------- SYNCHRONISATION GITHUB (même mécanisme que le module Quizz) ----------
function githubConfigured() { return !!(process.env.GITHUB_TOKEN && process.env.GITHUB_REPO_OWNER && process.env.GITHUB_REPO_NAME); }
async function githubPutAsync(remotePath, dataObj, commitMessage) {
  if (!githubConfigured()) return;
  try {
    const url = `https://api.github.com/repos/${process.env.GITHUB_REPO_OWNER}/${process.env.GITHUB_REPO_NAME}/contents/${remotePath}`;
    const getRes = await fetch(url, { headers: { 'Authorization': `token ${process.env.GITHUB_TOKEN}` } });
    let sha = ''; if (getRes.ok) { const fileData = await getRes.json(); sha = fileData.sha; }
    const contentBase64 = Buffer.from(JSON.stringify(dataObj, null, 2)).toString('base64');
    const putRes = await fetch(url, {
      method: 'PUT',
      headers: { 'Authorization': `token ${process.env.GITHUB_TOKEN}`, 'Content-Type': 'application/json', 'User-Agent': 'Node-JS-Facilitation-Server' },
      body: JSON.stringify({ message: commitMessage, content: contentBase64, sha })
    });
    if (putRes.ok) console.log(`🚀 ${remotePath} synchronisé sur GitHub !`);
    else console.error('❌ Erreur API GitHub (PUT):', await putRes.json());
  } catch (err) { console.error('❌ Échec de la synchronisation GitHub :', err); }
}
async function githubDeleteAsync(remotePath, commitMessage) {
  if (!githubConfigured()) return;
  try {
    const url = `https://api.github.com/repos/${process.env.GITHUB_REPO_OWNER}/${process.env.GITHUB_REPO_NAME}/contents/${remotePath}`;
    const getRes = await fetch(url, { headers: { 'Authorization': `token ${process.env.GITHUB_TOKEN}` } });
    if (!getRes.ok) return;
    const fileData = await getRes.json();
    await fetch(url, {
      method: 'DELETE',
      headers: { 'Authorization': `token ${process.env.GITHUB_TOKEN}`, 'Content-Type': 'application/json', 'User-Agent': 'Node-JS-Facilitation-Server' },
      body: JSON.stringify({ message: commitMessage, sha: fileData.sha })
    });
    console.log(`🗑️ ${remotePath} supprimé sur GitHub.`);
  } catch (err) { console.error('❌ Échec de la suppression GitHub :', err); }
}
function syncSequenceToGitHub(seq) { githubPutAsync(`data/facilitation/sequences/${seq.id}.json`, seq, `📝 Séquence "${seq.nom}" mise à jour depuis l'outil Facilitation`); }
function deleteSequenceOnGitHub(id) { githubDeleteAsync(`data/facilitation/sequences/${id}.json`, `🗑️ Suppression de la séquence ${id}`); }
function syncConfigToGitHub(config) { githubPutAsync(`data/facilitation/config.json`, config, `⚙️ Mise à jour des publics/lieux (Facilitation)`); }

async function restaurerDepuisGitHubAuDemarrage() {
  if (!githubConfigured()) return;
  try {
    const url = `https://api.github.com/repos/${process.env.GITHUB_REPO_OWNER}/${process.env.GITHUB_REPO_NAME}/contents/data/facilitation/sequences`;
    const res = await fetch(url, { headers: { 'Authorization': `token ${process.env.GITHUB_TOKEN}` } });
    if (!res.ok) return;
    const files = await res.json();
    if (!Array.isArray(files)) return;
    for (const f of files) {
      if (!f.name.endsWith('.json')) continue;
      const localFile = path.join(SEQ_DIR, f.name);
      if (fs.existsSync(localFile)) continue;
      const fileRes = await fetch(f.download_url);
      if (!fileRes.ok) continue;
      fs.writeFileSync(localFile, await fileRes.text(), 'utf8');
      console.log(`⬇️  Séquence restaurée depuis GitHub : ${f.name}`);
    }
    const cfgUrl = `https://api.github.com/repos/${process.env.GITHUB_REPO_OWNER}/${process.env.GITHUB_REPO_NAME}/contents/data/facilitation/config.json`;
    const cfgRes = await fetch(cfgUrl, { headers: { 'Authorization': `token ${process.env.GITHUB_TOKEN}` } });
    if (cfgRes.ok) {
      const cfgData = await cfgRes.json();
      const cfgRes2 = await fetch(cfgData.download_url);
      if (cfgRes2.ok) fs.writeFileSync(CONFIG_FILE, await cfgRes2.text(), 'utf8');
    }
  } catch (err) { console.error('❌ Échec de la restauration depuis GitHub :', err); }
}

module.exports = function registerFacilitation(app, io) {
  ensureDirs();
  restaurerDepuisGitHubAuDemarrage();
  const router = express.Router();
  router.use(express.json());

  router.get('/config', (req, res) => {
    const c = readJSON(CONFIG_FILE, { publics: [], lieux: [] });
    res.json({ publics: triAlpha(c.publics || []), lieux: triAlpha(c.lieux || []) });
  });
  router.post('/config', (req, res) => {
    const current = readJSON(CONFIG_FILE, { publics: [], lieux: [] });
    const { publics, lieux } = req.body || {};
    if (Array.isArray(publics)) current.publics = triAlpha([...new Set(publics.map(p => String(p).trim()).filter(Boolean))]);
    if (Array.isArray(lieux)) current.lieux = triAlpha([...new Set(lieux.map(l => String(l).trim()).filter(Boolean))]);
    writeJSON(CONFIG_FILE, current);
    syncConfigToGitHub(current);
    res.json(current);
  });

  router.get('/sequences', (req, res) => res.json(listSequencesMeta().map(s => ({ ...s, active: s.id === currentSequenceId }))));

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
      public: req.body.public || '', lieu: req.body.lieu || '', heureDemarrage: req.body.heureDemarrage || '',
      emailTo: req.body.emailTo || '', emailFrom: req.body.emailFrom || process.env.SMTP_FROM || ''
    });
    writeJSON(seqPath(seq.id), seq);
    syncSequenceToGitHub(seq);
    res.json(seq);
  });

  router.put('/sequences/:id', (req, res) => {
    const seq = readJSON(seqPath(req.params.id), null);
    if (!seq) return res.status(404).json({ error: 'Séquence introuvable' });
    const b = req.body || {};
    ['nom', 'descriptif', 'public', 'lieu', 'heureDemarrage', 'emailTo', 'emailFrom'].forEach(k => { if (b[k] !== undefined) seq[k] = b[k]; });
    if (Array.isArray(b.groupes)) seq.groupes = b.groupes;
    if (Array.isArray(b.etapes)) {
      seq.etapes = b.etapes.map(e => ({
        id: e.id || newId(),
        type: TYPES_ETAPE.includes(e.type) ? e.type : 'individuel',
        titre: sanitizeText(e.titre, 120),
        duree: parseInt(e.duree, 10) || 300,
        consignes: sanitizeText(e.consignes, 300),
        sourceEtapeId: e.sourceEtapeId || null
      }));
    }
    writeJSON(seqPath(seq.id), seq);
    syncSequenceToGitHub(seq);
    res.json(seq);
  });

  router.delete('/sequences/:id', (req, res) => {
    const p = seqPath(req.params.id);
    if (fs.existsSync(p)) fs.unlinkSync(p);
    deleteSequenceOnGitHub(req.params.id);
    if (currentSequenceId === req.params.id) currentSequenceId = null;
    res.json({ ok: true });
  });

  router.post('/sequences/:id/dupliquer', (req, res) => {
    const seq = readJSON(seqPath(req.params.id), null);
    if (!seq) return res.status(404).json({ error: 'Séquence introuvable' });
    const copy = JSON.parse(JSON.stringify(seq));
    copy.id = newId(); copy.nom = seq.nom + ' (copie)'; copy.archived = false; copy.createdAt = Date.now(); copy.results = {};
    writeJSON(seqPath(copy.id), copy);
    syncSequenceToGitHub(copy);
    res.json(copy);
  });

  router.post('/sequences/:id/archiver', (req, res) => {
    const seq = readJSON(seqPath(req.params.id), null);
    if (!seq) return res.status(404).json({ error: 'Séquence introuvable' });
    seq.archived = !seq.archived;
    writeJSON(seqPath(seq.id), seq);
    syncSequenceToGitHub(seq);
    res.json(seq);
  });

  router.get('/sequences/:id/impact/:etapeId', (req, res) => {
    const seq = readJSON(seqPath(req.params.id), null);
    if (!seq) return res.status(404).json({ error: 'Séquence introuvable' });
    const liees = (seq.etapes || []).filter(e => e.sourceEtapeId === req.params.etapeId);
    res.json({ impact: liees.length > 0, etapesLiees: liees.map(e => e.titre) });
  });

  router.get('/sequences/:id/export.csv', (req, res) => {
    const seq = readJSON(seqPath(req.params.id), null);
    if (!seq) return res.status(404).send('Séquence introuvable');
    const csv = toCSV(buildExportRows(seq));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="export-${seq.nom.replace(/[^a-z0-9]/gi, '_')}.csv"`);
    res.send('\uFEFF' + csv);
  });

  router.post('/sequences/:id/envoyer-email', async (req, res) => {
    const seq = readJSON(seqPath(req.params.id), null);
    if (!seq) return res.status(404).json({ error: 'Séquence introuvable' });
    const transporter = getMailer();
    if (!transporter) return res.status(400).json({ error: "Aucun service SMTP configuré (variables d'environnement manquantes)" });
    const dest = req.body.emailTo || seq.emailTo;
    const from = req.body.emailFrom || seq.emailFrom || process.env.SMTP_FROM;
    if (!dest) return res.status(400).json({ error: 'Aucun destinataire défini pour cette séquence' });
    const csv = toCSV(buildExportRows(seq));
    try {
      await transporter.sendMail({
        from, to: dest, subject: `Extraction facilitation - ${seq.nom}`,
        text: `Vous trouverez ci-joint l'extraction des travaux de la séquence "${seq.nom}".`,
        attachments: [{ filename: `export-${seq.nom.replace(/[^a-z0-9]/gi, '_')}.csv`, content: '\uFEFF' + csv }]
      });
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: 'Échec envoi email: ' + e.message }); }
  });

  app.use('/facilitation/api', router);

  // ---------------- SOCKET.IO : une session en direct unique, partagée par tout le monde ----------------
  const nsp = io.of('/facilitation');
  const ROOM = 'facilitation-live';
  const ADMIN_ROOM = 'facilitation-live-admin';

  function seqActive() { return currentSequenceId ? readJSON(seqPath(currentSequenceId), null) : null; }
  function saveActive(s) { if (currentSequenceId) writeJSON(seqPath(currentSequenceId), s); }

  function broadcastState() {
    const s = seqActive();
    const counts = connectedCounts();
    nsp.to(ROOM).emit('etat:maj', {
      sequenceActiveId: currentSequenceId,
      currentEtapeId: liveSession.currentEtapeId,
      timer: { timeLeft: liveSession.timer.timeLeft, total: liveSession.timer.total, running: liveSession.timer.running },
      connectes: counts,
      participants: Object.entries(liveSession.participants).map(([pid, p]) => ({ id: pid, pseudo: p.pseudo, groupId: p.groupId, connected: p.connected })),
      nonParticipants: (s && liveSession.currentEtapeId) ? nonParticipants(s, liveSession.currentEtapeId) : []
    });
  }

  nsp.on('connection', (socket) => {
    let role = null;
    let currentParticipantId = null;

    socket.on('admin:join', () => {
      role = 'admin';
      socket.join(ROOM); socket.join(ADMIN_ROOM);
      const s = seqActive();
      socket.emit('sequence:active', { sequence: s });
      if (s && liveSession.currentEtapeId) {
        const etape = (s.etapes || []).find(e => e.id === liveSession.currentEtapeId);
        if (etape) socket.emit('etape:courante', { etape, results: s.results[etape.id] || emptyResultsEntry() });
      }
      broadcastState();
    });

    // Depuis l'écran d'administration (bibliothèque de séquences) : active une séquence pour la session en direct.
    // Comme pour le Quizz : réinitialise la session en cours (groupes, étape en cours, résultats de la séquence).
    socket.on('admin:activerSequence', ({ sequenceId }) => {
      const s = readJSON(seqPath(sequenceId), null);
      if (!s) return socket.emit('erreur', 'Séquence introuvable');
      if (liveSession.interval) clearInterval(liveSession.interval);
      currentSequenceId = sequenceId;
      s.results = {};
      writeJSON(seqPath(sequenceId), s);
      liveSession.currentEtapeId = null;
      liveSession.timer = { timeLeft: 0, total: 0, running: false };
      Object.values(liveSession.participants).forEach(p => { p.groupId = null; });
      nsp.to(ROOM).emit('sequence:active', { sequence: s });
      broadcastState();
    });

    socket.on('participant:join', ({ pseudo, participantId }) => {
      role = 'participant';
      currentParticipantId = participantId || newId();
      socket.join(ROOM);
      const s = seqActive();
      const existing = liveSession.participants[currentParticipantId];
      liveSession.participants[currentParticipantId] = {
        pseudo: sanitizeText(pseudo, 60) || (existing && existing.pseudo) || 'Participant',
        groupId: existing ? existing.groupId : null,
        socketId: socket.id, connected: true
      };
      socket.emit('participant:bienvenue', { participantId: currentParticipantId, sequence: s });
      socket.emit('sequence:active', { sequence: s });
      const etape = (s && liveSession.currentEtapeId) ? (s.etapes || []).find(e => e.id === liveSession.currentEtapeId) : null;
      if (etape) {
        socket.emit('etape:courante', { etape, results: s.results[etape.id] || emptyResultsEntry() });
        if (etape.type === 'individuel') {
          const mine = (s.results[etape.id] && s.results[etape.id].submissions[currentParticipantId]) || { items: [] };
          socket.emit('mesIdees:maj', { etapeId: etape.id, items: mine.items || [] });
        }
      }
      broadcastState();
    });

    socket.on('admin:demarrerEtape', ({ etapeId, duree }) => {
      const s = seqActive(); if (!s) return;
      const etape = (s.etapes || []).find(e => e.id === etapeId);
      if (!etape) return;
      liveSession.currentEtapeId = etapeId;
      const d = parseInt(duree, 10) || etape.duree || 300;
      liveSession.timer = { timeLeft: d, total: d, running: true, startedAt: Date.now() };
      s.results[etapeId] = s.results[etapeId] || emptyResultsEntry();
      saveActive(s);
      nsp.to(ROOM).emit('etape:courante', { etape, results: s.results[etapeId] });
      runTimer();
      broadcastState();
    });

    socket.on('admin:timer', ({ action, seconds }) => {
      if (action === 'pause') liveSession.timer.running = false;
      if (action === 'reprendre') liveSession.timer.running = true;
      if (action === 'reinitialiser') liveSession.timer.timeLeft = liveSession.timer.total;
      if (action === 'modifier' && seconds != null) { liveSession.timer.timeLeft = parseInt(seconds, 10); liveSession.timer.total = Math.max(liveSession.timer.total, liveSession.timer.timeLeft); }
      broadcastState();
    });

    function envoyerEtatSaisies(etapeId, s) {
      const r = s.results[etapeId] || emptyResultsEntry();
      nsp.to(ADMIN_ROOM).emit('saisies:maj', { etapeId, submissions: r.submissions });
    }
    socket.on('participant:ajouterIdee', ({ etapeId, text }) => {
      const s = seqActive(); if (!s || !currentParticipantId) return;
      const p = liveSession.participants[currentParticipantId];
      s.results[etapeId] = s.results[etapeId] || emptyResultsEntry();
      const subs = s.results[etapeId].submissions;
      if (!subs[currentParticipantId]) subs[currentParticipantId] = { pseudo: p ? p.pseudo : 'Participant', groupId: p ? p.groupId : null, items: [] };
      subs[currentParticipantId].items.push({ id: newId(), text: sanitizeText(text, 500), updatedAt: Date.now() });
      saveActive(s);
      socket.emit('mesIdees:maj', { etapeId, items: subs[currentParticipantId].items });
      envoyerEtatSaisies(etapeId, s);
      broadcastState();
    });
    socket.on('participant:modifierIdee', ({ etapeId, itemId, text }) => {
      const s = seqActive(); if (!s || !currentParticipantId) return;
      const subs = (s.results[etapeId] || emptyResultsEntry()).submissions;
      const mine = subs[currentParticipantId]; if (!mine) return;
      const item = mine.items.find(i => i.id === itemId); if (!item) return;
      item.text = sanitizeText(text, 500); item.updatedAt = Date.now();
      saveActive(s);
      socket.emit('mesIdees:maj', { etapeId, items: mine.items });
      envoyerEtatSaisies(etapeId, s);
    });
    socket.on('participant:supprimerIdee', ({ etapeId, itemId }) => {
      const s = seqActive(); if (!s || !currentParticipantId) return;
      const subs = (s.results[etapeId] || emptyResultsEntry()).submissions;
      const mine = subs[currentParticipantId]; if (!mine) return;
      mine.items = mine.items.filter(i => i.id !== itemId);
      saveActive(s);
      socket.emit('mesIdees:maj', { etapeId, items: mine.items });
      envoyerEtatSaisies(etapeId, s);
      broadcastState();
    });

    socket.on('admin:groupes:autoAssign', () => {
      const s = seqActive(); if (!s) return;
      const groupes = s.groupes || [];
      if (!groupes.length) return;
      const compte = {}; groupes.forEach(g => { compte[g.id] = 0; });
      Object.values(liveSession.participants).forEach(p => { if (p.connected && p.groupId && compte[p.groupId] !== undefined) compte[p.groupId]++; });
      const sansGroupe = Object.keys(liveSession.participants).filter(pid => liveSession.participants[pid].connected && !liveSession.participants[pid].groupId);
      sansGroupe.forEach(pid => {
        let groupeCible = groupes[0].id, min = Infinity;
        groupes.forEach(g => { if (compte[g.id] < min) { min = compte[g.id]; groupeCible = g.id; } });
        liveSession.participants[pid].groupId = groupeCible;
        compte[groupeCible]++;
      });
      broadcastState();
    });
    socket.on('admin:groupes:assigner', ({ participantId, groupId }) => {
      if (liveSession.participants[participantId]) { liveSession.participants[participantId].groupId = groupId || null; broadcastState(); }
    });

    socket.on('admin:miseEnCommun:ajouter', ({ etapeId, text, groupeNom }) => {
      const s = seqActive(); if (!s) return;
      s.results[etapeId] = s.results[etapeId] || emptyResultsEntry();
      s.results[etapeId].retenues.push({ id: newId(), text: sanitizeText(text, 500), groupeNom: groupeNom || '', origine: 'ajout' });
      saveActive(s);
      nsp.to(ROOM).emit('retenues:maj', { etapeId, retenues: s.results[etapeId].retenues });
    });
    socket.on('admin:miseEnCommun:retenir', ({ etapeId, text, groupeNom }) => {
      const s = seqActive(); if (!s) return;
      s.results[etapeId] = s.results[etapeId] || emptyResultsEntry();
      s.results[etapeId].retenues.push({ id: newId(), text: sanitizeText(text, 500), groupeNom: groupeNom || '', origine: 'retenu' });
      saveActive(s);
      nsp.to(ROOM).emit('retenues:maj', { etapeId, retenues: s.results[etapeId].retenues });
    });
    socket.on('admin:miseEnCommun:supprimer', ({ etapeId, itemId }) => {
      const s = seqActive(); if (!s || !s.results[etapeId]) return;
      s.results[etapeId].retenues = s.results[etapeId].retenues.filter(it => it.id !== itemId);
      saveActive(s);
      nsp.to(ROOM).emit('retenues:maj', { etapeId, retenues: s.results[etapeId].retenues });
    });
    socket.on('admin:miseEnCommun:reordonner', ({ etapeId, itemId, direction }) => {
      const s = seqActive(); if (!s || !s.results[etapeId]) return;
      const arr = s.results[etapeId].retenues;
      const idx = arr.findIndex(it => it.id === itemId); if (idx < 0) return;
      const swapWith = direction === 'up' ? idx - 1 : idx + 1;
      if (swapWith < 0 || swapWith >= arr.length) return;
      [arr[idx], arr[swapWith]] = [arr[swapWith], arr[idx]];
      saveActive(s);
      nsp.to(ROOM).emit('retenues:maj', { etapeId, retenues: arr });
    });

    socket.on('disconnect', () => {
      if (role === 'participant' && currentParticipantId && liveSession.participants[currentParticipantId]) {
        liveSession.participants[currentParticipantId].connected = false;
        broadcastState();
      }
    });
  });

  function runTimer() {
    if (liveSession.interval) clearInterval(liveSession.interval);
    liveSession.interval = setInterval(() => {
      if (!liveSession.timer.running) return;
      if (liveSession.timer.timeLeft <= 0) return;
      liveSession.timer.timeLeft -= 1;
      let alerte = null;
      if (liveSession.timer.timeLeft === Math.round(liveSession.timer.total / 2)) alerte = 'moitie';
      else if (liveSession.timer.timeLeft === Math.round(liveSession.timer.total / 3)) alerte = 'tiers';
      else if (liveSession.timer.timeLeft === 300) alerte = '5min';
      else if (liveSession.timer.timeLeft === 120) alerte = '2min';
      nsp.to(ROOM).emit('timer:tick', { timeLeft: liveSession.timer.timeLeft, total: liveSession.timer.total, alerte });
      if (liveSession.timer.timeLeft <= 0) {
        liveSession.timer.running = false;
        const s = seqActive();
        if (s && liveSession.currentEtapeId) {
          s.results[liveSession.currentEtapeId] = s.results[liveSession.currentEtapeId] || emptyResultsEntry();
          s.results[liveSession.currentEtapeId].dureeReelle = liveSession.timer.total;
          saveActive(s);
        }
        nsp.to(ROOM).emit('timer:fin', {});
      }
    }, 1000);
  }
};
