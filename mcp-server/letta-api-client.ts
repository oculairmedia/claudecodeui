#!/usr/bin/env node
/**
 * Letta API Client for sending responses back to Letta agents
 */

import fetch from 'node-fetch';
import { debugLog } from './server.js';

interface LettaApiConfig {
  baseUrl: string;
  authToken: string;
  barePassword: string;
}

interface LettaMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

interface LettaStreamResponse {
  messages: LettaMessage[];
  stream_steps: boolean;
  stream_tokens: boolean;
}

export class LettaApiClient {
  private config: LettaApiConfig;

  constructor(config?: Partial<LettaApiConfig>) {
    this.config = {
      baseUrl: config?.baseUrl || 'https://letta2.oculair.ca',
      authToken: config?.authToken || 'lettaSecurePass123',
      barePassword: config?.barePassword || 'password lettaSecurePass123'
    };
  }

  /**
   * Send a message to a specific Letta agent asynchronously
   */
  async sendMessageToAgent(agentId: string, message: string): Promise<void> {
    const url = `${this.config.baseUrl}/v1/agents/${agentId}/messages/async`;
    
    debugLog(`[Letta API] Sending async message to agent ${agentId} at ${url}`);
    
    const requestBody = {
      messages: [
        {
          role: 'system',
          content: message
        }
      ],
      max_steps: 50,
      use_assistant_message: true,
      assistant_message_tool_name: 'send_message',
      assistant_message_tool_kwarg: 'message'
    };

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.config.authToken}`,
          'X-BARE-PASSWORD': this.config.barePassword,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(requestBody)
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`HTTP error! status: ${response.status}, statusText: ${response.statusText}, body: ${errorText}`);
      }

      const result = await response.json() as any;
      debugLog(`[Letta API] Async message accepted, run ID: ${result.id}, status: ${result.status}`);
    } catch (error) {
      debugLog(`[Letta API] Error sending message to agent ${agentId}:`, error);
      throw error;
    }
  }
}

/**
 * Send a result back to a Letta agent using the API
 */
export async function sendResultToLettaApi(
  agentId: string, 
  message: string,
  lettaConfig?: Partial<LettaApiConfig>
): Promise<void> {
  const client = new LettaApiClient(lettaConfig);
  
  try {
    await client.sendMessageToAgent(agentId, message);
    debugLog(`[Letta API] Successfully sent message to agent ${agentId}`);
  } catch (error) {
    debugLog(`[Letta API] Error sending message:`, error);
    throw error;
  }
}

// CLI interface for testing
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  
  if (args.length < 2) {
    console.error('Usage: node letta-api-client.js <agentId> <message> [baseUrl] [authToken]');
    console.error('Example: node letta-api-client.js agent-1eacfc07-d8b6-4f25-a6ee-aab71934e07a "Hello from Claude!"');
    process.exit(1);
  }
  
  const [agentId, message, baseUrl, authToken] = args;
  
  const config: Partial<LettaApiConfig> = {};
  if (baseUrl) config.baseUrl = baseUrl;
  if (authToken) config.authToken = authToken;
  
  sendResultToLettaApi(agentId, message, config)
    .then(() => {
      console.log('Message sent successfully');
      process.exit(0);
    })
    .catch((error) => {
      console.error('Failed to send message:', error);
      process.exit(1);
    });
}