#!/usr/bin/env node

const jwt = require('jsonwebtoken');

// Same JWT secret as used in auth middleware
const JWT_SECRET = process.env.JWT_SECRET || 'claude-ui-dev-secret-change-in-production';

// Generate token for MCP service account (using existing user)
const mcpUser = {
  id: 1,
  username: 'Oculair'
};

const token = jwt.sign(
  { 
    userId: mcpUser.id, 
    username: mcpUser.username 
  },
  JWT_SECRET
  // No expiration - token lasts forever
);

console.log('MCP Service Token:', token);