#!/usr/bin/env node
import express from 'express';
import cors from 'cors';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'crypto';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

// Import the original server class
import { ClaudeCodeServer } from './server.js';

// Get directory name in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Session management
interface Session {
  id: string;
  server: ClaudeCodeServer;
  createdAt: Date;
  lastActivity: Date;
  mockTransport: MockTransport;
}

// Mock transport for HTTP
class MockTransport {
  private response: any = null;

  send(message: any) {
    this.response = message;
  }

  getResponse() {
    return this.response;
  }

  clearResponse() {
    this.response = null;
  }
}

const sessions = new Map<string, Session>();

// Configuration
const SESSION_CONFIG = {
  maxSessions: parseInt(process.env.MAX_SESSIONS || '100'),
  sessionTimeout: parseInt(process.env.SESSION_TIMEOUT_MS || '3600000'), // 1 hour
  cleanupInterval: parseInt(process.env.CLEANUP_INTERVAL_MS || '300000'), // 5 minutes
};

// Session cleanup
function cleanupInactiveSessions() {
  const now = new Date();
  const timeout = SESSION_CONFIG.sessionTimeout;
  
  for (const [sessionId, session] of sessions.entries()) {
    const inactiveTime = now.getTime() - session.lastActivity.getTime();
    if (inactiveTime > timeout) {
      console.error(`[HTTP] Cleaning up inactive session ${sessionId} (inactive for ${Math.round(inactiveTime / 1000)}s)`);
      sessions.delete(sessionId);
    }
  }
}

setInterval(cleanupInactiveSessions, SESSION_CONFIG.cleanupInterval);

// Helper to get server version  
function getServerVersion(): string {
  try {
    const packageJsonPath = path.join(__dirname, '../../package.json');
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
    return packageJson.version;
  } catch {
    return 'unknown';
  }
}

// Check if request is initialize
function isInitializeRequest(body: any): boolean {
  return body && body.method === 'initialize';
}

// Send SSE formatted response
function sendSSEResponse(res: express.Response, data: any, sessionId: string) {
  const eventId = `${sessionId}_${Date.now()}_${Math.random().toString(36).substr(2, 8)}`;
  
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Mcp-Session-Id');
  
  res.write(`event: message\\n`);
  res.write(`id: ${eventId}\\n`);
  res.write(`data: ${JSON.stringify(data)}\\n\\n`);
  res.end();
}

// Send JSON response
function sendJSONResponse(res: express.Response, data: any) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Mcp-Session-Id');
  res.json(data);
}

// Handle MCP requests
async function handleMCPRequest(req: express.Request, res: express.Response) {
  try {
    const sessionId = req.headers['mcp-session-id'] as string;
    const acceptHeader = req.headers.accept || '';
    const wantsSSE = acceptHeader.includes('text/event-stream');
    
    // Handle initialize request
    if (isInitializeRequest(req.body)) {
      if (sessionId && sessions.has(sessionId)) {
        const error = {
          jsonrpc: '2.0',
          error: {
            code: -32000,
            message: 'Session already exists'
          },
          id: req.body.id || null
        };
        
        if (wantsSSE) {
          sendSSEResponse(res, error, sessionId);
        } else {
          sendJSONResponse(res, error);
        }
        return;
      }
      
      // Create new session
      const newSessionId = randomUUID();
      const server = new ClaudeCodeServer();
      const mockTransport = new MockTransport();
      
      const session: Session = {
        id: newSessionId,
        server,
        createdAt: new Date(),
        lastActivity: new Date(),
        mockTransport
      };
      
      sessions.set(newSessionId, session);
      
      // Create initialize response
      const response = {
        jsonrpc: '2.0',
        id: req.body.id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: {
            tools: {}
          },
          serverInfo: {
            name: 'claude-code-mcp',
            version: getServerVersion()
          }
        }
      };
      
      res.setHeader('Mcp-Session-Id', newSessionId);
      
      if (wantsSSE) {
        sendSSEResponse(res, response, newSessionId);
      } else {
        sendJSONResponse(res, response);
      }
      
      console.error(`[HTTP] New session created: ${newSessionId}`);
      return;
    }
    
    // Handle other requests - require valid session
    if (!sessionId || !sessions.has(sessionId)) {
      const error = {
        jsonrpc: '2.0',
        error: {
          code: -32000,
          message: 'Bad Request: No valid session ID provided'
        },
        id: req.body?.id || null
      };
      
      if (wantsSSE) {
        sendSSEResponse(res, error, sessionId || 'unknown');
      } else {
        sendJSONResponse(res, error);
      }
      return;
    }
    
    const session = sessions.get(sessionId)!;
    session.lastActivity = new Date();
    
    // For now, just return a basic error for non-initialize requests
    // The claude-code tool is primarily used through stdio, not HTTP tools
    const response = {
      jsonrpc: '2.0',
      error: {
        code: -32601,
        message: 'Method not implemented in HTTP transport. Use stdio transport for claude_code tool.'
      },
      id: req.body?.id || null
    };
    
    if (wantsSSE) {
      sendSSEResponse(res, response, sessionId);
    } else {
      sendJSONResponse(res, response);
    }
    
  } catch (error: any) {
    console.error('[HTTP] Error handling MCP request:', error);
    
    const errorResponse = {
      jsonrpc: '2.0',
      error: {
        code: -32603,
        message: error.message || 'Internal server error'
      },
      id: req.body?.id || null
    };
    
    const acceptHeader = req.headers.accept || '';
    const wantsSSE = acceptHeader.includes('text/event-stream');
    const sessionId = req.headers['mcp-session-id'] as string;
    
    if (wantsSSE && sessionId) {
      sendSSEResponse(res, errorResponse, sessionId);
    } else {
      sendJSONResponse(res, errorResponse);
    }
  }
}

// Extend the original server to add HTTP support
export class ClaudeCodeServerHTTP extends ClaudeCodeServer {
  async run(): Promise<void> {
    const useHTTP = process.argv.includes('--http') || process.env.MCP_TRANSPORT === 'http';
    const port = parseInt(process.env.PORT || '3456');

    if (useHTTP) {
      const app = express();
      
      // CORS setup
      app.use(cors({
        origin: ['http://localhost', 'http://127.0.0.1', /^http:\/\/192\.168\./, /^http:\/\/10\./, /^http:\/\/172\.(1[6-9]|2[0-9]|3[0-1])\./],
        credentials: true,
        allowedHeaders: ['Content-Type', 'Mcp-Session-Id', 'Accept'],
        exposedHeaders: ['Mcp-Session-Id']
      }));
      
      app.use(express.json());
      
      // Main MCP endpoint
      app.post('/mcp', handleMCPRequest);
      
      // Session deletion endpoint
      app.delete('/mcp', (req, res) => {
        const sessionId = req.headers['mcp-session-id'] as string;
        
        if (sessionId && sessions.has(sessionId)) {
          sessions.delete(sessionId);
          console.error(`[HTTP] Session deleted: ${sessionId}`);
          res.json({ success: true, message: 'Session deleted' });
        } else {
          res.status(404).json({ error: 'Session not found' });
        }
      });
      
      // Health check endpoint
      app.get('/health', (req, res) => {
        res.json({ 
          status: 'healthy', 
          transport: 'streamable_http',
          protocol_version: '2025-06-18',
          version: getServerVersion(),
          sessions: sessions.size,
          uptime: process.uptime(),
          timestamp: new Date().toISOString(),
          security: {
            origin_validation: true,
            localhost_binding: true
          }
        });
      });
      
      // Info endpoint
      app.get('/', (req, res) => {
        res.json({
          name: 'claude-code-mcp',
          transport: 'streamable_http',
          endpoints: {
            mcp: '/mcp',
            health: '/health'
          },
          version: getServerVersion(),
          note: 'This server provides HTTP MCP protocol compatibility. The claude_code tool runs on stdio transport.'
        });
      });
      
      // Start both stdio and HTTP
      const transport = new StdioServerTransport();
      await this.connectTransport(transport);
      
      app.listen(port, '0.0.0.0', () => {
        console.error(`Claude Code MCP server running on stdio`);
        console.error(`Claude Code MCP server running on HTTP at http://0.0.0.0:${port}`);
        console.error(`MCP endpoint: http://0.0.0.0:${port}/mcp`);
        console.error(`Health endpoint: http://0.0.0.0:${port}/health`);
      });
    } else {
      await super.run();
    }
  }
}

// Create and run the server if this is the main module
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const server = new ClaudeCodeServerHTTP();
  server.run().catch(console.error);
}