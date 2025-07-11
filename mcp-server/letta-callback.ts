#!/usr/bin/env node
/**
 * Letta callback handler for async Claude Code responses
 * Modified to use Matrix notifications instead of direct agent responses
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { MatrixBotService, createMatrixBotFromEnv } from './matrix-client.js';
import { AgentRoomMappingClient, createAgentRoomMappingClient } from './agent-room-mapping-client.js';

interface CallbackData {
  agentId: string;
  taskId?: string;
  callbackUrl: string;
  result: string;
  success: boolean;
  error?: string;
}

// Global Matrix bot instance
let matrixBot: MatrixBotService | null = null;
let mappingClient: AgentRoomMappingClient | null = null;

/**
 * Initialize Matrix bot and mapping client
 */
async function initializeServices(): Promise<void> {
  try {
    // Initialize Matrix bot
    if (!matrixBot) {
      matrixBot = createMatrixBotFromEnv();
      await matrixBot.initialize();
      console.log('[Matrix Integration] Matrix bot initialized successfully');
    }
    
    // Initialize agent room mapping client
    if (!mappingClient) {
      mappingClient = createAgentRoomMappingClient();
      const isAvailable = await mappingClient.isServiceAvailable();
      
      if (!isAvailable) {
        console.warn('[Matrix Integration] Agent room mapping service is not available');
        // Don't throw error, we'll fall back to direct callback
      } else {
        console.log('[Matrix Integration] Agent room mapping service is available');
      }
    }
  } catch (error) {
    console.error('[Matrix Integration] Failed to initialize services:', error);
    throw error;
  }
}

/**
 * Send result to Matrix room and optionally fallback to direct Letta callback
 */
export async function sendResultToLetta(data: CallbackData): Promise<void> {
  console.log(`[Matrix Integration] Processing result for agent ${data.agentId}`);
  
  let matrixSuccess = false;
  
  try {
    // Initialize services if not already done
    await initializeServices();
    
    // Try Matrix notification first
    if (matrixBot && mappingClient) {
      const roomId = await mappingClient.getPrimaryRoom(data.agentId);
      
      if (roomId) {
        console.log(`[Matrix Integration] Found primary room ${roomId} for agent ${data.agentId}`);
        
        // Format job result for Matrix
        const jobResult = {
          taskId: data.taskId || generateTaskId(),
          agentId: data.agentId,
          success: data.success,
          result: data.result,
          error: data.error,
          timestamp: new Date()
        };
        
        // Send to Matrix room
        await matrixBot.sendJobResult(roomId, jobResult);
        matrixSuccess = true;
        
        console.log(`[Matrix Integration] Successfully sent result to Matrix room ${roomId}`);
      } else {
        console.warn(`[Matrix Integration] No primary room found for agent ${data.agentId}`);
      }
    }
  } catch (error) {
    console.error(`[Matrix Integration] Matrix notification failed:`, error);
    matrixSuccess = false;
  }
  
  // Fallback to direct Letta callback if Matrix failed or is not configured
  if (!matrixSuccess) {
    console.log(`[Matrix Integration] Falling back to direct Letta callback for agent ${data.agentId}`);
    await sendDirectLettaCallback(data);
  }
}

/**
 * Original direct Letta callback implementation (fallback)
 */
async function sendDirectLettaCallback(data: CallbackData): Promise<void> {
  console.log(`[Letta Callback] Sending result to agent ${data.agentId}`);
  
  try {
    // Parse the callback URL to determine transport type
    const url = new URL(data.callbackUrl);
    
    if (url.protocol === 'sse:' || url.pathname.includes('/sse')) {
      // Use SSE transport for Letta
      console.log(`[Letta Callback] Using SSE transport to ${url.href}`);
      
      // TODO: Implement SSE client connection to Letta
      // This would involve:
      // 1. Creating an SSE client transport
      // 2. Connecting to Letta's MCP server
      // 3. Calling a tool to send message to the specific agent
      
      // Example pseudo-code:
      // const transport = new SSEClientTransport(url.href);
      // const client = new Client({ name: 'claude-code-callback', version: '1.0.0' }, { capabilities: {} });
      // await client.connect(transport);
      // await client.callTool('send_message_to_agent', {
      //   agent_id: data.agentId,
      //   message: data.result
      // });
      
      console.log(`[Letta Callback] TODO: Implement Letta MCP client`);
      console.log(`[Letta Callback] Would send to ${data.agentId}: ${data.result.substring(0, 100)}...`);
      
    } else {
      // Use HTTP POST for direct callback
      const response = await fetch(data.callbackUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          agent_id: data.agentId,
          message: data.result,
          success: data.success,
          error: data.error,
          timestamp: new Date().toISOString()
        })
      });
      
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      
      console.log(`[Letta Callback] Successfully sent result via HTTP POST`);
    }
    
  } catch (error) {
    console.error(`[Letta Callback] Error sending result to Letta:`, error);
    throw error;
  }
}

/**
 * Generate a simple task ID if not provided
 */
function generateTaskId(): string {
  return `task_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Cleanup function to stop Matrix bot
 */
export async function cleanup(): Promise<void> {
  if (matrixBot) {
    await matrixBot.stop();
    matrixBot = null;
  }
}

// Handle process termination gracefully
process.on('SIGTERM', cleanup);
process.on('SIGINT', cleanup);

// CLI interface for testing
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  
  if (args.length < 3) {
    console.error('Usage: node letta-callback-matrix.js <agentId> <callbackUrl> <result> [taskId]');
    process.exit(1);
  }
  
  const [agentId, callbackUrl, ...resultParts] = args;
  let result = resultParts.join(' ');
  
  // Extract taskId if provided as last argument
  let taskId: string | undefined;
  if (args.length > 3 && args[args.length - 1].startsWith('task_')) {
    taskId = args[args.length - 1];
    // Remove taskId from result
    const resultWithoutTaskId = resultParts.slice(0, -1).join(' ');
    if (resultWithoutTaskId.trim()) {
      result = resultWithoutTaskId;
    }
  }
  
  sendResultToLetta({
    agentId,
    taskId,
    callbackUrl,
    result,
    success: true
  }).catch(console.error);
}