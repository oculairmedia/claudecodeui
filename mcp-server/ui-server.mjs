#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';
import WebSocket from 'ws';
import { fileURLToPath } from 'url';
import path from 'path';
import { randomUUID } from 'crypto';
import { createMatrixBotFromEnv } from './matrix-client.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Server configuration
const SERVER_VERSION = "1.0.0";
const HTTP_PORT = process.env.MCP_HTTP_PORT || 3014;
const UI_SERVER_URL = process.env.CLAUDE_UI_SERVER_URL || 'http://127.0.0.1:3012';
const UI_WS_URL = process.env.CLAUDE_UI_WS_URL || 'ws://192.168.50.90:3012';
const MCP_AUTH_TOKEN = process.env.MCP_AUTH_TOKEN || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOjEsInVzZXJuYW1lIjoiT2N1bGFpciIsImlhdCI6MTc1MjIxOTIxMn0.hCkVJcEwmCnusosaizXOBr2ttPL0KKXqMPXJhh4-AV0';

// Debug mode
const debugMode = process.env.MCP_CLAUDE_DEBUG === 'true';

function debugLog(message, ...args) {
  if (debugMode) {
    console.error(`[DEBUG] ${message}`, ...args);
  }
}

// Simple in-memory event store for resumability
class InMemoryEventStore {
  constructor() {
    this.events = new Map();
  }

  async storeEvent(sessionId, event) {
    if (!this.events.has(sessionId)) {
      this.events.set(sessionId, []);
    }
    this.events.get(sessionId).push(event);
  }

  async append(sessionId, event) {
    return this.storeEvent(sessionId, event);
  }

  async getEvents(sessionId, afterId) {
    const sessionEvents = this.events.get(sessionId) || [];
    if (!afterId) {
      return sessionEvents;
    }
    const index = sessionEvents.findIndex(e => e.id === afterId);
    return index >= 0 ? sessionEvents.slice(index + 1) : sessionEvents;
  }
}

/**
 * MCP Server for Claude Code
 * Provides claude_code tool that executes through the UI backend
 */
class ClaudeCodeMCPServer {
  constructor() {
    this.server = new Server(
      {
        name: 'claude_code',
        version: SERVER_VERSION,
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.setupToolHandlers();
    this.server.onerror = (error) => console.error('[MCP Error]', error);
    
    // Initialize Matrix bot
    this.initializeMatrixBot();
  }

  /**
   * Initialize Matrix bot for notifications
   */
  async initializeMatrixBot() {
    try {
      this.matrixBot = createMatrixBotFromEnv();
      await this.matrixBot.initialize();
      console.log('[Matrix] Bot initialized successfully');
    } catch (error) {
      console.error('[Matrix] Failed to initialize bot:', error);
      this.matrixBot = null;
    }
  }

  /**
   * Set up the MCP tool handlers
   */
  setupToolHandlers() {
    // Define available tools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'claude_code',
          description: `Claude Code Agent: Your versatile multi-modal assistant for code, file, Git, and terminal operations via Claude CLI. Use \`workFolder\` for contextual execution.

• File ops: Create, read, (fuzzy) edit, move, copy, delete, list files, analyze/ocr images, file content analysis
    └─ e.g., "Create /tmp/log.txt with 'system boot'", "Edit main.py to replace 'debug_mode = True' with 'debug_mode = False'", "List files in /src", "Move a specific section somewhere else"

• Code: Generate / analyse / refactor / fix
    └─ e.g. "Generate Python to parse CSV→JSON", "Find bugs in my_script.py"

• Git: Stage ▸ commit ▸ push ▸ tag (any workflow)
    └─ "Commit '/workspace/src/main.java' with 'feat: user auth' to develop."

• Terminal: Run any CLI cmd or open URLs
    └─ "npm run build", "Open https://developer.mozilla.org"

• Web search + summarise content on-the-fly

• Multi-step workflows  (Version bumps, changelog updates, release tagging, etc.)

• GitHub integration  Create PRs, check CI status

• Confused or stuck on an issue? Ask Claude Code for a second opinion, it might surprise you!

**Prompt tips**

1. Be concise, explicit & step-by-step for complex tasks. No need for niceties, this is a tool to get things done.
2. For multi-line text, write it to a temporary file in the project root, use that file, then delete it.
3. If you get a timeout, split the task into smaller steps.
4. **Seeking a second opinion/analysis**: If you're stuck or want advice, you can ask \`claude_code\` to analyze a problem and suggest solutions. Clearly state in your prompt that you are looking for analysis only and no actual file modifications should be made.
5. If workFolder is set to the project path, there is no need to repeat that path in the prompt and you can use relative paths for files.
6. Claude Code is really good at complex multi-step file operations and refactorings and faster than your native edit features.
7. Combine file operations, README updates, and Git commands in a sequence.
8. Claude can do much more, just ask it!`,
          inputSchema: {
            type: 'object',
            properties: {
              prompt: {
                type: 'string',
                description: 'The detailed natural language prompt for Claude to execute.',
              },
              workFolder: {
                type: 'string',
                description: 'Mandatory when using file operations or referencing any file. The working directory for the Claude CLI execution. Must be an absolute path.',
              },
            },
            required: ['prompt'],
          },
        },
        {
          name: 'claude_code_async',
          description: `Async Claude Code: Execute Claude Code tasks asynchronously with Matrix/Letta notification.

• Executes Claude Code in the background
• Sends result to Matrix room or Letta agent via MCP
• Useful for long-running tasks

**Required parameters:**
• prompt: The task to execute
• agentId: The Letta agent ID to notify when complete
• lettaUrl: (optional) Letta base URL for the MCP endpoint, defaults to https://letta.oculair.ca

**Optional parameters:**
• workFolder: Working directory for execution
• keepTaskBlocks: Number of task blocks to keep in memory (1-50, default: 3)
• elevateBlock: Whether to elevate this task block to prevent cleanup
• request_heartbeat: Whether to request periodic heartbeat updates (default: true)

**Example usage:**
{
  "prompt": "Analyze the codebase and generate a comprehensive README.md",
  "agentId": "agent_123",
  "workFolder": "/workspace"
}`,
          inputSchema: {
            type: 'object',
            properties: {
              prompt: {
                type: 'string',
                description: 'The detailed natural language prompt for Claude to execute.',
              },
              agentId: {
                type: 'string',
                description: 'The Letta agent ID to notify when the task completes.',
              },
              workFolder: {
                type: 'string',
                description: 'Optional working directory for the Claude CLI execution. Must be an absolute path.',
              },
              lettaUrl: {
                type: 'string',
                description: 'Optional Letta base URL for the MCP endpoint. Defaults to https://letta.oculair.ca',
              },
              keepTaskBlocks: {
                type: 'integer',
                description: 'Number of task blocks to keep in memory (1-50, default: 3)',
                minimum: 1,
                maximum: 50,
              },
              elevateBlock: {
                type: 'boolean',
                description: 'Whether to elevate this task block to prevent cleanup',
              },
              requestHeartbeat: {
                type: 'boolean',
                description: 'Whether to request periodic heartbeat updates (default: true)',
              },
            },
            required: ['prompt', 'agentId'],
          },
        },
      ],
    }));

    // Handle tool calls
    this.server.setRequestHandler(CallToolRequestSchema, async (args) => {
      const { name, arguments: toolArgs } = args.params;

      if (name === 'claude_code') {
        return await this.handleClaudeCode(toolArgs);
      } else if (name === 'claude_code_async') {
        return await this.handleClaudeCodeAsync(toolArgs);
      } else {
        throw new McpError(ErrorCode.MethodNotFound, `Tool ${name} not found`);
      }
    });
  }

  /**
   * Handle sync claude_code tool
   */
  async handleClaudeCode(toolArgs) {
    // Validate prompt
    if (!toolArgs || typeof toolArgs.prompt !== 'string') {
      throw new McpError(ErrorCode.InvalidParams, 'Missing or invalid required parameter: prompt');
    }

    try {
      // Execute Claude Code through the UI backend
      const result = await this.executeClaudeCode(toolArgs.prompt, toolArgs.workFolder);
      
      return {
        content: [{
          type: 'text',
          text: typeof result === 'string' ? result : JSON.stringify(result),
        }],
      };
    } catch (error) {
      debugLog('Error executing Claude Code:', error);
      throw new McpError(ErrorCode.InternalError, `Claude Code execution failed: ${error.message}`);
    }
  }

  /**
   * Handle async claude_code_async tool
   */
  async handleClaudeCodeAsync(toolArgs) {
    // Validate required parameters
    if (!toolArgs || typeof toolArgs.prompt !== 'string') {
      throw new McpError(ErrorCode.InvalidParams, 'Missing or invalid required parameter: prompt');
    }
    if (!toolArgs.agentId || typeof toolArgs.agentId !== 'string') {
      throw new McpError(ErrorCode.InvalidParams, 'Missing or invalid required parameter: agentId');
    }

    try {
      // Generate task ID
      const taskId = `task_${randomUUID()}`;
      
      // Start async execution (don't await)
      this.executeClaudeCodeAsync(
        taskId,
        toolArgs.agentId,
        toolArgs.prompt,
        toolArgs.workFolder,
        toolArgs.lettaUrl || 'https://letta.oculair.ca',
        toolArgs.keepTaskBlocks || 3,
        toolArgs.elevateBlock || false,
        toolArgs.requestHeartbeat !== false
      ).catch(error => {
        console.error(`Async task ${taskId} failed:`, error);
      });

      return {
        content: [{
          type: 'text',
          text: `Async task started with ID: ${taskId}\nAgent: ${toolArgs.agentId}\nYou will receive a notification when the task completes.`,
        }],
      };
    } catch (error) {
      debugLog('Error starting async Claude Code:', error);
      throw new McpError(ErrorCode.InternalError, `Async Claude Code execution failed: ${error.message}`);
    }
  }

  /**
   * Execute Claude Code through the UI backend
   */
  async executeClaudeCode(prompt, workFolder) {
    debugLog('Executing Claude Code with prompt:', prompt);
    debugLog('Work folder:', workFolder);

    // First, ensure we have a project for the work folder
    let projectName = null;
    if (workFolder) {
      projectName = await this.ensureProject(workFolder);
    }

    // Now execute the command through the UI's chat interface
    return await this.executeThroughChat(prompt, projectName, workFolder);
  }

  /**
   * Ensure a project exists for the given path
   */
  async ensureProject(projectPath) {
    try {
      // Check if project already exists
      const response = await fetch(`${UI_SERVER_URL}/api/projects`);
      const projects = await response.json();
      
      // Look for existing project with this path
      const existingProject = projects.find(p => p.path === projectPath);
      if (existingProject) {
        debugLog('Using existing project:', existingProject.name);
        return existingProject.name;
      }

      // Create new project
      debugLog('Creating new project for path:', projectPath);
      const createResponse = await fetch(`${UI_SERVER_URL}/api/projects/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: projectPath }),
      });

      if (!createResponse.ok) {
        throw new Error(`Failed to create project: ${createResponse.statusText}`);
      }

      const newProject = await createResponse.json();
      debugLog('Created project:', newProject.name);
      return newProject.name;
    } catch (error) {
      debugLog('Error ensuring project:', error);
      // Continue without project if creation fails
      return null;
    }
  }

  /**
   * Execute command through the UI's chat interface
   */
  async executeThroughChat(prompt, projectName, workFolder) {
    return new Promise((resolve, reject) => {
      debugLog('Connecting to WebSocket...');
      
      // Connect to the UI's WebSocket with authentication token
      const ws = new WebSocket(`${UI_WS_URL}/ws?token=${MCP_AUTH_TOKEN}`);
      let responseBuffer = '';
      let isComplete = false;
      let sessionId = null;

      ws.on('open', () => {
        debugLog('WebSocket connected');
        
        // Send chat message
        const message = {
          type: 'claude-command',
          command: prompt,
          options: {
            projectPath: workFolder || '/opt/stacks',
            cwd: workFolder || '/opt/stacks', // Backend uses cwd for actual working directory
            projectName: projectName,
            sessionId: sessionId, // null for new session
            resume: false,
            toolsSettings: {
              allowedTools: ['Write', 'Read', 'Edit', 'MultiEdit', 'Bash', 'Task', 'Glob', 'Grep', 'LS'], // Pre-approve common tools
              disallowedTools: [],
              skipPermissions: false // Can't use this as root
            }
          }
        };
        
        debugLog('Sending message:', message);
        ws.send(JSON.stringify(message));
      });

      ws.on('message', (data) => {
        try {
          const message = JSON.parse(data.toString());
          debugLog('Received message type:', message.type);
          debugLog('Full message:', JSON.stringify(message).substring(0, 500)); // Log first 500 chars

          switch (message.type) {
            case 'session-created':
              sessionId = message.sessionId;
              debugLog('Session created:', sessionId);
              break;

            case 'claude-response':
              // Handle Claude's response
              debugLog('Claude response data:', JSON.stringify(message.data));
              if (message.data) {
                // Check if this is the final result
                if (message.data.type === 'result' && message.data.result) {
                  responseBuffer = message.data.result; // Use the final result
                  debugLog('Got final result:', responseBuffer);
                } 
                // Extract text from assistant messages
                else if (message.data.type === 'assistant' && message.data.message && message.data.message.content) {
                  const content = message.data.message.content;
                  for (const item of content) {
                    if (item.type === 'text' && item.text) {
                      responseBuffer += item.text + '\n';
                      debugLog('Added assistant text to buffer:', item.text);
                    }
                  }
                }
              }
              break;

            case 'claude-output':
              // Handle raw output
              if (message.data) {
                responseBuffer += message.data;
              }
              break;

            case 'claude-complete':
              isComplete = true;
              debugLog('Claude complete with exit code:', message.exitCode);
              ws.close();
              if (responseBuffer) {
                resolve(responseBuffer);
              } else {
                resolve('Command completed successfully');
              }
              break;

            case 'claude-error':
              debugLog('Claude error:', message.error);
              ws.close();
              reject(new Error(message.error || 'Unknown error'));
              break;

            case 'projects_updated':
              debugLog('Projects updated - ignoring');
              break;

            default:
              debugLog('Unknown message type:', message.type, 'Full message:', JSON.stringify(message));
          }
        } catch (error) {
          debugLog('Error parsing message:', error);
        }
      });

      ws.on('error', (error) => {
        debugLog('WebSocket error:', error);
        reject(error);
      });

      ws.on('close', () => {
        debugLog('WebSocket closed');
        if (!isComplete) {
          if (responseBuffer) {
            resolve(responseBuffer);
          } else {
            reject(new Error('Connection closed unexpectedly'));
          }
        }
      });

      // Set timeout
      const timeout = setTimeout(() => {
        if (!isComplete) {
          debugLog('Command timed out after 5 minutes');
          ws.close();
          if (responseBuffer) {
            resolve(responseBuffer);
          } else {
            reject(new Error('Command timed out after 5 minutes'));
          }
        }
      }, 5 * 60 * 1000); // 5 minutes timeout
      
      // Clear timeout on completion
      ws.on('close', () => {
        clearTimeout(timeout);
      });
    });
  }

  /**
   * Connect to a transport
   */
  async connectTransport(transport) {
    await this.server.connect(transport);
  }

  /**
   * Start MCP server with stdio transport
   */
  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('Claude Code MCP server running on stdio');
  }

  /**
   * Start MCP server with HTTP transport
   */
  async runHttp() {
    const app = express();
    
    // CORS setup
    app.use(cors({
      origin: ['http://localhost', 'http://127.0.0.1', /^http:\/\/192\.168\./, /^http:\/\/10\./, /^http:\/\/172\.(1[6-9]|2[0-9]|3[0-1])\./],
      credentials: true,
      allowedHeaders: ['Content-Type', 'Mcp-Session-Id', 'Accept'],
      exposedHeaders: ['Mcp-Session-Id']
    }));

    // Map to store transports by session ID
    const transports = {};
    const eventStore = new InMemoryEventStore();

    // Main MCP endpoint
    app.post('/mcp', async (req, res) => {
      console.error('[Streamable HTTP] Received MCP request');
      
      try {
        // Check for existing session ID
        const sessionId = req.headers['mcp-session-id'];
        let transport;
        
        if (sessionId && transports[sessionId]) {
          // Reuse existing transport
          transport = transports[sessionId];
        } else if (!sessionId) {
          // New session - create transport
          transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            eventStore, // Enable resumability
            onsessioninitialized: (sessionId) => {
              // Store the transport by session ID when session is initialized
              console.error(`[Streamable HTTP] Session initialized with ID: ${sessionId}`);
              transports[sessionId] = transport;
            }
          });
          
          // Create a new server instance for this session
          const server = new ClaudeCodeMCPServer();
          await server.connectTransport(transport);
          console.error('[Streamable HTTP] Server connected to transport');
        } else {
          // Session ID provided but not found
          res.status(400).send('Invalid session ID');
          return;
        }
        
        // Handle the request - the transport will parse the body
        await transport.handleRequest(req, res);
      } catch (error) {
        console.error('[Streamable HTTP] Error handling MCP request:', error);
        if (!res.headersSent) {
          res.status(500).send('Internal server error');
        }
      }
    });

    // SSE endpoint for resumability
    app.get('/mcp', async (req, res) => {
      const sessionId = req.headers['mcp-session-id'];
      
      console.error('[Streamable HTTP] SSE request for session:', sessionId);
      
      if (!sessionId || !transports[sessionId]) {
        res.status(400).send('Invalid or missing session ID');
        return;
      }
      
      // Check for Last-Event-ID header for resumability
      const lastEventId = req.headers['last-event-id'];
      
      try {
        await transports[sessionId].handleRequest(req, res, { lastEventId });
      } catch (error) {
        console.error('[Streamable HTTP] Error handling SSE request:', error);
        if (!res.headersSent) {
          res.status(500).send('Internal server error');
        }
      }
    });

    // Health check endpoint
    app.get('/health', (req, res) => {
      res.json({
        status: 'healthy',
        transport: 'streamable_http',
        protocol_version: '2024-11-05',
        sessions: Object.keys(transports).length,
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
      });
    });

    // Session deletion endpoint
    app.delete('/mcp', (req, res) => {
      const sessionId = req.headers['mcp-session-id'];
      
      if (sessionId && transports[sessionId]) {
        delete transports[sessionId];
        console.error(`[Streamable HTTP] Session deleted: ${sessionId}`);
        res.json({ success: true, message: 'Session deleted' });
      } else {
        res.status(404).json({ error: 'Session not found' });
      }
    });

    app.listen(HTTP_PORT, '0.0.0.0', () => {
      console.error(`Claude Code MCP server running on HTTP port ${HTTP_PORT}`);
      console.error(`[Streamable HTTP] MCP endpoint: http://0.0.0.0:${HTTP_PORT}/mcp`);
      console.error(`[Streamable HTTP] Health endpoint: http://0.0.0.0:${HTTP_PORT}/health`);
      console.error(`[Streamable HTTP] Session management:`);
      console.error(`[Streamable HTTP]   POST   /mcp - Initialize new session or handle request`);
      console.error(`[Streamable HTTP]   GET    /mcp - SSE endpoint for resumability`);
      console.error(`[Streamable HTTP]   DELETE /mcp - Delete session`);
    });
  }

  /**
   * Execute Claude Code asynchronously with Matrix/Letta notification
   */
  async executeClaudeCodeAsync(taskId, agentId, prompt, workFolder, lettaUrl, keepTaskBlocks, elevateBlock, requestHeartbeat) {
    console.log(`[Async] Starting task ${taskId} for agent ${agentId}`);
    
    try {
      // Execute the command and wait for completion
      const startTime = Date.now();
      const result = await this.executeClaudeCode(prompt, workFolder);
      const executionTime = Date.now() - startTime;
      
      console.log(`[Async] Task ${taskId} completed successfully in ${executionTime}ms`);
      
      // Send success notification to Matrix/Letta
      await this.sendAsyncNotification({
        agentId,
        taskId,
        callbackUrl: lettaUrl,
        result: `Task ${taskId} completed successfully:\n\n${result}`,
        success: true,
        executionTime
      });
      
    } catch (error) {
      console.error(`[Async] Task ${taskId} failed:`, error);
      
      // Send error notification to Matrix/Letta
      await this.sendAsyncNotification({
        agentId,
        taskId,
        callbackUrl: lettaUrl,
        result: `Task ${taskId} failed: ${error.message}`,
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Get Matrix room ID for an agent from the mapping service
   */
  async getAgentMatrixRoom(agentId) {
    try {
      const mappingUrl = process.env.AGENT_ROOM_MAPPING_URL || 'http://192.168.50.90:3002';
      console.log(`[Agent Mapping] Fetching primary room for agent: ${agentId}`);
      
      const response = await fetch(`${mappingUrl}/api/agent-room-mapping/${encodeURIComponent(agentId)}`);
      
      if (!response.ok) {
        if (response.status === 404) {
          console.log(`[Agent Mapping] No room mapping found for agent: ${agentId}`);
          return null;
        }
        throw new Error(`Agent room mapping service error: ${response.status}`);
      }
      
      const data = await response.json();
      
      if (data.success && data.data && data.data.roomId) {
        console.log(`[Agent Mapping] Primary room for agent ${agentId}: ${data.data.roomId}`);
        return data.data.roomId;
      }
      
      console.log(`[Agent Mapping] No primary room found for agent: ${agentId}`);
      return null;
    } catch (error) {
      console.error(`[Agent Mapping] Error fetching primary room for agent ${agentId}:`, error);
      return null;
    }
  }

  /**
   * Send async notification via Matrix/Letta
   */
  async sendAsyncNotification(data) {
    console.log(`[Async] Sending notification for task ${data.taskId} to agent ${data.agentId}`);
    console.log(`[Async] Success: ${data.success}`);
    console.log(`[Async] Result: ${data.result.substring(0, 200)}...`);
    
    try {
      let notificationSent = false;
      
      // Try Matrix notification first
      if (this.matrixBot) {
        try {
          const roomId = await this.getAgentMatrixRoom(data.agentId);
          if (roomId) {
            console.log(`[Matrix] Sending notification to room ${roomId} for agent ${data.agentId}`);
            
            const jobResult = {
              taskId: data.taskId,
              agentId: data.agentId,
              success: data.success,
              result: data.result,
              error: data.error,
              timestamp: new Date()
            };
            
            await this.matrixBot.sendJobResult(roomId, jobResult);
            console.log(`[Matrix] Notification sent successfully to room ${roomId}`);
            notificationSent = true;
          } else {
            console.log(`[Matrix] No room found for agent ${data.agentId}, trying Letta fallback`);
          }
        } catch (error) {
          console.error(`[Matrix] Failed to send Matrix notification:`, error);
        }
      } else {
        console.log(`[Matrix] Matrix bot not available, trying Letta fallback`);
      }
      
      // Fallback to Letta HTTP callback if Matrix failed
      if (!notificationSent) {
        try {
          const lettaResponse = await fetch(`${data.callbackUrl}/v1/agents/${data.agentId}/messages`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${process.env.LETTA_PASSWORD || ''}`
            },
            body: JSON.stringify({
              messages: [{
                role: 'user',
                content: `🔧 Claude Code Task Complete\n\nTask: ${data.taskId}\nStatus: ${data.success ? 'Success' : 'Failed'}\nResult: ${data.result}`
              }]
            })
          });
          
          if (lettaResponse.ok) {
            console.log(`[Letta] Fallback notification sent to agent ${data.agentId}`);
            notificationSent = true;
          } else {
            console.error(`[Letta] Failed to send fallback notification: ${lettaResponse.status}`);
          }
        } catch (error) {
          console.error(`[Letta] Fallback notification failed:`, error);
        }
      }
      
      // Log the notification details
      const notification = {
        taskId: data.taskId,
        agentId: data.agentId,
        success: data.success,
        timestamp: new Date().toISOString(),
        result: data.result,
        notificationSent,
        ...(data.error && { error: data.error }),
        ...(data.executionTime && { executionTime: data.executionTime })
      };
      
      console.log(`[Async] Notification ${notificationSent ? 'sent' : 'failed'}:`, JSON.stringify(notification, null, 2));
      
    } catch (error) {
      console.error(`[Async] Failed to send notification:`, error);
    }
  }
}

// Determine transport type and start server
const server = new ClaudeCodeMCPServer();

if (process.argv.includes('--http')) {
  server.runHttp().catch(console.error);
} else {
  server.run().catch(console.error);
}