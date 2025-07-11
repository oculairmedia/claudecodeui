#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  type ServerResult,
} from '@modelcontextprotocol/sdk/types.js';
import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';
import WebSocket from 'ws';
import { randomUUID } from 'crypto';
import { taskTracker } from './task-tracker.js';
import { sendResultToLetta } from './letta-callback.js';
import { memoryClient } from './letta-memory-client.js';

// Server version
const SERVER_VERSION = "1.0.0";

// Server configuration
const HTTP_PORT = process.env.MCP_HTTP_PORT || 3014;
const UI_SERVER_URL = process.env.CLAUDE_UI_SERVER_URL || 'http://127.0.0.1:3012';
const UI_WS_URL = process.env.CLAUDE_UI_WS_URL || 'ws://192.168.50.90:3012';

// Debug mode
const debugMode = process.env.MCP_CLAUDE_DEBUG === 'true';

// Track if this is the first tool use
let isFirstToolUse = true;
const serverStartupTime = new Date().toISOString();

// Debug logging function
export function debugLog(message?: any, ...optionalParams: any[]): void {
  if (debugMode) {
    console.error(`[DEBUG] ${message}`, ...optionalParams);
  }
}

// Simple in-memory event store for resumability
class InMemoryEventStore {
  private events = new Map<string, any[]>();

  async storeEvent(sessionId: string, event: any): Promise<string> {
    if (!this.events.has(sessionId)) {
      this.events.set(sessionId, []);
    }
    const eventWithId = { ...event, id: event.id || randomUUID() };
    this.events.get(sessionId)!.push(eventWithId);
    return eventWithId.id;
  }

  async append(sessionId: string, event: any): Promise<void> {
    await this.storeEvent(sessionId, event);
  }

  async getEvents(sessionId: string, afterId?: string): Promise<any[]> {
    const sessionEvents = this.events.get(sessionId) || [];
    if (!afterId) {
      return sessionEvents;
    }
    const index = sessionEvents.findIndex(e => e.id === afterId);
    return index >= 0 ? sessionEvents.slice(index + 1) : sessionEvents;
  }

  async replayEventsAfter(sessionId: string, afterId?: string): Promise<any[]> {
    return this.getEvents(sessionId, afterId);
  }
}


/**
 * MCP Server for Claude Code UI with Matrix/Letta Integration
 */
export class ClaudeCodeMCPServer {
  private server: Server;

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
  }

  /**
   * Set up the MCP tool handlers
   */
  private setupToolHandlers(): void {
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
}

**Response:**
{
  "taskId": "task_abc123",
  "message": "Task started successfully. Will notify agent_123 when complete.",
  "status": "running"
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
                description: 'The working directory for the Claude CLI execution. Must be an absolute path.',
              },
              lettaUrl: {
                type: 'string',
                description: 'Letta MCP server URL. Defaults to https://letta.oculair.ca',
              },
              keepTaskBlocks: {
                type: 'number',
                description: 'Number of task blocks to keep in memory. Defaults to 3. Set higher for agents that track many concurrent tasks.',
              },
              elevateBlock: {
                type: 'boolean',
                description: 'Whether to elevate this task block to prevent cleanup. Use for important long-running tasks.',
              },
              request_heartbeat: {
                type: 'boolean',
                description: 'Whether to request periodic heartbeat updates during long-running tasks. Defaults to true.',
                default: true,
              },
            },
            required: ['prompt', 'agentId'],
          },
        }
      ],
    }));

    // Handle tool calls
    this.server.setRequestHandler(CallToolRequestSchema, async (args): Promise<ServerResult> => {
      debugLog('Handling CallToolRequest:', args);

      const toolName = args.params.name;
      if (toolName !== 'claude_code' && toolName !== 'claude_code_async') {
        throw new McpError(ErrorCode.MethodNotFound, `Tool ${toolName} not found`);
      }

      const toolArguments = args.params.arguments as any;

      // Validate prompt
      if (!toolArguments || !toolArguments.prompt || typeof toolArguments.prompt !== 'string') {
        throw new McpError(ErrorCode.InvalidParams, 'Missing or invalid required parameter: prompt');
      }

      const prompt = toolArguments.prompt.trim();
      const workFolder = toolArguments.workFolder;

      // Handle async tool
      if (toolName === 'claude_code_async') {
        // Validate async-specific parameters
        let agentId: string;
        let lettaUrl: string = 'https://letta.oculair.ca';
        let keepTaskBlocks: number = 3;
        let elevateBlock: boolean = false;
        let requestHeartbeat: boolean = true;

        if (!toolArguments.agentId || typeof toolArguments.agentId !== 'string') {
          throw new McpError(ErrorCode.InvalidParams, 'Missing required parameter: agentId for claude_code_async tool');
        }
        agentId = toolArguments.agentId;

        if (toolArguments.lettaUrl && typeof toolArguments.lettaUrl === 'string') {
          lettaUrl = toolArguments.lettaUrl;
        }

        if (toolArguments.keepTaskBlocks && typeof toolArguments.keepTaskBlocks === 'number') {
          keepTaskBlocks = Math.max(1, Math.min(50, toolArguments.keepTaskBlocks));
        }

        if (toolArguments.elevateBlock && typeof toolArguments.elevateBlock === 'boolean') {
          elevateBlock = toolArguments.elevateBlock;
        }

        if (toolArguments.request_heartbeat !== undefined && typeof toolArguments.request_heartbeat === 'boolean') {
          requestHeartbeat = toolArguments.request_heartbeat;
        }

        // Create a unique task ID
        const taskId = `task_${randomUUID()}`;
        
        // Store task info for tracking
        taskTracker.createTask(taskId, agentId, prompt);

        // Create enhanced task status in memory
        const taskStatus = memoryClient.createEnhancedTaskStatus(taskId, agentId, prompt, workFolder || process.cwd());
        
        // Add elevation flag if requested
        if (elevateBlock) {
          taskStatus.archive_priority = 'high';
          taskStatus.should_archive = true;
          (taskStatus as any).elevated = true;
          (taskStatus as any).keepTaskBlocks = keepTaskBlocks;
        }
        
        // Store heartbeat preference
        (taskStatus as any).requestHeartbeat = requestHeartbeat;
        
        // Store task in Letta memory block
        memoryClient.updateTaskStatus(agentId, taskStatus).catch(error => {
          console.error(`[Async] Failed to create memory block for task ${taskId}:`, error);
        });

        // Start async execution
        this.executeClaudeAsync(taskId, agentId, prompt, workFolder, lettaUrl, keepTaskBlocks, elevateBlock, requestHeartbeat).catch(error => {
          console.error(`[Async] Task ${taskId} failed:`, error);
          // Try to notify Letta about the failure
          sendResultToLetta({
            agentId,
            taskId,
            callbackUrl: lettaUrl,
            result: `Task ${taskId} failed: ${error.message}`,
            success: false,
            error: error.message
          }).catch(console.error);
        });

        // Return immediately with task ID
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                taskId,
                message: `Task started successfully. Will notify agent ${agentId} when complete.`,
                status: 'running'
              }, null, 2),
            },
          ],
        };
      }

      // Handle sync tool
      try {
        debugLog(`Attempting to execute Claude CLI with prompt: "${prompt}" in CWD: "${workFolder}"`);

        // Print tool info on first use
        if (isFirstToolUse) {
          const versionInfo = `claude_code v${SERVER_VERSION} started at ${serverStartupTime}`;
          console.error(versionInfo);
          isFirstToolUse = false;
        }

        // Execute through UI backend
        const result = await this.executeClaudeCode(prompt, workFolder);
        
        return {
          content: [{
            type: 'text',
            text: typeof result === 'string' ? result : JSON.stringify(result),
          }],
        };
      } catch (error: any) {
        debugLog('Error executing Claude Code:', error);
        throw new McpError(ErrorCode.InternalError, `Claude Code execution failed: ${error.message}`);
      }
    });
  }

  /**
   * Execute Claude Code through the UI backend
   */
  private async executeClaudeCode(prompt: string, workFolder?: string): Promise<string> {
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
   * Execute Claude CLI asynchronously and notify via Matrix/Letta
   */
  private async executeClaudeAsync(
    taskId: string,
    agentId: string,
    prompt: string,
    workFolder: string | undefined,
    lettaUrl: string,
    keepTaskBlocks: number = 3,
    elevateBlock: boolean = false,
    requestHeartbeat: boolean = true
  ): Promise<void> {
    console.error(`[Async] Starting task ${taskId} for agent ${agentId}`);
    
    try {
      // Update task status to in_progress
      await memoryClient.updateTaskProgress(agentId, taskId, {
        progress: 'Executing Claude Code',
        progress_percentage: 10,
        current_step: 'Starting Claude CLI',
        steps_completed: 0,
        total_steps: 2
      });

      // Execute through UI backend
      const startTime = Date.now();
      const result = await this.executeClaudeCode(prompt, workFolder);
      const executionTime = Date.now() - startTime;
      
      console.error(`[Async] Task ${taskId} completed successfully`);
      
      // Complete task in memory with metrics
      await memoryClient.completeTask(agentId, taskId, result, true, {
        execution_time_ms: executionTime
      });
      
      // If not elevated, cleanup will happen with the specified keepTaskBlocks count
      if (!elevateBlock) {
        await memoryClient.cleanupOldTaskBlocks(agentId, keepTaskBlocks);
      }
      
      // Send result to Letta/Matrix
      const message = `Task ${taskId} completed:\n\n${result}`;
      await sendResultToLetta({
        agentId,
        taskId,
        callbackUrl: lettaUrl,
        result: message,
        success: true
      });
      
      // Clean up task tracker
      taskTracker.removeTask(taskId);
      
    } catch (error: any) {
      console.error(`[Async] Task ${taskId} failed:`, error);
      
      // Log error to memory
      const taskError = {
        timestamp: new Date().toISOString(),
        error_type: 'system' as const,
        message: error.message || 'Unknown error',
        details: error.stack,
        recoverable: false
      };
      await memoryClient.addTaskError(agentId, taskId, taskError);
      
      // Complete task as failed
      await memoryClient.completeTask(agentId, taskId, error.message || 'Task failed', false);
      
      // Send error to Letta/Matrix
      const errorMessage = error.message || 'Unknown error';
      const message = `Task ${taskId} failed: ${errorMessage}`;
      await sendResultToLetta({
        agentId,
        taskId,
        callbackUrl: lettaUrl,
        result: message,
        success: false,
        error: errorMessage
      });
      
      // Clean up task tracker
      taskTracker.removeTask(taskId);
      
      throw error;
    }
  }

  /**
   * Ensure a project exists for the given path
   */
  private async ensureProject(projectPath: string): Promise<string | null> {
    try {
      // Check if project already exists
      const response = await fetch(`${UI_SERVER_URL}/api/projects`);
      const projects = await response.json();
      
      // Look for existing project with this path
      const existingProject = (projects as any[]).find((p: any) => p.path === projectPath);
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

      const newProject = await createResponse.json() as any;
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
  private async executeThroughChat(prompt: string, projectName: string | null, workFolder?: string): Promise<string> {
    return new Promise((resolve, reject) => {
      debugLog('Connecting to WebSocket...');
      
      // Connect to the UI's WebSocket
      const ws = new WebSocket(`${UI_WS_URL}/ws`);
      let responseBuffer = '';
      let isComplete = false;
      let sessionId: string | null = null;

      ws.on('open', () => {
        debugLog('WebSocket connected');
        
        // Send chat message
        const message = {
          type: 'claude-command',
          command: prompt,
          options: {
            projectPath: workFolder || process.cwd(),
            cwd: workFolder || process.cwd(),
            projectName: projectName,
            sessionId: sessionId,
            resume: false,
            toolsSettings: {
              allowedTools: ['Write', 'Read', 'Edit', 'MultiEdit', 'Bash', 'Task', 'Glob', 'Grep', 'LS'],
              disallowedTools: [],
              skipPermissions: false
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
          debugLog('Full message:', JSON.stringify(message).substring(0, 500));

          switch (message.type) {
            case 'session-created':
              sessionId = message.sessionId;
              debugLog('Session created:', sessionId);
              break;

            case 'claude-response':
              debugLog('Claude response data:', JSON.stringify(message.data));
              if (message.data) {
                if (message.data.type === 'result' && message.data.result) {
                  responseBuffer = message.data.result;
                  debugLog('Got final result:', responseBuffer);
                } 
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
  async connectTransport(transport: any): Promise<void> {
    await this.server.connect(transport);
  }

  /**
   * Start MCP server with stdio transport
   */
  async run(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('Claude Code MCP server running on stdio');
  }

  /**
   * Start MCP server with HTTP transport
   */
  async runHttp(): Promise<void> {
    const app = express();
    
    // CORS setup
    app.use(cors({
      origin: ['http://localhost', 'http://127.0.0.1', /^http:\/\/192\.168\./, /^http:\/\/10\./, /^http:\/\/172\.(1[6-9]|2[0-9]|3[0-1])\./],
      credentials: true,
      allowedHeaders: ['Content-Type', 'Mcp-Session-Id', 'Accept'],
      exposedHeaders: ['Mcp-Session-Id']
    }));

    // Map to store transports by session ID
    const transports: Record<string, any> = {};
    const eventStore = new InMemoryEventStore();

    // Main MCP endpoint
    app.post('/mcp', async (req, res) => {
      console.error('[Streamable HTTP] Received MCP request');
      
      try {
        // Check for existing session ID
        const sessionId = req.headers['mcp-session-id'] as string | undefined;
        let transport: any;
        
        if (sessionId && transports[sessionId]) {
          // Reuse existing transport
          transport = transports[sessionId];
        } else if (!sessionId) {
          // New session - create transport
          transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            eventStore: eventStore as any,
            onsessioninitialized: (sessionId: string) => {
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
        
        // Handle the request
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
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      
      console.error('[Streamable HTTP] SSE request for session:', sessionId);
      
      if (!sessionId || !transports[sessionId]) {
        res.status(400).send('Invalid or missing session ID');
        return;
      }
      
      // Check for Last-Event-ID header for resumability
      const lastEventId = req.headers['last-event-id'] as string | undefined;
      
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
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      
      if (sessionId && transports[sessionId]) {
        delete transports[sessionId];
        console.error(`[Streamable HTTP] Session deleted: ${sessionId}`);
        res.json({ success: true, message: 'Session deleted' });
      } else {
        res.status(404).json({ error: 'Session not found' });
      }
    });

    app.listen(Number(HTTP_PORT), '0.0.0.0', () => {
      console.error(`Claude Code MCP server running on HTTP port ${HTTP_PORT}`);
      console.error(`[Streamable HTTP] MCP endpoint: http://0.0.0.0:${HTTP_PORT}/mcp`);
      console.error(`[Streamable HTTP] Health endpoint: http://0.0.0.0:${HTTP_PORT}/health`);
      console.error(`[Streamable HTTP] Session management:`);
      console.error(`[Streamable HTTP]   POST   /mcp - Initialize new session or handle request`);
      console.error(`[Streamable HTTP]   GET    /mcp - SSE endpoint for resumability`);
      console.error(`[Streamable HTTP]   DELETE /mcp - Delete session`);
    });
  }
}

// Determine transport type and start server
if (import.meta.url === `file://${process.argv[1]}`) {
  const server = new ClaudeCodeMCPServer();
  
  if (process.argv.includes('--http')) {
    server.runHttp().catch(console.error);
  } else {
    server.run().catch(console.error);
  }
}