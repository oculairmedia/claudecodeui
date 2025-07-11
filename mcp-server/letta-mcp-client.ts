#!/usr/bin/env node
/**
 * Letta MCP Client for sending responses back to Letta agents
 */

import fetch from 'node-fetch';
import { EventSource } from 'eventsource';

interface LettaMessage {
  agentId: string;
  message: string;
  timestamp?: string;
  metadata?: Record<string, any>;
}

export class LettaMCPClient {
  private baseUrl: string;
  private sessionId?: string;
  private messageEndpoint?: string;
  private requestId: number = 0;

  constructor(baseUrl: string = 'http://192.168.50.90:3001') {
    this.baseUrl = baseUrl;
  }

  /**
   * Connect to Letta MCP server via SSE
   */
  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const sseUrl = `${this.baseUrl}/sse`;
      console.log(`[Letta Client] Connecting to ${sseUrl}`);

      const eventSource = new EventSource(sseUrl);

      eventSource.addEventListener('endpoint', (event: any) => {
        const endpoint = event.data;
        // Extract session ID from endpoint URL
        const match = endpoint.match(/sessionId=([^&]+)/);
        if (match) {
          this.sessionId = match[1];
          this.messageEndpoint = `${this.baseUrl}${endpoint}`;
          console.log(`[Letta Client] Connected with session ID: ${this.sessionId}`);
          eventSource.close();
          resolve();
        } else {
          eventSource.close();
          reject(new Error('Failed to extract session ID from endpoint'));
        }
      });

      eventSource.addEventListener('error', (error: any) => {
        console.error('[Letta Client] SSE connection error:', error);
        eventSource.close();
        reject(error);
      });

      // Timeout after 10 seconds
      setTimeout(() => {
        eventSource.close();
        reject(new Error('Connection timeout'));
      }, 10000);
    });
  }

  /**
   * Send an MCP request to Letta
   */
  private async sendRequest(method: string, params: any = {}): Promise<any> {
    if (!this.messageEndpoint) {
      throw new Error('Not connected to Letta MCP server');
    }

    this.requestId++;
    const request = {
      jsonrpc: '2.0',
      id: this.requestId,
      method,
      params
    };

    console.log(`[Letta Client] Sending request:`, JSON.stringify(request, null, 2));

    const response = await fetch(this.messageEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(request)
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const result = await response.json() as any;
    console.log(`[Letta Client] Received response:`, JSON.stringify(result, null, 2));
    
    if (result.error) {
      throw new Error(`MCP error: ${result.error.message}`);
    }

    return result.result;
  }

  /**
   * Initialize the MCP session
   */
  async initialize(): Promise<void> {
    await this.sendRequest('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {
        tools: {}
      },
      clientInfo: {
        name: 'claude-code-letta-client',
        version: '1.0.0'
      }
    });
  }

  /**
   * List available tools from Letta
   */
  async listTools(): Promise<any[]> {
    const response = await this.sendRequest('tools/list');
    return response.tools || [];
  }

  /**
   * Send a message to a specific Letta agent
   */
  async sendMessageToAgent(agentId: string, message: string): Promise<any> {
    // First, let's list tools to see what's available
    const tools = await this.listTools();
    console.log(`[Letta Client] Available tools:`, tools.map(t => t.name));

    // Look for a tool that can send messages to agents
    // This might be named something like 'send_message', 'message_agent', etc.
    const messageTool = tools.find(t => 
      t.name.toLowerCase().includes('message') || 
      t.name.toLowerCase().includes('send') ||
      t.name.toLowerCase().includes('agent')
    );

    if (messageTool) {
      console.log(`[Letta Client] Using tool '${messageTool.name}' to send message`);
      return await this.sendRequest('tools/call', {
        name: messageTool.name,
        arguments: {
          agent_id: agentId,
          message: message
        }
      });
    } else {
      // If no specific tool found, try a generic approach
      console.log(`[Letta Client] No specific messaging tool found, trying generic call`);
      return await this.sendRequest('tools/call', {
        name: 'send_message',
        arguments: {
          agent_id: agentId,
          message: message
        }
      });
    }
  }

  /**
   * Disconnect from Letta
   */
  async disconnect(): Promise<void> {
    // MCP doesn't have a specific disconnect method
    console.log('[Letta Client] Disconnected');
  }
}

/**
 * Send a result back to a Letta agent
 */
export async function sendResultToLetta(
  agentId: string, 
  message: string,
  lettaUrl: string = 'https://letta.oculair.ca'
): Promise<void> {
  // Use the Letta API directly
  const apiUrl = `${lettaUrl}/v1/agents/${agentId}/messages/stream`;
  
  console.log(`[Letta Client] Sending message to agent ${agentId} via API: ${apiUrl}`);
  
  try {
    // Send message directly to Letta agent via API
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer lettaSecurePass123',
        'X-BARE-PASSWORD': 'password lettaSecurePass123',
        'Content-Type': 'application/json',
        'Accept': 'text/event-stream'
      },
      body: JSON.stringify({
        messages: [
          {
            role: 'system',
            content: message
          }
        ],
        stream_steps: true,
        stream_tokens: true
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`HTTP error! status: ${response.status}, body: ${errorText}`);
    }

    // For streaming response, we just need to ensure the connection was established
    // We don't need to wait for the full response
    console.log(`[Letta Client] Successfully sent message to agent ${agentId}`);
    
    // Note: The agent will process the message asynchronously
    // We don't need to wait for or parse the streaming response
  } catch (error) {
    console.error(`[Letta Client] Error sending message:`, error);
    throw error;
  }
}

// CLI interface for testing
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  
  if (args.length < 2) {
    console.error('Usage: node letta-mcp-client.js <agentId> <message> [lettaUrl]');
    process.exit(1);
  }
  
  const [agentId, message, lettaUrl] = args;
  
  sendResultToLetta(agentId, message, lettaUrl)
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}