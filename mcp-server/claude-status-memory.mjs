/**
 * Claude Code Status Memory Manager
 * Automatically updates Letta memory blocks with Claude Code status information
 */

import fetch from 'node-fetch';

const CLAUDE_STATUS_BLOCK_LABEL = 'claude_code_status';
const CLAUDE_STATS_BLOCK_LABEL = 'claude_code_statistics';

export class ClaudeStatusMemory {
  constructor(config = {}) {
    this.baseUrl = config.lettaUrl || process.env.LETTA_API_URL || 'https://letta.oculair.ca';
    this.password = config.lettaPassword || process.env.LETTA_PASSWORD || 'lettaSecurePass123';
    this.authToken = null;
    this.updateInterval = config.updateInterval || 30000; // Update every 30 seconds
    this.statusTracker = null;
    this.updateTimer = null;
    this.blockIds = new Map(); // Cache block IDs
  }

  /**
   * Initialize the memory manager with a status tracker
   */
  async initialize(statusTracker) {
    this.statusTracker = statusTracker;
    
    // Authenticate with Letta
    await this.authenticate();
    
    // Ensure global blocks exist
    await this.ensureGlobalBlocks();
    
    // Start periodic updates
    this.startPeriodicUpdates();
    
    console.log('[Claude Status Memory] Initialized with update interval:', this.updateInterval);
  }

  /**
   * Ensure global Claude Code status blocks exist
   */
  async ensureGlobalBlocks() {
    try {
      // Check if blocks already exist
      const existingBlocks = await this.listGlobalBlocks();
      
      const statusBlockExists = existingBlocks.some(block => block.label === CLAUDE_STATUS_BLOCK_LABEL);
      const statsBlockExists = existingBlocks.some(block => block.label === CLAUDE_STATS_BLOCK_LABEL);
      
      // Create blocks if they don't exist
      if (!statusBlockExists) {
        console.log('[Claude Status Memory] Creating global claude_code_status block...');
        const statusBlock = await this.createGlobalMemoryBlock(
          CLAUDE_STATUS_BLOCK_LABEL, 
          'Claude Code Status - Initializing...',
          false // Not read-only, will be updated
        );
        this.blockIds.set(CLAUDE_STATUS_BLOCK_LABEL, statusBlock.id);
      } else {
        // Find and cache the block ID
        const block = existingBlocks.find(b => b.label === CLAUDE_STATUS_BLOCK_LABEL);
        if (block) this.blockIds.set(CLAUDE_STATUS_BLOCK_LABEL, block.id);
      }
      
      if (!statsBlockExists) {
        console.log('[Claude Status Memory] Creating global claude_code_statistics block...');
        const statsBlock = await this.createGlobalMemoryBlock(
          CLAUDE_STATS_BLOCK_LABEL,
          JSON.stringify({ initialized: new Date().toISOString() }, null, 2),
          false // Not read-only, will be updated
        );
        this.blockIds.set(CLAUDE_STATS_BLOCK_LABEL, statsBlock.id);
      } else {
        // Find and cache the block ID
        const block = existingBlocks.find(b => b.label === CLAUDE_STATS_BLOCK_LABEL);
        if (block) this.blockIds.set(CLAUDE_STATS_BLOCK_LABEL, block.id);
      }
      
      console.log('[Claude Status Memory] Global blocks ready');
    } catch (error) {
      console.error('[Claude Status Memory] Error ensuring global blocks:', error);
    }
  }

  /**
   * List all global blocks
   */
  async listGlobalBlocks() {
    const url = `${this.baseUrl}/v1/blocks/?label=${CLAUDE_STATUS_BLOCK_LABEL}&label=${CLAUDE_STATS_BLOCK_LABEL}`;
    
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: this.getHeaders()
      });

      if (!response.ok) {
        throw new Error(`Failed to list blocks: ${response.status}`);
      }

      return await response.json();
    } catch (error) {
      console.error('[Claude Status Memory] Error listing global blocks:', error);
      return [];
    }
  }

  /**
   * Authenticate with Letta API
   */
  async authenticate() {
    // Letta uses the password as the Bearer token directly
    this.authToken = this.password;
    console.log('[Claude Status Memory] Using direct token authentication with Letta');
  }

  /**
   * Get headers for API requests
   */
  getHeaders() {
    return {
      'Authorization': `Bearer ${this.authToken}`,
      'X-BARE-PASSWORD': `password ${this.password}`,
      'Content-Type': 'application/json'
    };
  }

  /**
   * Start periodic status updates
   */
  startPeriodicUpdates() {
    // Initial update
    this.updateAllAgentStatuses().catch(console.error);
    
    // Set up periodic updates
    this.updateTimer = setInterval(() => {
      this.updateAllAgentStatuses().catch(console.error);
    }, this.updateInterval);
  }

  /**
   * Stop periodic updates
   */
  stopPeriodicUpdates() {
    if (this.updateTimer) {
      clearInterval(this.updateTimer);
      this.updateTimer = null;
    }
  }

  /**
   * Update status for all agents
   */
  async updateAllAgentStatuses() {
    if (!this.statusTracker) return;

    try {
      // Get all agents
      const agents = await this.getAllAgents();
      
      // Filter agents with claude_code tag
      const claudeCodeAgents = agents.filter(agent => 
        agent.tags && agent.tags.includes('claude_code')
      );
      
      console.log(`[Claude Status Memory] Found ${claudeCodeAgents.length} agents with claude_code tag`);
      
      // Update status block for each agent with claude_code tag
      for (const agent of claudeCodeAgents) {
        await this.updateAgentStatus(agent.id);
      }
    } catch (error) {
      console.error('[Claude Status Memory] Error updating all agent statuses:', error);
    }
  }

  /**
   * Update status for a specific agent
   */
  async updateAgentStatus(agentId) {
    if (!this.statusTracker) return;

    try {
      // Get current status from tracker
      const status = {
        timestamp: new Date().toISOString(),
        activeJobs: this.statusTracker.getActiveJobs().filter(job => 
          job.agentId === agentId || !job.agentId // Include jobs without agent ID
        ),
        stats: this.statusTracker.getStats(),
        recentCompleted: this.statusTracker.getCompletedJobs(10).filter(job => 
          job.agentId === agentId || !job.agentId
        ),
        summary: this.generateStatusSummary(agentId)
      };

      // Update global status block
      await this.updateGlobalBlock(CLAUDE_STATUS_BLOCK_LABEL, status);

      // Update global statistics block
      const stats = this.generateDetailedStats(agentId);
      await this.updateGlobalBlock(CLAUDE_STATS_BLOCK_LABEL, stats);

      // Ensure the blocks are attached to this agent
      await this.ensureBlocksAttachedToAgent(agentId);

      console.log(`[Claude Status Memory] Updated global blocks with status for agent ${agentId}`);
    } catch (error) {
      console.error(`[Claude Status Memory] Error updating status for agent ${agentId}:`, error);
    }
  }

  /**
   * Generate status summary for an agent
   */
  generateStatusSummary(agentId) {
    const activeJobs = this.statusTracker.getActiveJobs();
    const agentJobs = activeJobs.filter(job => job.agentId === agentId || !job.agentId);
    const stats = this.statusTracker.getStats();
    
    const lines = [];
    lines.push(`Claude Code Status Summary - ${new Date().toLocaleString()}`);
    lines.push('═'.repeat(50));
    
    if (agentJobs.length > 0) {
      lines.push(`\n🔄 Active Jobs: ${agentJobs.length}`);
      agentJobs.forEach(job => {
        const runtime = Math.round((Date.now() - new Date(job.startTime)) / 1000);
        lines.push(`  • ${job.id.slice(0, 12)}... (${runtime}s) - ${job.command?.slice(0, 50) || 'No command'}${job.command?.length > 50 ? '...' : ''}`);
        if (job.sessionId) {
          lines.push(`    Session: ${job.sessionId}`);
        }
        if (job.lastTool) {
          lines.push(`    Last tool: ${job.lastTool}`);
        }
      });
    } else {
      lines.push('\n✅ No active jobs');
    }
    
    lines.push(`\n📊 Overall Statistics:`);
    lines.push(`  • Total started: ${stats.totalJobsStarted}`);
    lines.push(`  • Completed: ${stats.totalJobsCompleted}`);
    lines.push(`  • Failed: ${stats.totalJobsFailed}`);
    lines.push(`  • Aborted: ${stats.totalJobsAborted}`);
    lines.push(`  • Success rate: ${stats.totalJobsStarted > 0 ? Math.round((stats.totalJobsCompleted / stats.totalJobsStarted) * 100) : 0}%`);
    lines.push(`  • Avg duration: ${Math.round(stats.averageJobDuration / 1000)}s`);
    lines.push(`  • Checkpoints hit: ${stats.checkpointHitCount}`);
    lines.push(`  • Sessions resumed: ${stats.sessionResumeCount}`);
    
    return lines.join('\n');
  }

  /**
   * Generate detailed statistics
   */
  generateDetailedStats(agentId) {
    const stats = this.statusTracker.getStats();
    const activeJobs = this.statusTracker.getActiveJobs();
    const completedJobs = this.statusTracker.getCompletedJobs(50);
    
    // Calculate agent-specific stats
    const agentActive = activeJobs.filter(job => job.agentId === agentId || !job.agentId);
    const agentCompleted = completedJobs.filter(job => job.agentId === agentId || !job.agentId);
    
    // Tool usage statistics
    const toolUsage = {};
    agentCompleted.forEach(job => {
      if (job.lastTool) {
        toolUsage[job.lastTool] = (toolUsage[job.lastTool] || 0) + 1;
      }
    });
    
    // Error analysis
    const errorTypes = {};
    agentCompleted.filter(job => job.status === 'failed').forEach(job => {
      const errorType = job.result?.errorType || 'unknown';
      errorTypes[errorType] = (errorTypes[errorType] || 0) + 1;
    });
    
    return {
      timestamp: new Date().toISOString(),
      global: {
        totalJobsStarted: stats.totalJobsStarted,
        totalJobsCompleted: stats.totalJobsCompleted,
        totalJobsFailed: stats.totalJobsFailed,
        totalJobsAborted: stats.totalJobsAborted,
        averageJobDuration: stats.averageJobDuration,
        checkpointHitCount: stats.checkpointHitCount,
        sessionResumeCount: stats.sessionResumeCount,
        uptime: stats.uptime,
        startTime: stats.startTime
      },
      agent: {
        activeJobCount: agentActive.length,
        completedJobCount: agentCompleted.length,
        failedJobCount: agentCompleted.filter(job => job.status === 'failed').length,
        successRate: agentCompleted.length > 0 
          ? (agentCompleted.filter(job => job.status === 'completed').length / agentCompleted.length) * 100 
          : 0
      },
      toolUsage,
      errorTypes,
      performance: {
        averageResponseTime: this.calculateAverageResponseTime(agentCompleted),
        peakHour: this.calculatePeakHour(agentCompleted),
        jobsPerHour: this.calculateJobsPerHour(stats)
      }
    };
  }

  /**
   * Calculate average response time
   */
  calculateAverageResponseTime(jobs) {
    if (jobs.length === 0) return 0;
    const totalDuration = jobs.reduce((sum, job) => sum + (job.duration || 0), 0);
    return Math.round(totalDuration / jobs.length / 1000); // in seconds
  }

  /**
   * Calculate peak usage hour
   */
  calculatePeakHour(jobs) {
    const hourCounts = {};
    jobs.forEach(job => {
      const hour = new Date(job.startTime).getHours();
      hourCounts[hour] = (hourCounts[hour] || 0) + 1;
    });
    
    let peakHour = 0;
    let maxCount = 0;
    Object.entries(hourCounts).forEach(([hour, count]) => {
      if (count > maxCount) {
        maxCount = count;
        peakHour = parseInt(hour);
      }
    });
    
    return peakHour;
  }

  /**
   * Calculate jobs per hour rate
   */
  calculateJobsPerHour(stats) {
    const uptimeHours = stats.uptime / (1000 * 60 * 60);
    return uptimeHours > 0 ? Math.round(stats.totalJobsStarted / uptimeHours * 10) / 10 : 0;
  }

  /**
   * Update a global memory block using its ID
   */
  async updateGlobalBlock(blockLabel, value) {
    const blockId = this.blockIds.get(blockLabel);
    if (!blockId) {
      console.error(`[Claude Status Memory] No block ID found for label: ${blockLabel}`);
      return;
    }
    
    const url = `${this.baseUrl}/v1/blocks/${blockId}`;
    
    try {
      const response = await fetch(url, {
        method: 'PATCH',
        headers: this.getHeaders(),
        body: JSON.stringify({
          value: typeof value === 'string' ? value : JSON.stringify(value, null, 2)
        })
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Failed to update global block: ${response.status} - ${errorText}`);
      }
    } catch (error) {
      console.error(`[Claude Status Memory] Error updating global block ${blockLabel}:`, error);
      throw error;
    }
  }

  /**
   * Ensure global blocks are attached to an agent
   */
  async ensureBlocksAttachedToAgent(agentId) {
    try {
      // First check if we have any block IDs cached
      if (this.blockIds.size === 0) {
        console.log('[Claude Status Memory] No block IDs cached, skipping attachment');
        return;
      }
      
      // Get agent details to check attached blocks and tags
      const agentUrl = `${this.baseUrl}/v1/agents/${agentId}`;
      const response = await fetch(agentUrl, {
        method: 'GET',
        headers: this.getHeaders()
      });
      
      if (!response.ok) {
        console.error(`[Claude Status Memory] Failed to get agent details: ${response.status}`);
        return;
      }
      
      const agent = await response.json();
      
      // Check if agent has claude_code tag
      if (!agent.tags || !agent.tags.includes('claude_code')) {
        console.log(`[Claude Status Memory] Agent ${agent.name || agentId} does not have claude_code tag, skipping block attachment`);
        return;
      }
      
      const attachedBlockIds = new Set();
      
      // Check memory blocks
      if (agent.memory && agent.memory.blocks) {
        agent.memory.blocks.forEach(block => {
          if (block.id) attachedBlockIds.add(block.id);
        });
      }
      
      // Attach missing blocks
      let attachmentCount = 0;
      for (const [label, blockId] of this.blockIds.entries()) {
        if (!attachedBlockIds.has(blockId)) {
          console.log(`[Claude Status Memory] Attaching block ${label} (${blockId}) to agent ${agentId}`);
          await this.attachBlockToAgent(agentId, blockId);
          attachmentCount++;
        }
      }
      
      if (attachmentCount === 0) {
        console.log(`[Claude Status Memory] All blocks already attached to agent ${agentId}`);
      }
    } catch (error) {
      console.error(`[Claude Status Memory] Error ensuring blocks attached to agent:`, error);
    }
  }

  /**
   * Update or create a memory block for an agent (deprecated - use updateGlobalBlock instead)
   */
  async updateMemoryBlock(agentId, blockLabel, value) {
    const url = `${this.baseUrl}/v1/agents/${agentId}/core-memory/blocks/${blockLabel}`;
    
    try {
      const response = await fetch(url, {
        method: 'PATCH',
        headers: this.getHeaders(),
        body: JSON.stringify({
          value: typeof value === 'string' ? value : JSON.stringify(value, null, 2)
        })
      });

      if (!response.ok) {
        // Try to create the block if it doesn't exist
        if (response.status === 404) {
          await this.createMemoryBlock(agentId, blockLabel, value);
        } else {
          throw new Error(`Failed to update block: ${response.status}`);
        }
      }
    } catch (error) {
      console.error(`[Claude Status Memory] Error updating block ${blockLabel}:`, error);
      throw error;
    }
  }

  /**
   * Create a new memory block (global block, not agent-specific)
   */
  async createGlobalMemoryBlock(blockLabel, value, isReadOnly = false) {
    const createUrl = `${this.baseUrl}/v1/blocks/`;
    
    const blockData = {
      value: typeof value === 'string' ? value : JSON.stringify(value, null, 2),
      name: blockLabel,
      label: blockLabel,
      description: `Claude Code ${blockLabel.replace(/_/g, ' ')} - Auto-updated by MCP server`,
      limit: 50000, // Larger limit for status data
      is_template: false,
      preserve_on_migration: true, // Keep this block when agents are migrated
      read_only: isReadOnly,
      metadata: {
        type: 'claude_code_status',
        auto_updated: true,
        created_at: new Date().toISOString(),
        source: 'claude-code-ui-mcp'
      }
    };

    try {
      const response = await fetch(createUrl, {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify(blockData)
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Failed to create block: ${response.status} - ${errorText}`);
      }

      const block = await response.json();
      console.log(`[Claude Status Memory] Created global block ${blockLabel} with ID: ${block.id}`);
      
      return block;
    } catch (error) {
      console.error(`[Claude Status Memory] Error creating global block ${blockLabel}:`, error);
      throw error;
    }
  }

  /**
   * Create a memory block for an agent (deprecated - use global blocks instead)
   */
  async createMemoryBlock(agentId, blockLabel, value) {
    const url = `${this.baseUrl}/v1/agents/${agentId}/core-memory/blocks`;
    
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify({
          label: blockLabel,
          value: typeof value === 'string' ? value : JSON.stringify(value, null, 2)
        })
      });

      if (!response.ok) {
        throw new Error(`Failed to create block: ${response.status}`);
      }
    } catch (error) {
      console.error(`[Claude Status Memory] Error creating block ${blockLabel}:`, error);
      throw error;
    }
  }

  /**
   * Attach a block to an agent
   */
  async attachBlockToAgent(agentId, blockId) {
    const url = `${this.baseUrl}/v1/agents/${agentId}/core-memory/blocks/attach/${blockId}`;
    
    try {
      const response = await fetch(url, {
        method: 'PATCH',
        headers: this.getHeaders(),
        body: JSON.stringify({}) // Empty body to prevent proxy error
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Failed to attach block: ${response.status} - ${errorText}`);
      }
      
      console.log(`[Claude Status Memory] Successfully attached block ${blockId} to agent ${agentId}`);
    } catch (error) {
      console.error(`[Claude Status Memory] Error attaching block to agent:`, error);
      // Don't throw - continue with other operations
    }
  }

  /**
   * Get all agents
   */
  async getAllAgents() {
    const url = `${this.baseUrl}/v1/agents/`;
    
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: this.getHeaders()
      });

      if (!response.ok) {
        throw new Error(`Failed to get agents: ${response.status}`);
      }

      return await response.json();
    } catch (error) {
      console.error('[Claude Status Memory] Error getting agents:', error);
      return [];
    }
  }

  /**
   * Manually trigger an update for a specific job
   */
  async onJobUpdate(jobId, agentId) {
    if (agentId) {
      // Update only the specific agent
      await this.updateAgentStatus(agentId);
    } else {
      // Update all agents if no specific agent ID
      await this.updateAllAgentStatuses();
    }
  }

  /**
   * Clean up and stop updates
   */
  destroy() {
    this.stopPeriodicUpdates();
    this.statusTracker = null;
    this.authToken = null;
  }
}

// Export singleton instance
export const claudeStatusMemory = new ClaudeStatusMemory();