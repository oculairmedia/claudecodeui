/**
 * Matrix Client Service for Claude Code MCP
 * Handles Matrix bot authentication, room operations, and message sending
 */

import { MatrixClient, SimpleFsStorageProvider, AutojoinRoomsMixin } from 'matrix-bot-sdk';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables from the correct path
dotenv.config({ path: path.join(__dirname, '.env') });

export class MatrixBotService {
  constructor(config) {
    this.config = config;
    this.storage = new SimpleFsStorageProvider("./matrix-bot-storage.json");
    this.client = new MatrixClient(config.homeserverUrl, config.accessToken, this.storage);
    this.isInitialized = false;
    
    if (config.autoJoinRooms) {
      AutojoinRoomsMixin.setupOnClient(this.client);
    }
  }

  /**
   * Initialize the Matrix client and start syncing
   */
  async initialize() {
    if (this.isInitialized) return;
    
    console.log('[Matrix] Initializing Matrix bot client...');
    
    try {
      await this.client.start();
      console.log('[Matrix] Bot client started successfully');
      this.isInitialized = true;
    } catch (error) {
      console.error('[Matrix] Failed to start bot client:', error);
      throw error;
    }
  }

  /**
   * Join a Matrix room if not already a member
   */
  async joinRoom(roomId) {
    try {
      console.log(`[Matrix] Attempting to join room: ${roomId}`);
      
      // Check if we're already in the room
      const joinedRooms = await this.client.getJoinedRooms();
      if (joinedRooms.includes(roomId)) {
        console.log(`[Matrix] Already in room: ${roomId}`);
        return;
      }
      
      // Join the room
      await this.client.joinRoom(roomId);
      console.log(`[Matrix] Successfully joined room: ${roomId}`);
    } catch (error) {
      console.error(`[Matrix] Failed to join room ${roomId}:`, error);
      throw error;
    }
  }

  /**
   * Send a formatted message about an async job completion to a Matrix room
   */
  async sendJobResult(roomId, jobResult) {
    try {
      // Ensure we're in the room
      await this.joinRoom(roomId);
      
      // Format the message
      const message = this.formatJobResultMessage(jobResult);
      
      // Send the message
      await this.client.sendMessage(roomId, {
        msgtype: 'm.text',
        body: message.plain,
        format: 'org.matrix.custom.html',
        formatted_body: message.html
      });
      
      console.log(`[Matrix] Job result sent to room ${roomId} for task ${jobResult.taskId}`);
    } catch (error) {
      console.error(`[Matrix] Failed to send job result to room ${roomId}:`, error);
      throw error;
    }
  }

  /**
   * Format job result into Matrix message format
   */
  formatJobResultMessage(jobResult) {
    const status = jobResult.success ? '✅ Success' : '❌ Failed';
    const timestamp = jobResult.timestamp.toISOString();
    
    let plain = `🔧 Claude Code Async Job Complete\n\n`;
    plain += `📊 Task ID: ${jobResult.taskId}\n`;
    plain += `🤖 Agent ID: ${jobResult.agentId}\n`;
    plain += `📈 Status: ${status}\n`;
    plain += `🕒 Time: ${timestamp}\n\n`;
    
    if (jobResult.success) {
      plain += `📝 Result:\n${jobResult.result}`;
    } else {
      plain += `💥 Error: ${jobResult.error || 'Unknown error'}`;
    }
    
    let html = `<h3>🔧 Claude Code Async Job Complete</h3>`;
    html += `<p><strong>📊 Task ID:</strong> <code>${jobResult.taskId}</code></p>`;
    html += `<p><strong>🤖 Agent ID:</strong> <code>${jobResult.agentId}</code></p>`;
    html += `<p><strong>📈 Status:</strong> ${status}</p>`;
    html += `<p><strong>🕒 Time:</strong> ${timestamp}</p>`;
    
    if (jobResult.success) {
      html += `<h4>📝 Result:</h4><pre><code>${this.escapeHtml(jobResult.result)}</code></pre>`;
    } else {
      html += `<p><strong>💥 Error:</strong> ${this.escapeHtml(jobResult.error || 'Unknown error')}</p>`;
    }
    
    return { plain, html };
  }

  /**
   * Escape HTML special characters
   */
  escapeHtml(text) {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /**
   * Get the current user ID
   */
  getUserId() {
    return this.config.userId;
  }

  /**
   * Stop the Matrix client
   */
  async stop() {
    if (!this.isInitialized) return;
    
    console.log('[Matrix] Stopping Matrix bot client...');
    await this.client.stop();
    this.isInitialized = false;
  }
}

/**
 * Factory function to create a Matrix bot service from environment variables
 */
export function createMatrixBotFromEnv() {
  const config = {
    homeserverUrl: process.env.MATRIX_HOMESERVER_URL || 'https://matrix.org',
    accessToken: process.env.MATRIX_ACCESS_TOKEN || '',
    userId: process.env.MATRIX_USER_ID || '@claude-code:matrix.org',
    autoJoinRooms: process.env.MATRIX_AUTO_JOIN_ROOMS !== 'false'
  };
  
  if (!config.accessToken) {
    throw new Error('MATRIX_ACCESS_TOKEN environment variable is required');
  }
  
  return new MatrixBotService(config);
}