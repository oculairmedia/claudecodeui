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
import { claudeStatusMemory } from './claude-status-memory.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Server configuration
const SERVER_VERSION = "1.0.0";
const HTTP_PORT = process.env.MCP_HTTP_PORT || 3014;
const UI_SERVER_URL = process.env.CLAUDE_UI_SERVER_URL || 'http://127.0.0.1:3012';
const UI_WS_URL = process.env.CLAUDE_UI_WS_URL || 'ws://192.168.50.90:3012';
const MCP_AUTH_TOKEN = process.env.MCP_AUTH_TOKEN;

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

    // Initialize job tracker
    this.activeJobs = new Map();
    this.completedJobs = [];
    this.jobStats = {
      totalStarted: 0,
      totalCompleted: 0,
      totalFailed: 0,
      totalCheckpoints: 0,
      totalResumes: 0,
      startTime: new Date()
    };

    this.setupToolHandlers();
    this.server.onerror = (error) => console.error('[MCP Error]', error);
    
    // Initialize Matrix bot
    this.initializeMatrixBot();
    
    // Initialize status memory after a delay to ensure everything is ready
    setTimeout(() => this.initializeStatusMemory(), 5000);
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
   * Initialize Claude status memory integration
   */
  async initializeStatusMemory() {
    try {
      // Create a status tracker interface that matches the expected API
      const statusTracker = {
        getActiveJobs: () => Array.from(this.activeJobs.values()),
        getCompletedJobs: (limit = 10) => this.completedJobs.slice(0, limit),
        getStats: () => ({
          ...this.jobStats,
          uptime: Date.now() - this.jobStats.startTime.getTime(),
          activeJobCount: this.activeJobs.size,
          averageJobDuration: this.calculateAverageJobDuration()
        })
      };

      await claudeStatusMemory.initialize(statusTracker);
      console.log('[Status Memory] Initialized Claude status memory integration');
    } catch (error) {
      console.error('[Status Memory] Failed to initialize:', error);
    }
  }

  /**
   * Track a new job
   */
  trackJob(taskId, agentId, metadata = {}) {
    const job = {
      id: taskId,
      agentId,
      startTime: new Date(),
      status: 'running',
      ...metadata
    };
    
    this.activeJobs.set(taskId, job);
    this.jobStats.totalStarted++;
    
    // Trigger memory update
    claudeStatusMemory.onJobUpdate(taskId, agentId).catch(console.error);
    
    return job;
  }

  /**
   * Update job status
   */
  updateJob(taskId, updates) {
    const job = this.activeJobs.get(taskId);
    if (job) {
      Object.assign(job, updates, { lastUpdate: new Date() });
      
      // Track checkpoints
      if (updates.checkpointReached) {
        this.jobStats.totalCheckpoints++;
      }
      
      // Track resumes
      if (updates.resumed) {
        this.jobStats.totalResumes++;
      }
      
      // Trigger memory update
      claudeStatusMemory.onJobUpdate(taskId, job.agentId).catch(console.error);
    }
    return job;
  }

  /**
   * Complete a job
   */
  completeJob(taskId, result = {}) {
    const job = this.activeJobs.get(taskId);
    if (job) {
      job.endTime = new Date();
      job.duration = job.endTime - job.startTime;
      job.status = result.success ? 'completed' : 'failed';
      job.result = result;
      
      // Update stats
      if (result.success) {
        this.jobStats.totalCompleted++;
      } else {
        this.jobStats.totalFailed++;
      }
      
      // Move to completed history
      this.completedJobs.unshift(job);
      if (this.completedJobs.length > 100) {
        this.completedJobs.pop();
      }
      
      this.activeJobs.delete(taskId);
      
      // Trigger memory update
      claudeStatusMemory.onJobUpdate(taskId, job.agentId).catch(console.error);
    }
    return job;
  }

  /**
   * Calculate average job duration
   */
  calculateAverageJobDuration() {
    const completed = this.completedJobs.filter(job => job.duration);
    if (completed.length === 0) return 0;
    
    const totalDuration = completed.reduce((sum, job) => sum + job.duration, 0);
    return Math.round(totalDuration / completed.length);
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
          description: `Async Claude Code: Execute Claude Code tasks asynchronously with Matrix/Letta notification and iteration support.

• Executes Claude Code in the background
• Sends result to Matrix room or Letta agent via MCP
• Supports checkpoints and iterative feedback
• Can resume from previous sessions

**Required parameters:**
• prompt: The task to execute
• agentId: The Letta agent ID to notify when complete
• lettaUrl: (optional) Letta base URL for the MCP endpoint, defaults to https://letta.oculair.ca

**Optional parameters:**
• workFolder: Working directory for execution
• sessionId: Existing session ID to resume from
• interactionMode: 'autonomous' (default), 'checkpoint', or 'iterative'
• checkpointPattern: Regex pattern to pause at (e.g., "Analysis complete|Ready for review")
• maxIterations: Maximum feedback rounds (default: 5)
• keepTaskBlocks: Number of task blocks to keep in memory (1-50, default: 3)
• elevateBlock: Whether to elevate this task block to prevent cleanup
• requestHeartbeat: Whether to request periodic heartbeat updates (default: true)

**Example - Autonomous (default):**
{
  "prompt": "Analyze the codebase and generate a comprehensive README.md",
  "agentId": "agent_123",
  "workFolder": "/workspace"
}

**Example - With Checkpoints:**
{
  "prompt": "Analyze the codebase. Pause after analysis for review.",
  "agentId": "agent_123",
  "interactionMode": "checkpoint",
  "checkpointPattern": "Analysis complete|Ready for review"
}

**Example - Resume Session:**
{
  "prompt": "Good analysis. Now add API examples for each module.",
  "agentId": "agent_123",
  "sessionId": "2e9c8a98-1293-4021-861c-2cb7da383967"
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
              sessionId: {
                type: 'string',
                description: 'Optional existing session ID to resume from.',
              },
              interactionMode: {
                type: 'string',
                description: 'Interaction mode: autonomous (default), checkpoint, or iterative.',
                enum: ['autonomous', 'checkpoint', 'iterative'],
              },
              checkpointPattern: {
                type: 'string',
                description: 'Regex pattern to detect checkpoints in output.',
              },
              maxIterations: {
                type: 'integer',
                description: 'Maximum number of feedback iterations (default: 5)',
                minimum: 1,
                maximum: 20,
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
      const response = await this.executeClaudeCode(toolArgs.prompt, toolArgs.workFolder);
      
      // Extract result text (handle both old string format and new object format)
      const resultText = typeof response === 'string' ? response : response.result;
      
      return {
        content: [{
          type: 'text',
          text: resultText,
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

    // Validate optional parameters
    if (toolArgs.interactionMode && !['autonomous', 'checkpoint', 'iterative'].includes(toolArgs.interactionMode)) {
      throw new McpError(ErrorCode.InvalidParams, 'Invalid interactionMode. Must be: autonomous, checkpoint, or iterative');
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
        toolArgs.requestHeartbeat !== false,
        toolArgs.sessionId,
        toolArgs.interactionMode || 'autonomous',
        toolArgs.checkpointPattern,
        toolArgs.maxIterations || 5
      ).catch(error => {
        console.error(`Async task ${taskId} failed:`, error);
      });

      return {
        content: [{
          type: 'text',
          text: `Async task started with ID: ${taskId}\nAgent: ${toolArgs.agentId}\nMode: ${toolArgs.interactionMode || 'autonomous'}\n${toolArgs.sessionId ? `Resuming session: ${toolArgs.sessionId}` : 'New session'}\nYou will receive a notification when the task completes${toolArgs.checkpointPattern ? ' or reaches a checkpoint' : ''}.`,
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
  async executeClaudeCode(prompt, workFolder, sessionId = null) {
    debugLog('Executing Claude Code with prompt:', prompt);
    debugLog('Work folder:', workFolder);
    debugLog('Session ID:', sessionId);

    // First, ensure we have a project for the work folder
    let projectName = null;
    if (workFolder) {
      projectName = await this.ensureProject(workFolder);
    }

    // Now execute the command through the UI's chat interface
    return await this.executeThroughChat(prompt, projectName, workFolder, sessionId);
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
  async executeThroughChat(prompt, projectName, workFolder, inputSessionId = null) {
    return new Promise((resolve, reject) => {
      debugLog('Connecting to WebSocket...');
      
      // Check for auth token
      if (!MCP_AUTH_TOKEN) {
        reject(new Error('MCP_AUTH_TOKEN environment variable is not set'));
        return;
      }
      
      // Connect to the UI's WebSocket with authentication token
      const ws = new WebSocket(`${UI_WS_URL}/ws?token=${MCP_AUTH_TOKEN}`);
      let responseBuffer = '';
      let isComplete = false;
      let capturedSessionId = inputSessionId;
      let sessionCreated = false;

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
            sessionId: inputSessionId || undefined, // Convert null to undefined for backend
            resume: !!inputSessionId, // Resume if we have a session ID
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
              capturedSessionId = message.sessionId;
              sessionCreated = true;
              debugLog('Session created:', capturedSessionId);
              break;

            case 'claude-response':
              // Handle Claude's response
              debugLog('Claude response data:', JSON.stringify(message.data));
              if (message.data) {
                // Capture session ID from response if available
                if (message.data.session_id && !capturedSessionId) {
                  capturedSessionId = message.data.session_id;
                  debugLog('Captured session ID from response:', capturedSessionId);
                }
                
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
              resolve({
                result: responseBuffer || 'Command completed successfully',
                sessionId: capturedSessionId
              });
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
            resolve({
              result: responseBuffer,
              sessionId: capturedSessionId
            });
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
            resolve({
              result: responseBuffer,
              sessionId: capturedSessionId
            });
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
   * Execute Claude Code with real-time output monitoring for checkpoints
   */
  async executeClaudeCodeWithMonitoring(prompt, workFolder, inputSessionId, checkpointPattern) {
    return new Promise((resolve, reject) => {
      debugLog('Executing with checkpoint monitoring...');
      
      // Check for auth token
      if (!MCP_AUTH_TOKEN) {
        reject(new Error('MCP_AUTH_TOKEN environment variable is not set'));
        return;
      }
      
      const ws = new WebSocket(`${UI_WS_URL}/ws?token=${MCP_AUTH_TOKEN}`);
      let responseBuffer = '';
      let isComplete = false;
      let capturedSessionId = inputSessionId;
      let checkpointReached = false;
      let checkpointRegex = null;
      try {
        checkpointRegex = checkpointPattern ? new RegExp(checkpointPattern, 'i') : null;
      } catch (error) {
        debugLog('Invalid checkpoint pattern:', checkpointPattern, error);
        reject(new Error(`Invalid checkpoint pattern: ${error.message}`));
        return;
      }

      ws.on('open', () => {
        debugLog('WebSocket connected for monitoring');
        
        const message = {
          type: 'claude-command',
          command: prompt,
          options: {
            projectPath: workFolder || '/opt/stacks',
            cwd: workFolder || '/opt/stacks',
            projectName: null,
            sessionId: inputSessionId || undefined,
            resume: !!inputSessionId,
            toolsSettings: {
              allowedTools: ['Write', 'Read', 'Edit', 'MultiEdit', 'Bash', 'Task', 'Glob', 'Grep', 'LS'],
              disallowedTools: [],
              skipPermissions: false
            }
          }
        };
        
        ws.send(JSON.stringify(message));
      });

      ws.on('message', (data) => {
        try {
          const message = JSON.parse(data.toString());
          
          switch (message.type) {
            case 'session-created':
              capturedSessionId = message.sessionId;
              break;

            case 'claude-response':
              if (message.data) {
                if (message.data.session_id && !capturedSessionId) {
                  capturedSessionId = message.data.session_id;
                }
                
                // Monitor for checkpoint in all output
                if (message.data.type === 'assistant' && message.data.message && message.data.message.content) {
                  const content = message.data.message.content;
                  for (const item of content) {
                    if (item.type === 'text' && item.text) {
                      responseBuffer += item.text + '\n';
                      
                      // Check for checkpoint pattern
                      if (!checkpointReached && checkpointRegex && checkpointRegex.test(item.text)) {
                        checkpointReached = true;
                        debugLog('Checkpoint reached:', item.text);
                        // Continue collecting output but mark checkpoint
                      }
                    }
                  }
                } else if (message.data.type === 'result' && message.data.result) {
                  responseBuffer = message.data.result;
                }
              }
              break;

            case 'claude-output':
              if (message.data) {
                responseBuffer += message.data;
                // Check output for checkpoint
                if (!checkpointReached && checkpointRegex && checkpointRegex.test(message.data)) {
                  checkpointReached = true;
                  debugLog('Checkpoint reached in output:', message.data);
                }
              }
              break;

            case 'claude-complete':
              isComplete = true;
              ws.close();
              resolve({
                result: responseBuffer || 'Command completed',
                sessionId: capturedSessionId,
                checkpointReached
              });
              break;

            case 'claude-error':
              ws.close();
              reject(new Error(message.error || 'Unknown error'));
              break;
          }
        } catch (error) {
          debugLog('Error parsing message:', error);
        }
      });

      ws.on('error', (error) => {
        reject(error);
      });

      ws.on('close', () => {
        if (!isComplete) {
          resolve({
            result: responseBuffer,
            sessionId: capturedSessionId,
            checkpointReached
          });
        }
      });

      // Timeout with cleanup
      const timeout = setTimeout(() => {
        if (!isComplete) {
          isComplete = true;
          ws.close();
          resolve({
            result: responseBuffer,
            sessionId: capturedSessionId,
            checkpointReached
          });
        }
      }, 5 * 60 * 1000);
      
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

    // Status endpoint for Claude Code jobs
    app.get('/status', (req, res) => {
      const status = {
        timestamp: new Date().toISOString(),
        activeJobs: Array.from(this.activeJobs.values()),
        stats: {
          ...this.jobStats,
          uptime: Date.now() - this.jobStats.startTime.getTime(),
          activeJobCount: this.activeJobs.size,
          averageJobDuration: this.calculateAverageJobDuration()
        },
        recentCompleted: this.completedJobs.slice(0, 10),
        system: {
          uptime: process.uptime(),
          memory: process.memoryUsage(),
          platform: process.platform,
          nodeVersion: process.version
        }
      };
      
      res.json(status);
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
  async executeClaudeCodeAsync(taskId, agentId, prompt, workFolder, lettaUrl, keepTaskBlocks, elevateBlock, requestHeartbeat, sessionId, interactionMode, checkpointPattern, maxIterations) {
    console.log(`[Async] Starting task ${taskId} for agent ${agentId}`);
    console.log(`[Async] Mode: ${interactionMode}, Session: ${sessionId || 'new'}`);
    
    // Track the job
    this.trackJob(taskId, agentId, {
      command: prompt,
      workFolder,
      sessionId,
      interactionMode,
      checkpointPattern
    });
    
    let currentSessionId = sessionId;
    let iterationCount = 0;
    let checkpointReached = false;
    let fullOutput = '';
    
    try {
      // Execute the command
      const startTime = Date.now();
      
      // If checkpoint mode, monitor output for patterns
      if (interactionMode === 'checkpoint' && checkpointPattern) {
        console.log(`[Async] Monitoring for checkpoint pattern: ${checkpointPattern}`);
        
        // Execute with real-time output monitoring
        const response = await this.executeClaudeCodeWithMonitoring(
          prompt, 
          workFolder, 
          currentSessionId,
          checkpointPattern
        );
        
        currentSessionId = response.sessionId;
        fullOutput = response.result;
        checkpointReached = response.checkpointReached;
        
      } else {
        // Standard execution
        const response = await this.executeClaudeCode(prompt, workFolder, currentSessionId);
        currentSessionId = response.sessionId;
        fullOutput = response.result;
      }
      
      const executionTime = Date.now() - startTime;
      console.log(`[Async] Task ${taskId} ${checkpointReached ? 'reached checkpoint' : 'completed'} in ${executionTime}ms`);
      
      // Update job status
      if (checkpointReached) {
        this.updateJob(taskId, { 
          checkpointReached: true,
          sessionId: currentSessionId,
          iterationCount
        });
      } else {
        // Complete the job
        this.completeJob(taskId, {
          success: true,
          result: fullOutput,
          executionTime,
          sessionId: currentSessionId
        });
      }
      
      // Send notification with session info
      await this.sendAsyncNotification({
        agentId,
        taskId,
        callbackUrl: lettaUrl,
        result: fullOutput,
        success: true,
        executionTime,
        sessionId: currentSessionId,
        checkpointReached,
        interactionMode,
        iterationCount,
        canContinue: checkpointReached && iterationCount < maxIterations
      });
      
    } catch (error) {
      console.error(`[Async] Task ${taskId} failed:`, error);
      
      // Complete the job with error
      this.completeJob(taskId, {
        success: false,
        error: error.message,
        sessionId: currentSessionId
      });
      
      // Send error notification with session info
      await this.sendAsyncNotification({
        agentId,
        taskId,
        callbackUrl: lettaUrl,
        result: `Task ${taskId} failed: ${error.message}`,
        success: false,
        error: error.message,
        sessionId: currentSessionId,
        interactionMode,
        iterationCount
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
    
    // Build enhanced notification message
    let notificationContent = `🔧 Claude Code Task ${data.checkpointReached ? 'Checkpoint' : 'Complete'}\n\n`;
    notificationContent += `Task: ${data.taskId}\n`;
    notificationContent += `Status: ${data.success ? (data.checkpointReached ? '⏸️ Checkpoint Reached' : '✅ Success') : '❌ Failed'}\n`;
    
    if (data.sessionId) {
      notificationContent += `Session: ${data.sessionId}\n`;
    }
    
    if (data.interactionMode) {
      notificationContent += `Mode: ${data.interactionMode}\n`;
    }
    
    if (data.iterationCount !== undefined) {
      notificationContent += `Iteration: ${data.iterationCount}\n`;
    }
    
    if (data.checkpointReached && data.canContinue) {
      notificationContent += `\n💡 To continue, use:\n`;
      notificationContent += `claude_code_async with sessionId: "${data.sessionId}"\n`;
    }
    
    notificationContent += `\nResult:\n${data.result}`;
    
    // Enhanced notification data for structured processing
    const enhancedData = {
      ...data,
      notificationContent,
      continuationInfo: data.checkpointReached ? {
        sessionId: data.sessionId,
        canContinue: data.canContinue,
        suggestedPrompt: 'Continue with the next step...'
      } : null
    };
    
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
              result: notificationContent,
              error: data.error,
              timestamp: new Date(),
              // Add session info for Matrix clients
              sessionId: data.sessionId,
              checkpointReached: data.checkpointReached,
              interactionMode: data.interactionMode,
              canContinue: data.canContinue
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
                content: notificationContent
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
        result: data.result.substring(0, 500) + '...',
        notificationSent,
        sessionId: data.sessionId,
        checkpointReached: data.checkpointReached,
        interactionMode: data.interactionMode,
        canContinue: data.canContinue,
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