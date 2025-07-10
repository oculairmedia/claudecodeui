#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import express from 'express';
import cors from 'cors';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

// Import the original server class
import { ClaudeCodeServer } from './server.js';

// Get directory name in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Store active servers and transports by session ID
const activeSessions: Record<string, { 
  server: ClaudeCodeServer, 
  transport: SSEServerTransport,
  createdAt: Date,
  lastActivity: Date
}> = {};

// Configuration for session management
const SESSION_CONFIG = {
  maxSessions: parseInt(process.env.MAX_SESSIONS || '100'),
  sessionTimeout: parseInt(process.env.SESSION_TIMEOUT_MS || '3600000'), // 1 hour default
  cleanupInterval: parseInt(process.env.CLEANUP_INTERVAL_MS || '300000'), // 5 minutes
};

// Session cleanup function
function cleanupInactiveSessions() {
  const now = new Date();
  const timeout = SESSION_CONFIG.sessionTimeout;
  
  for (const [sessionId, session] of Object.entries(activeSessions)) {
    const inactiveTime = now.getTime() - session.lastActivity.getTime();
    if (inactiveTime > timeout) {
      console.error(`[SSE] Cleaning up inactive session ${sessionId} (inactive for ${Math.round(inactiveTime / 1000)}s)`);
      try {
        session.transport.close();
      } catch (error) {
        console.error(`[SSE] Error closing transport for session ${sessionId}:`, error);
      }
      delete activeSessions[sessionId];
    }
  }
}

// Start periodic cleanup
setInterval(cleanupInactiveSessions, SESSION_CONFIG.cleanupInterval);

// Extend the original server to add SSE support
export class ClaudeCodeServerSSE extends ClaudeCodeServer {
  /**
   * Override the run method to support SSE transport
   */
  async run(): Promise<void> {
    const useSSE = process.argv.includes('--sse') || process.env.MCP_TRANSPORT === 'sse';
    const port = parseInt(process.env.PORT || '3001');

    if (useSSE) {
      // Create Express app for SSE
      const app = express();
      app.use(cors());
      app.use(express.json());

      // SSE endpoint for establishing the stream
      app.get('/sse', async (req, res) => {
        console.error('[SSE] Establishing SSE stream...');
        
        // Check session limit
        const sessionCount = Object.keys(activeSessions).length;
        if (sessionCount >= SESSION_CONFIG.maxSessions) {
          console.error(`[SSE] Session limit reached (${sessionCount}/${SESSION_CONFIG.maxSessions})`);
          res.status(503).send('Server at capacity. Please try again later.');
          return;
        }
        
        try {
          // Create a new SSE transport for this client
          const transport = new SSEServerTransport('/messages', res);
          
          // Create a new server instance for this connection
          const server = new ClaudeCodeServer();
          
          // Store both server and transport by session ID with metadata
          const sessionId = transport.sessionId;
          const now = new Date();
          activeSessions[sessionId] = { 
            server, 
            transport,
            createdAt: now,
            lastActivity: now
          };
          
          // Set up cleanup on close
          transport.onclose = () => {
            console.error(`[SSE] Transport closed for session ${sessionId}`);
            delete activeSessions[sessionId];
          };
          
          // Connect the transport to the new server instance
          await server.connectTransport(transport);
          console.error(`[SSE] Established stream with session ID: ${sessionId} (active sessions: ${sessionCount + 1})`);
        } catch (error) {
          console.error('[SSE] Error establishing stream:', error);
          if (!res.headersSent) {
            res.status(500).send('Error establishing SSE stream');
          }
        }
      });

      // Messages endpoint for receiving client messages
      app.post('/messages', async (req, res) => {
        const sessionId = req.query.sessionId as string;
        
        if (!sessionId) {
          console.error('[SSE] No session ID provided');
          res.status(400).send('Session ID required');
          return;
        }
        
        const session = activeSessions[sessionId];
        if (!session) {
          console.error(`[SSE] No session found for ${sessionId}`);
          res.status(404).send('Session not found');
          return;
        }
        
        // Update last activity timestamp
        session.lastActivity = new Date();
        
        try {
          // Handle the incoming message
          await session.transport.handlePostMessage(req, res, req.body);
        } catch (error) {
          console.error('[SSE] Error handling message:', error);
          if (!res.headersSent) {
            res.status(500).send('Error processing message');
          }
        }
      });

      // Add endpoint for Letta to send messages to tasks
      app.post('/messages/task/:taskId', async (req, res) => {
        const { taskId } = req.params;
        const { from, content, metadata } = req.body;
        
        if (!taskId || !from || !content) {
          res.status(400).json({ error: 'taskId, from, and content are required' });
          return;
        }
        
        // Import taskTracker
        const { taskTracker } = await import('./task-tracker.js');
        
        try {
          const task = taskTracker.getTask(taskId);
          if (!task) {
            res.status(404).json({ error: `No active task found with ID: ${taskId}` });
            return;
          }
          
          // Log the message for debugging
          console.error(`[TaskTracker] Letta agent ${from} sent message to task ${taskId}: ${content}`);
          
          res.json({
            success: true,
            message: 'Message noted for task',
            taskId,
            agentId: task.agentId,
            note: 'The Claude agent executing this task has been instructed to check for updates via prompt_agent'
          });
        } catch (error: any) {
          console.error(`[SSE] Error sending message to task ${taskId}:`, error);
          res.status(500).json({ error: error.message });
        }
      });

      // Add health check endpoint
      app.get('/health', (req, res) => {
        const now = new Date();
        const sessionStats = {
          total: Object.keys(activeSessions).length,
          oldest: null as string | null,
          newest: null as string | null,
          averageAge: 0,
        };
        
        if (sessionStats.total > 0) {
          const sessions = Object.entries(activeSessions);
          sessions.sort((a, b) => a[1].createdAt.getTime() - b[1].createdAt.getTime());
          
          sessionStats.oldest = `${Math.round((now.getTime() - sessions[0][1].createdAt.getTime()) / 1000)}s`;
          sessionStats.newest = `${Math.round((now.getTime() - sessions[sessions.length - 1][1].createdAt.getTime()) / 1000)}s`;
          
          const totalAge = sessions.reduce((sum, [_, session]) => 
            sum + (now.getTime() - session.createdAt.getTime()), 0);
          sessionStats.averageAge = Math.round(totalAge / sessions.length / 1000);
        }
        
        res.json({ 
          status: 'healthy', 
          transport: 'sse',
          version: this.getServerVersion(),
          sessions: {
            active: sessionStats.total,
            limit: SESSION_CONFIG.maxSessions,
            oldest: sessionStats.oldest,
            newest: sessionStats.newest,
            averageAgeSeconds: sessionStats.averageAge,
          },
          config: {
            sessionTimeoutMs: SESSION_CONFIG.sessionTimeout,
            cleanupIntervalMs: SESSION_CONFIG.cleanupInterval,
          }
        });
      });

      // Add info endpoint
      app.get('/', (req, res) => {
        res.json({
          name: 'claude-code-mcp',
          transport: 'sse',
          endpoints: {
            sse: '/sse',
            messages: '/messages',
            health: '/health',
            taskMessages: '/messages/task/:taskId'
          },
          version: this.getServerVersion()
        });
      });

      // Start Express server
      app.listen(port, '0.0.0.0', () => {
        console.error(`Claude Code MCP server running on SSE at http://0.0.0.0:${port}`);
        console.error(`SSE endpoint: http://0.0.0.0:${port}/sse`);
        console.error(`Message endpoint: http://0.0.0.0:${port}/messages`);
      });
    } else {
      // Use the parent class implementation for stdio
      await super.run();
    }
  }

  // Helper to get server version  
  private getServerVersion(): string {
    try {
      const packageJsonPath = path.join(__dirname, '../../package.json');
      const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
      return packageJson.version;
    } catch {
      return 'unknown';
    }
  }
}

// Create and run the server if this is the main module
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const server = new ClaudeCodeServerSSE();
  server.run().catch(console.error);
}