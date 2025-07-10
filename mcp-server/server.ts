#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  type ServerResult,
} from '@modelcontextprotocol/sdk/types.js';
import { spawn, ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve as pathResolve } from 'node:path';
import * as path from 'path';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'crypto';
import { taskTracker } from './task-tracker.js';
import { sendResultToLetta } from './letta-callback.js';
import { memoryClient } from './letta-memory-client.js';

// Server version - update this when releasing new versions
const SERVER_VERSION = "1.10.12";

// Define debugMode globally using const
const debugMode = process.env.MCP_CLAUDE_DEBUG === 'true';

// Track if this is the first tool use for version printing
let isFirstToolUse = true;

// Capture server startup time when the module loads
const serverStartupTime = new Date().toISOString();

// Dedicated debug logging function
export function debugLog(message?: any, ...optionalParams: any[]): void {
  if (debugMode) {
    console.error(message, ...optionalParams);
  }
}

/**
 * Determine the Claude CLI command/path.
 * 1. Checks for CLAUDE_CLI_NAME environment variable:
 *    - If absolute path, uses it directly
 *    - If relative path, throws error
 *    - If simple name, continues with path resolution
 * 2. Checks for Claude CLI at the local user path: ~/.claude/local/claude.
 * 3. If not found, defaults to the CLI name (or 'claude'), relying on the system's PATH for lookup.
 */
export function findClaudeCli(): string {
  debugLog('[Debug] Attempting to find Claude CLI...');

  // Check for custom CLI name from environment variable
  const customCliName = process.env.CLAUDE_CLI_NAME;
  if (customCliName) {
    debugLog(`[Debug] Using custom Claude CLI name from CLAUDE_CLI_NAME: ${customCliName}`);
    
    // If it's an absolute path, use it directly
    if (path.isAbsolute(customCliName)) {
      debugLog(`[Debug] CLAUDE_CLI_NAME is an absolute path: ${customCliName}`);
      return customCliName;
    }
    
    // If it starts with ~ or ./, reject as relative paths are not allowed
    if (customCliName.startsWith('./') || customCliName.startsWith('../') || customCliName.includes('/')) {
      throw new Error(`Invalid CLAUDE_CLI_NAME: Relative paths are not allowed. Use either a simple name (e.g., 'claude') or an absolute path (e.g., '/tmp/claude-test')`);
    }
  }
  
  const cliName = customCliName || 'claude';

  // Try local install path: ~/.claude/local/claude (using the original name for local installs)
  const userPath = join(homedir(), '.claude', 'local', 'claude');
  debugLog(`[Debug] Checking for Claude CLI at local user path: ${userPath}`);

  if (existsSync(userPath)) {
    debugLog(`[Debug] Found Claude CLI at local user path: ${userPath}. Using this path.`);
    return userPath;
  } else {
    debugLog(`[Debug] Claude CLI not found at local user path: ${userPath}.`);
  }

  // 3. Fallback to CLI name (PATH lookup)
  debugLog(`[Debug] Falling back to "${cliName}" command name, relying on spawn/PATH lookup.`);
  console.warn(`[Warning] Claude CLI not found at ~/.claude/local/claude. Falling back to "${cliName}" in PATH. Ensure it is installed and accessible.`);
  return cliName;
}

/**
 * Interface for Claude Code tool arguments
 */
interface ClaudeCodeArgs {
  prompt: string;
  workFolder?: string;
}

// Ensure spawnAsync is defined correctly *before* the class
export async function spawnAsync(command: string, args: string[], options?: { timeout?: number, cwd?: string }): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    debugLog(`[Spawn] Running command: ${command} ${args.join(' ')}`);
    const process = spawn(command, args, {
      shell: false, // Reverted to false
      timeout: options?.timeout,
      cwd: options?.cwd,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    process.stdout.on('data', (data) => { stdout += data.toString(); });
    process.stderr.on('data', (data) => {
      stderr += data.toString();
      debugLog(`[Spawn Stderr Chunk] ${data.toString()}`);
    });

    process.on('error', (error: NodeJS.ErrnoException) => {
      debugLog(`[Spawn Error Event] Full error object:`, error);
      let errorMessage = `Spawn error: ${error.message}`;
      if (error.path) {
        errorMessage += ` | Path: ${error.path}`;
      }
      if (error.syscall) {
        errorMessage += ` | Syscall: ${error.syscall}`;
      }
      errorMessage += `\nStderr: ${stderr.trim()}`;
      reject(new Error(errorMessage));
    });

    process.on('close', (code) => {
      debugLog(`[Spawn Close] Exit code: ${code}`);
      debugLog(`[Spawn Stderr Full] ${stderr.trim()}`);
      debugLog(`[Spawn Stdout Full] ${stdout.trim()}`);
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`Command failed with exit code ${code}\nStderr: ${stderr.trim()}\nStdout: ${stdout.trim()}`));
      }
    });
  });
}

/**
 * MCP Server for Claude Code
 * Provides a simple MCP tool to run Claude CLI in one-shot mode
 */
export class ClaudeCodeServer {
  private server: Server;
  private claudeCliPath: string; // This now holds either a full path or just 'claude'
  private packageVersion: string; // Add packageVersion property

  constructor() {
    // Use the simplified findClaudeCli function
    this.claudeCliPath = findClaudeCli(); // Removed debugMode argument
    console.error(`[Setup] Using Claude CLI command/path: ${this.claudeCliPath}`);
    this.packageVersion = SERVER_VERSION;

    this.server = new Server(
      {
        name: 'claude_code',
        version: '1.0.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.setupToolHandlers();

    this.server.onerror = (error) => console.error('[Error]', error);
    process.on('SIGINT', async () => {
      await this.server.close();
      process.exit(0);
    });
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
8. Claude can do much more, just ask it!

        `,
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
          description: `Async Claude Code Agent: Same as claude_code but runs asynchronously and notifies the calling Letta agent when complete.

• Returns immediately with a task ID
• Executes Claude Code in the background
• Sends result back to the calling Letta agent via MCP

**Required parameters:**
• prompt: The task to execute
• agentId: The Letta agent ID to notify when complete
• lettaUrl: (optional) Letta base URL for the MCP endpoint, defaults to https://letta.oculair.ca

**Example usage:**
{
  "prompt": "Analyze the codebase and generate a comprehensive README.md",
  "agentId": "agent_123",
  "workFolder": "/workspace"
}

**Response:**
{
  "taskId": "task_abc123",
  "message": "Task started successfully. Will notify agent_123 when complete."
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
            },
            required: ['prompt', 'agentId'],
          },
        }
      ],
    }));

    // Handle tool calls
    const executionTimeoutMs = 1800000; // 30 minutes timeout

    this.server.setRequestHandler(CallToolRequestSchema, async (args, call): Promise<ServerResult> => {
      debugLog('[Debug] Handling CallToolRequest:', args);

      // Correctly access toolName from args.params.name
      const toolName = args.params.name;
      if (toolName !== 'claude_code' && toolName !== 'claude_code_async') {
        // ErrorCode.ToolNotFound should be ErrorCode.MethodNotFound as per SDK for tools
        throw new McpError(ErrorCode.MethodNotFound, `Tool ${toolName} not found`);
      }

      // Robustly access prompt from args.params.arguments
      const toolArguments = args.params.arguments;
      let prompt: string;

      if (
        toolArguments &&
        typeof toolArguments === 'object' &&
        'prompt' in toolArguments &&
        typeof toolArguments.prompt === 'string'
      ) {
        prompt = toolArguments.prompt;
      } else {
        throw new McpError(ErrorCode.InvalidParams, 'Missing or invalid required parameter: prompt (must be an object with a string "prompt" property) for claude_code tool');
      }

      // Determine the working directory
      let effectiveCwd = homedir(); // Default CWD is user's home directory

      // Check if workFolder is provided in the tool arguments
      if (toolArguments.workFolder && typeof toolArguments.workFolder === 'string') {
        const resolvedCwd = pathResolve(toolArguments.workFolder);
        debugLog(`[Debug] Specified workFolder: ${toolArguments.workFolder}, Resolved to: ${resolvedCwd}`);

        // Check if the resolved path exists
        if (existsSync(resolvedCwd)) {
          effectiveCwd = resolvedCwd;
          debugLog(`[Debug] Using workFolder as CWD: ${effectiveCwd}`);
        } else {
          debugLog(`[Warning] Specified workFolder does not exist: ${resolvedCwd}. Using default: ${effectiveCwd}`);
        }
      } else {
        debugLog(`[Debug] No workFolder provided, using default CWD: ${effectiveCwd}`);
      }


      // Handle async tool separately
      if (toolName === 'claude_code_async') {
        // Validate async-specific parameters
        let agentId: string;
        let lettaUrl: string = 'https://letta.oculair.ca';
        let keepTaskBlocks: number = 3;
        let elevateBlock: boolean = false;

        if (!toolArguments.agentId || typeof toolArguments.agentId !== 'string') {
          throw new McpError(ErrorCode.InvalidParams, 'Missing required parameter: agentId for claude_code_async tool');
        }
        agentId = toolArguments.agentId;

        if (toolArguments.lettaUrl && typeof toolArguments.lettaUrl === 'string') {
          lettaUrl = toolArguments.lettaUrl;
        }

        if (toolArguments.keepTaskBlocks && typeof toolArguments.keepTaskBlocks === 'number') {
          keepTaskBlocks = Math.max(1, Math.min(50, toolArguments.keepTaskBlocks)); // Limit between 1-50
        }

        if (toolArguments.elevateBlock && typeof toolArguments.elevateBlock === 'boolean') {
          elevateBlock = toolArguments.elevateBlock;
        }

        // Create a unique task ID
        const taskId = `task_${randomUUID()}`;
        
        // Store task info for tracking
        taskTracker.createTask(taskId, agentId, prompt);

        // Create enhanced task status in memory
        const taskStatus = memoryClient.createEnhancedTaskStatus(taskId, agentId, prompt, effectiveCwd);
        
        // Add elevation flag if requested
        if (elevateBlock) {
          taskStatus.archive_priority = 'high';
          taskStatus.should_archive = true;
          // Store elevation info in the task status itself
          (taskStatus as any).elevated = true;
          (taskStatus as any).keepTaskBlocks = keepTaskBlocks;
        }
        
        // Store task in Letta memory block with custom keep count
        memoryClient.updateTaskStatus(agentId, taskStatus).catch(error => {
          console.error(`[Async] Failed to create memory block for task ${taskId}:`, error);
        });

        // Start async execution with parameters
        this.executeClaudeAsync(taskId, agentId, prompt, effectiveCwd, lettaUrl, keepTaskBlocks, elevateBlock).catch(error => {
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

      try {
        debugLog(`[Debug] Attempting to execute Claude CLI with prompt: "${prompt}" in CWD: "${effectiveCwd}"`);

        // Print tool info on first use
        if (isFirstToolUse) {
          const versionInfo = `claude_code v${SERVER_VERSION} started at ${serverStartupTime}`;
          console.error(versionInfo);
          isFirstToolUse = false;
        }

        const claudeProcessArgs = ['--dangerously-skip-permissions', '-p', prompt];
        debugLog(`[Debug] Invoking Claude CLI: ${this.claudeCliPath} ${claudeProcessArgs.join(' ')}`);

        const { stdout, stderr } = await spawnAsync(
          this.claudeCliPath, // Run the Claude CLI directly
          claudeProcessArgs, // Pass the arguments
          { timeout: executionTimeoutMs, cwd: effectiveCwd }
        );

        debugLog('[Debug] Claude CLI stdout:', stdout.trim());
        if (stderr) {
          debugLog('[Debug] Claude CLI stderr:', stderr.trim());
        }

        // Return stdout content, even if there was stderr, as claude-cli might output main result to stdout.
        return { content: [{ type: 'text', text: stdout }] };

      } catch (error: any) {
        debugLog('[Error] Error executing Claude CLI:', error);
        let errorMessage = error.message || 'Unknown error';
        // Attempt to include stderr and stdout from the error object if spawnAsync attached them
        if (error.stderr) {
          errorMessage += `\nStderr: ${error.stderr}`;
        }
        if (error.stdout) {
          errorMessage += `\nStdout: ${error.stdout}`;
        }

        if (error.signal === 'SIGTERM' || (error.message && error.message.includes('ETIMEDOUT')) || (error.code === 'ETIMEDOUT')) {
          // Reverting to InternalError due to lint issues, but with a specific timeout message.
          throw new McpError(ErrorCode.InternalError, `Claude CLI command timed out after ${executionTimeoutMs / 1000}s. Details: ${errorMessage}`);
        }
        // ErrorCode.ToolCallFailed should be ErrorCode.InternalError or a more specific execution error if available
        throw new McpError(ErrorCode.InternalError, `Claude CLI execution failed: ${errorMessage}`);
      }
    });
  }

  /**
   * Execute Claude CLI asynchronously and notify Letta agent when complete
   */
  private async executeClaudeAsync(
    taskId: string,
    agentId: string,
    prompt: string,
    cwd: string,
    lettaUrl: string,
    keepTaskBlocks: number = 3,
    elevateBlock: boolean = false
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

      // Execute Claude CLI
      const claudeProcessArgs = ['--dangerously-skip-permissions', '-p', prompt];
      debugLog(`[Async] Invoking Claude CLI: ${this.claudeCliPath} ${claudeProcessArgs.join(' ')}`);

      const startTime = Date.now();
      const { stdout, stderr } = await spawnAsync(
        this.claudeCliPath,
        claudeProcessArgs,
        {
          timeout: 1800000, // 30 minutes
          cwd
        }
      );

      // Process successful result
      const result = stdout.trim();
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
   * Connect to a transport
   */
  async connectTransport(transport: any): Promise<void> {
    await this.server.connect(transport);
  }

  /**
   * Start the MCP server
   */
  async run(): Promise<void> {
    // Revert to original server start logic if listen caused errors
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('Claude Code MCP server running on stdio');
  }
}

// Create and run the server if this is the main module
const server = new ClaudeCodeServer();
server.run().catch(console.error);