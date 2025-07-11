/**
 * Central configuration module for Claude Code MCP Server
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

interface ServerConfig {
  // Server settings
  server: {
    version: string;
    transport: 'stdio' | 'sse';
    port: number;
  };
  
  // Session management
  sessions: {
    maxSessions: number;
    sessionTimeoutMs: number;
    cleanupIntervalMs: number;
  };
  
  // Process management
  processes: {
    executionTimeoutMs: number;
    maxAsyncProcesses: number;
    asyncProcessTimeoutMs: number;
  };
  
  // Claude CLI settings
  claudeCli: {
    customName?: string;
    fallbackName: string;
  };
  
  // Input validation
  validation: {
    maxPromptLength: number;
  };
  
  // Logging
  logging: {
    debug: boolean;
    format: 'text' | 'json';
  };
  
  // Letta integration
  letta: {
    baseUrl: string;
    authToken: string;
    barePassword: string;
  };
}

// Default configuration
const defaultConfig: ServerConfig = {
  server: {
    version: '1.10.12',
    transport: 'stdio',
    port: 3001,
  },
  sessions: {
    maxSessions: 100,
    sessionTimeoutMs: 3600000, // 1 hour
    cleanupIntervalMs: 300000, // 5 minutes
  },
  processes: {
    executionTimeoutMs: 1800000, // 30 minutes
    maxAsyncProcesses: 50,
    asyncProcessTimeoutMs: 1800000, // 30 minutes
  },
  claudeCli: {
    fallbackName: 'claude',
  },
  validation: {
    maxPromptLength: 50000,
  },
  logging: {
    debug: false,
    format: 'text',
  },
  letta: {
    baseUrl: 'https://letta2.oculair.ca',
    authToken: 'lettaSecurePass123',
    barePassword: 'password lettaSecurePass123',
  },
};

/**
 * Load configuration from file if exists
 */
function loadConfigFile(): Partial<ServerConfig> {
  const configPaths = [
    join(process.cwd(), 'claude-mcp.config.json'),
    join(homedir(), '.claude-mcp', 'config.json'),
    '/etc/claude-mcp/config.json',
  ];
  
  for (const configPath of configPaths) {
    if (existsSync(configPath)) {
      try {
        const configContent = readFileSync(configPath, 'utf-8');
        return JSON.parse(configContent);
      } catch (error) {
        console.error(`[Config] Error loading config from ${configPath}:`, error);
      }
    }
  }
  
  return {};
}

/**
 * Merge configurations with environment variables taking precedence
 */
function mergeConfig(): ServerConfig {
  const fileConfig = loadConfigFile();
  const config = JSON.parse(JSON.stringify(defaultConfig)) as ServerConfig;
  
  // Merge file config
  Object.assign(config, fileConfig);
  
  // Override with environment variables
  if (process.env.MCP_TRANSPORT) {
    config.server.transport = process.env.MCP_TRANSPORT as 'stdio' | 'sse';
  }
  if (process.env.PORT) {
    config.server.port = parseInt(process.env.PORT);
  }
  if (process.env.MAX_SESSIONS) {
    config.sessions.maxSessions = parseInt(process.env.MAX_SESSIONS);
  }
  if (process.env.SESSION_TIMEOUT_MS) {
    config.sessions.sessionTimeoutMs = parseInt(process.env.SESSION_TIMEOUT_MS);
  }
  if (process.env.CLEANUP_INTERVAL_MS) {
    config.sessions.cleanupIntervalMs = parseInt(process.env.CLEANUP_INTERVAL_MS);
  }
  if (process.env.EXECUTION_TIMEOUT_MS) {
    config.processes.executionTimeoutMs = parseInt(process.env.EXECUTION_TIMEOUT_MS);
  }
  if (process.env.MAX_ASYNC_PROCESSES) {
    config.processes.maxAsyncProcesses = parseInt(process.env.MAX_ASYNC_PROCESSES);
  }
  if (process.env.ASYNC_PROCESS_TIMEOUT_MS) {
    config.processes.asyncProcessTimeoutMs = parseInt(process.env.ASYNC_PROCESS_TIMEOUT_MS);
  }
  if (process.env.CLAUDE_CLI_NAME) {
    config.claudeCli.customName = process.env.CLAUDE_CLI_NAME;
  }
  if (process.env.MAX_PROMPT_LENGTH) {
    config.validation.maxPromptLength = parseInt(process.env.MAX_PROMPT_LENGTH);
  }
  if (process.env.MCP_CLAUDE_DEBUG === 'true') {
    config.logging.debug = true;
  }
  if (process.env.LOG_FORMAT) {
    config.logging.format = process.env.LOG_FORMAT as 'text' | 'json';
  }
  if (process.env.LETTA_BASE_URL) {
    config.letta.baseUrl = process.env.LETTA_BASE_URL;
  }
  if (process.env.LETTA_AUTH_TOKEN) {
    config.letta.authToken = process.env.LETTA_AUTH_TOKEN;
  }
  if (process.env.LETTA_BARE_PASSWORD) {
    config.letta.barePassword = process.env.LETTA_BARE_PASSWORD;
  }
  
  return config;
}

// Export the merged configuration
export const config = mergeConfig();

// Export a function to get current config (useful for runtime updates)
export function getConfig(): ServerConfig {
  return config;
}

// Log configuration on startup
if (config.logging.debug) {
  console.error('[Config] Loaded configuration:', JSON.stringify(config, null, 2));
}