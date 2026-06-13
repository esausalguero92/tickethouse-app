'use strict';
const jwt = require('jsonwebtoken');
const env = require('../config/env');

function verifyJwt(token) {
  try {
    return jwt.verify(token, env.JWT_SECRET);
  } catch {
    return null;
  }
}

function requireAdmin(req, res, next) {
  const token = req.header('x-admin-token');
  if (!token) return res.status(401).json({ error: 'token_required' });
  const payload = verifyJwt(token);
  if (!payload || !['admin', 'master_owner'].includes(payload.role)) {
    return res.status(401).json({ error: 'session_invalid' });
  }
  req.admin = payload;
  next();
}

function requireStaff(req, res, next) {
  const token = req.header('x-staff-token');
  if (!token) return res.status(401).json({ error: 'token_required' });
  const payload = verifyJwt(token);
  if (!payload || payload.role !== 'staff') {
    return res.status(401).json({ error: 'session_invalid' });
  }
  req.staff = payload;
  next();
}

module.exports = { verifyJwt, requireAdmin, requireStaff };
